/**
 * Politica de escalado.
 *
 * Escalar NO es "no saber que hacer". Es una decision con destino, plazo y
 * responsable: quien recibe el ticket tiene que saber que ha recibido, por que
 * y que se espera de el. Un escalado sin esas tres cosas es un ticket que nadie
 * trabaja.
 *
 * Modulo puro: decide y devuelve un parche. Quien llama lo aplica con
 * `applyTransition`, de modo que la maquina de estados sigue siendo la unica que
 * cambia el status. Aqui solo se construye el contenido de `ticket.escalation`.
 */

import { ValidationError } from "../core/errors.js";
import { newReference } from "../core/ids.js";
import { TYPOLOGIES } from "../knowledge/taxonomy.js";
import { MAX_HANDOFFS } from "../domain/lifecycle.js";
import { agentById } from "../ecosystem/manifest.js";

/**
 * Motivos de escalado. Son un conjunto CERRADO a proposito: un motivo libre
 * ("otros", "varios") no se puede medir ni modificar. Cada entrada lleva la
 * consequence sobre el SLA, porque no todos los motivos valen lo mismo.
 *
 * `severityFloor` es la severidad MINIMA que puede tener el ticket al llegar a
 * la mesa humana. Si la severidad real es menor, se sube: una escalacion
 * academica no puede haber perdido prioridad por el camino.
 */
export const ESCALATION_REASONS = Object.freeze({
  ambiguous_classification: {
    es: "No se ha podido clasificar con confianza suficiente.",
    en: "Could not classify the report with enough confidence.",
    severityFloor: "S2",
    group: "triage",
    ackMinutes: 30,
  },
  company_wide_impact: {
    es: "Afecta a toda la empresa.",
    en: "Company-wide impact.",
    severityFloor: "S1",
    group: "incident",
    ackMinutes: 15,
  },
  out_of_scope: {
    es: "Peticion fuera del alcance de soporte interno.",
    en: "Request out of internal support scope.",
    severityFloor: "S3",
    group: "triage",
    ackMinutes: 240,
  },
  insufficient_authority: {
    es: "La accion requerida excede la autoridad del agente.",
    en: "The required action exceeds the agent's authority.",
    severityFloor: "S2",
    group: "operations",
    ackMinutes: 30,
  },
  missing_diagnosis: {
    es: "El diagnostico automatico no ha concluido.",
    en: "Automatic diagnostics did not conclude.",
    severityFloor: "S2",
    group: "operations",
    ackMinutes: 60,
  },
  destructive_action: {
    es: "La unica via disponible es una accion destructiva.",
    en: "The only available path is a destructive action.",
    severityFloor: "S2",
    group: "operations",
    ackMinutes: 30,
  },
  handoff_limit_reached: {
    es: "Se ha alcanzado el tope de traspasos entre agentes.",
    en: "The inter-agent handoff limit was reached.",
    severityFloor: "S2",
    group: "operations",
    ackMinutes: 60,
  },
  repeated_remediation_failed: {
    es: "La remediacion se ha intentado y ha fallado mas de una vez.",
    en: "Remediation was attempted and failed more than once.",
    severityFloor: "S2",
    group: "operations",
    ackMinutes: 45,
  },
  security_concern: {
    es: "Posible condicion de seguridad.",
    en: "Possible security condition.",
    severityFloor: "S1",
    group: "security",
    ackMinutes: 15,
  },
  data_loss_risk: {
    es: "Riesgo de perdida de datos.",
    en: "Risk of data loss.",
    severityFloor: "S1",
    group: "operations",
    ackMinutes: 15,
  },
});

/** Motivos que deben arrastrar el ticket a S1 aunque la severidad real sea menor. */
const S1_REASONS = ["company_wide_impact", "security_concern", "data_loss_risk"];

/**
 * Palabras que delatan un motivo de escalado en el texto del usuario.
 *
 * Los terminos tienen que ser **inequivocos**. La version anterior incluia
 * "casa" para detectar una peticion fuera de alcance, y eso reventaba en el caso
 * mas frecuente de soporte remoto: "no me conecto a la VPN desde casa" salia
 * clasificado como fuera de alcance. Un detector demasiado sensible no es
 * prudente, es un generador de falsos positivos, y aqui el coste de equivocarse
 * es derivar un ticket de trabajo real a la cola equivocada.
 */
const REASON_SIGNALS = [
  { reason: "security_concern", terms: ["suplantacion", "phishing", "hackeado", "virus", "ransomware", "acceso no autorizado", "fuga de datos", "impersonation", "unauthorized access", "malware"] },
  { reason: "data_loss_risk", terms: ["he perdido", "han borrado", "se ha borrado", "no encuentro el archivo", "documentos perdidos", "disco lleno", "data loss", "files deleted", "se me ha borrado"] },
  { reason: "company_wide_impact", terms: ["toda la empresa", "todos los usuarios", "todo el mundo", "toda la oficina", "company wide", "whole office", "todos tenemos", "medio mundo"] },
  { reason: "out_of_scope", terms: ["portatil personal", "equipo personal", "telefono personal", "coche", "en mi vehiculo", "personal laptop", "personal device", "my own laptop", "en mi casa"] },
];

/** Numeros de severidad para comparar. */
const SEVERITY_ORDER = { S1: 1, S2: 2, S3: 3, S4: 4 };

/**
 * Construye el bloque `escalation` del ticket y el parche listo para aplicar.
 *
 * @param {object} args
 * @param {object} args.ticket
 * @param {string} args.reason    Clave de `ESCALATION_REASONS`.
 * @param {string} [args.detail]  Como lo cuenta quien escala.
 * @param {string} [args.requestedBy] Quien lo pide (agente u operador).
 * @param {Date}   [args.now]
 * @param {boolean}[args.force]  Escalar sin comprobar si el motivo es legitimo.
 * @returns {{escalation: object, patch: object, shouldEscalate: boolean, severity: string}}
 */
export function escalate({ ticket, reason, detail, requestedBy = "agent", now = new Date(), force = false }) {
  const spec = ESCALATION_REASONS[reason];
  if (!spec) {
    throw new ValidationError("ESCALATION_REASON_UNKNOWN", `Motivo de escalado desconocido: ${reason}`, {
      allowed: Object.keys(ESCALATION_REASONS),
    });
  }

  // Un escalado nunca baja la severidad. Si la severidad actual es mas suave que
  // el suelo del motivo, manda el motivo: quien escala lo ha visto de cerca.
  const severity = escalateSeverity(ticket.severity, spec.severityFloor);
  const acknowledgedBy = null;
  const id = newReference("ESC", 6);

  // `force` salta la COMPROBACION del motivo (que lo hace el cliente al decidir si
  // escalar), nunca el suelo de severidad. Con `ticket.severity` aqui, un S4
  // escalado por "perdida de datos" se habría registrado como S4, que es
  // exactamente la contradiccion que el suelo existe para impedir: la mesa
  // humana recibiria el caso con la severidad del motivo, no con la de quien lo
  // escribio a mano.
  const escalation = {
    id,
    reason,
    reasonText: spec.es,
    group: spec.group,
    severityFloor: spec.severityFloor,
    severity,
    forced: force,
    target: "escalation-desk",
    /** Ventana de aceptacion: hasta cuando debe aparecer una persona. */
    ackDueBy: new Date(now.getTime() + spec.ackMinutes * 60_000).toISOString(),
    ackMinutes: spec.ackMinutes,
    detail: detail ?? defaultDetail(reason, spec, ticket),
    requestedBy,
    escalatedAt: now.toISOString(),
    acknowledgedBy,
    acknowledgedAt: null,
    /** Que necesita de la mesa humana para poder seguir. */
    needed: neededFor(ticket, reason),
  };

  return {
    escalation,
    patch: { escalation, severity: escalation.severity },
    shouldEscalate: true,
    severity: escalation.severity,
  };
}

/**
 * Severidad efectiva tras escalar: la mas grave de las dos.
 *
 * OJO con la comparacion: un numero MENOR es mas grave (S1 es critica, S4 es
 * baja). El error facil aqui es invertir el comparador y acabar bajando la
 * prioridad de un S1 a S2 al escalarlo, que es justo lo contrario de lo que
 * quiere el mecanismo.
 */
export function escalateSeverity(current, floor) {
  const a = SEVERITY_ORDER[current];
  const b = SEVERITY_ORDER[floor];
  if (!b) return current;
  if (!a) return floor;
  return a <= b ? current : floor;
}

/**
 * Si el texto del ticket apunta a un motivo de escalado.
 *
 * Va mas alla del triaje: hay motivos que solo se ven en el TEXTO ("me han
 * borrado archivos"), no en la categoria. Un detector de senales evita que un
 * ticket con perdida de datos se resuelva con un reinicio de equipo.
 *
 * @returns {string[]}
 */
export function detectEscalationSignals(ticket) {
  const text = String(ticket?.request?.text ?? "");
  const found = new Set();
  for (const { reason, terms } of REASON_SIGNALS) {
    for (const term of terms) {
      if (text.toLowerCase().includes(term)) {
        found.add(reason);
        break;
      }
    }
  }
  return [...found];
}

/**
 * Elige el motivo de escalado que corresponde a una decision de triaje.
 *
 * @param {object} args
 * @param {object} args.ticket
 * @param {string} args.reason  Motivo vindo de la decision (snake_case o camelCase).
 * @returns {string} clave de `ESCALATION_REASONS`
 */
export function reasonFromDecision({ ticket, reason }) {
  const camel = snakeToCamel(reason);
  if (ESCALATION_REASONS[camel]) return camel;

  // Se comparan en ambos sentidos: el llamante puede pasar `missing_diagnosis`
  // (clave del catalogo) o `sin_diagnostico` (nombre de la condicion del
  // traspaso). Aceptar los dos evita la traduccion embarrassing en el sitio de
  // la llamada.
  const snake = camelToSnake(camel);
  if (ESCALATION_REASONS[snake]) return snake;

  const signals = detectEscalationSignals(ticket);
  if (signals.length > 0) {
    // Una senal de texto gana a la condicion que llego: "se han borrado
    // archivos" es mas urgente que la razon por la que se escalo.
    return signals.sort(
      (a, b) => SEVERITY_ORDER[ESCALATION_REASONS[a].severityFloor] - SEVERITY_ORDER[ESCALATION_REASONS[b].severityFloor],
    )[0];
  }

  switch (camel) {
    case "clasificacionAmbigua":
    case "ambigua":
    case "confianzaInsuficiente":
      return "ambiguous_classification";
    case "alcanceEmpresarial":
      return "company_wide_impact";
    case "fueraDeAlcance":
      return "out_of_scope";
    case "sinDiagnostico":
    case "sin_diagnostico":
      return "missing_diagnosis";
    case "faltanDatos":
    case "missingInformation":
    case "sinPermiso":
    case "noPermission":
    case "sinRecurso":
    case "aprobacionPendiente":
      return "insufficient_authority";
    case "riesgoDestructivo":
    case "destructiveRisk":
      return "destructive_action";
    default:
      return "insufficient_authority";
  }
}

function camelToSnake(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Lo que la mesa humana tiene que aportar para desbloquear el ticket.
 * Se calcula del estado real, no de una frase generica.
 */
function neededFor(ticket, reason) {
  const needed = [];
  const missing = ticket?.entities?.missingRequired ?? [];
  for (const key of missing) needed.push(ENTITY_LABEL_ES[key] ?? key);

  if (ticket?.diagnosis && ticket.diagnosis.insufficient) {
    const gaps = ticket.diagnosis.missing ?? ticket.diagnosis.missingData ?? [];
    if (gaps.length) needed.push(`datos de diagnostico: ${gaps.join(", ")}`);
  }
  if (reason === "repeated_remediation_failed") needed.push("causa de raiz del fallo");
  if (reason === "out_of_scope") needed.push("destino alternativo (proveedor o responsable)");
  if (ticket?.request?.userOfferedCredentials) needed.push("rotacion de credenciales expuestas");
  if (needed.length === 0) needed.push("confirmacion de la decision a tomar");
  return needed;
}

const ENTITY_LABEL_ES = {
  affectedUser: "usuario afectado",
  impactedService: "servicio afectado",
  targetResource: "recurso objetivo",
  asset: "activo",
  location: "ubicacion",
  impactScope: "alcance de impacto",
  businessCriticality: "criticidad del negocio",
  workaroundAvailable: "si existe alternativa",
};

function defaultDetail(reason, spec, ticket) {
  if (reason === "ambiguous_classification") {
    const alts = ticket?.classification?.alternatives ?? [];
    return `Clasificacion no concluyente (confianza ${ticket?.confidence ?? "?"}). Alternativas: ${
      alts.map((a) => a.category).join(", ") || "ninguna"
    }.`;
  }
  if (reason === "company_wide_impact") {
    return "Alcance declarado de empresa: se trata como incidente.";
  }
  if (reason === "handoff_limit_reached") {
    return `Se agotaron los ${MAX_HANDOFFS} traspasos permitidos entre agentes sin cerrar el caso.`;
  }
  return spec.es;
}

function snakeToCamel(value) {
  return String(value).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * La mesa humana acepta el escalado.
 *
 * Sin esto, `resolvabilityErrors` bloquea la resolucion para siempre: el ticket
 * queda atrapado en `escalated` aunque la persona ya lo haya cogido. Por eso la
 * aceptacion deja CONSTANCIA (quien, cuando, que ha asumido), y por eso exige
 * un `operator` explicito: un agente no puede_acceptarse a si mismo.
 *
 * @param {object} args
 * @param {object} args.ticket
 * @param {string} args.operator  Identificador humano.
 * @param {string} [args.note]
 * @param {Date}   [args.now]
 * @returns {{escalation: object, patch: object}}
 * @throws {ValidationError}
 */
export function acknowledge({ ticket, operator, note, now = new Date() }) {
  if (!operator || String(operator).trim().length < 2) {
    throw new ValidationError("ESCALATION_OPERATOR_REQUIRED", "Hace falta quien acepta el escalado.");
  }
  // Un escalado existe precisamente para que lo atienda una persona. Si un
  // agente pudiera aceptarlo, `acknowledgedBy` dejaria de ser la prueba de que
  // alguien lo ha cogido, y la compuerta `TRANSITION_NOT_ACKNOWLEDGED` no
  // significaria nada.
  if (agentById(String(operator).trim())) {
    throw new ValidationError(
      "ESCALATION_ACKNOWLEDGED_BY_AGENT",
      "Un agente no puede aceptar un escalado: hace falta una persona.",
      { operator },
    );
  }
  if (!ticket.escalation) {
    throw new ValidationError("ESCALATION_MISSING", "El ticket no esta escalado.");
  }
  if (ticket.escalation.acknowledgedBy) {
    throw new ValidationError("ESCALATION_ALREADY_ACKNOWLEDGED", "El escalado ya fue aceptado.", {
      acknowledgedBy: ticket.escalation.acknowledgedBy,
      acknowledgedAt: ticket.escalation.acknowledgedAt,
    });
  }

  const escalation = {
    ...ticket.escalation,
    acknowledgedBy: String(operator).trim(),
    acknowledgedAt: now.toISOString(),
    acknowledgmentNote: note ?? null,
  };

  return { escalation, patch: { escalation } };
}

/** Indica si el escalado vencio su ventana de aceptacion. */
export function isAckOverdue(ticket, now = new Date()) {
  const esc = ticket?.escalation;
  if (!esc || esc.acknowledgedBy || !esc.ackDueBy) return false;
  return now.getTime() > Date.parse(esc.ackDueBy);
}

export { TYPOLOGIES };
