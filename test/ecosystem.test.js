import test, { suite } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { intakeAndTriage } from "../src/triage/index.js";
import { applyTransition, MAX_HANDOFFS } from "../src/domain/lifecycle.js";
import { STATUS } from "../src/domain/ticket.js";
import {
  AGENTS,
  HANDOFFS,
  agentById,
  canHandoff,
  routeFor,
  validateManifest,
  handoff,
  initialRoute,
  validateHandoffs,
} from "../src/ecosystem/index.js";
import {
  ESCALATION_REASONS,
  escalate,
  escalateSeverity,
  detectEscalationSignals,
  reasonFromDecision,
  acknowledge,
  isAckOverdue,
} from "../src/escalation/index.js";
import { PolicyError, ValidationError } from "../src/core/errors.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-01-05T08:00:00Z");

function ticketFor(text) {
  return intakeAndTriage({ text, reporter: "E-99001", now: NOW }).ticket;
}

suite("ecosistema/manifiesto", () => {
  test("el manifiesto es coherente consigo mismo", () => {
    const { ok, errors } = validateManifest();
    assert.equal(ok, true, errors.join(" | "));
  });

  test("todo destino de traspaso existe como agente", () => {
    for (const agent of AGENTS) {
      for (const target of agent.handoffTargets) {
        assert.ok(agentById(target), `"${agent.id}" apunta a "${target}", que no existe`);
      }
    }
  });

  test("ningun agente declara una categoria que no existe en la taxonomia", async () => {
    const { CATEGORIES, TYPOLOGIES } = await import("../src/knowledge/taxonomy.js");
    const categoryIds = new Set(CATEGORIES.map((c) => c.id));
    const typologyValues = new Set(Object.values(TYPOLOGIES));
    for (const agent of AGENTS) {
      for (const category of agent.categories) {
        assert.ok(categoryIds.has(category), `"${agent.id}" declara la categoria "${category}"`);
      }
      for (const typology of agent.typologies) {
        assert.ok(typologyValues.has(typology), `"${agent.id}" declara la tipologia "${typology}"`);
      }
    }
  });

  test("los agentes de la mesa humana no delegan: el ciclo termina", () => {
    const terminal = agentById("escalation-desk");
    assert.deepEqual(terminal.handoffTargets, []);
    assert.ok(terminal.forbidden.some((f) => f.includes("delegar")));
  });

  test("cada agente declara herramientas coherentes con su perfil", () => {
    // Nadie edita ficheros del proyecto: el sistema ejecuta codigo, no lo modifica.
    for (const agent of AGENTS) {
      assert.equal(agent.tools.deny.includes("edit"), true, `${agent.id} podria editar codigo`);
    }
    // Y quien ejecuta acciones lo hace con un binario concreto, no con la shell.
    for (const agent of AGENTS) {
      assert.ok(agent.bash["*"] === "deny", `${agent.id} deja la shell abierta`);
    }
  });
});

suite("ecosistema/reparto", () => {
  test("una incidencia de identidad va a identidad", () => {
    const t = ticketFor("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    assert.equal(initialRoute(t), "identity-support");
  });

  test("una incidencia de red va a infraestructura", () => {
    const t = ticketFor("No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway");
    assert.equal(initialRoute(t), "infra-support");
  });

  test("una peticion de acceso va a aprovisionamiento", () => {
    const t = ticketFor("Solicito acceso de escritura al repositorio data-platform para el usuario E-10482");
    assert.equal(initialRoute(t), "access-provisioning");
  });

  test("una categoria desconocida va a la mesa humana, no a un agente al azar", () => {
    const t = ticketFor("Hola, buenos dias, no se que me pasa con el ordenador de mi despacho");
    assert.equal(routeFor({ category: t.category, typology: t.typology }), "escalation-desk");
  });

  test("el reparto se puede leer en la taxonomia: cola y agente coinciden", async () => {
    const { categoryById } = await import("../src/knowledge/taxonomy.js");
    for (const agent of AGENTS) {
      for (const categoryId of agent.categories) {
        const category = categoryById(categoryId);
        assert.ok(category, `categoria ${categoryId} inexistente`);
        // El agente duele ser el unico dueno de su categoria.
        const otros = AGENTS.filter((a) => a.categories.includes(categoryId) && a.id !== agent.id);
        assert.equal(otros.length, 0, `${categoryId} la comparten ${otros.map((a) => a.id).join(", ")}`);
      }
    }
  });
});

suite("ecosistema/traspasos", () => {
  test("el traspaso queda registrado y suma al contador", () => {
    const t = handoff({
      ticket: { ...ticketFor("Usuario E-10482 con la cuenta bloqueada"), assignedAgent: "helpdesk-orchestrator" },
      to: "identity-support",
      now: NOW,
    });
    assert.equal(t.assignedAgent, "identity-support");
    assert.equal(t.handoffs.count, 1);
    assert.deepEqual(t.handoffs.trail, ["helpdesk-orchestrator"]);
    assert.ok(t.history.at(-1).rationale.length > 0, "el traspaso se explica");
  });

  test("un ticket recien nacido sale del orquestador, no de la nada", () => {
    // El ticket nace sin agente asignado. El primer traspaso tiene que dejar
    // constancia de quien lo envio: si el rastro empieza sin origen, el
    // analisis de ciclos pierde un salto entero y el recuento de traspasos
    // miente.
    const t = handoff({
      ticket: { ...ticketFor("No puedo conectarme a la VPN desde casa"), assignedAgent: null },
      to: "infra-support",
      now: NOW,
    });
    assert.equal(t.assignedAgent, "infra-support");
    assert.deepEqual(t.handoffs.trail, ["helpdesk-orchestrator"]);
    assert.equal(t.history.at(-1).from, "helpdesk-orchestrator");
    assert.ok(!t.history.at(-1).rationale.includes("null"), `no debe quedar un "null" en el rastro: ${t.history.at(-1).rationale}`);
  });

  test("no se puede saltar a un agente sin relacion declarada", () => {
    const t = { ...ticketFor("Usuario E-10482 con la cuenta bloqueada"), assignedAgent: "identity-support" };
    assert.throws(
      () => handoff({ ticket: t, to: "helpdesk-orchestrator", now: NOW }),
      (error) => error instanceof PolicyError && error.code === "HANDOFF_NOT_ALLOWED",
    );
  });

  test("volver a un agente que ya intervino es un ciclo y se rechaza", () => {
    // El caso que importa no es el corto (A -> B -> A, que el grafo ya
    // prohibe) sino el largo: la mesa humana coge el ticket y vuelve a pasarselo
    // al especialista que lo miraba antes.
    const check = canHandoff({
      from: "identity-support",
      to: "escalation-desk",
      trail: ["helpdesk-orchestrator", "identity-support", "escalation-desk"],
    });
    assert.equal(check.allowed, false);
    assert.match(check.reason, /ya intervino|ciclo/);
  });

  test("el mismo traspaso se rechaza por el rastro, no por el grafo", () => {
    // Ambos caminos son legales en el grafo; lo que lo veta es que el destino
    // ya estuvo. Sin esta comprobacion, el ticketiriaria mesa -> especialista
    // -> mesa indefinidamente hasta comerse el tope.
    const t = {
      ...ticketFor("Usuario E-10482 con la cuenta bloqueada"),
      assignedAgent: "identity-support",
      handoffs: { count: 2, trail: ["helpdesk-orchestrator", "identity-support", "escalation-desk"] },
    };
    assert.throws(
      () => handoff({ ticket: t, to: "escalation-desk", now: NOW }),
      (error) => error instanceof PolicyError && error.code === "HANDOFF_NOT_ALLOWED",
    );
  });

  test("se respeta el tope de traspasos", () => {
    const t = {
      ...ticketFor("Usuario E-10482 con la cuenta bloqueada"),
      assignedAgent: "identity-support",
      handoffs: { count: MAX_HANDOFFS, trail: ["helpdesk-orchestrator", "infra-support", "identity-support"] },
    };
    assert.throws(
      () => handoff({ ticket: t, to: "escalation-desk", now: NOW }),
      (error) => error instanceof PolicyError && error.code === "HANDOFF_LIMIT_REACHED",
    );
  });

  test("traspasar al agente actual no rompe nada", () => {
    const t = { ...ticketFor("Usuario E-10482 con la cuenta bloqueada"), assignedAgent: "identity-support" };
    assert.equal(handoff({ ticket: t, to: "identity-support", now: NOW }), t);
  });

  test("un destino inexistente da un error de validacion, no de politica", () => {
    const t = { ...ticketFor("Usuario E-10482 con la cuenta bloqueada"), assignedAgent: "helpdesk-orchestrator" };
    assert.throws(
      () => handoff({ ticket: t, to: "reina-del-cafe", now: NOW }),
      (error) => error instanceof ValidationError && error.code === "HANDOFF_UNKNOWN_AGENT",
    );
  });

  test("el ticket-loaded se valida: un rastro con ciclos se delata", () => {
    const t = { ...ticketFor("x".repeat(10)), handoffs: { count: 2, trail: ["a", "b", "a"] } };
    assert.ok(validateHandoffs(t).some((p) => p.includes("ciclo")));
  });
});

suite("escalado/politica", () => {
  test("los motivos son un conjunto cerrado y documentado", () => {
    for (const [key, spec] of Object.entries(ESCALATION_REASONS)) {
      assert.ok(spec.es && spec.en, `${key} sin texto`);
      assert.ok(spec.severityFloor, `${key} sin suelo de severidad`);
      assert.ok(spec.group, `${key} sin grupo`);
    }
    assert.throws(
      () => escalate({ ticket: {}, reason: "porque_si" }),
      (e) => e instanceof ValidationError && e.code === "ESCALATION_REASON_UNKNOWN",
    );
  });

  test("escalar nunca baja la severidad", () => {
    assert.equal(escalateSeverity("S1", "S2"), "S1");
    assert.equal(escalateSeverity("S3", "S2"), "S2");
    assert.equal(escalateSeverity(null, "S2"), "S2");
  });

  test("una senal de texto puede forzar S1 por encima de la categoria", () => {
    const t = ticketFor("Se ha borrado todo, he perdido los documentos importantes y el equipo va lento");
    const signals = detectEscalationSignals(t);
    assert.ok(signals.includes("data_loss_risk"), "una perdida de datos debe verse aunque la categoria sea otra");
  });

  test("el motivo de la decision se traduce a una clave del catalogo", () => {
    assert.equal(reasonFromDecision({ ticket: {}, reason: "alcance_empresarial" }), "company_wide_impact");
    assert.equal(reasonFromDecision({ ticket: {}, reason: "clasificacion_ambigua" }), "ambiguous_classification");
  });

  test("el escalado trae destino, plazo y responsable", () => {
    const t = ticketFor("Se ha borrado todo, he perdido los documentos importantes");
    const { escalation } = escalate({ ticket: t, reason: "data_loss_risk", now: NOW });
    assert.equal(escalation.target, "escalation-desk");
    assert.ok(Date.parse(escalation.ackDueBy) > NOW.getTime());
    assert.ok(escalation.needed.length > 0);
    assert.equal(escalation.severity, "S1");
  });

  test("escalar a la fuerza tampoco baja la severidad por debajo del suelo", () => {
    // `force` salta la comprobacion del motivo, no la severidad. Un S4 con
    // datos perdidos se registra como S1: la mesa humana ve el motivo con la
    // severidad que el motivo implica, no la que traia el ticket.
    const t = { ...ticketFor("Hola, buenos dias, no se que me pasa con el ordenador"), severity: "S4" };
    const { escalation } = escalate({ ticket: t, reason: "data_loss_risk", now: NOW, force: true });
    assert.equal(escalation.severity, "S1");
    assert.equal(escalation.forced, true);
  });

  test("el motivo se acepta en snake_case y en camelCase", () => {
    // El nombre de la condicion del traspaso es `sin_diagnostico` y la clave del
    // catalogo es `missing_diagnosis`. Aceptar las dos evita translating a mano
    // en el punto de la llamada, que es donde se equivocan las llamadas.
    for (const reason of ["missing_diagnosis", "sin_diagnostico", "missingDiagnosis"]) {
      assert.equal(reasonFromDecision({ ticket: ticketFor("Hola, buenos dias"), reason }), "missing_diagnosis");
    }
  });

  test("un sitio de trabajo remoto no se toma por una peticion fuera de alcance", () => {
    // "desde casa" es teletrabajo, la forma mas comun de describir un problema
    // de VPN. Una senal de escalado demasiado sensible no es prudente.
    const t = ticketFor("No puedo conectarme a la VPN desde casa, AnyConnect da error 403 de gateway");
    assert.equal(reasonFromDecision({ ticket: t, reason: "missing_diagnosis" }), "missing_diagnosis");
  });
});

suite("escalado/ciclo de vida", () => {
  test("un ticket escalado no se puede resolver hasta que alguien lo acepta", () => {
    const t = { ...ticketFor("Hola, buenos dias, no se que me pasa con el ordenador"), status: STATUS.IN_PROGRESS };
    const { escalation, patch } = escalate({ ticket: t, reason: "ambiguous_classification", now: NOW });
    const esc = { ...t, ...patch, escalation };
    const conResolution = { ...esc, resolution: { summary: "Resuelto" } };
    assert.throws(
      () => applyTransition(conResolution, { to: STATUS.RESOLVED, now: NOW }),
      (e) => e.code === "TRANSITION_NOT_ACKNOWLEDGED",
    );
  });

  test("tras la aceptacion, se puede resolver", () => {
    const t = { ...ticketFor("Hola, buenos dias, no se que me pasa con el ordenador"), status: STATUS.IN_PROGRESS };
    const { escalation, patch } = escalate({ ticket: t, reason: "ambiguous_classification", now: NOW });
    const { escalation: acked } = acknowledge({ ticket: { ...t, ...patch, escalation }, operator: "mesa-n2", now: NOW });
    const listo = { ...t, ...patch, escalation: acked, resolution: { summary: "Resuelto" } };
    const r = applyTransition(listo, { to: STATUS.RESOLVED, now: NOW });
    assert.equal(r.status, STATUS.RESOLVED);
  });

  test("un agente no puede aceptar su propio escalado", () => {
    const t = { ...ticketFor("Hola, buenos dias, no se que me pasa con el ordenador") };
    const { escalation, patch } = escalate({ ticket: t, reason: "ambiguous_classification", now: NOW });
    assert.throws(
      () => acknowledge({ ticket: { ...t, ...patch, escalation }, operator: "helpdesk-orchestrator", now: NOW }),
      (e) => e.code === "ESCALATION_ACKNOWLEDGED_BY_AGENT",
    );
  });

  test("aceptar dos veces es un error, no un sobrescrito silencioso", () => {
    const t = { ...ticketFor("Hola, buenos dias, no se que me pasa con el ordenador") };
    const { escalation, patch } = escalate({ ticket: t, reason: "ambiguous_classification", now: NOW });
    const una = { ...t, ...patch, escalation };
    const dos = acknowledge({ ticket: una, operator: "mesa-n2", now: NOW }).escalation;
    assert.throws(
      () => acknowledge({ ticket: { ...una, escalation: dos }, operator: "mesa-n1", now: NOW }),
      (e) => e.code === "ESCALATION_ALREADY_ACKNOWLEDGED",
    );
  });

  test("el escalado vencido se detecta, no se pasa desapercibido", () => {
    const t = ticketFor("Hola, buenos dias, no se que me pasa con el ordenador");
    const { escalation, patch } = escalate({ ticket: t, reason: "ambiguous_classification", now: NOW });
    const conEscalado = { ...t, ...patch, escalation };
    assert.equal(isAckOverdue(conEscalado, NOW), false);
    assert.equal(isAckOverdue(conEscalado, new Date(NOW.getTime() + 31 * 60_000)), true);
  });
});

suite("agentes/ficheros", () => {
  test("cada agente del manifiesto tiene su fichero .md", () => {
    for (const agent of AGENTS) {
      assert.ok(fs.existsSync(path.join(ROOT, agent.file)), `falta ${agent.file}`);
    }
  });

  test("no hay ficheros de agente huerfanos en .opencode/agents", () => {
    const dir = path.join(ROOT, ".opencode/agents");
    const declarados = new Set(AGENTS.map((a) => path.basename(a.file)));
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      assert.ok(declarados.has(entry), `${entry} no esta en el manifiesto`);
    }
  });
});
