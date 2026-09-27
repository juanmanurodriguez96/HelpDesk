/**
 * Entidad Ticket.
 *
 * El ticket es un objeto inmutable por convencion: las funciones de dominio
 * devuelven una copia nueva en lugar de mutar la recibida. Asi una transicion
 * invalida nunca deja el ticket a medias, y la bitacora puede guardar el estado
 * anterior y el nuevo sin aliasing.
 *
 * REGLA DE PRIVACIDAD: `request.text` SIEMPRE contiene texto ya saneado. El
 * original no se guarda en ninguna parte. Quien llama a `createTicket` es
 * responsable de pasar el texto por `redact()`; la asercion de abajo lo verifica.
 */

import { ValidationError, PolicyError } from "../core/errors.js";
import { newTicketId } from "../core/ids.js";
import { redact, containsSecret, offersCredentials } from "../privacy/pii.js";
import { deepClone } from "../core/canonical-json.js";
import { firstWords } from "../core/text.js";

/** Estados del ciclo de vida. Los valores son parte del contrato publico. */
export const STATUS = Object.freeze({
  NEW: "new",
  TRIAGED: "triaged",
  DIAGNOSING: "diagnosing",
  IN_PROGRESS: "in_progress",
  WAITING_USER: "waiting_user",
  ESCALATED: "escalated",
  RESOLVED: "resolved",
  CLOSED: "closed",
  CANCELLED: "cancelled",
});

/** Actores que pueden ejecutar una transicion. */
export const ACTOR = Object.freeze({
  AGENT: "agent",
  SYSTEM: "system",
  OPERATOR: "operator",
});

/** Canales de entrada admitidos. */
export const CHANNELS = Object.freeze(["email", "chat", "telefono", "portal", "walkin"]);

/** Idiomas de la respuesta al usuario. */
export const LANGS = Object.freeze(["es", "en"]);

/**
 * @typedef {object} TicketInput
 * @property {string}  text        Texto del usuario final, YA REDACTADO.
 * @property {string}  reporter    Identificador corporativo de quien reporta.
 * @property {string} [channel]
 * @property {string} [lang]
 * @property {object} [meta]
 */

/**
 * Crea un ticket nuevo. No valida el contenido: solo la forma minima y la
 * invariante de privacidad.
 *
 * @param {TicketInput & {now: Date, id?: string}} args
 */
export function createTicket({
  text,
  reporter,
  channel = "email",
  lang = "es",
  meta = {},
  now,
  id,
  signals = {},
}) {
  if (typeof text !== "string" || text.trim().length < 5) {
    throw new ValidationError("TICKET_TEXT_TOO_SHORT", "El texto de la incidencia es demasiado corto.", {
      minLength: 5,
    });
  }
  if (!reporter || String(reporter).trim().length < 2) {
    throw new ValidationError("TICKET_REPORTER_REQUIRED", "Falta el identificador de quien reporta la incidencia.");
  }
  if (!CHANNELS.includes(channel)) {
    throw new ValidationError("TICKET_CHANNEL_INVALID", `Canal no admitido: ${channel}`, {
      allowed: CHANNELS,
    });
  }
  if (!LANGS.includes(lang)) {
    throw new ValidationError("TICKET_LANG_INVALID", `Idioma no admitido: ${lang}`, { allowed: LANGS });
  }

  const timestamp = now.toISOString();

  return {
    id: id ?? newTicketId(),
    status: STATUS.NEW,
    createdAt: timestamp,
    updatedAt: timestamp,

    // --- Entrada --------------------------------------------------------
    request: {
      text,
      subject: deriveSubject(text),
      // Se conserva la EVIDENCIA de que hubo que sanear, nunca el material saneado.
      //
      // Estas dos banderas deben observarse sobre el texto ORIGINAL, antes de
      // redactear. Si se calcularan aqui sobre `text` ya estarian siempre en
      // `false`, porque el unico rastro de un secreto es precisamente que ya no
      // esta: el aviso de seguridad al usuario dependeria de esta senal.
      containedSecret: signals.containedSecret ?? containsSecret(text),
      userOfferedCredentials: signals.credentialsOffered ?? offersCredentials(text),
      redaction: { applied: true, findings: signals.findings ?? [] },
    },

    reporter: { id: String(reporter).trim() },

    // --- Clasificacion (la rellena el triaje) ---------------------------
    category: null,
    typology: null,
    severity: null,
    priority: null,
    confidence: null,
    classification: null,

    // --- Entidades ------------------------------------------------------
    entities: {
      affectedUser: null,
      impactedService: null,
      targetResource: null,
      asset: null,
      location: null,
      impactScope: null,
      businessCriticality: null,
      workaroundAvailable: null,
      missingRequired: [],
    },

    // --- Trabajo --------------------------------------------------------
    diagnosis: null,
    remediation: { attempted: [], applied: [], skipped: [] },
    resolution: null,
    escalation: null,
    pendingQuestions: [],

    // --- Control --------------------------------------------------------
    sla: null,
    /** Salto actual del agente. Un handoff lo cambia; volver al origen es un ciclo. */
    assignedAgent: null,
    /** Numero de traspasos realizados. Tope duro contra bucles de delegacion. */
    handoffs: { count: 0, trail: [] },
    history: [
      {
        at: timestamp,
        from: null,
        to: STATUS.NEW,
        actor: ACTOR.SYSTEM,
        rationale: "Incidencia registrada en el canal de entrada",
      },
    ],
    meta,
  };
}

/**
 * Titular legible a partir del texto. Se toma de las primeras palabras tras
 *normalizar; no se usa como clasificacion.
 */
function deriveSubject(text) {
  const first = String(text).split(/[.\n]/)[0] ?? "";
  return firstWords(first, 10) || "Incidencia sin titulo";
}

/** Copia profunda. Util para guardar snapshots sin aliasing. */
export function cloneTicket(ticket) {
  return deepClone(ticket);
}

/**
 * Verifica la invariante de privacidad antes de persistir.
 *
 * @param {object} ticket
 * @throws {PolicyError} `PII_IN_TICKET`
 */
export function assertPrivacyInvariant(ticket) {
  const problems = [];
  const fields = [
    ["request.text", ticket.request?.text],
    ["resolution.summary", ticket.resolution?.summary],
    ["diagnosis.findings[].detail", collectStrings(ticket.diagnosis?.findings?.map((f) => f.detail))],
  ];
  for (const [field, value] of fields) {
    if (value && containsSecret(value)) {
      problems.push(field);
    }
  }
  if (problems.length > 0) {
    throw new PolicyError("PII_IN_TICKET", "El ticket contiene material sensible en texto plano.", {
      fields: problems,
    });
  }
  return ticket;
}

function collectStrings(values) {
  return (values ?? []).filter(Boolean).join(" \n ");
}

/** Reexportado para que los comandos de intake no tengan que importar la privacy. */
export { redact };
