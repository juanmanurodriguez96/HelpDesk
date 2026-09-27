/**
 * Respuestas al usuario.
 *
 * Un ticket trae `lang` y todo lo que ve la persona que lo escribió sale en ese
 * idioma. Estas plantillas son la unica fuente de la prosa: el codigo decide la
 * plantilla, nunca inventa frases.
 *
 * La estructura de todos los mensajes es la misma y no es decorativa:
 *
 *   1. Que se ha hecho        -> el usuario quiere saber si le han resuelto algo
 *   2. Que tiene que hacer    -> acciones concretas, numeradas
 *   3. Que se ha hecho por el -> la parte que le protege y que nadie pide
 *   4. Cuando se espera       -> expectativa realista, no promesas
 *   5. Referencia             -> para que pueda citarlo
 *
 * Lo que se dice al usuario no incluye: rutas internas, nombres de otros
 * usuarios, otros tickets, ni el detalle de lo que ha hecho otro agente. El
 * usuario no necesita el organigrama del servicio para resolver su problema.
 */

import { STATUS } from "../domain/ticket.js";
import { SEVERITY_LABEL } from "../triage/index.js";
import { categoryById } from "../knowledge/taxonomy.js";

/** Plantillas base por tipo de mensaje. */
const TEMPLATES = {
  ack: {
    es: (t) => `He registrado tu incidencia con la referencia **${t.ticketId}**.`,
    en: (t) => `I have logged your request with reference **${t.ticketId}**.`,
  },
  classified: {
    es: (t) =>
      `La he clasificado como **${t.categoryLabel}** y la he pasado a ${t.agentLabel}. ${
        t.urgency
          ? `La estoy tratando como prioridad ${t.severity} (${t.severityLabel}).`
          : ""
      }`,
    en: (t) =>
      `I have classified it as **${t.categoryLabel}** and passed it to ${t.agentLabel}. ${
        t.urgency
          ? `It is being handled at ${t.severity} priority (${t.severityLabel}).`
          : ""
      }`,
  },
  waiting: {
    es: (t) =>
      `Necesito un par de datos antes de poder continuar. ${
        t.questions.length ? t.questions.join(" ") : ""
      }`,
    en: (t) =>
      `I need a couple of details before I can continue. ${
        t.questions.length ? t.questions.join(" ") : ""
      }`,
  },
  noCredentials: {
    es: () =>
      "No te voy a pedir la contraseña ni ningún código de acceso: por seguridad no se comparten por este canal, y nunca se guardan aquí.",
    en: () =>
      "I will not ask you for your password or any access code: those are never shared on this channel, and they are never stored here.",
  },
  securityNotice: {
    es: () =>
      "**Aviso de seguridad.** Detecté que el mensaje traía una credencial o un dato de acceso. Ya no está almacenado y no se ha usado, pero como ha estado escrito aquí te recomendamos que lo cambies: lo que se ha compartido, deja de ser secreto.",
    en: () =>
      "**Security notice.** Your message contained a credential or an access value. It is no longer stored and was not used, but since it was written here you should change it: once shared, something stops being a secret.",
  },
  diagnosed: {
    es: (t) =>
      t.conclusive
        ? `He identificado la causa: **${t.cause}**.`
        : `He revisado lo que puedo desde aquí y **no he podido determinar la causa con suficiente certeza**. ${t.missing ? `Falta: ${t.missing}.` : ""}`,
    en: (t) =>
      t.conclusive
        ? `I have identified the cause: **${t.cause}**.`
        : `I have checked what I can from here and **could not determine the cause with enough certainty**. ${t.missing ? `Missing: ${t.missing}.` : ""}`,
  },
  remediated: {
    es: (t) =>
      `**Hecho:** ${t.action}. ${
        t.steps && t.steps.length ? `\n\nPara tu lado:\n${numbered(t.steps)}` : ""
      }`,
    en: (t) =>
      `**Done:** ${t.action}. ${
        t.steps && t.steps.length ? `\n\nOn your side:\n${numbered(t.steps)}` : ""
      }`,
  },
  rollback: {
    es: (t) => (t.rollback ? `Si algo va mal, esto es lo que hay que deshacer: ${t.rollback}` : ""),
    en: (t) => (t.rollback ? `If something goes wrong, here is how to undo it: ${t.rollback}` : ""),
  },
  blocked: {
    es: (t) => {
      if (t.waitingOn?.includes("user")) {
        return `No he ejecutado nada en tu equipo o en el sistema. ${t.why} Con lo que me has contado no llego a una conclusión segura, y no quiero tocar nada sin estar seguro.`;
      }
      if (t.waitingOn?.includes("operator")) {
        return `No he ejecutado nada en tu equipo o en el sistema. ${t.why} Lo está revisando una persona del equipo.`;
      }
      return `No he ejecutado nada en tu equipo o en el sistema. ${t.why} El caso sigue en el equipo técnico.`;
    },
    en: (t) => {
      if (t.waitingOn?.includes("user")) {
        return `I have not changed anything on your device or in the system. ${t.why} What you have told me is not enough for a safe conclusion, and I would rather change nothing than change it wrongly.`;
      }
      if (t.waitingOn?.includes("operator")) {
        return `I have not changed anything on your device or in the system. ${t.why} A member of the team is reviewing it.`;
      }
      return `I have not changed anything on your device or in the system. ${t.why} The case stays with the technical team.`;
    },
  },
  escalated: {
    es: (t) => `Lo he pasado al equipo humano: **${t.group}**. ${t.expectation}`,
    en: (t) => `It has been passed to the human team: **${t.group}**. ${t.expectation}`,
  },
  resolved: {
    es: (t) => `**Resuelto.** ${t.summary}`,
    en: (t) => `**Resolved.** ${t.summary}`,
  },
  closed: {
    es: (t) => `Caso cerrado. ${t.summary} Si vuelve a pasar, no abras uno nuevo: escribe en este mismo ticket (${t.ticketId}).`,
    en: (t) => `Case closed. ${t.summary} If it happens again, do not open a new one: reply on this ticket (${t.ticketId}).`,
  },
  cancelled: {
    es: (t) => `Caso cerrado por ${t.why}`,
    en: (t) => `Case closed: ${t.why}`,
  },
  sla: {
    es: (t) => `Con la prioridad actual (${t.severity}) te responderemos antes del **${t.due}**.`,
    en: (t) => `At the current priority (${t.severity}) we will respond before **${t.due}**.`,
  },
};

function numbered(steps) {
  return steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
}

/** Une varios mensajes en el orden protocolario y descarta los vacios. */
function compose(parts) {
  return parts.map((part) => (part ?? "").trim()).filter(Boolean).join("\n\n");
}

/**
 * Mensaje de acuse de recibo tras el ingreso.
 *
 * @param {object} args
 * @param {object} args.ticket
 * @param {object} [args.decision]
 * @param {string} [args.lang]
 * @returns {string} markdown
 */
export function acknowledgement({ ticket, decision = {}, lang = ticket.lang ?? "es" }) {
  const t = template(ticket, lang);
  const parts = [
    render("ack", t),
    decision.category ? render("classified", { ...t, ...categoryContext(ticket, decision) }) : null,
    decision.securityNotice ? render("securityNotice", t) : null,
    decision.securityNotice ? render("noCredentials", t) : null,
    decision.nextQuestions?.length ? render("waiting", { ...t, questions: decision.nextQuestions }) : null,
  ];
  return compose(parts);
}

/** Preguntas de aclaracion, nunca sobre credenciales. */
export function clarifying({ ticket, questions, lang = ticket.lang ?? "es" }) {
  if (!questions?.length) return "";
  const t = template(ticket, lang);
  return compose([render("waiting", { ...t, questions })]);
}

/** Resultado del diagnostico, sea o no concluyente. */
export function diagnosisResult({ ticket, report, lang = ticket.lang ?? "es" }) {
  const t = template(ticket, lang);
  // `missing` son objetos con `id`, `reason` y `ask`: al usuario le interesa la
  // `ask` (que tiene que ocurrir), no el identificador interno del check. Se
  // quitan los puntos finales para no encadenarlos con el punto de la frase.
  const missing = (report.missing ?? [])
    .map((m) => (m.ask ?? m.reason ?? m.id).trim().replace(/\.$/, ""))
    .join("; ");
  const body = render("diagnosed", {
    ...t,
    conclusive: report.cause?.conclusive === true,
    cause: report.cause?.hypothesis ?? report.cause?.rule,
    missing,
  });
  const parts = [body];
  if (report.cause?.conclusive !== true) {
    parts.push(lang === "es"
      ? "Antes de tocar nada, prefiero preguntarte o pasar el caso a una persona que adivinar y dejarte peor."
      : "Before changing anything, I would rather ask you or hand it to a person than guess and leave you worse off.");
  }
  return compose(parts);
}

/** Resultado de una remediacion: el estado se cuenta tal cual es. */
export function remediationResult({ ticket, result, lang = ticket.lang ?? "es" }) {
  const t = template(ticket, lang);

  if (result.status === "blocked") {
    // "Bloqueado" no significa siempre "lo ha cogido una persona": puede estar
    // esperando al usuario. Decir lo contrario convierte un dato razonable en
    // una mentira, y es la clase de mentira que hace que el usuario deje de
    // fiarse del sistema entero.
    const esperando = new Set(result.awaiting ?? []);
    return compose([
      render("blocked", {
        ...t,
        why: blockedWhy(result, lang),
        waitingOn: [...esperando],
      }),
    ]);
  }
  if (result.status === "planned") {
    return compose([
      lang === "es"
        ? `He preparado la solución (**${result.playbook}**) y la he revisado; todavía no he aplicado nada.`
        : `I have prepared the fix (**${result.playbook}**) and reviewed it; I have not applied anything yet.`,
    ]);
  }
  if (result.status === "unavailable") {
    return compose([
      lang === "es"
        ? "No he podido aplicar el cambio: el sistema que lo ejecuta no está disponible ahora mismo."
        : "I could not apply the change: the system that performs it is unavailable right now.",
    ]);
  }
  if (result.status === "failed") {
    return compose([
      lang === "es"
        ? `No he podido aplicar el cambio. **No he dejado nada a medias**: o se aplicó entero, o no se aplicó.`
        : `I could not apply the change. **Nothing was left half-done**: either it applied fully, or it did not apply at all.`,
    ]);
  }

  const guide = result.guidance ?? {};
  return compose([
    render("remediated", { ...t, action: guide.summary, steps: guide.steps }),
    render("rollback", { ...t, rollback: result.rollback }),
  ]);
}

/** Aviso de escalado: destino y plazo de aceptacion, en concreto. */
export function escalationNotice({ ticket, escalation, lang = ticket.lang ?? "es" }) {
  const t = template(ticket, lang);
  return compose([
    render("escalated", {
      ...t,
      group: GROUP_LABEL[escalation.group]?.[lang] ?? escalation.group,
      expectation:
        lang === "es"
          ? `Te responderemos antes del **${formatDate(escalation.ackDueBy, t.lang, ticket.sla?.calendar)}**.`
          : `We will get back to you before **${formatDate(escalation.ackDueBy)}**.`,
    }),
  ]);
}

const GROUP_LABEL = {
  triage: { es: "cola de triaje", en: "triage queue" },
  incident: { es: "incidencias", en: "incident response" },
  operations: { es: "operaciones", en: "operations" },
  security: { es: "seguridad", en: "security" },
};

/** Mensaje de resolucion, con lo que el usuario tiene que hacer. */
export function resolutionNotice({ ticket, lang = ticket.lang ?? "es" }) {
  const t = template(ticket, lang);
  const resolution = ticket.resolution ?? {};
  const parts = [render("resolved", { ...t, summary: resolution.summary ?? "" })];
  if (resolution.userSteps?.length) {
    parts.push(
      lang === "es"
        ? `Para tu lado:\n${numbered(resolution.userSteps)}`
        : `On your side:\n${numbered(resolution.userSteps)}`,
    );
  }
  if (ticket.status === STATUS.CLOSED) parts.push(render("closed", { ...t, summary: "" }));
  return compose(parts);
}

/** Estado del SLA en lenguaje de usuario. */
export function slaNotice({ ticket, now = new Date(), lang = ticket.lang ?? "es" }) {
  const t = template(ticket, lang);
  const due = ticket.sla?.responseDueAt ?? ticket.sla?.resolutionDueAt;
  if (!due) return "";
  return render("sla", { ...t, severity: ticket.severity, due: formatDate(due, t.lang, ticket.sla?.calendar) });
}

/** Construye el contexto comun de las plantillas. */
function template(ticket, lang) {
  return {
    ticketId: ticket.id,
    lang,
    severity: ticket.severity,
    severityLabel: SEVERITY_LABEL[ticket.severity]?.[lang] ?? ticket.severity,
    agentLabel: ticket.assignedAgent,
  };
}

/** Datos de la plantilla de clasificacion. */
function categoryContext(ticket, decision) {
  return {
    categoryLabel: categoryById(ticket.category)?.label ?? ticket.category,
    agentLabel: decision.target,
    urgency: ticket.severity === "S1" || ticket.severity === "S2",
  };
}

function render(name, t) {
  const template = TEMPLATES[name];
  return template?.[t.lang]?.(t) ?? "";
}

/**
 * Formatea una fecha para el usuario.
 *
 * El detalle que hace que esto no sea trivial: el SLA se calcula con el
 * `utcOffsetHours` de su propio calendario, no con el del reloj del servidor.
 * Si se formatea con `toLocaleString()` a secas, se muestra la hora del
 * ordenador que ejecuta el servicio, y el usuario ve una fecha distinta de la
 * que el motor acaba de comprometer. Se desplaza el instante de forma
 * explicita y se formatea con `timeZone: "UTC"`, que ya es la zona correcta.
 */
function formatDate(iso, lang = "es", calendar = null) {
  if (!iso) return "";
  const offset = calendar?.utcOffsetHours ?? 0;
  const shifted = new Date(new Date(iso).getTime() + offset * 3_600_000);
  return shifted.toLocaleString(lang === "es" ? "es-ES" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

/** Por que quedo bloqueado, en una frase por estado. */
function blockedWhy(result, lang) {
  const codes = (result.blocks ?? []).map((b) => b.code);
  const faltaDiagnostico = codes.includes("DIAGNOSIS_NOT_CONCLUSIVE");
  const faltaDato = codes.some((c) => c === "MISSING_REQUIRED_FIELDS" || c.startsWith("MISSING"));
  const faltaConfirmacion = codes.includes("HUMAN_CONFIRMATION_REQUIRED");

  if (lang === "es") {
    if (faltaDato) return "Faltan datos que necesito antes de tocar nada.";
    if (faltaConfirmacion) return "La acción necesita la confirmación de una persona.";
    if (faltaDiagnostico) return "No tengo un diagnóstico fiable sobre el que actuar.";
    return "No se dan las condiciones para actuar con seguridad.";
  }
  if (faltaDato) return "I am missing data I need before changing anything.";
  if (faltaConfirmacion) return "This action needs a person's confirmation.";
  if (faltaDiagnostico) return "I do not have a reliable diagnosis to act on.";
  return "The conditions to act safely are not met.";
}

export { TEMPLATES };
