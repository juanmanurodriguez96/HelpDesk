#!/usr/bin/env node
/**
 * Interfaz de linea de comandos.
 *
 * Es la superficie que los agentes usan (`bash: "node src/cli.js *": allow`).
 * Tres reglas de diseno que explican casi todo lo que hace:
 *
 *   1. **Todo pasa por la maquina de estados.** Ningun comando cambia
 *      `ticket.status` directamente. Si un comando parece necesitar una
 *      transicion que no existe, lo que se anade es una transicion, y se
 *      documenta en `AGENTS.md`.
 *
 *   2. **Simular es el valor por defecto.** `remediate` sin `--apply` no toca
 *      nada. Volver a aplicar de verdad exige pasar la flag explicitamente.
 *
 *   3. **Todo error sale con su codigo.** Un `TransitionError` sin el motivo
 *      de la transicion rechazada es un error que obliga a leer el codigo
 *      fuente; con el motivo, es un error que se resuelve mirando la pantalla.
 *
 * Los codigos de salida son los de `EXIT`: distintos para problema de
 * argumentos, de politica, de transicion o de dependencia, porque un script que
 * envuelve esto necesita distinguirlos.
 */

import { createStore } from "./infra/store.js";
import { intakeAndTriage, triage } from "./triage/index.js";
import { diagnose } from "./diagnostics/index.js";
import { remediate, playbooksForCategory } from "./remediation/index.js";
import { escalate, reasonFromDecision, acknowledge } from "./escalation/index.js";
import { applyTransition, canTransition, slaSnapshot } from "./domain/lifecycle.js";
import { STATUS, ACTOR, ACTOR as TICKET_ACTOR, LANGS, cloneTicket } from "./domain/ticket.js";
import { initialRoute, handoff, AGENTS } from "./ecosystem/index.js";
import { redact, containsSecret, offersCredentials } from "./privacy/pii.js";
import { AppError, EXIT, exitCodeFor, ValidationError } from "./core/errors.js";
import {
  acknowledgement as renderAck,
  clarifying,
  diagnosisResult,
  remediationResult,
  escalationNotice,
  resolutionNotice,
  slaNotice,
} from "./responses/index.js";
import { TICKET_ID_RE } from "./core/ids.js";
import { pathToFileURL } from "node:url";

const USAGE = `
Servicio de soporte interno. Mesa de ayuda.

  node src/cli.js intake    --text "..." --reporter E-10482 [--lang es|en] [--channel email]
  node src/cli.js triage    --ticket HD-A1B2C3
  node src/cli.js route     --ticket HD-A1B2C3 [--to <agente>]
  node src/cli.js diagnose  --ticket HD-A1B2C3 [--allow-network]
  node src/cli.js playbooks --ticket HD-A1B2C3
  node src/cli.js remediate --ticket HD-A1B2C3 [--playbook <id>] [--apply] [--actor <agente>]
  node src/cli.js escalate  --ticket HD-A1B2C3 [--reason <motivo>]
  node src/cli.js accept    --ticket HD-A1B2C3 --operator mesa-n2
  node src/cli.js ask       --ticket HD-A1B2C3
  node src/cli.js answer    --ticket HD-A1B2C3 --text "respuesta del usuario"
  node src/cli.js sla       --ticket HD-A1B2C3
  node src/cli.js status    --ticket HD-A1B2C3
  node src/cli.js resolve   --ticket HD-A1B2C3 --summary "..." [--actor agent]
  node src/cli.js close     --ticket HD-A1B2C3 --operator mesa-n2
  node src/cli.js cancel    --ticket HD-A1B2C3 --reason "..." --operator mesa-n2
  node src/cli.js audit     [--ticket HD-A1B2C3] [--verify]
  node src/cli.js list
  node src/cli.js agents
  node src/cli.js demo

Notas:
  - remediate SIMULA por defecto. Sin --apply no toca nada.
  - Solo "close" y "cancel" exigen --operator: un agente no cierra.
  - --operator NO es un control de seguridad, es una declaracion. La CLI no
    sabe quien la escribe: no hay quien autentique al operador. Quien
    autoriza el cierre es el permiso de bash del agente que lo invoca, y ahi
    "close", "cancel" y "accept" estan denegados para todos. Si alguien
    interfacea la CLI por otro camino, esa persona es el operador.
  - --allow-network abre los comprobadores en vivo. Sin ella el informe sale
    parcial y honesto, que es lo correcto.
`.trim();

/* ------------------------------------------------------------------ *
 * Utilidades de linea de comandos
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function required(args, name, hint) {
  const value = args[name];
  if (value === undefined || value === true || String(value).trim() === "") {
    throw new ValidationError("ARGUMENT_REQUIRED", `Falta --${name}.`, { argument: name, hint: hint ?? null });
  }
  return String(value).trim();
}

function requireTicketId(value) {
  if (!TICKET_ID_RE.test(String(value ?? ""))) {
    throw new ValidationError("TICKET_ID_INVALID", `"${value}" no tiene forma de identificador de ticket.`, {
      expected: "HD-XXXXXX",
    });
  }
  return String(value).trim();
}

function out(...lines) {
  process.stdout.write(`${lines.filter((l) => l !== undefined && l !== null).join("\n")}\n`);
}

function heading(text) {
  out("", `── ${text} ${"─".repeat(Math.max(0, 58 - text.length))}`);
}

function bullets(items, empty = "  (ninguno)") {
  if (!items || items.length === 0) return out(empty);
  for (const item of items) out(`  - ${item}`);
}

/* ------------------------------------------------------------------ *
 * Comandos
 * ------------------------------------------------------------------ */

const COMMANDS = {
  async help() {
    out(USAGE);
  },

  async intake(store, args) {
    const text = required(args, "text", "el texto del usuario, entre comillas");
    const reporter = required(args, "reporter", "identificador corporativo, p.ej. E-10482");
    const lang = args.lang ?? "es";
    if (!LANGS.includes(lang)) throw new ValidationError("LANG_INVALID", `Idioma no admitido: ${lang}`, { allowed: LANGS });

    const { ticket, decision, nextQuestions } = intakeAndTriage({
      text,
      reporter,
      channel: args.channel ?? "email",
      lang,
      now: new Date(),
    });

    // El ticket nace en `new` y pasa por la maquina de estados como cualquier
    // otro. Aqui se ve por que la transicion `new -> triaged` exige categoria,
    // severidad, prioridad y confianza: no se puede inventar un ticket que las
    // tenga y la maquina no lo note.
    //
    // Las preguntas del triaje tambien se persisten aqui, no se quedan en la
    // salida de la pantalla. Un ticket que sabe que le falta un dato y no lo
    // guarda es un ticket que se vuelve a preguntar lo mismo en cuanto alguien
    // lo toca.
    const triaged = applyTransition(ticket, {
      to: STATUS.TRIAGED,
      patch: {
        category: ticket.category,
        severity: ticket.severity,
        priority: ticket.priority,
        confidence: ticket.confidence,
        questions: nextQuestions,
      },
      actor: ACTOR.SYSTEM,
      rationale: `Clasificado como ${ticket.category} con confianza ${ticket.confidence}`,
      now: new Date(),
    });

    const routed = handoff({
      ticket: triaged,
      to: decision.target === "escalation-desk" ? "escalation-desk" : initialRoute(triaged),
      now: new Date(),
    });

    const guardado = store.save(routed);
    store.audit.append({
      at: new Date().toISOString(),
      ticketId: guardado.id,
      actor: ACTOR.SYSTEM,
      action: "intake",
      rationale: decision.rationale,
      decision: { action: decision.action, reason: decision.reason, target: decision.target },
      evidence: {
        matchedTerms: guardado.classification?.matchedTerms ?? [],
        redactionFindings: guardado.request.redaction.findings.length,
      },
      after: { status: guardado.status, category: guardado.category, severity: guardado.severity },
    });

    heading(`Ticket ${guardado.id}`);
    out(renderAck({ ticket: guardado, decision, lang }));
    heading("Clasificacion");
    out(`  categoria    ${guardado.category} (${guardado.typology})`);
    out(`  confianza    ${guardado.confidence}${guardado.classification?.ambiguous ? "  AMBIGUA" : ""}`);
    out(`  severidad    ${guardado.severity}   prioridad ${guardado.priority}`);
    bullets(guardado.classification?.alternatives?.map((a) => `alternativa: ${a.category} (${a.confidence})`));
    heading("Decision");
    out(`  ${decision.action} -> ${guardado.assignedAgent}`);
    out(`  ${decision.rationale}`);
    out(`  ${decision.priorityExplanation ?? ""}`);
    if (decision.nextQuestions?.length) {
      heading("Preguntas");
      out(clarifying({ ticket: guardado, questions: decision.nextQuestions, lang }));
      out("  Quedan guardadas en el ticket: el comando `ask` las presenta al usuario.");
    }
    heading("SLA");
    out(`  ${slaNotice({ ticket: guardado, lang })}`);

    return 0;
  },

  async triage(store, args) {
    const id = requireTicketId(args.ticket);
    const ticket = store.get(id);
    const { ticket: retriaged, decision, nextQuestions } = triage(ticket);

    // Igual que en `intake`: lo que el triaje deduce que falta, se guarda. Un
    // recalculo que no persiste su resultado es una lectura, no una decision.
    store.save({ ...retriaged, pendingQuestions: nextQuestions });

    heading(`Triaje de ${id}`);
    out(`  categoria    ${retriaged.category} (confianza ${retriaged.confidence})`);
    out(`  severidad    ${retriaged.severity}   prioridad ${retriaged.priority}`);
    out(`  decision     ${decision.action} -> ${decision.target}`);
    out(`  ${decision.rationale}`);
    out(`  ${decision.priorityExplanation ?? ""}`);
    if (nextQuestions?.length) {
      heading("Falta");
      out(clarifying({ ticket: retriaged, questions: nextQuestions, lang: ticket.lang }));
    }
    return 0;
  },

  async route(store, args) {
    const id = requireTicketId(args.ticket);
    const ticket = store.get(id);
    if (args.to) {
      const moved = handoff({ ticket, to: String(args.to), now: new Date() });
      store.save(moved);
      store.audit.append({
        at: new Date().toISOString(),
        ticketId: id,
        actor: ACTOR.AGENT,
        action: "handoff",
        rationale: moved.history.at(-1).rationale,
        before: { agent: ticket.assignedAgent },
        after: { agent: moved.assignedAgent, count: moved.handoffs.count },
      });
      heading(`Traspaso de ${id}`);
      out(`  ${ticket.assignedAgent} -> ${moved.assignedAgent}`);
      out(`  ${moved.history.at(-1).rationale}`);
      out(`  rastro: ${moved.handoffs.trail.join(" -> ")} (${moved.handoffs.count} traspasos)`);
      return 0;
    }
    heading(`Reparto de ${id}`);
    out(`  agente actual  ${ticket.assignedAgent}`);
    out(`  siguiente      ${initialRoute(ticket)}`);
    return 0;
  },

  async diagnose(store, args) {
    const id = requireTicketId(args.ticket);
    const ticket = store.get(id);
    const allowNetwork = args["allow-network"] === true;
    const now = new Date();
    const report = await diagnose({ ticket, allowNetwork, now });

    // El informe se PERSISTE. Sin esto, `remediate` encuentra el ticket sin
    // diagnostico y se bloquea con DIAGNOSIS_NOT_CONCLUSIVE, que es el
    // comportamiento correcto, pero por un motivo equivocado: el diagnostico
    // si se hizo, solo se habia quedado en memoria. Un informe que no sobrevive
    // al proceso que lo produjo no es evidencia de nada.
    //
    // El recorrido se hace por la maquina de estados y no escribiendo campos:
    // entrar en DIAGNOSING y volver con el informe deja dos entradas de
    // historial que dicen, por separado, que se empezo y que se termino.
    let current = ticket;
    if (current.status !== STATUS.DIAGNOSING) {
      const check = canTransition(current, STATUS.DIAGNOSING, { category: current.category }, ACTOR.AGENT);
      if (check.allowed) {
        current = applyTransition(current, {
          to: STATUS.DIAGNOSING,
          patch: { category: current.category },
          actor: ACTOR.AGENT,
          rationale: `Diagnostico iniciado (${allowNetwork ? "red autorizada" : "sin salida a la red"})`,
          now,
        });
      }
    }
    const withReport = applyTransition(current, {
      to: STATUS.IN_PROGRESS,
      patch: { diagnosis: report },
      actor: ACTOR.AGENT,
      rationale: `Diagnostico concluido: cobertura ${Math.round(report.summary.coverage * 100)}%, acuerdo ${Math.round(
        report.summary.agreement * 100,
      )}%, ${report.insufficient ? "no concluyente" : "concluyente"}`,
      now,
    });
    store.save(withReport);
    store.audit.append({
      at: now.toISOString(),
      ticketId: id,
      actor: ticket.assignedAgent ?? "agent",
      action: "diagnosis",
      rationale: `cobertura ${Math.round(report.summary.coverage * 100)}%`,
      decision: { allowNetwork, sufficient: !report.insufficient },
      after: {
        conclusive: !report.insufficient,
        coverage: report.summary.coverage,
        agreement: report.summary.agreement,
        failed: report.checks.filter((c) => c.verdict === "fail").map((c) => c.id),
      },
    });

    heading(`Diagnostico de ${id}${allowNetwork ? " (red abierta)" : " (offline)"}`);
    out(diagnosisResult({ ticket, report, lang: ticket.lang }));
    heading("Cobertura");
    out(`  checks        ${report.summary.pass} ok / ${report.summary.fail} ko / ${report.summary.unknown} sin dato de ${report.summary.total}`);
    out(`  cobertura     ${Math.round(report.summary.coverage * 100)}%   acuerdo ${Math.round(report.summary.agreement * 100)}%`);
    out(`  suficiente    ${report.insufficient ? "NO" : "si"}`);
    if (report.missing?.length) {
      heading("Falta");
      bullets(report.missing.map((m) => `${m.id}: ${m.reason}`));
    }
    heading("Checks");
    bullets(
      report.checks.map((c) => `${c.verdict.padEnd(7)} ${c.id}  ${c.summary ?? ""}`),
    );
    return 0;
  },

  async playbooks(store, args) {
    const id = requireTicketId(args.ticket);
    const ticket = store.get(id);
    const candidates = playbooksForCategory(ticket.category);
    heading(`Playbooks para ${id} (${ticket.category})`);
    if (candidates.length === 0) {
      out("  Ninguno. Este caso no tiene remediacion automatica: se escala.");
      return 0;
    }
    for (const p of candidates) {
      out(`  ${p.id}`);
      out(`    riesgo      ${p.risk}`);
      out(`    requiere    ${p.requires.join(", ") || "-"}`);
      out(`    deshacer    ${p.rollback}`);
    }
    return 0;
  },

  async remediate(store, args) {
    const id = requireTicketId(args.ticket);
    const ticket = store.get(id);
    const apply = args.apply === true;

    // Un adaptador real conectaria aqui el directorio corporativo, el gestor
    // de permisos, etc. Sin uno, el ejecutor devuelve `unavailable` y el CLI lo
    // dice, en vez de fingir que se ha hecho algo.
    const adapter = args["fake-adapter"] ? fakeAdapter() : null;

    const result = await remediate({
      ticket,
      playbookId: args.playbook ? String(args.playbook) : undefined,
      diagnosis: ticket.diagnosis,
      adapter,
      dryRun: !apply,
      actor: args.actor ? String(args.actor) : ticket.assignedAgent,
      lang: ticket.lang,
      now: new Date(),
    });

    heading(`Remediacion en ${id}: ${result.playbook ?? "(sin playbook)"}`);
    out(remediationResult({ ticket, result, lang: ticket.lang }));
    out("");
    out(`  estado       ${result.status}${apply ? "" : "  (simulacion: no se ha aplicado nada)"}`);
    out(`  riesgo       ${result.risk ?? "-"}`);
    if (result.missing?.length) {
      out("  falta        " + result.missing.join(", "));
    }
    for (const block of result.blocks ?? []) {
      out(`  BLOQUEO      ${block.code}: ${block.reason}  [${block.resolvableBy}]`);
    }

    if (result.status === "applied") {
      const actualizado = store.save({
        ...ticket,
        remediation: {
          attempted: [...ticket.remediation.attempted, result.id],
          applied: [...ticket.remediation.applied, result.id],
          skipped: ticket.remediation.skipped,
        },
      });
      store.audit.append({
        at: new Date().toISOString(),
        ticketId: id,
        actor: result.actor ?? "agent",
        action: "remediation",
        rationale: result.playbook,
        decision: { status: result.status, risk: result.risk },
        after: { remediationId: result.id, rollback: result.rollback },
      });
      void actualizado;
    }
    return result.status === "applied" || result.status === "planned" ? 0 : EXIT.POLICY;
  },

  async escalate(store, args) {
    const id = requireTicketId(args.ticket);
    const ticket = store.get(id);
    const reason = reasonFromDecision({ ticket, reason: args.reason ?? "insufficient_authority" });
    const { escalation, patch, severity } = escalate({
      ticket,
      reason,
      requestedBy: args.actor ? String(args.actor) : ticket.assignedAgent,
      now: new Date(),
    });

    const escalated = applyTransition(ticket, {
      to: STATUS.ESCALATED,
      patch,
      actor: ACTOR.AGENT,
      rationale: `Escalado por ${reason}: ${escalation.detail}`,
      now: new Date(),
    });
    store.save(escalated);
    store.audit.append({
      at: new Date().toISOString(),
      ticketId: id,
      actor: ticket.assignedAgent ?? "agent",
      action: "escalation",
      rationale: escalation.detail,
      decision: { reason, severity, group: escalation.group },
      after: { escalationId: escalation.id, severity },
    });

    heading(`Escalado ${escalation.id}`);
    out(`  motivo    ${reason}`);
    out(`  grupo     ${escalation.group}`);
    out(`  severidad ${severity} (suelo ${escalation.severityFloor})`);
    out(`  acepta    ${escalation.ackDueBy}`);
    bullets(escalation.needed.map((n) => `necesita: ${n}`));
    out("");
    out(escalationNotice({ ticket: escalated, escalation, lang: ticket.lang }));
    return 0;
  },

  async accept(store, args) {
    const id = requireTicketId(args.ticket);
    const operator = required(args, "operator", "identificador de la persona que lo coge");
    const ticket = store.get(id);
    const { escalation, patch } = acknowledge({ ticket, operator, now: new Date() });
    const actualizado = applyTransition(ticket, {
      to: STATUS.IN_PROGRESS,
      patch,
      actor: ACTOR.AGENT,
      rationale: `Escalado aceptado por ${operator}`,
      now: new Date(),
    });
    store.save(actualizado);
    store.audit.append({
      at: new Date().toISOString(),
      ticketId: id,
      actor: operator,
      action: "escalation_ack",
      rationale: args.note ? String(args.note) : `Aceptado por ${operator}`,
      after: { acknowledgedBy: escalation.acknowledgedBy, acknowledgedAt: escalation.acknowledgedAt },
    });
    heading(`Escalado ${escalation.id} aceptado`);
    out(`  ${operator} lo ha cogido. El ticket vuelve a estar en trabajo.`);
    return 0;
  },

  async ask(store, args) {
    const id = requireTicketId(args.ticket);
    const ticket = store.get(id);
    if (!ticket.pendingQuestions?.length) {
      throw new ValidationError("NO_PENDING_QUESTIONS", "No hay preguntas pendientes en este ticket.");
    }
    const waiting = applyTransition(ticket, {
      to: STATUS.WAITING_USER,
      patch: { questions: ticket.pendingQuestions },
      actor: ACTOR.AGENT,
      rationale: "Faltan datos del usuario",
      now: new Date(),
    });
    store.save(waiting);
    heading(`Esperando a ${ticket.reporter.id} en ${id}`);
    out(clarifying({ ticket: waiting, questions: waiting.pendingQuestions, lang: waiting.lang }));
    out("");
    out("  El SLA queda en pausa mientras esperamos la respuesta.");
    return 0;
  },

  async answer(store, args) {
    const id = requireTicketId(args.ticket);
    const text = required(args, "text", "lo que contesta el usuario");
    const ticket = store.get(id);
    const now = new Date();

    if (ticket.status !== STATUS.WAITING_USER) {
      const check = canTransition(ticket, STATUS.IN_PROGRESS, {}, ACTOR.AGENT);
      if (!check.allowed) {
        throw new ValidationError("TICKET_NOT_WAITING", `El ticket esta en "${ticket.status}" y no espera respuesta.`, {
          allowedFrom: check.allowedFrom ?? null,
        });
      }
    }

    // La respuesta entra por el MISMO filtro de privacidad que la incidencia
    // inicial. No es un caso especial: es el mismo caso.
    //
    // Lo que NO se hace, y es lo importante: el texto de la respuesta no se
    // escribe ni en el ticket, ni en el historial, ni en la bitacora. De la
    // respuesta solo se conservan las senales (que se refieren al original, y
    // por eso se calculan antes de sanear) y el recuento de hallazgos.
    const signals = { containedSecret: containsSecret(text), credentialsOffered: offersCredentials(text) };
    const { text: safeAnswer, findings } = redact(text);

    // Se re-tria el texto COMBINADO (incidencia + respuesta) y no solo la
    // respuesta. "Windows 11" no dice por si solo que el problema es de VPN:
    // clasificar la respuesta aislada tiraria el contexto y dejaria el ticket
    // sin categoria justo cuando el usuario ha Beirado a ayudar.
    const combined = {
      ...cloneTicket(ticket),
      request: {
        ...ticket.request,
        text: `${ticket.request.text}\n${safeAnswer}`,
        signals: {
          ...ticket.request.signals,
          containedSecret: ticket.request.signals?.containedSecret || signals.containedSecret,
          credentialsOffered: ticket.request.signals?.credentialsOffered || signals.credentialsOffered,
        },
      },
    };
    const retriage = triage(combined, { now, lang: ticket.lang });

    // La re-triaje puede cambiar categoria, severidad y confianza. Se aplican
    // por la maquina de estados, no escribiendo campos sueltos: el cambio queda
    // en el historial y en la bitacora, con su explicacion.
    const updated = applyTransition(ticket, {
      to: STATUS.IN_PROGRESS,
      patch: {
        category: retriage.ticket.category,
        typology: retriage.ticket.typology,
        severity: retriage.ticket.severity,
        priority: retriage.ticket.priority,
        confidence: retriage.ticket.confidence,
        classification: retriage.ticket.classification,
        entities: retriage.ticket.entities,
        questions: [],
      },
      actor: ACTOR.SYSTEM,
      // Sin el texto: el historial se lee en auditorias, y una linea de
      // bitacora no es el sitio donde se guardan las palabras de un usuario.
      rationale: `Respuesta del usuario recibida y saneada (${findings.length} hallazgo(s))`,
      now,
    });
    const merged = { ...updated, pendingQuestions: retriage.nextQuestions };
    store.save(merged);
    store.audit.append({
      at: now.toISOString(),
      ticketId: id,
      actor: ticket.reporter.id,
      action: "user_answer",
      rationale: "Respuesta del usuario incorporada y saneada",
      after: {
        pendingQuestions: retriage.nextQuestions.length,
        redactionFindings: findings.length,
        containedSecret: signals.containedSecret,
        credentialsOffered: signals.credentialsOffered,
      },
    });

    heading(`Respuesta recibida en ${id}`);
    out(`  hallazgos saneados: ${findings.length}`);
    out(`  preguntas pendientes: ${retriage.nextQuestions.length}`);
    if (retriage.nextQuestions.length) {
      out(clarifying({ ticket: merged, questions: retriage.nextQuestions, lang: ticket.lang }));
    } else {
      out("  Ya no falta nada. El ticket sigue en trabajo.");
    }
    return 0;
  },

  async sla(store, args) {
    const id = requireTicketId(args.ticket);
    const ticket = store.get(id);
    const now = new Date();
    const snapshot = slaSnapshot(ticket, now);

    heading(`SLA de ${id}`);
    out(`  severidad   ${ticket.severity}   prioridad ${ticket.priority}`);
    // `evaluateSla` devuelve la respuesta y la resolucion por separado, cada
    // una con su estado. Se imprime asi, sin aplanar, porque "el SLA" son dos
    // plazos distintos y confundirlos en una linea esconde precisamente el
    // que se ha incumplido.
    for (const [nombre, evaluacion] of [["respuesta ", snapshot.response], ["resolucion", snapshot.resolution]]) {
      const estado = evaluacion.met
        ? evaluacion.late
          ? `CUMPLIDO TARDE (${evaluacion.deltaMinutes} min)`
          : "CUMPLIDO"
        : (evaluacion.state ?? "EN CURSO").toUpperCase();
      out(`  ${nombre}  ${estado}`);
      out(`    vence      ${evaluacion.dueAt ?? "-"}`);
      if (evaluacion.minutesRemaining !== undefined && evaluacion.minutesRemaining !== null) {
        out(`    restante    ${evaluacion.minutesRemaining} min`);
      }
      if (evaluacion.note) out(`    nota       ${evaluacion.note}`);
    }
    out(`  riesgo      ${snapshot.riskLevel}${snapshot.atRisk ? "  (ATENCION)" : ""}`);
    if (snapshot.response.note) out(`  ${snapshot.response.note}`);
    out("");
    out(`  ${slaNotice({ ticket, lang: ticket.lang })}`);
    return 0;
  },

  async status(store, args) {
    const id = requireTicketId(args.ticket);
    const ticket = store.get(id);
    heading(`${ticket.id}  ${ticket.severity}/${ticket.priority}  ${ticket.status}`);
    out(`  asunto      ${ticket.request.subject}`);
    out(`  categoria   ${ticket.category} (confianza ${ticket.confidence})`);
    out(`  agente      ${ticket.assignedAgent ?? "-"}`);
    out(`  reportante  ${ticket.reporter.id}`);
    out(`  creado      ${ticket.createdAt}`);
    if (ticket.diagnosis) out(`  diagnostico  ${ticket.diagnosis.cause?.conclusive ? "concluyente" : "no concluyente"}`);
    if (ticket.escalation) {
      out(`  escalado    ${ticket.escalation.id} (${ticket.escalation.reason})`);
      out(`  aceptado    ${ticket.escalation.acknowledgedBy ?? "PENDIENTE"}`);
    }
    heading("Historial");
    for (const step of ticket.history) {
      out(`  ${step.at}  ${String(step.from).padEnd(13)} -> ${String(step.to).padEnd(13)} ${step.actor}  ${step.rationale}`);
    }
    if (ticket.request.redaction.findings.length) {
      heading("Privacidad");
      out(`  ${ticket.request.redaction.findings.length} hallazgo(s) eliminado(s) del texto. El original no se conserva.`);
    }
    return 0;
  },

  async resolve(store, args) {
    const id = requireTicketId(args.ticket);
    const summary = required(args, "summary", "que se ha hecho, en una frase");
    const ticket = store.get(id);
    const actor = args.actor === "operator" ? TICKET_ACTOR.OPERATOR : ACTOR.AGENT;

    const resolved = applyTransition(ticket, {
      to: STATUS.RESOLVED,
      patch: { resolution: { summary, at: new Date().toISOString() } },
      actor,
      rationale: summary,
      now: new Date(),
    });
    store.save(resolved);
    store.audit.append({
      at: new Date().toISOString(),
      ticketId: id,
      actor,
      action: "resolve",
      rationale: summary,
      after: { status: resolved.status, resolvedAt: resolved.sla?.resolvedAt ?? null },
    });

    heading(`Resuelto ${id}`);
    out(resolutionNotice({ ticket: resolved, lang: ticket.lang }));
    out("");
    out("  El ticket esta resuelto pero NO cerrado: cerrarlo requiere un operador.");
    return 0;
  },

  async close(store, args) {
    const id = requireTicketId(args.ticket);
    const operator = required(args, "operator", "identificador del operador que cierra");
    const ticket = store.get(id);

    const closed = applyTransition(ticket, {
      to: STATUS.CLOSED,
      patch: { closure: { by: operator, at: new Date().toISOString() } },
      actor: TICKET_ACTOR.OPERATOR,
      rationale: `Cerrado por ${operator}`,
      now: new Date(),
    });
    store.save(closed);
    store.audit.append({
      at: new Date().toISOString(),
      ticketId: id,
      actor: operator,
      action: "close",
      rationale: args.summary ? String(args.summary) : `Cerrado por ${operator}`,
      after: { status: closed.status },
    });

    heading(`Cerrado ${id}`);
    out(`  cierre ${closed.closure.by} a las ${closed.closure.at}`);
    if (ticket.resolution?.summary) out(`  ${ticket.resolution.summary}`);
    return 0;
  },

  async cancel(store, args) {
    const id = requireTicketId(args.ticket);
    const operator = required(args, "operator");
    const reason = required(args, "reason", "por que se cancela. Un motivo es obligatorio.");
    const ticket = store.get(id);

    const cancelled = applyTransition(ticket, {
      to: STATUS.CANCELLED,
      patch: { cancelReason: reason },
      actor: TICKET_ACTOR.OPERATOR,
      rationale: `Cancelado por ${operator}: ${reason}`,
      now: new Date(),
    });
    store.save(cancelled);
    store.audit.append({
      at: new Date().toISOString(),
      ticketId: id,
      actor: operator,
      action: "cancel",
      rationale: reason,
      after: { status: cancelled.status },
    });
    heading(`Cancelado ${id}`);
    out(`  motivo: ${reason}`);
    return 0;
  },

  async audit(store, args) {
    if (args.verify) {
      const result = store.audit.verify();
      heading("Verificacion de la bitacora");
      out(`  entradas   ${result.checked}`);
      out(`  cadena     ${result.ok ? "intacta" : "ROTA"}`);
      if (!result.ok) bullets([`se rompio en la entrada ${result.brokenAt}`, `esperado ${result.expected?.slice(0, 16)}`, `encontrado ${result.found?.slice(0, 16)}`]);
      return result.ok ? 0 : EXIT.INTEGRITY;
    }

    const entries = args.ticket
      ? store.audit.all().filter((e) => e.ticketId === args.ticket)
      : store.audit.all();
    heading(args.ticket ? `Bitacora de ${args.ticket}` : "Bitacora");
    for (const entry of entries) {
      out(`  ${entry.at}  ${String(entry.ticketId ?? "-").padEnd(11)} ${String(entry.action).padEnd(16)} ${entry.rationale ?? ""}`);
    }
    out("");
    out(`  ${entries.length} entrada(s). La cadena SHA-256 se comprueba con --verify.`);
    return 0;
  },

  async list(store) {
    const tickets = store.all();
    heading(`${tickets.length} ticket(s)`);
    bullets(
      tickets.map(
        (t) =>
          `${t.id}  ${String(t.severity ?? "?").padEnd(3)} ${String(t.status).padEnd(12)} ${String(t.assignedAgent ?? "-").padEnd(20)} ${t.request.subject}`,
      ),
      "  (ninguno)",
    );
    return 0;
  },

  async agents() {
    heading("Agentes");
    for (const agent of AGENTS) {
      out(`  ${agent.id}  [${agent.mode}]`);
      out(`    ${agent.description}`);
      if (agent.categories.length) out(`    categorias: ${agent.categories.join(", ")}`);
      out(`    traspasa a: ${agent.handoffTargets.length ? agent.handoffTargets.join(", ") : "(nadie: es terminal)"}`);
    }
    out("");
    out("  Topologia en src/ecosystem/manifest.js. Comprobada con npm run validate.");
    return 0;
  },

  async demo() {
    return runDemo();
  },
};

/**
 * Demostracion de extremo a extremo, con salida narrada.
 *
 * No es un test: es para ver el sistema funcionando. Por eso imprime el PORQUE
 * de cada paso y no solo su resultado.
 */
async function runDemo() {
  const store = createStore({ dir: "data/demo" });
  const reporter = "E-10482";

  /**
   * Persiste el ticket Y anota la decision en la bitacora, en ese orden.
   *
   * Las dos cosas van juntas a proposito. Anotar la bitacora sin guardar el
   * ticket deja un registro de decisiones sin el objeto sobre el que se
   * tomaron: se lee "se escalo" y no hay ticket que lo demuestre. Guardar sin
   * anotar deja el cambio sin explicar. Haciendolo por separado, `data/demo/`
   * acababa con seis entradas de bitacora y `tickets/` vacio, que es la forma
   * de que una demo que pretende demostrar la auditabilidad la desmienta.
   */
  const persistir = (t, action, rationale, after) => {
    store.save(t);
    store.audit.append({
      at: new Date().toISOString(),
      ticketId: t.id,
      actor: "demo",
      action,
      rationale,
      after,
    });
    return t;
  };

  out("=".repeat(64));
  out("  SERVICIO DE SOPORTE - DEMOSTRACION DE EXTREMO A EXTREMO");
  out("=".repeat(64));

  heading("1. Entra una incidencia que trae una credencial pegada");
  const texto =
    "Hola, soy E-10482, desde ayer no puedo conectarme a la VPN desde casa. " +
    "AnyConnect da error 403 de gateway. He probado a reiniciar el portatil y nada. " +
    "Por si sirve, mi usuario es E-10482 y la contrasena es Tr3boleta2026.";
  out(`  "${texto}"`);

  const { ticket, decision, nextQuestions } = intakeAndTriage({
    text: texto,
    reporter,
    lang: "es",
    now: new Date(),
  });
  out("");
  out("  Lo que se guarda (texto ya saneado):");
  out(`    "${ticket.request.text}"`);
  out(`  Hallazgos eliminados: ${ticket.request.redaction.findings.length}`);
  for (const f of ticket.request.redaction.findings) out(`    - ${f.type}`);
  out("");
  out("  Lo que se recuerda del original (solo la evidencia):");
  out(`    containedSecret:         ${ticket.request.containedSecret}`);
  out(`    userOfferedCredentials:  ${ticket.request.userOfferedCredentials}`);
  out("");
  out("  -> El aviso de seguridad salta porque la senal se calculo ANTES de sanear.");
  out("     Si se calculara despues, daria false y el usuario se quedaria sin avisar.");
  persistir(ticket, "intake", "Incidencia registrada y saneada", {
    findings: ticket.request.redaction.findings.length,
  });

  heading("2. Triaje");
  const triaged = applyTransition(ticket, {
    to: STATUS.TRIAGED,
    patch: {
      category: ticket.category,
      severity: ticket.severity,
      priority: ticket.priority,
      confidence: ticket.confidence,
    },
    actor: ACTOR.SYSTEM,
    rationale: "Clasificacion automatica",
    now: new Date(),
  });
  out(`  categoria    ${triaged.category} (${triaged.typology})`);
  out(`  confianza    ${triaged.confidence}`);
  out(`  severidad    ${triaged.severity}   prioridad ${triaged.priority}`);
  out(`  decision     ${decision.action} -> ${decision.target}`);
  out(`  ${decision.rationale}`);
  out(`  ${decision.priorityExplanation}`);

  persistir(triaged, "triage", decision.rationale, {
    category: triaged.category,
    severity: triaged.severity,
  });

  const routed = handoff({ ticket: triaged, to: initialRoute(triaged), now: new Date() });
  out(`  agente       ${routed.assignedAgent}`);
  persistir(routed, "handoff", routed.history.at(-1).rationale, { agent: routed.assignedAgent });

  heading("3. Diagnostico (RED CERRADA)");
  const report = await diagnose({ ticket: routed, allowNetwork: false });
  out(diagnosisResult({ ticket: routed, report, lang: "es" }));
  out(`  cobertura    ${Math.round(report.summary.coverage * 100)}%`);
  out(`  suficiente   ${report.insufficient ? "NO" : "si"}`);
  out("");
  out("  -> Sin autorizacion no se sale a la red. El informe sale parcial y lo dice,");
  out("     en vez de inventar un fallo con la red forzada.");
  persistir(routed, "diagnosis", `Cobertura ${Math.round(report.summary.coverage * 100)}%`, {
    conclusive: !report.insufficient,
  });

  heading("4. Remediacion (SIMULACION, no toca nada)");
  const simulacion = await remediate({
    ticket: routed,
    playbookId: "network.restart-vpn-client",
    diagnosis: report,
    dryRun: true,
    lang: "es",
  });
  out(`  playbook     ${simulacion.playbook}`);
  out(`  riesgo       ${simulacion.risk}`);
  out(`  estado       ${simulacion.status}`);
  for (const block of simulacion.blocks ?? []) {
    out(`  BLOQUEO      ${block.code}: ${block.reason}  [${block.resolvableBy}]`);
  }
  out("");
  out("  -> Sin diagnostico concluyente no se aplica nada, aunque se pida.");

  heading("5. Escalado a la mesa humana");
  const { escalation, patch, severity } = escalate({
    ticket: routed,
    reason: "missing_diagnosis",
    now: new Date(),
  });
  const escalated = applyTransition(routed, {
    to: STATUS.ESCALATED,
    patch,
    actor: ACTOR.AGENT,
    rationale: "El diagnostico no ha concluido",
    now: new Date(),
  });
  out(`  id           ${escalation.id}`);
  out(`  motivo       ${escalation.reason}`);
  out(`  severidad    ${severity} (suelo ${escalation.severityFloor})`);
  out(`  aceptado     ${escalation.acknowledgedBy ?? "pendiente"}`);
  out("");
  out("  -> El ticket no se puede resolver hasta que alguien lo acepte.");
  persistir(escalated, "escalation", escalation.detail, { reason: escalation.reason });

  heading("6. Resolucion sin aceptacion: BLOQUEADA");
  try {
    applyTransition(
      { ...escalated, resolution: { summary: "Resuelto" } },
      { to: STATUS.RESOLVED, now: new Date() },
    );
    out("  ERROR: deberia haber fallado.");
  } catch (error) {
    out(`  ${error.code}`);
    out(`  ${error.message}`);
  }

  heading("7. Una persona lo acepta y lo resuelve");
  const { escalation: acked } = acknowledge({
    ticket: escalated,
    operator: "mesa-n2",
    now: new Date(),
  });
  const enTrabajo = applyTransition(escalated, {
    to: STATUS.IN_PROGRESS,
    patch: { escalation: acked },
    actor: ACTOR.AGENT,
    rationale: "Aceptado por mesa-n2",
    now: new Date(),
  });
  out(`  aceptado por ${acked.acknowledgedBy}`);

  const resuelto = applyTransition(
    { ...enTrabajo, resolution: { summary: "Renovado el perfil de AnyConnect del usuario." } },
    { to: STATUS.RESOLVED, now: new Date() },
  );
  out(`  ${resuelto.status}  SLA detenido en ${resuelto.sla.resolvedAt}`);
  persistir(resuelto, "resolve", resuelto.resolution.summary, { status: resuelto.status });

  heading("8. Un agente intenta cerrar el ticket");
  try {
    applyTransition({ ...resuelto, closure: { by: "mesa-n2" } }, { to: STATUS.CLOSED, now: new Date(), actor: ACTOR.AGENT });
    out("  ERROR: deberia haber fallado.");
  } catch (error) {
    out(`  ${error.code}`);
    out(`  ${error.message}`);
    out("  -> Un agente resuelve; cerrar lo hace una persona.");
  }

  heading("9. Un operador lo cierra");
  const cerrado = applyTransition(
    { ...resuelto, closure: { by: "mesa-n2" } },
    { to: STATUS.CLOSED, now: new Date(), actor: TICKET_ACTOR.OPERATOR },
  );
  out(`  ${cerrado.status} por ${cerrado.closure.by}`);
  persistir(cerrado, "close", `Cerrado por ${cerrado.closure.by}`, { by: cerrado.closure.by });

  heading("10. Lo que queda en disco");
  const releido = store.get(cerrado.id);
  out(`  ticket        data/demo/tickets/${releido.id}.json`);
  out(`  releido de disco: ${releido.status} por ${releido.closure.by}, ${releido.history.length} pasos`);
  out(`  y la invariante de privacidad sigue cumpliendose al leerlo: no hay nada que sanear`);

  heading("11. La bitacora de todo lo anterior");
  for (const entry of store.audit.all()) {
    out(`  ${String(entry.action).padEnd(11)} ${entry.rationale.slice(0, 58).padEnd(58)} ${entry.hash.slice(0, 12)}`);
  }
  const verificacion = store.audit.verify();
  out("");
  out(`  cadena: ${verificacion.ok ? "intacta" : "ROTA"} (${verificacion.checked} entradas)`);
  out("  -> Alterar una entrada vieja rompe la cadena. Eso es lo que la hace auditable.");

  out("");
  out("=".repeat(64));
  out("  FIN. Un ticket, una credencial eliminada antes de guardarse,");
  out("  ninguna accion destructiva y ninguna decision sin explicar.");
  out("=".repeat(64));
  return 0;
}

/** Adaptador de demostracion: no toca nada real y lo dice. */
function fakeAdapter() {
  return {
    name: "demo",
    available: () => true,
    async apply({ playbook, ticket, actor }) {
      return { ok: true, simulated: true, playbook: playbook.id, ticketId: ticket.id, actor };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Arranque
 * ------------------------------------------------------------------ */

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    out(USAGE);
    return 0;
  }

  const args = parseArgs(rest);
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`Comando desconocido: ${command}\n${USAGE}\n`);
    return EXIT.USAGE;
  }

  // `demo`, `agents` y `help` no necesitan almacen; el resto, si. Se crea
  // perezoso para que un `list` en un directorio limpio no falle.
  const store = ["demo", "agents", "help"].includes(command) ? null : createStore({ dir: args.data ?? "data" });
  try {
    return await handler(store, args);
  } finally {
    void store;
  }
}

// El modulo se importa desde el validador del ecosistema (para comprobar que
// los permisos de cada agente apuntan a comandos que existen de verdad), asi que
// la ejecucion solo arranca cuando este fichero ES el programa principal.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof AppError) {
      process.stderr.write(`\n${error.code}\n${error.message}\n`);
      if (error.details && Object.keys(error.details).length > 0) {
        process.stderr.write(`  ${JSON.stringify(error.details)}\n`);
      }
      process.exitCode = exitCodeFor(error);
    } else {
      process.stderr.write(`\nERROR INESPERADO\n${error.stack ?? error.message}\n`);
      process.exitCode = EXIT.INTERNAL;
    }
  }
}

export { COMMANDS, parseArgs, requireTicketId };
