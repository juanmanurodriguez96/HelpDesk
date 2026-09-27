import test from "node:test";
import assert from "node:assert/strict";

import { classify, AMBIGUITY_MARGIN } from "../src/triage/classifier.js";
import { extractEntities, buildClarifyingQuestions } from "../src/triage/entities.js";
import { scorePriority, explainPriority } from "../src/triage/priority.js";
import { intakeAndTriage, triage } from "../src/triage/index.js";
import { createTicket } from "../src/domain/ticket.js";
import { categoryById } from "../src/knowledge/taxonomy.js";
import { containsSecret, assertSafeQuestion } from "../src/privacy/pii.js";

const NOW = new Date("2026-01-05T08:00:00Z");
const REPORTER = "E-99001";

function run(text, overrides = {}) {
  return intakeAndTriage({ text, reporter: REPORTER, now: NOW, ...overrides });
}

test("clasifica un bloqueo de cuenta por encima de una peticion de MFA", () => {
  const result = classify("Me sale cuenta bloqueada por exceso de intentos al entrar al SSO");
  assert.equal(result.category, "identity.lockout");
  assert.ok(result.matchedTerms.length > 0, "debe indicar que termino justifico la decision");
  assert.equal(result.ambiguous, false);
});

test("clasifica una incidencia de VPN por sus terminos de sintoma", () => {
  const result = classify("No me conecto a la VPN desde casa, AnyConnect da error de gateway y timeout");
  assert.equal(result.category, "network.vpn");
});

test("no confunde subcadenas: 'ssola' no dispara la categoria de identidad", () => {
  const result = classify("La consulta ssola tarda demasiado en la intranet");
  assert.notEqual(result.category, "identity.password_reset");
});

test("texto sin senal reconocible cae en unclassified y se marca ambiguo", () => {
  const result = classify("Hola, buenos dias, no se que me pasa con el ordenador de mi despacho");
  assert.equal(result.category, "unclassified");
  assert.equal(result.ambiguous, true);
  assert.equal(result.confidence, 0);
});

test("dos categorias casi empatadas se consideran ambiguas en lugar de decidir por orden", () => {
  // "no tengo conexion" (conectividad, w4) y "acceso remoto" (VPN, w4) empatan.
  // El ticket es real: la misma frase puede ser un fallo de WiFi en casa o el
  // cliente VPN que no arranca. Decidir por orden de peso seria inventarse el
  // diagnostico, asi que se escala a la mesa humana.
  const result = classify("No tengo conexion con el acceso remoto desde el portatil");
  assert.equal(result.category, "unclassified");
  assert.equal(result.ambiguous, true);
  assert.ok(result.confidence <= 0.35, "la confianza de una ambiguedad debe ser baja");
  const categories = result.alternatives.map((a) => a.category);
  assert.ok(
    categories.includes("network.vpn") || categories.includes("network.connectivity"),
    "debe exponer las alternativas en vez de ocultarlas: " + categories.join(", "),
  );
});

test("extrae el identificador corporativo del usuario afectado", () => {
  const entities = extractEntities("Usuario E-10482 sin acceso al repositorio data-platform");
  assert.equal(entities.affectedUser, "E-10482");
  assert.equal(entities.impactedService, "gitlab");
  assert.equal(entities.targetResource, "data-platform");
});

test("extrae el inventario de equipo y no lo confunde con un usuario", () => {
  const entities = extractEntities("En el portatil LT-MADRID-042 no me conecta la VPN");
  assert.equal(entities.asset, "LT-MADRID-042");
  assert.ok(
    !String(entities.affectedUser ?? "").includes("MADRID"),
    "el tag de equipo no puede convertirse en identificador de usuario",
  );
});

test("la referencia del propio ticket no se interpreta como usuario afectado", () => {
  const entities = extractEntities("Sigo con el bloqueo del ticket HD-4821");
  assert.equal(entities.affectedUser, null);
});

test("un caso personal sin nombrar a nadie se atribuye a quien reporta", () => {
  const entities = extractEntities("No me deja entrar, solo me pasa a mi", { reporterId: REPORTER });
  assert.equal(entities.affectedUser, REPORTER);
});

test("un caso que nombra a un tercero no se atribuye al solicitante", () => {
  const entities = extractEntities("El usuario E-30055 no puede entrar", { reporterId: REPORTER });
  assert.equal(entities.affectedUser, "E-30055");
});

test("detecta el alcance del impacto a partir del lenguaje natural", () => {
  assert.equal(extractEntities("Afecta a todos los usuarios de la oficina").impactScope, "company");
  assert.equal(extractEntities("Le pasa a varios usuarios del equipo").impactScope, "department");
  assert.equal(extractEntities("Unicamente me ocurre a mi").impactScope, "single");
  assert.equal(extractEntities("El teclado no funciona").impactScope, null);
});

test("detecta senales de urgencia y la existencia de alternativa", () => {
  const entities = extractEntities(
    "Es urgente, me bloquea el trabajo, pero puedo trabajar desde la oficina de la empresa",
  );
  assert.ok(entities.urgencySignals.includes("explicit_urgent"));
  assert.ok(entities.urgencySignals.includes("blocks_work"));
  assert.equal(entities.workaroundAvailable, true);
});

test("extrae la criticidad de negocio desde el catalogo de servicios", () => {
  const entities = extractEntities("No me entra el ERP de facturacion");
  assert.equal(entities.impactedService, "erp");
  assert.equal(entities.businessCriticality, 1);
});

test("la severidad sube con el trabajo bloqueado y con la criticidad del servicio", () => {
  const category = categoryById("identity.lockout");
  const bare = scorePriority({ category, entities: { businessCriticality: 1, impactScope: "single" } });
  const blocked = scorePriority({
    category,
    entities: {
      businessCriticality: 1,
      impactScope: "single",
      urgencySignals: ["blocks_work"],
    },
  });
  assert.ok(blocked.severity < bare.severity, "bloquear el trabajo debe subir la severidad");
});

test("S1 queda reservado a impacto confirmado de toda la empresa", () => {
  const category = categoryById("service.degradation");

  // Con atenuante presente el alcance ya impide el S1, asi que se comprueba el
  // invariante, no el mecanismo: lo que importa es que un usuario no es S1.
  const individual = scorePriority({
    category,
    entities: { businessCriticality: 1, impactScope: "single", urgencySignals: ["blocks_work", "explicit_urgent"] },
  });
  assert.equal(individual.severity, 2, "un usuario nunca es S1");

  const company = scorePriority({
    category,
    entities: { businessCriticality: 1, impactScope: "company", urgencySignals: ["blocks_work"] },
  });
  assert.equal(company.severity, 1);
  assert.equal(company.priority, "P1");
});

test("el techo de severidad deja rastro auditable cuando es el que frena el S1", () => {
  // Aqui no hay atenuante que ya baje el S1: lo unico que lo frena es la politica
  // de empresa. Ese es el caso en que el registro tiene que explicar el por que.
  const result = scorePriority({
    category: categoryById("identity.lockout"),
    entities: { businessCriticality: 1, impactScope: null, urgencySignals: ["blocks_work"] },
  });
  assert.equal(result.severity, 2);
  const cap = result.factors.find((f) => f.code === "individual_severity_ceiling");
  assert.ok(cap, "el techo de severidad debe quedar registrado como factor auditable");
  assert.match(cap.explanation, /empresa/);
});

test("los atenuantes juntos solo pueden rebajar un escalo de severidad", () => {
  // Base 2 (VPN), sin hechos duros, pero con dos atenuantes: alcance individual
  // y alternativa disponible. Suman un solo escalo, no dos: Bajar dos veces por
  // el mismo motivo bury el caso. El resultado es S3, no S4.
  const result = scorePriority({
    category: categoryById("network.vpn"),
    entities: { businessCriticality: 1, impactScope: "single", workaroundAvailable: true },
  });
  assert.equal(result.severity, 3);
  assert.equal(result.priority, "P3");
});

test("un hecho duro si puede reforzar la severidad por encima de un atenuante", () => {
  const result = scorePriority({
    category: categoryById("network.vpn"),
    entities: {
      businessCriticality: 1,
      impactScope: "department",
      workaroundAvailable: true,
      urgencySignals: ["blocks_work"],
    },
  });
  assert.ok(result.severity <= 2, "el bloqueo de trabajo debe pesar mas que el apano");
  assert.equal(result.priority, "P2");
});

test("la explicacion de prioridad es legible y cita los factores", () => {
  const result = scorePriority({
    category: categoryById("network.vpn"),
    entities: { businessCriticality: 1, impactScope: "single", urgencySignals: ["blocks_work"] },
    lang: "en",
  });
  const text = explainPriority(result, "en");
  assert.match(text, /Severity 2/);
  assert.ok(text.length > 30);
});

test("triage completo: un bloqueo de cuenta individual va a identidad sin preguntar", () => {
  const { ticket, decision } = run(
    "Llevo tres intentos de entrar al SSO y me sale cuenta bloqueada por exceso de intentos. Usuario E-10482, me bloquea el trabajo",
  );
  assert.equal(ticket.category, "identity.lockout");
  assert.equal(ticket.assignedAgent, null);
  assert.equal(decision.target, "identity-support");
  assert.equal(decision.action, "remediate_or_ask");
  assert.equal(ticket.severity, "S2");
  assert.equal(ticket.priority, "P2");
});

test("triage completo: un ticket de infraestructura se deriva a diagnostico", () => {
  const { decision } = run(
    "Desde casa no puedo conectarme a la VPN, AnyConnect da error 403 de gateway y timeout a los 30s. Solo me pasa a mi",
  );
  assert.equal(decision.action, "diagnose");
  assert.equal(decision.target, "infra-support");
});

test("triage completo: faltan datos -> se pregunta, no se ejecuta nada", () => {
  const { ticket, decision, nextQuestions } = run("Solicito acceso a una carpeta compartida del equipo");
  assert.equal(decision.action, "ask_user");
  assert.ok(nextQuestions.length > 0, "debe formular al menos una pregunta");
  assert.equal(ticket.status, "new", "un ticket con datos insuficientes no avanza de estado");
  // La comprobacion va con el guardia real, no con una expresion regular
  // inventada aqui: lo que hay que garantizar es que ninguna pregunta SALTA la
  // politica de credenciales, y eso lo sabe mejor `assertSafeQuestion`.
  for (const question of nextQuestions) {
    assert.doesNotThrow(() => assertSafeQuestion(question), "pregunta no permitida: " + question);
  }
});

test("triage completo: impacto de empresa -> escalado inmediato", () => {
  const { ticket, decision } = run(
    "El ERP de facturacion esta caido, error 503, afecta a toda la empresa segun me dijo el equipo",
  );
  assert.equal(decision.action, "escalate");
  assert.equal(decision.target, "escalation-desk");
  assert.equal(decision.reason, "alcance_empresarial");
  assert.equal(ticket.severity, "S1");
});

test("triage completo: texto no clasificable -> mesa humana, nunca auto-remediacion", () => {
  const { decision } = run("Hola, buenos dias, no se que me pasa con el ordenador de mi despacho");
  assert.equal(decision.action, "escalate");
  assert.equal(decision.target, "escalation-desk");
});

test("triage completo: las credenciales se eliminan del registro y se avisa al usuario", () => {
  const { ticket, decision } = run(
    "No me puedo conectar a la VPN, mi usuario es E-10482 y la contrasena es Secreto123!",
  );
  assert.equal(containsSecret(JSON.stringify(ticket)), false, "el ticket no debe guardar secretos");
  assert.equal(ticket.request.userOfferedCredentials, true);
  assert.ok(decision.securityNotice, "debe incluirse un aviso de seguridad");
  assert.equal(decision.action, "handle_with_warning");
  assert.match(decision.securityNotice.message, /credencial/i);
  assert.match(decision.securityNotice.message, /nunca se las pedira/i);
});

test("triage completo: el SLA se calcula con la severidad resultante", () => {
  const { ticket } = run(
    "El ERP de facturacion esta caido y afecta a toda la empresa segun el equipo de sistemas",
  );
  assert.equal(ticket.sla.severity, "S1");
  assert.equal(typeof ticket.sla.responseDueAt, "string");
  assert.equal(Date.parse(ticket.sla.resolutionDueAt) > Date.parse(ticket.sla.responseDueAt), true);
  assert.equal(ticket.sla.firstRespondedAt, null, "un ticket recien triado no tiene respuesta registrada");
});

test("triage de un ticket ya creado no muta el original", () => {
  const original = createTicket({ text: "No me conecto a la VPN desde casa", reporter: REPORTER, now: NOW });
  const { ticket } = triage(original, { now: NOW });
  assert.equal(original.category, null, "el ticket de entrada no debe mutarse");
  assert.ok(ticket.category, "el triaje produce una categoria");
});

test("las preguntas de aclaracion cubren exactamente lo que falta", () => {
  const ticket = { entities: { missingRequired: ["affectedUser", "targetResource"] } };
  const questions = buildClarifyingQuestions(ticket, "es");
  assert.equal(questions.length, 2);
  assert.match(questions[0], /identificador corporativo/);
  assert.match(questions[1], /recurso concreto/);
});
