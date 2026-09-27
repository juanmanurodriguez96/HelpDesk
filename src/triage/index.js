/**
 * Orquestador del triaje.
 *
 * Una sola funcion, `triageTicket`, que recorre el camino completo:
 *
 *   ingress  ->  redactar  ->  clasificar  ->  extraer entidades
 *            ->  puntuar   ->  calcular SLA ->  decidir siguiente paso
 *
 * La ultima fase es la que importa de verdad: el triaje no devuelve solo una
 * etiqueta, devuelve una DECISION con su justificacion, y esa decision es la que
 * gobierna el handoff entre agentes. Un clasificador que se limita a nombrar la
 * categoria deja al agente siguiente adivinando; este devuelve "esto es identidad,
 * falta el usuario, asi que preguntamos antes de tocar nada".
 */

import { classify, MIN_ACTIONABLE_CONFIDENCE } from "./classifier.js";
import { extractEntities, buildClarifyingQuestions } from "./entities.js";
import { scorePriority, explainPriority } from "./priority.js";
import { categoryById, TYPOLOGIES } from "../knowledge/taxonomy.js";
import { redact, containsSecret, offersCredentials, SECRET_NOTICE } from "../privacy/pii.js";
import { computeSla, DEFAULT_CALENDAR } from "../domain/sla.js";
import { cloneTicket, createTicket, STATUS } from "../domain/ticket.js";
import { missingRequiredEntities } from "../domain/lifecycle.js";

/**
 * @typedef {object} TriageResult
 * @property {object} ticket          Ticket con clasificacion, entidades y SLA.
 * @property {object} decision        Decision y su justificacion.
 * @property {string[]} nextQuestions Preguntas que hay que hacer al usuario.
 */

/**
 * Da de alta una incidencia a partir de texto libre.
 *
 * @param {object} args
 * @param {string} args.text      Texto ORIGINAL del usuario final. Se redacta aqui.
 * @param {string} args.reporter  Identificador corporativo de quien escribe.
 * @param {string} [args.channel]
 * @param {string} [args.lang]
 * @param {Date}   [args.now]
 * @param {object} [args.slaCalendar]
 * @returns {TriageResult}
 */
export function intakeAndTriage({
  text,
  reporter,
  channel = "email",
  lang = "es",
  now = new Date(),
  slaCalendar = DEFAULT_CALENDAR,
}) {
  // 1. REDACTAR EN EL INGRESO. A partir de aqui, el texto original no existe
  //    para el resto del sistema: no se persiste, no se registra, no se muestra.
  //
  //    Antes de tirarlo se extraen las dos senales que el ticket necesita para
  //    poder avisar al usuario, porque se refieren al original y no a su version
  //    saneada. Si se calcularan despues, darian `false` siempre.
  const signals = {
    containedSecret: containsSecret(text),
    credentialsOffered: offersCredentials(text),
  };
  const { text: safeText, findings } = redact(text);

  const ticket = createTicket({
    text: safeText,
    reporter,
    channel,
    lang,
    now,
    signals: { ...signals, findings },
    meta: { redactionFindings: findings },
  });

  return triage(ticket, { now, slaCalendar, lang });
}

/**
 * Triaje de un ticket ya creado.
 *
 * @param {object} ticket
 * @param {object} args
 * @returns {TriageResult}
 */
export function triage(ticket, { now = new Date(), slaCalendar = DEFAULT_CALENDAR, lang = "es" } = {}) {
  const next = cloneTicket(ticket);
  const text = next.request.text;
  const es = lang === "es";

  // 1. Clasificacion
  const classification = classify(text);
  const category = categoryById(classification.category);
  next.category = classification.category;
  next.typology = classification.typology;
  next.confidence = classification.confidence;
  next.classification = {
    matchedTerms: classification.matchedTerms,
    ambiguous: classification.ambiguous,
    alternatives: classification.alternatives,
    typology: classification.typology,
  };

  // 2. Entidades
  const entities = extractEntities(text, { reporterId: next.reporter.id });
  next.entities = { ...next.entities, ...entities };

  // 3. Severidad y prioridad
  const scoring = scorePriority({ category, entities: next.entities, lang });
  next.severity = `S${scoring.severity}`;
  next.priority = scoring.priority;

  // 4. SLA
  next.sla = computeSla({ from: now, severity: next.severity, calendar: slaCalendar });

  // 5. Entidades obligatorias pendientes
  next.entities.missingRequired = missingRequiredEntities(next);
  const nextQuestions = buildClarifyingQuestions(next, lang);

  // 6. Decision: el nucleo del triaje.
  const decision = decide({
    next,
    classification,
    category,
    scoring,
    lang,
    now,
  });

  // Aviso de seguridad si el usuario compartio credenciales: es parte de la
  // respuesta, no un comentario opcional.
  const securityNotice = next.request.userOfferedCredentials
    ? { code: "CREDENTIALS_SHARED", message: SECRET_NOTICE[lang] }
    : null;

  return {
    ticket: next,
    decision: {
      ...decision,
      priorityExplanation: explainPriority(scoring, lang),
      nextQuestions,
      securityNotice,
    },
    nextQuestions,
  };
}

/**
 * Politica de decision. Ordena las condiciones de mas restrictiva a menos.
 *
 * El criterio no negociable: **ante la duda, no se ejecuta nada**. Se pregunta
 * o se escala, pero nunca se toca un sistema de produccion basandose en una
 * clasificacion dudosa.
 */
function decide({ next, classification, category, scoring, lang, now }) {
  const es = lang === "es";

  // 1. Sin clasificacion fiable -> mesa humana. Nunca se auto-remedia.
  if (classification.ambiguous || classification.category === "unclassified") {
    return {
      action: "escalate",
      reason: es ? "clasificacion_ambigua" : "ambiguous_classification",
      target: "escalation-desk",
      rationale: es
        ? `No se ha podido clasificar con confianza (${classification.confidence}). Alternativas: ${
            classification.alternatives.map((a) => a.category).join(", ") || "ninguna"
          }. Se deriva a la mesa humana antes de ejecutar nada.`
        : `Could not classify reliably (${classification.confidence}). Alternatives: ${
            classification.alternatives.map((a) => a.category).join(", ") || "none"
          }. Routed to the human desk before acting.`,
    };
  }

  if (classification.confidence < MIN_ACTIONABLE_CONFIDENCE) {
    return {
      action: "escalate",
      reason: es ? "confianza_insuficiente" : "insufficient_confidence",
      target: "escalation-desk",
      rationale: es
        ? `Confianza ${classification.confidence} por debajo del minimo accionable ${MIN_ACTIONABLE_CONFIDENCE}.`
        : `Confidence ${classification.confidence} below the actionable minimum ${MIN_ACTIONABLE_CONFIDENCE}.`,
    };
  }

  // 2. Impacto de toda la empresa -> escalado inmediato, sin triaje adicional.
  if (next.entities.impactScope === "company") {
    return {
      action: "escalate",
      reason: es ? "alcance_empresarial" : "company_wide_impact",
      target: "escalation-desk",
      rationale: es
        ? "El usuario describe un alcance de toda la empresa. Se escala de inmediato."
        : "The user reports company-wide impact. Escalated immediately.",
    };
  }

  // 3. Faltan entidades obligatorias -> preguntar. No se resuelve, no se ejecuta.
  if (next.entities.missingRequired.length > 0) {
    return {
      action: "ask_user",
      reason: es ? "faltan_datos" : "missing_information",
      target: next.assignedAgent ?? category.queue,
      rationale: es
        ? `Faltan las entidades obligatorias para "${category.label}": ${next.entities.missingRequired.join(", ")}.`
        : `Missing required entities for "${category.label}": ${next.entities.missingRequired.join(", ")}.`,
    };
  }

  // 4. Secretos en la entrada -> se avisa y se sigue con el caso, nunca con el secreto.
  if (next.request.userOfferedCredentials) {
    return {
      action: "handle_with_warning",
      reason: es ? "credenciales_compartidas" : "shared_credentials",
      target: next.assignedAgent ?? category.queue,
      rationale: es
        ? "El usuario compartio credenciales: se han eliminado del registro y se le avisara. El caso continua normalmente."
        : "The user shared credentials: removed from the record and the user will be warned. The case proceeds normally.",
    };
  }

  // 5. Via de diagnostico y remediacion determinista.
  const diagnosable = category.typology === TYPOLOGIES.INFRAESTRUCTURA;
  return {
    action: diagnosable ? "diagnose" : "remediate_or_ask",
    reason: es ? "clasificado" : "classified",
    target: next.assignedAgent ?? category.queue,
    rationale: es
      ? `Clasificado como "${category.label}" (${category.typology}) con confianza ${
          classification.confidence
        }. ${diagnosable ? "Procede diagnostico automatico." : "Procede revisar el catalogo de remediacion."}`
      : `Classified as "${category.label}" (${category.typology}) with confidence ${
          classification.confidence
        }. ${diagnosable ? "Proceeding with automatic diagnostics." : "Proceeding to review the remediation catalogue."}`,
  };
}

/** Etiquetas legibles de una severidad, para respuestas al usuario. */
export const SEVERITY_LABEL = {
  S1: { es: "critica", en: "critical" },
  S2: { es: "alta", en: "high" },
  S3: { es: "media", en: "medium" },
  S4: { es: "baja", en: "low" },
};
