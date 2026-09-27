/**
 * Recurso auxiliar del procedimiento de diagnostico.
 *
 * Este script es el "recurso auxiliar funcional" que consume la skill
 * `.opencode/skills/helpdesk-diagnosis/SKILL.md`. No duplica la logica de
 * diagnostico: reutiliza los mismos checks y el mismo contexto que
 * `diagnose()`, de modo que lo que el agente ve aqui y lo que acaba en el
 * ticket no pueden divergir.
 *
 * Que hace, en una frase: convierte un ticket en la lista explicita de sondas
 * que hay que ejecutar, y las ejecuta SOLO con autorizacion.
 *
 * Por que existe como script y no solo como prosa en el SKILL.md:
 *
 *   - La lista de destinos comprobables no se deduce leyendo el ticket a ojo. Es
 *     el resultado de cruzar el texto con el catalogo, y equivocarse ahi manda
 *     una sonda a un host que no toca.
 *   - Un recurso que puede no responder necesita un CONTRATO de respuesta, y un
 *     contrato se comprueba con codigos de salida, no con una promesa en el
 *     markdown. Por eso los tres codigos de `EXIT` son parte de la API.
 *
 * Los tres finales posibles, y por que se distinguen:
 *
 *   0 OK          -> Se pudo construir el plan y, si se pidio, sondear.
 *   2 BLOCKED     -> El recurso funciona pero no se puede sondear: la red esta
 *                    cerrada o el ticket no aporta ningun destino comprobable.
 *                    No es un fallo: es la respuesta correcta por defecto.
 *   3 UNAVAILABLE -> El recurso NO respondio: el ticket no existe, este runtime
 *                    no trae `fetch`, o el fichero esta corrupto. aqui no se
 *                    puede afirmar nada, y quien lo consume debe decirlo en voz
 *                    alta en lugar de rellenarlo con suposiciones.
 *
 * La distincion 2 frente a 3 es la que evita el bug caro: un `BLOCKED` que se
 * reporta como `fail` inventa una averia de red que no se ha comprobado, y un
 * `UNAVAILABLE` que se reporta como `unknown` sin más oculta que la herramienta
 * estaba rota.
 *
 * Uso:
 *   node tools/probe-endpoints.mjs --ticket HD-xxxx
 *   node tools/probe-endpoints.mjs --ticket HD-xxxx --allow-network
 *   node tools/probe-endpoints.mjs --ticket HD-xxxx --allow-network --json
 */

import process from "node:process";
import { pathToFileURL } from "node:url";

import { runCheck, summarize } from "../src/diagnostics/check.js";
import {
  NETWORK_CHECKS,
  SERVICE_CHECKS,
  contextFromTicket,
  networkAllowed,
} from "../src/diagnostics/network-checks.js";
import { createStore } from "../src/infra/store.js";

/** Identificador del recurso, tal y como lo cita la skill. */
export const RESOURCE_ID = "tools/probe-endpoints.mjs";

/** Codigos de salida. Parte del contrato con la skill. */
export const EXIT = Object.freeze({
  OK: 0,
  BLOCKED: 2,
  UNAVAILABLE: 3,
});

/** Checks que salen a la red, en el orden en que conviene sondearlos. */
const LIVE_CHECKS = [...NETWORK_CHECKS, ...SERVICE_CHECKS].filter((c) => c.source === "live");

/**
 * Plan de sondas derivado del contexto de un ticket.
 *
 * Es una funcion PURA: mismo contexto, mismo plan. No toca la red, no lee disco y
 * no depende del reloj, asi que se puede comprobar entera en las pruebas sin
 * abrir un socket.
 *
 * @param {object} ctx Contexto devuelto por `contextFromTicket()`.
 * @returns {{probeable: boolean, reason: string|null, targets: object[], static: object[]}}
 */
export function buildProbePlan(ctx) {
  const service = ctx.service ?? null;
  const targets = [];

  for (const hostname of ctx.hostnames ?? []) {
    targets.push({ kind: "dns", host: hostname, detail: "Resolucion de nombres" });
  }
  for (const ip of ctx.ips ?? []) {
    targets.push({ kind: "tcp", host: ip, detail: "Alcanzabilidad de la direccion" });
  }
  for (const port of ctx.ports ?? []) {
    const hosts = [...(ctx.hostnames ?? []), ...(ctx.ips ?? [])];
    for (const host of hosts) {
      targets.push({ kind: "port", host, port, detail: `Puerto ${port} abierto` });
    }
  }
  if (ctx.url) {
    targets.push({ kind: "http", host: ctx.url, detail: "Endpoint de salud" });
  }

  // Lo que se sabe SIN salir a la red tambien se lista. Un agente que solo ve la
  // parte viva de este plan pierde la informacion de que el servicio es
  // diagnosticable, que es justo lo que decide si hay algo que sondear.
  const staticChecks = SERVICE_CHECKS.filter((c) => c.source === "static").map((c) => ({
    id: c.id,
    label: c.label,
    service: service?.id ?? null,
  }));

  let reason = null;
  if (targets.length === 0) {
    reason =
      "El ticket no aporta ningun destino comprobable: sin host, IP, puerto ni endpoint de salud conocidos.";
  }

  return { probeable: targets.length > 0, reason, targets, static: staticChecks, service };
}

/**
 * Ejecuta los checks `live` del plan.
 *
 * Los `unknown` que devuelve `runCheck()` cuando un comprobador LANZA no se
 * convierten en `fail`: se reportan como `unknown` con su motivo. Un
 * comprobador roto no es un sintoma del sistema.
 *
 * @param {object} ctx
 * @returns {Promise<{results: object[], summary: object}>}
 */
export async function runLiveChecks(ctx) {
  const results = [];
  for (const check of LIVE_CHECKS) {
    results.push(await runCheck(check, ctx));
  }
  return { results, summary: summarize(results) };
}

/**
 * Comprueba si este runtime puede siquiera intentar sondear.
 *
 * Separado de la ejecucion para que el fallo se distinga del "no autorizado":
 * sin `fetch` el recurso esta ROTO, no bloqueado.
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export function probeCapability() {
  if (typeof globalThis.fetch !== "function") {
    return { ok: false, reason: "Este runtime no expone fetch: la sonda HTTP no puede ejecutarse." };
  }
  return { ok: true, reason: null };
}

/**
 * Ejecuta el recurso completo y devuelve su informe.
 *
 * Devuelve tambien `exitCode` para que la capa de CLI no tenga que reimplementar
 * la politica: la funcion que decide es una sola.
 *
 * @param {object} args
 * @param {object} [args.ticket]        Ticket ya leido.
 * @param {boolean} [args.allowNetwork]
 * @param {boolean} [args.probe]        Intentar sondear de verdad.
 * @returns {Promise<{exitCode: number, plan: object, results: object[], summary: object|null, report: string}>}
 */
export async function probeEndpoints({ ticket, allowNetwork = false, probe = false }) {
  const ctx = contextFromTicket(ticket, { allowNetwork });
  const plan = buildProbePlan(ctx);

  if (!plan.probeable) {
    return {
      exitCode: EXIT.BLOCKED,
      plan,
      results: [],
      summary: null,
      report: formatPlan(plan, { exitCode: EXIT.BLOCKED }),
    };
  }

  if (!probe) {
    return {
      exitCode: EXIT.BLOCKED,
      plan,
      results: [],
      summary: null,
      report: formatPlan(plan, { exitCode: EXIT.BLOCKED }),
    };
  }

  if (!networkAllowed(allowNetwork)) {
    return {
      exitCode: EXIT.BLOCKED,
      plan,
      results: [],
      summary: null,
      report: formatPlan(plan, {
        exitCode: EXIT.BLOCKED,
        notice: "Red cerrada: el plan es real pero no se ejecuta ninguna sonda. Pasa --allow-network solo en un entorno controlado.",
      }),
    };
  }

  const capability = probeCapability();
  if (!capability.ok) {
    return {
      exitCode: EXIT.UNAVAILABLE,
      plan,
      results: [],
      summary: null,
      report: formatPlan(plan, { exitCode: EXIT.UNAVAILABLE, notice: capability.reason }),
    };
  }

  const { results, summary } = await runLiveChecks(ctx);
  return {
    exitCode: EXIT.OK,
    plan,
    results,
    summary,
    report: formatPlan(plan, { exitCode: EXIT.OK, results, summary }),
  };
}

/**
 * Informe en texto para el agente.
 *
 * @param {object} plan
 * @param {object} [options]
 * @param {number} [options.exitCode]
 * @param {string} [options.notice]
 * @param {object[]} [options.results]
 * @param {object}   [options.summary]
 * @returns {string}
 */
export function formatPlan(plan, { exitCode = EXIT.OK, notice = null, results = [], summary = null } = {}) {
  const lines = [];
  lines.push(`Recurso auxiliar: ${RESOURCE_ID}`);
  lines.push(`Servicio: ${plan.service?.id ?? "sin servicio en el catalogo"}`);
  lines.push(`Destinos comprobables: ${plan.targets.length}`);

  for (const target of plan.targets) {
    const where = target.kind === "port" ? `${target.host}:${target.port}` : target.host;
    lines.push(`  - [${target.kind}] ${where} (${target.detail})`);
  }
  if (plan.static.length > 0) {
    lines.push(`Comprobaciones estaticas disponibles: ${plan.static.map((s) => s.id).join(", ")}`);
  }

  if (summary) {
    lines.push(
      `Cobertura: ${summary.coverage} | Acuerdo: ${summary.agreement} | pass ${summary.pass} / fail ${summary.fail} / unknown ${summary.unknown}`,
    );
    for (const r of results) {
      lines.push(`  - ${r.id}: ${r.verdict} (${r.detail})`);
    }
  }
  if (notice) lines.push(`Aviso: ${notice}`);
  if (plan.reason) lines.push(`Motivo: ${plan.reason}`);

  lines.push(`Fin del informe (codigo ${exitCode})`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Capa de linea de comandos
 * ------------------------------------------------------------------ */

/** Analiza los argumentos de la CLI. */
export function parseArgs(argv) {
  const args = { ticket: null, allowNetwork: false, probe: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--ticket") args.ticket = argv[++i] ?? null;
    else if (token === "--allow-network") args.allowNetwork = true;
    else if (token === "--probe") args.probe = true;
    else if (token === "--json") args.json = true;
  }
  if (args.allowNetwork) args.probe = true;
  return args;
}

/**
 * Carga el ticket desde el almacen.
 *
 * @param {string} id
 * @param {string} dir
 * @returns {{ok: true, ticket: object}|{ok: false, reason: string}}
 */
export function loadTicket(id, dir) {
  if (!id) return { ok: false, reason: "Falta --ticket." };
  try {
    const store = createStore({ dir });
    return { ok: true, ticket: store.get(id) };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const loaded = loadTicket(args.ticket, process.env.HELPDESK_DATA_DIR ?? "data");
  if (!loaded.ok) {
    process.stderr.write(`${RESOURCE_ID}: ${loaded.reason}\n`);
    process.exitCode = EXIT.UNAVAILABLE;
    return;
  }
  const outcome = await probeEndpoints({
    ticket: loaded.ticket,
    allowNetwork: args.allowNetwork,
    probe: args.probe,
  });
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ exitCode: outcome.exitCode, plan: outcome.plan, results: outcome.results, summary: outcome.summary }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${outcome.report}\n`);
  }
  process.exitCode = outcome.exitCode;
}

// Se compara contra `pathToFileURL()`, no contra una plantilla `file://${argv}`.
// En Windows `process.argv[1]` trae barras invertidas y espacios sin escapar, y
// `import.meta.url` trae barras normales y el espacio en `%20`: las cadenas nunca
// coinciden, `main()` no llega a ejecutarse y el script sale con codigo 0 sin
// haber hecho nada. Un recurso auxiliar que no hace nada y aun asi parece
// funcionamiento es peor que no tenerlo.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
