import test, { suite } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  EXIT,
  RESOURCE_ID,
  buildProbePlan,
  formatPlan,
  loadTicket,
  parseArgs,
  probeCapability,
  probeEndpoints,
} from "../tools/probe-endpoints.mjs";
import { contextFromTicket } from "../src/diagnostics/index.js";
import { intakeAndTriage } from "../src/triage/index.js";
import { createStore } from "../src/infra/store.js";

const NOW = new Date("2026-01-05T08:00:00Z");

/** Ticket minimo con el contexto que necesita `contextFromTicket()`. */
function ticketCon(host, { ports = [] } = {}) {
  const { ticket } = intakeAndTriage(
    { text: `La VPN no conecta desde ${host}`, reporter: "marta", channel: "email", lang: "es", now: NOW },
  );
  if (ports.length > 0) {
    ticket.entities.impactedService = "vpn";
  }
  return ticket;
}

/**
 * Ticket sin servicio identificado ni host nombrado: el caso en el que el
 * recurso NO tiene nada que sondear. Se construye a mano a proposito, porque un
 * ticket real casi siempre acaba clasificado en un servicio del catalogo, y si no
 * se pinara el contexto el test no probaria el caso que dice probar.
 */
const ticketSinDestino = {
  id: "HD-sin-destino-0001",
  entities: {},
  request: { text: "el despacho no tiene salida a internet desde ayer" },
};

suite("probe-endpoints: recurso auxiliar del diagnostico", () => {
  test("el recurso esta en disco y es ejecutable por node", () => {
    const full = path.resolve(RESOURCE_ID);
    assert.ok(fs.existsSync(full), `${RESOURCE_ID} deberia existir`);
    assert.match(fs.readFileSync(full, "utf8"), /^#!\/usr\/bin\/env node|mjs/);
  });

  test("el plan lista los destinos que se deducen del ticket y del catalogo", () => {
    const ctx = contextFromTicket(ticketCon("vpn.corp.example"));
    const plan = buildProbePlan(ctx);

    assert.equal(plan.probeable, true);
    assert.equal(plan.reason, null);
    const hosts = plan.targets.map((t) => t.host);
    assert.ok(hosts.includes("vpn.corp.example"), "debe listar el host nombrado en el ticket");
    assert.ok(
      plan.targets.some((t) => t.kind === "http"),
      "debe listar el endpoint de salud derivado del servicio",
    );
    assert.ok(plan.static.length > 0, "debe listar tambien las comprobaciones estaticas");
  });

  test("un ticket sin ningun destino comprobable no inventa sondas", () => {
    const ctx = contextFromTicket(ticketSinDestino);
    const plan = buildProbePlan(ctx);

    assert.equal(plan.probeable, false);
    assert.equal(plan.targets.length, 0);
    assert.match(plan.reason, /ningun destino comprobable/);
  });

  test("el plan es puro: mismo contexto, mismo plan", () => {
    const ctx = contextFromTicket(ticketCon("vpn.corp.example"));
    assert.deepEqual(buildProbePlan(ctx), buildProbePlan(ctx));
  });

  test("sin autorizacion el recurso responde BLOCKED, no un fallo de red", async () => {
    const ticket = ticketCon("vpn.corp.example");
    const outcome = await probeEndpoints({ ticket, allowNetwork: false, probe: false });

    assert.equal(outcome.exitCode, EXIT.BLOCKED);
    assert.equal(outcome.results.length, 0, "no debe ejecutar ninguna sonda");
    assert.equal(outcome.summary, null);
  });

  test("pedir sondas sin autorizacion sigue siendo BLOCKED, con aviso", async () => {
    const ticket = ticketCon("vpn.corp.example");
    const outcome = await probeEndpoints({ ticket, allowNetwork: false, probe: true });

    assert.equal(outcome.exitCode, EXIT.BLOCKED);
    assert.equal(outcome.results.length, 0);
    assert.match(outcome.report, /Red cerrada/);
  });

  test("sin destinos comprobables el recurso responde BLOCKED con motivo", async () => {
    const outcome = await probeEndpoints({
      ticket: ticketSinDestino,
      allowNetwork: true,
      probe: true,
    });

    assert.equal(outcome.exitCode, EXIT.BLOCKED);
    assert.match(outcome.report, /Motivo: /);
  });

  test("un ticket inexistente se reporta como recurso no disponible, no como BLOCKED", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helpdesk-probe-"));
    const loaded = loadTicket("HD-inexistente-0001", dir);

    assert.equal(loaded.ok, false);
    assert.match(loaded.reason, /No existe el ticket/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("sin --ticket se dice cual falta en vez de sondear a ciegas", () => {
    const loaded = loadTicket(null, os.tmpdir());
    assert.equal(loaded.ok, false);
    assert.match(loaded.reason, /Falta --ticket/);
  });

  test("si el runtime no trae fetch la capacidad lo declara no disponible", () => {
    const original = globalThis.fetch;
    try {
      delete globalThis.fetch;
      const capability = probeCapability();
      assert.equal(capability.ok, false);
      assert.match(capability.reason, /fetch/);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("el informe incluye el codigo de salida para que el agente lo compruebe", () => {
    const plan = buildProbePlan(contextFromTicket(ticketCon("vpn.corp.example")));
    const report = formatPlan(plan, { exitCode: EXIT.BLOCKED });

    assert.match(report, new RegExp(RESOURCE_ID.replace(/[./]/g, "\\$&")));
    assert.match(report, new RegExp(`codigo ${EXIT.BLOCKED}`));
  });

  test("parseArgs entiende los flags del skill y --allow-network imply sonda", () => {
    const plain = parseArgs(["--ticket", "HD-1"]);
    assert.equal(plain.ticket, "HD-1");
    assert.equal(plain.probe, false);
    assert.equal(plain.allowNetwork, false);

    const open = parseArgs(["--ticket", "HD-1", "--allow-network", "--json"]);
    assert.equal(open.allowNetwork, true);
    assert.equal(open.probe, true, "--allow-network debe implicar --probe");
    assert.equal(open.json, true);
  });
});

suite("probe-endpoints: el script se ejecuta de verdad", () => {
  /**
   * Se lanza como proceso hijo, no se llama a `main()` desde aqui. Es la unica
   * forma de cubrir el guardia de ejecucion: comparar `import.meta.url` con
   * `process.argv[1]` mediante una plantilla de texto falla en Windows (barras
   * invertidas y `%20` en el espacio), el proceso sale con codigo 0 sin haber
   * hecho nada y todos los tests de arriba pasan igual muerto.
   */
  function run(args, dataDir) {
    return spawnSync(process.execPath, [path.resolve(RESOURCE_ID), ...args], {
      encoding: "utf8",
      env: { ...process.env, HELPDESK_DATA_DIR: dataDir },
    });
  }

  test("sin argumentos dice cual falta y sale con codigo 3", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helpdesk-probe-cli-"));
    const result = run([], dir);

    assert.equal(result.status, EXIT.UNAVAILABLE);
    assert.match(result.stderr, /Falta --ticket/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("un ticket inexistente sale con codigo 3, no con 0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helpdesk-probe-cli-"));
    const result = run(["--ticket", "HD-NO-EXISTE-1"], dir);

    assert.equal(result.status, EXIT.UNAVAILABLE);
    assert.match(result.stderr, /No existe el ticket/);
    assert.equal(result.stdout, "", "un recurso que no puede leer nada no imprime un informe");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("con la red cerrada imprime el plan y sale con codigo 2", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helpdesk-probe-cli-"));
    const store = createStore({ dir });
    const { ticket } = intakeAndTriage(
      { text: "No me conecto a la VPN, falla vpn.corp.example", reporter: "marta", channel: "email", lang: "es", now: NOW },
    );
    store.save(ticket);

    const result = run(["--ticket", ticket.id], dir);

    assert.equal(result.status, EXIT.BLOCKED);
    assert.match(result.stdout, /Destinos comprobables: [1-9]/);
    assert.match(result.stdout, new RegExp(`codigo ${EXIT.BLOCKED}`));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
