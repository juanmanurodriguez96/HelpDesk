import test, { suite } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuditLog, hashEntry, humanize, GENESIS } from "../src/audit/audit-log.js";
import { IntegrityError } from "../src/core/errors.js";
import { stableStringify } from "../src/core/canonical-json.js";

function tempLog() {
  const dir = mkdtempSync(join(tmpdir(), "helpdesk-audit-"));
  return { dir, file: join(dir, "audit.log"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ENTRY = {
  ticketId: "HD-4821",
  actor: "identity-support",
  action: "ticket.triaged",
  at: "2026-01-05T08:00:00.000Z",
  rationale: "Clasificado como identity.lockout con confianza 0.92",
};

suite("audit/hash", () => {
  test("una bitacora vacia arranca en el hash raiz", () => {
    assert.equal(GENESIS, "0".repeat(64));
  });

  test("el hash depende del contenido y del previo", () => {
    const a = hashEntry(GENESIS, { action: "x", actor: "y" });
    const b = hashEntry(GENESIS, { action: "x", actor: "z" });
    const c = hashEntry("1".repeat(64), { action: "x", actor: "y" });
    assert.notEqual(a, b, "cambiar el contenido cambia el hash");
    assert.notEqual(a, c, "cambiar el previo cambia el hash");
  });

  test("el hash no depende del orden de las claves", () => {
    const a = hashEntry(GENESIS, { a: 1, b: 2 });
    const b = hashEntry(GENESIS, { b: 2, a: 1 });
    assert.equal(a, b, "un registro reordenado no debe romper la cadena");
  });
});

suite("audit/log", () => {
  test("la primera entrada se encadena con el hash raiz", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      const entry = log.append(ENTRY);
      assert.equal(entry.seq, 1);
      assert.equal(entry.prevHash, GENESIS);
      assert.equal(entry.hash, hashEntry(GENESIS, { ...entry, hash: undefined }));
    } finally {
      cleanup();
    }
  });

  test("cada entrada encadena con la anterior", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      const first = log.append(ENTRY);
      const second = log.append({ ...ENTRY, action: "ticket.responded" });
      assert.equal(second.seq, 2);
      assert.equal(second.prevHash, first.hash);
    } finally {
      cleanup();
    }
  });

  test("verify() confirma una bitacora integra", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      for (let i = 0; i < 5; i += 1) log.append({ ...ENTRY, action: `paso.${i}` });
      const result = log.verify();
      assert.equal(result.ok, true);
      assert.equal(result.checked, 5);
      assert.equal(result.head, log.all().at(-1).hash);
    } finally {
      cleanup();
    }
  });

  test("verify() detecta una entrada alterada", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      log.append(ENTRY);
      log.append({ ...ENTRY, action: "ticket.resolved" });
      log.append({ ...ENTRY, action: "ticket.closed" });

      // Se reescribe el motivo de la segunda entrada, como haria alguien que
      // quiere justificar despues una decision que tomo mal.
      const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      lines[1].rationale = "Lo cerre porque el usuario insistio";
      writeFileSync(file, `${lines.map((l) => stableStringify(l)).join("\n")}\n`, "utf8");

      const result = log.verify();
      assert.equal(result.ok, false, "una bitacora manipulada no puede pasar por intacta");
      assert.equal(result.brokenAt, 2);
      assert.notEqual(result.expected, result.found);
    } finally {
      cleanup();
    }
  });

  test("verify() detecta una entrada eliminada del medio", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      log.append(ENTRY);
      log.append({ ...ENTRY, action: "ticket.responded" });
      log.append({ ...ENTRY, action: "ticket.resolved" });

      const lines = readFileSync(file, "utf8").trim().split("\n");
      lines.splice(1, 1);
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

      const result = log.verify();
      assert.equal(result.ok, false);
      assert.equal(result.brokenAt, 3, "el hueco se manifiesta en la entrada siguiente");
    } finally {
      cleanup();
    }
  });

  test("una linea corrupta se reporta con su numero, no con una excepcion opaca", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      log.append(ENTRY);
      writeFileSync(file, `{ esto no es json\n`, "utf8");
      assert.throws(() => log.all(), (error) => {
        assert.ok(error instanceof IntegrityError);
        assert.equal(error.code, "AUDIT_LINE_CORRUPT");
        assert.equal(error.details.line, 1);
        return true;
      });
    } finally {
      cleanup();
    }
  });

  test("reabre una bitacora existente y sigue la cadena", () => {
    const { file, cleanup } = tempLog();
    try {
      createAuditLog(file).append(ENTRY);
      const reopened = createAuditLog(file);
      const next = reopened.append({ ...ENTRY, action: "ticket.closed" });
      assert.equal(next.seq, 2);
      assert.equal(reopened.verify().ok, true);
    } finally {
      cleanup();
    }
  });

  test("tail() devuelve las ultimas entradas", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      for (let i = 0; i < 4; i += 1) log.append({ ...ENTRY, action: `paso.${i}` });
      assert.deepEqual(log.tail(2).map((e) => e.action), ["paso.2", "paso.3"]);
      assert.equal(log.tail(10).length, 4);
    } finally {
      cleanup();
    }
  });
});

suite("audit/politica", () => {
  test("exige ticket y accion", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      assert.throws(() => log.append({ actor: "x", action: "y" }), /ticket/i);
      assert.throws(() => log.append({ ticketId: "HD-1", actor: "x" }), /accion|action/i);
    } finally {
      cleanup();
    }
  });

  test("rechaza una entrada que lleva material sensible", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      assert.throws(
        () => log.append({ ...ENTRY, context: { note: "la contrasena es hunter2" } }),
        (error) => {
          assert.equal(error.code, "AUDIT_SECRET_REJECTED");
          return true;
        },
      );
      assert.equal(log.all().length, 0, "una entrada rechazada no debe dejar rastro");
    } finally {
      cleanup();
    }
  });

  test("acepta una entrada con texto ya saneado", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      const entry = log.append({ ...ENTRY, context: { note: "el usuario compartio [REDACTED_SECRET] en el mensaje" } });
      assert.equal(entry.context.note.includes("REDACTED_SECRET"), true);
      assert.equal(log.verify().ok, true);
    } finally {
      cleanup();
    }
  });

  test("las claves de credenciales se eliminan aunque no parezcan secretas", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      const entry = log.append({
        ...ENTRY,
        after: { status: "resolved", password: "x", api_key: "x", privateKey: "x", apiKey: "x" },
      });
      assert.deepEqual(entry.after, { status: "resolved" });
    } finally {
      cleanup();
    }
  });
});

suite("audit/humanize", () => {
  test("resume una entrada sin arrastrar los hashes", () => {
    const { file, cleanup } = tempLog();
    try {
      const log = createAuditLog(file);
      const entry = log.append({ ...ENTRY, decision: { from: "new", to: "triaged" } });
      const view = humanize(entry);
      assert.equal(view.accion, "ticket.triaged");
      assert.equal(view.transicion, "new -> triaged");
      assert.equal(view.motivo, ENTRY.rationale);
      assert.equal(view.hash, undefined);
    } finally {
      cleanup();
    }
  });
});
