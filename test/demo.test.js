import test, { suite } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("src/cli.js");
const PASSWORD = "Tr3boleta2026";

/** Corre la demo en un directorio temporal para no tocar `data/` del repo. */
function runDemoInTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helpdesk-demo-"));
  const result = spawnSync(process.execPath, [CLI, "demo"], { cwd: dir, encoding: "utf8" });
  return { dir, result };
}

suite("demo: lo que promete, lo deja en disco", () => {
  test("la demo guarda el ticket, no solo la bitacora", () => {
    const { dir, result } = runDemoInTemp();
    assert.equal(result.status, 0, result.stderr);

    const tickets = fs.readdirSync(path.join(dir, "data/demo/tickets")).filter((f) => f.endsWith(".json"));
    assert.equal(
      tickets.length,
      1,
      `la demo debe dejar UN ticket en disco, no ${tickets.length}. Un data/demo con bitacora y sin tickets desmiente su propia auditoria.`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("el ticket guardado se relee con su recorrido completo", () => {
    const { dir, result } = runDemoInTemp();
    const file = fs.readdirSync(path.join(dir, "data/demo/tickets"))[0];
    const ticket = JSON.parse(fs.readFileSync(path.join(dir, "data/demo/tickets", file), "utf8"));

    assert.equal(ticket.status, "closed");
    assert.equal(ticket.closure.by, "mesa-n2");
    assert.ok(ticket.history.length >= 5, "el historial debe reflejar las transiciones");
    // El rastro guarda quien PASO el ticket; quien lo tiene ahora va en assignedAgent.
    assert.deepEqual(ticket.handoffs.trail, ["helpdesk-orchestrator"]);
    assert.equal(ticket.assignedAgent, "infra-support");
    assert.match(result.stdout, /releido de disco: closed/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("la credencial de la demo no queda ni en el ticket ni en la bitacora", () => {
    const { dir } = runDemoInTemp();
    const ticketPath = path.join(dir, "data/demo/tickets", fs.readdirSync(path.join(dir, "data/demo/tickets"))[0]);
    const auditPath = path.join(dir, "data/demo/audit/bitacora.jsonl");

    assert.equal(fs.readFileSync(ticketPath, "utf8").includes(PASSWORD), false, "la contrasena quedo en el ticket");
    assert.equal(fs.readFileSync(auditPath, "utf8").includes(PASSWORD), false, "la contrasena quedo en la bitacora");

    const ticket = JSON.parse(fs.readFileSync(ticketPath, "utf8"));
    assert.match(ticket.request.text, /\[REDACTED_SECRET\]/);
    assert.equal(ticket.request.containedSecret, true);
    assert.equal(ticket.request.userOfferedCredentials, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("la bitacora cubre cada decision del recorrido", () => {
    const { dir } = runDemoInTemp();
    const lineas = fs
      .readFileSync(path.join(dir, "data/demo/audit/bitacora.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const acciones = lineas.map((e) => e.action);
    for (const esperada of ["intake", "triage", "handoff", "diagnosis", "escalation", "resolve", "close"]) {
      assert.ok(acciones.includes(esperada), `falta la entrada "${esperada}" en la bitacora`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("repetir la demo dos veces no rompe la cadena de hash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helpdesk-demo-"));
    const dirDatos = path.join(dir, "data/demo");
    for (let i = 0; i < 2; i += 1) {
      const r = spawnSync(process.execPath, [CLI, "demo"], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    const r = spawnSync(process.execPath, [CLI, "audit", "--data", dirDatos, "--verify"], { encoding: "utf8" });
    const salida = r.stdout + r.stderr;
    assert.ok(/intacta/.test(salida), `la cadena deberia verificar intacta: ${salida}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
