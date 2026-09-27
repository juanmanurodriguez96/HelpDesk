/**
 * Motor de diagnostico.
 *
 * Toma un ticket, decide que comprobadores aplican, los ejecuta y devuelve un
 * INFORME con una causa probable y su confianza. No ejecuta la conclusion: dice
 * cual es la lectura de los datos y con que margen, y deja la decision de
 * remediar en las manos de quien tiene el contexto.
 *
 * El informe siempre lleva `insufficient`. Un informe con comprobadores en
 * `unknown` no es un informe negativo: es un informe incompleto, y esa distincion
 * decide si el ticket puede cerrarse o tiene que quedarse esperando. Confundir
 * las dos es como se cierran tickets sin haberlos comprobado.
 */

import { runCheck, summarize } from "./check.js";
import { ALL_CHECKS, contextFromTicket, networkAllowed } from "./network-checks.js";
import { newReference } from "../core/ids.js";
import { ValidationError } from "../core/errors.js";
import { TYPOLOGIES, categoryById } from "../knowledge/taxonomy.js";

/**
 * Comprobadores que aplican a cada tipologia. Declararlo aqui, en vez de
 * descubrirlo en tiempo de ejecucion, evita que un ticket nuevo termine
 * ejecutando comprobadores de red sin relacion con su problema.
 */
const CHECKS_BY_TYPOLOGY = {
  [TYPOLOGIES.INFRAESTRUCTURA]: [
    "service.catalog",
    "dns.resolve",
    "net.reachability",
    "net.port",
    "service.health-endpoint",
    "service.sla-known",
  ],
  [TYPOLOGIES.APLICATIVA]: ["service.catalog", "service.health-endpoint", "service.sla-known"],
  [TYPOLOGIES.ACCESO]: ["service.catalog", "service.health-endpoint", "service.sla-known"],
  [TYPOLOGIES.PERSONAL]: [],
};

/**
 * Ejecuta el diagnostico de un ticket.
 *
 * @param {object} args
 * @param {object} args.ticket
 * @param {boolean} [args.allowNetwork] Autorizacion explicita para salir a la red.
 * @param {string[]} [args.only]        Forzar un subconjunto de comprobadores.
 * @param {object[]} [args.checks]      Inyectar comprobadores (pruebas).
 * @returns {Promise<object>}
 */
export async function diagnose({ ticket, allowNetwork = false, only = null, checks = ALL_CHECKS }) {
  if (!ticket || typeof ticket !== "object") {
    throw new ValidationError("DIAG_TICKET_REQUIRED", "El diagnostico necesita un ticket.");
  }

  const typology = ticket.typology ?? categoryById(ticket.category ?? "unclassified").typology;
  const selected = selectChecks(typology, checks, only);
  const context = contextFromTicket(ticket, { allowNetwork });
  const liveSelected = selected.filter((c) => c.source === "live");

  // Si el ticket pide comprobaciones de red sin permiso, se dice ANTES de
  // ejecutar nada. Un aviso de permiso escondido dentro del resultado pasaria
  // inadvertido entre lineas, y lo que hace falta es que quede claro que
  // faltaron datos.
  const deniedNetwork = liveSelected.length > 0 && !networkAllowed(allowNetwork);

  const results = [];
  for (const check of selected) {
    if (check.source === "live" && !networkAllowed(allowNetwork)) {
      results.push({
        id: check.id,
        label: check.label,
        verdict: "unknown",
        detail:
          "Comprobacion de red omitida: requiere autorizacion explicita (allowNetwork o HELPDESK_ALLOW_NETWORK=1).",
        evidence: { source: check.source, skipped: "network_not_allowed" },
        durationMs: 0,
      });
      continue;
    }
    results.push(await runCheck(check, context));
  }

  const summary = summarize(results);
  const cause = inferCause(results, typology, { deniedNetwork });

  return {
    id: newReference("DIAG"),
    ticketId: ticket.id,
    at: new Date().toISOString(),
    typology,
    mode: networkAllowed(allowNetwork) ? "live" : "offline",
    checks: results,
    summary,
    cause,
    /** Sin autorizacion de red, o con datos que faltan, el informe no cierra nada. */
    insufficient:
      deniedNetwork || results.length === 0 || summary.coverage < 1 || cause.confidence < 0.6,
    /** Que habria que pedir al usuario o a otro agente para cerrar el informe. */
    missing: missingFor(results, { deniedNetwork }),
  };
}

function selectChecks(typology, checks, only) {
  const ids = only ?? CHECKS_BY_TYPOLOGY[typology] ?? [];
  return ids.map((id) => checks.find((c) => c.id === id)).filter(Boolean);
}

/**
 * Reglas de inferencia, de la mas especifica a la mas general.
 *
 * Una regla que se activara con un unico `fail` produciria una causa plausible
 * pero inventada, que es el fallo clasico de estos sistemas: confianza alta y
 * ninguna base. Cada regla exige el sintoma que la sostiene, y la confianza se
 * deriva de cuantos comprobadores DICEN lo mismo, no de la regla elegida.
 */
const CAUSE_RULES = [
  {
    id: "dns_failure",
    applies: (r) => r["dns.resolve"] === "fail",
    /** Un NXDOMAIN es un diagnostico casi cerrado. */
    confidenceCap: 0.85,
    cause: {
      es: "Fallo de resolucion de nombres: el equipo no traduce el nombre del servicio",
      en: "Name resolution failure: the device cannot translate the service name",
    },
    next: {
      es: "Comprobar la configuracion DNS del equipo y el alcance del fallo",
      en: "Check the device DNS configuration and the blast radius",
    },
  },
  {
    id: "endpoint_unreachable",
    applies: (r) => r["net.reachability"] === "fail" || r["net.port"] === "fail",
    /** "No llega" puede ser cortafuegos, corte o cliente mal configurado. */
    confidenceCap: 0.6,
    cause: {
      es: "La direccion o el puerto no responden: el camino esta bloqueado o el servicio no escucha",
      en: "The address or port does not answer: the path is blocked or the service is not listening",
    },
    next: {
      es: "Descartar cortafuegos y estado del servicio antes de tocar el equipo del usuario",
      en: "Rule out firewall and service state before touching the user device",
    },
  },
  {
    id: "service_unhealthy",
    applies: (r) => r["service.health-endpoint"] === "fail",
    confidenceCap: 0.9,
    cause: {
      es: "El servicio responde con error: la incidencia no es del equipo del usuario",
      en: "The service answers with an error: this is not a user device issue",
    },
    next: {
      es: "Escalar al equipo propietario del servicio con la evidencia",
      en: "Escalate to the service owner with the evidence",
    },
  },
  {
    id: "service_unidentified",
    applies: (r) => r["service.catalog"] !== "pass",
    confidenceCap: 0.3,
    cause: {
      es: "El impacto no se puede atribuir a un servicio del catalogo",
      en: "The impact cannot be attributed to a catalogued service",
    },
    next: {
      es: "Pedir el nombre del servicio o la aplicacion afectada",
      en: "Ask for the name of the affected service or application",
    },
  },
  {
    id: "path_healthy",
    applies: (r) => r["dns.resolve"] === "pass" || r["net.port"] === "pass",
    confidenceCap: 0.3,
    cause: {
      es: "La ruta de red funciona: el problema esta mas alla de la conectividad",
      en: "The network path works: the problem is beyond connectivity",
    },
    next: {
      es: "Revisar configuracion del cliente, credenciales del dispositivo y estado de la sesion",
      en: "Review client configuration, device credentials and session state",
    },
  },
];

/**
 * Traduce un veredicto a probabilidad de exito, para la confianza.
 * `pass` vale 1, `fail` vale 0 y `unknown` NO vale 0.5: un dato que falta no es
 * un dato que sale mal, y tratarlo como evidencia neutra inflaria la confianza de
 * cualquier diagnostico incompleto.
 */
export function veredictRate(verdict) {
  if (verdict === "pass") return 1;
  if (verdict === "fail") return 0;
  return null;
}

/**
 * Construye la conclusion en dos etapas.
 *
 * Primero, una CAUSA por el primer sintoma que se sostiene. Despues, el
 * BLOQUEO: si nada se incumple, el informe no dice "todo bien" sino "no hay
 * evidencia de fallo", que es una afirmacion mucho mas debil y no cierra nada.
 */
function inferCause(results, typology, { deniedNetwork }) {
  const byId = Object.fromEntries(results.map((r) => [r.id, r.verdict]));
  const primary = CAUSE_RULES.find((rule) => rule.applies(byId)) ?? null;

  const known = results.filter((r) => r.verdict !== "unknown");
  const passes = known.filter((r) => r.verdict === "pass").length;
  const fails = known.filter((r) => r.verdict === "fail").length;
  const unknown = results.length - known.length;

  let confidence;
  if (primary === null) {
    confidence = 0.2;
  } else {
    // Proporcion de comprobaciones que DICEN lo mismo, penalizada por los datos
    // que faltan, y tops por el limite de la propia regla.
    const supporting = primary.id === "path_healthy" ? passes : fails;
    const coverage = known.length === 0 ? 0 : supporting / known.length;
    confidence = Math.min(primary.confidenceCap, clamp01(coverage - unknown * 0.2));
  }
  if (deniedNetwork) confidence = Math.min(confidence, 0.3);

  return {
    rule: primary?.id ?? null,
    hypothesis: primary?.cause ?? {
      es: "Sin sintoma claro: no se puede afirmar una causa con los datos disponibles",
      en: "No clear symptom: no cause can be asserted with the available data",
    },
    nextStep: primary?.next ?? {
      es: "Recabar informacion antes de actuar",
      en: "Gather more information before acting",
    },
    confidence: Math.round(confidence * 100) / 100,
    /** Un informe con esto en `false` no autoriza ninguna remediacion. */
    conclusive: confidence >= 0.6 && !deniedNetwork && unknown === 0,
    typology,
  };
}

/** Que falta para poder concluir. */
function missingFor(results, { deniedNetwork }) {
  const missing = [];
  if (deniedNetwork) {
    missing.push({
      id: "network_authorization",
      reason: "No se autorizo la salida a la red: los comprobadores de conectividad no se ejecutaron.",
      ask: "Autorizar comprobaciones de red o escalar a la mesa que si puede ejecutarlas.",
    });
  }
  for (const r of results) {
    if (r.verdict !== "unknown") continue;
    if (r.evidence?.skipped === "network_not_allowed") continue;
    missing.push({ id: r.id, reason: r.detail, ask: "Aportar los datos que este comprobador necesita." });
  }
  return missing;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}
