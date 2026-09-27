/**
 * Maquina de estados del ciclo de vida del ticket.
 *
 * Es la pieza que da sentido a las "instrucciones personalizadas" del pliego: la
 * tabla de transiciones de aqui es la MISMA que documenta `AGENTS.md`, y las dos
 * se validan entre si con `npm run validate`. Un agente no puede inventar una
 * transicion: si no esta en la tabla, la peticion falla con un codigo estable.
 *
 * Cada transicion declara:
 *  - `requires`: campos que deben existir en el parche o ya estar en el ticket;
 *  - `actors`: quien puede ejecutarla (un agente nunca cierra un ticket);
 *  - `guard`: predicado adicional que puede mirar el ticket entero.
 *
 * El diseno es deliberadamente DURO. Un ticket no se puede marcar resuelto si
 * faltan las entidades obligatorias de su categoria, ni cerrar sin confirmacion
 * del usuario. La preferencia es siempre pedir informacion (`waiting_user`) antes
 * que adivinar.
 */

import { TransitionError, ValidationError } from "../core/errors.js";
import { STATUS, ACTOR, cloneTicket, assertPrivacyInvariant } from "./ticket.js";
import { categoryById } from "../knowledge/taxonomy.js";
import { evaluateSla, pauseSla, resumeSla, markResolved, computeSla } from "./sla.js";
import { assertSafeQuestion } from "../privacy/pii.js";
import { deepClone } from "../core/canonical-json.js";

/** Estados en los que el ticket sigue abierto. */
export const OPEN_STATUSES = Object.freeze([
  STATUS.NEW,
  STATUS.TRIAGED,
  STATUS.DIAGNOSING,
  STATUS.IN_PROGRESS,
  STATUS.WAITING_USER,
  STATUS.ESCALATED,
]);

export const TERMINAL_STATUSES = Object.freeze([STATUS.CLOSED, STATUS.CANCELLED]);

/** Estados que son de lectura para el usuario: ya no requieren accion del agente. */
export const DONE_STATUSES = Object.freeze([STATUS.RESOLVED, ...TERMINAL_STATUSES]);

/** Tope de traspasos. Un ticket que lo alcanza se escala a la mesa humana. */
export const MAX_HANDOFFS = 3;

/**
 * @typedef {object} Transition
 * @property {string}   from
 * @property {string}   to
 * @property {string[]} [requires]  Campos que deben llegar en `patch` o ya existir.
 * @property {string[]} [actors]    Actores autorizados. Por defecto, cualquiera.
 * @property {(ticket: object) => string[]} [guard]  Motivos de rechazo.
 */

/** @type {Transition[]} */
export const TRANSITIONS = [
  // --- Clasificacion ----------------------------------------------------
  {
    from: STATUS.NEW,
    to: STATUS.TRIAGED,
    requires: ["category", "severity", "priority", "confidence"],
    guard: (t) => {
      const errors = [];
      if (t.category === "unclassified") {
        errors.push(
          "TRANSITION_UNCLASSIFIED",
        );
      }
      if (typeof t.confidence === "number" && t.confidence < 0.4) {
        errors.push("TRANSITION_LOW_CONFIDENCE");
      }
      return errors;
    },
  },
  {
    from: STATUS.TRIAGED,
    to: STATUS.DIAGNOSING,
    requires: ["category"],
  },

  // --- Trabajo ----------------------------------------------------------
  {
    from: STATUS.TRIAGED,
    to: STATUS.IN_PROGRESS,
  },
  {
    from: STATUS.DIAGNOSING,
    to: STATUS.IN_PROGRESS,
    requires: ["diagnosis"],
  },
  {
    from: STATUS.IN_PROGRESS,
    to: STATUS.DIAGNOSING,
  },

  // --- Espera al usuario ------------------------------------------------
  //
  // Preguntar al usuario se permite desde `triaged` y no solo desde
  // `in_progress`. El caso real es el mas comun de todos: la incidencia llega
  // clasificada pero sin el dato que hace falta para diagnosticarla, y quedarse
  // sin transicion obligaba a abrirla "en trabajo" solo para poder preguntar, o
  // peor, a avanzarla con un dato inventado. Esperar al usuario es una decision
  // prudente, no un estado de trabajo.
  {
    from: STATUS.TRIAGED,
    to: STATUS.WAITING_USER,
    requires: ["category"],
    guard: hasQuestionsGuard,
  },
  {
    from: STATUS.IN_PROGRESS,
    to: STATUS.WAITING_USER,
    requires: ["questions"],
    guard: hasQuestionsGuard,
  },
  {
    from: STATUS.WAITING_USER,
    to: STATUS.IN_PROGRESS,
  },
  {
    from: STATUS.WAITING_USER,
    to: STATUS.RESOLVED,
    requires: ["resolution"],
  },

  // --- Escalado ---------------------------------------------------------
  {
    from: STATUS.TRIAGED,
    to: STATUS.ESCALATED,
    requires: ["escalation"],
  },
  {
    from: STATUS.DIAGNOSING,
    to: STATUS.ESCALATED,
    requires: ["escalation"],
  },
  {
    from: STATUS.IN_PROGRESS,
    to: STATUS.ESCALATED,
    requires: ["escalation"],
  },
  {
    from: STATUS.WAITING_USER,
    to: STATUS.ESCALATED,
    requires: ["escalation"],
  },
  {
    from: STATUS.ESCALATED,
    to: STATUS.IN_PROGRESS,
  },

  // --- Resolucion -------------------------------------------------------
  {
    from: STATUS.IN_PROGRESS,
    to: STATUS.RESOLVED,
    requires: ["resolution"],
    guard: resolvabilityErrors,
  },
  {
    from: STATUS.DIAGNOSING,
    to: STATUS.RESOLVED,
    requires: ["resolution", "diagnosis"],
    guard: resolvabilityErrors,
  },
  {
    from: STATUS.TRIAGED,
    to: STATUS.RESOLVED,
    requires: ["resolution"],
    guard: resolvabilityErrors,
  },

  // --- Cierre -----------------------------------------------------------
  {
    from: STATUS.RESOLVED,
    to: STATUS.IN_PROGRESS,
    requires: ["reopenReason"],
    guard: (t) => (t.pendingQuestions?.length ? ["TRANSITION_OPEN_QUESTIONS"] : []),
  },
  {
    from: STATUS.RESOLVED,
    to: STATUS.CLOSED,
    actors: [ACTOR.OPERATOR],
    requires: ["closure"],
    guard: (t) => {
      const errors = [];
      if (!t.sla?.resolvedAt) errors.push("TRANSITION_SLA_NOT_STOPPED");
      if (t.pendingQuestions?.length) errors.push("TRANSITION_OPEN_QUESTIONS");
      return errors;
    },
  },

  // -- Cancelacion (siempre manual) ---------------------------------------
  { from: STATUS.NEW, to: STATUS.CANCELLED, actors: [ACTOR.OPERATOR], requires: ["cancelReason"] },
  {
    from: STATUS.TRIAGED,
    to: STATUS.CANCELLED,
    actors: [ACTOR.OPERATOR],
    requires: ["cancelReason"],
  },
];

/**
 * Guard compartido por las transiciones que dejan el ticket esperando al
 * usuario. Vive fuera de la tabla para que las dos rutas (desde `triaged` y
 * desde `in_progress`) apliquen exactamente las mismas reglas: sin preguntas no
 * se espera a nadie, y ninguna pregunta puede pedir una credencial.
 */
function hasQuestionsGuard(ticket) {
  const errors = [];
  const questions = ticket.pendingQuestions ?? [];
  if (questions.length === 0) errors.push("TRANSITION_NO_QUESTION");
  for (const question of questions) {
    try {
      assertSafeQuestion(question);
    } catch (error) {
      // Pedir una credencial es un fallo del agente, no una duda legitima. Se
      // rechaza la transicion entera: el ticket no entra en espera, de modo que
      // no pueda quedarse "esperando" una respuesta que nunca debe llegar.
      errors.push(`TRANSITION_QUESTION_REJECTED:${error.code}`);
    }
  }
  return errors;
}

/**
 * Un caso no se puede declarar resuelto si le faltan las entidades obligatorias
 * de su categoria, o si hay preguntas al usuario sin respuesta.
 */
function resolvabilityErrors(ticket) {
  const errors = [];
  const category = categoryById(ticket.category);
  const missing = missingRequiredEntities(ticket);
  if (category && category.requiredEntities.length > 0 && missing.length > 0) {
    errors.push("TRANSITION_MISSING_ENTITIES");
  }
  if (ticket.pendingQuestions?.length > 0) {
    errors.push("TRANSITION_OPEN_QUESTIONS");
  }
  if (ticket.escalation && !ticket.escalation.acknowledgedBy) {
    errors.push("TRANSITION_NOT_ACKNOWLEDGED");
  }
  return errors;
}

/**
 * Entidades obligatorias de la categoria del ticket que siguen sin rellenar.
 * Es la fuente de verdad que usan por igual la maquina de estados, la
 * auto-remediacion y el generador de respuestas.
 *
 * @param {object} ticket
 * @returns {string[]}
 */
export function missingRequiredEntities(ticket) {
  const category = categoryById(ticket.category);
  if (!category) return [];
  return category.requiredEntities.filter((key) => {
    const value = ticket.entities?.[key];
    return value === null || value === undefined || value === "";
  });
}

/**
 * Comprueba si una transicion esta permitida sin aplicarla.
 *
 * @param {object} ticket
 * @param {string} to
 * @param {object} [patch]
 * @param {string} [actor]
 * @returns {{allowed: boolean, reasons: string[], transition: Transition|null}}
 */
export function canTransition(ticket, to, patch = {}, actor = ACTOR.AGENT) {
  const transition = TRANSITIONS.find((t) => t.from === ticket.status && t.to === to);
  if (!transition) {
    const allowedFrom = TRANSITIONS.filter((t) => t.from === ticket.status).map((t) => t.to);
    return {
      allowed: false,
      reasons: allowedFrom.length
        ? ["TRANSITION_NOT_ALLOWED"]
        : ["TRANSITION_TERMINAL_STATE"],
      transition: null,
      allowedFrom,
    };
  }

  const reasons = [];
  if (transition.actors && !transition.actors.includes(actor)) {
    reasons.push("TRANSITION_ACTOR_NOT_ALLOWED");
  }

  for (const field of transition.requires ?? []) {
    if (!hasField(patch, field) && !hasField(ticket, field)) {
      reasons.push(`TRANSITION_MISSING_FIELD:${field}`);
    }
  }

  if (transition.guard) {
    // El guard ve el ticket ya fusionado con el parche: las reglas se evaluan
    // sobre el estado que resultaria de la transicion, no sobre el actual.
    //
    // La fusion es la MISMA que hara `applyTransition`, y no un `{...a, ...b}`:
    // `questions` no es un campo del ticket, es la puerta de entrada de
    // `pendingQuestions`. Con una fusion ingenua el guard veria `questions` y
    // leeria `pendingQuestions` vacio, y rechazaria siempre la espera al
    // usuario por "no hay preguntas" precisamente cuando las trae.
    const projected = cloneTicket(ticket);
    mergePatch(projected, patch);
    reasons.push(...transition.guard(projected));
  }

  return { allowed: reasons.length === 0, reasons, transition };
}

/** Resuelve rutas con punto (`questions`, `resolution.summary`) en un objeto. */
function hasField(source, path) {
  const value = getPath(source, path);
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function getPath(source, path) {
  return String(path)
    .split(".")
    .reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), source);
}

/**
 * Aplica una transicion y devuelve un ticket NUEVO.
 *
 * @param {object} ticket
 * @param {object} command
 * @param {string} command.to        Estado destino.
 * @param {object} [command.patch]   Campos a fusionar (ya validados por el llamante).
 * @param {string} [command.actor]
 * @param {string} [command.rationale]  Justificacion; queda en la bitacora.
 * @param {Date}   [command.now]
 * @param {object} [command.slaCalendar]
 * @returns {object} ticket actualizado
 * @throws {TransitionError}
 */
export function applyTransition(ticket, { to, patch = {}, actor = ACTOR.AGENT, rationale = "", now, slaCalendar }) {
  if (!Object.values(STATUS).includes(to)) {
    throw new ValidationError("TRANSITION_UNKNOWN_STATUS", `Estado desconocido: ${to}`, { to });
  }
  if (!now) {
    throw new ValidationError("TRANSITION_NOW_REQUIRED", "Una transicion necesita un instante de referencia.");
  }
  if (![...Object.values(ACTOR)].includes(actor)) {
    throw new ValidationError("TRANSITION_ACTOR_INVALID", `Actor desconocido: ${actor}`, { actor });
  }

  const check = canTransition(ticket, to, patch, actor);
  if (!check.allowed) {
    throw new TransitionError(
      check.reasons[0] ?? "TRANSITION_NOT_ALLOWED",
      describeRejection(check, ticket, to, actor),
      {
        from: ticket.status,
        to,
        actor,
        reasons: check.reasons,
        allowedFrom: check.allowedFrom ?? null,
      },
    );
  }

  const next = cloneTicket(ticket);
  mergePatch(next, patch);
  const timestamp = now.toISOString();

  const from = next.status;
  next.status = to;
  next.updatedAt = timestamp;

  applySideEffects(next, from, to, now, patch, slaCalendar);

  next.history.push({
    at: timestamp,
    from,
    to,
    actor,
    rationale: rationale || defaultRationale(from, to),
  });

  assertPrivacyInvariant(next);
  return next;
}

/**
 * Efectos colaterales de una transicion. Aqui es donde el SLA, las preguntas
 * pendientes y la cola se mantienen coherentes; mantenerlo en un unico sitio
 * evita que cada comando de la CLI invente su propia version.
 */
function applySideEffects(ticket, from, to, now, patch, slaCalendar) {
  switch (to) {
    case STATUS.TRIAGED: {
      if (!ticket.sla) {
        ticket.sla = computeSla({
          from: now,
          severity: ticket.severity,
          calendar: slaCalendar ?? ticket.sla?.calendar,
        });
      }
      // Las entidades obligatorias ausentes se congelan en el ticket: son la
      // lista de lo que hay que pedir al usuario.
      ticket.entities.missingRequired = missingRequiredEntities(ticket);
      break;
    }

    case STATUS.WAITING_USER: {
      ticket.pendingQuestions = patch.questions ?? ticket.pendingQuestions;
      if (ticket.sla) ticket.sla = pauseSla(ticket.sla, now);
      break;
    }

    case STATUS.RESOLVED: {
      if (ticket.sla) ticket.sla = markResolved(resumeSlaIfPaused(ticket.sla, now), now);
      ticket.pendingQuestions = [];
      break;
    }

    case STATUS.IN_PROGRESS: {
      if (from === STATUS.WAITING_USER && ticket.sla) {
        ticket.sla = resumeSla(ticket.sla, now, ticket.sla.calendar);
      }
      if (from === STATUS.RESOLVED) {
        // Reapertura: se borra el sello de resolucion y el SLA vuelve a correr.
        if (ticket.sla) {
          ticket.sla = { ...ticket.sla, resolvedAt: null };
        }
        ticket.reopenReason = patch.reopenReason ?? null;
      }
      break;
    }

    case STATUS.CLOSED: {
      ticket.closure = patch.closure ?? ticket.closure;
      break;
    }

    case STATUS.CANCELLED: {
      ticket.cancelReason = patch.cancelReason ?? null;
      break;
    }

    default:
      break;
  }
}

function resumeSlaIfPaused(sla, now) {
  return sla.pausedAt ? resumeSla(sla, now, sla.calendar) : sla;
}

/** Fusiona un parche respetando rutas con punto. */
function mergePatch(target, patch) {
  for (const [path, value] of Object.entries(patch)) {
    if (path === "questions") {
      target.pendingQuestions = value;
      continue;
    }
    if (path === "reopenReason" || path === "cancelReason" || path === "closure") {
      target[path] = value;
      continue;
    }
    setPath(target, path, deepClone(value));
  }
}

function setPath(target, path, value) {
  const keys = path.split(".");
  let node = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof node[keys[i]] !== "object" || node[keys[i]] === null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

/** Mensajes legibles para el operador, con la siguiente transicion posible. */
const REASON_TEXT = {
  TRANSITION_NOT_ALLOWED: "transicion no permitida desde el estado actual",
  TRANSITION_TERMINAL_STATE: "el ticket ya esta en un estado terminal",
  TRANSITION_ACTOR_NOT_ALLOWED: "el actor no puede ejecutar esta transicion",
  TRANSITION_MISSING_ENTITIES: "faltan entidades obligatorias de la categoria",
  TRANSITION_OPEN_QUESTIONS: "hay preguntas al usuario sin responder",
  TRANSITION_NOT_ACKNOWLEDGED: "el escalado aun no ha sido aceptado por la mesa humana",
  TRANSITION_SLA_NOT_STOPPED: "el SLA no esta detenido: falta marcar la resolucion",
  TRANSITION_NO_QUESTION: "no hay ninguna pregunta que hacer al usuario",
  TRANSITION_UNCLASSIFIED: "la incidencia no se ha podido clasificar",
  TRANSITION_LOW_CONFIDENCE: "la confianza de la clasificacion es insuficiente",
};

function describeRejection(check, ticket, to, actor) {
  const base = REASON_TEXT[check.reasons[0]] ?? check.reasons[0];
  const fields = check.reasons
    .filter((r) => r.startsWith("TRANSITION_MISSING_FIELD:"))
    .map((r) => r.split(":")[1]);
  const extras = [];
  if (fields.length) extras.push(`campos ausentes: ${fields.join(", ")}`);
  if (check.allowedFrom?.length) extras.push(`desde "${ticket.status}" solo se permite: ${check.allowedFrom.join(", ")}`);
  if (check.reasons.includes("TRANSITION_ACTOR_NOT_ALLOWED")) {
    extras.push(`el actor "${actor}" no tiene permiso para "${to}"`);
  }
  return [base, ...extras].join(". ");
}

function defaultRationale(from, to) {
  return `${from} -> ${to}`;
}

/**
 * Estado del SLA del ticket en un instante dado, listo para el comando `sla`.
 */
export function slaSnapshot(ticket, now) {
  return evaluateSla(ticket, now);
}

/**
 * Comprobacion de invariantes del propio ticket. Se ejecuta al leer de disco,
 * no solo al escribir: un fichero corrupto debe detectarse al cargarse.
 *
 * @returns {string[]} problemas encontrados (vacio = correcto)
 */
export function validateTicket(ticket) {
  const problems = [];
  if (!ticket.id) problems.push("Falta id");
  if (!Object.values(STATUS).includes(ticket.status)) problems.push(`Estado invalido: ${ticket.status}`);
  if (!ticket.createdAt) problems.push("Falta createdAt");
  if (!Array.isArray(ticket.history) || ticket.history.length === 0) problems.push("Historial vacio");
  if (ticket.status !== STATUS.NEW && !ticket.category) problems.push("Estado avanzado sin categoria");
  if (ticket.handoffs && ticket.handoffs.count > MAX_HANDOFFS) {
    problems.push(`Traspasos por encima del tope: ${ticket.handoffs.count}`);
  }
  return problems;
}
