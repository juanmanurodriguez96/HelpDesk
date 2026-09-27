import test, { suite } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../src/infra/store.js";
import { intakeAndTriage } from "../src/triage/index.js";
import { applyTransition } from "../src/domain/lifecycle.js";
import { STATUS, ACTOR } from "../src/domain/ticket.js";
import { escalate } from "../src/escalation/index.js";
import { handoff } from "../src/ecosystem/index.js";
import { IntegrityError, ValidationError } from "../src/core/errors.js";
import { ALPHABET, TICKET_ID_RE, newTicketId } from "../src/core/ids.js";

const NOW = new Date("2026-01-05T08:00:00Z");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "helpdesk-store-"));
}

function triagedTicket(text) {
  const { ticket } = intakeAndTriage({ text, reporter: "E-99001", now: NOW });
  return applyTransition(ticket, {
    to: STATUS.TRIAGED,
    patch: {
      category: ticket.category,
      severity: ticket.severity,
      priority: ticket.priority,
      confidence: ticket.confidence,
    },
    actor: ACTOR.SYSTEM,
    now: NOW,
  });
}

suite("infra/identificadores", () => {
  test("los ids de ticket son legibles y no se confunden entre si", () => {
    const ids = new Set();
    for (let i = 0; i < 2000; i += 1) {
      const id = newTicketId();
      assert.match(id, TICKET_ID_RE, id);
      // Sin O/0 ni I/1 ni S/5: un operador lee esto por telefono.
      assert.doesNotMatch(id, /[O0I1L5S]/, id);
      ids.add(id);
    }
    assert.ok(ids.size > 1990, `demasiadas colisiones: ${2000 - ids.size}`);
  });
});

suite("infra/store", () => {
  test("un ticket guardado se recupera igual", () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const ticket = triagedTicket("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");

    store.save(ticket);
    const leido = store.get(ticket.id);

    assert.equal(leido.id, ticket.id);
    assert.equal(leido.category, ticket.category);
    assert.deepEqual(leido.request, ticket.request);
    assert.equal(store.exists(ticket.id), true);
  });

  test("el ticket en disco es JSON legible, no un formato opaco", () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const ticket = triagedTicket("No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway");
    store.save(ticket);

    const raw = fs.readFileSync(path.join(dir, "tickets", `${ticket.id}.json`), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.id, ticket.id);
    // Las claves del ticket se leen en la primera linea: es lo que permite
    // abrir un ticket con un editor a las tres de la manana.
    assert.ok(raw.includes('"request"'));
  });

  test("la escritura es atomica: no quedan ficheros temporales", () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const ticket = triagedTicket("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    store.save(ticket);

    const files = fs.readdirSync(path.join(dir, "tickets"));
    assert.deepEqual(files, [`${ticket.id}.json`]);
  });

  test("un ticket inexistente es un error de validacion, no un undefined", () => {
    const store = createStore({ dir: tempDir() });
    assert.throws(
      () => store.get("HD-ZZZZZZ"),
      (error) => error instanceof ValidationError && error.code === "TICKET_NOT_FOUND",
    );
  });

  test("un ticket corrupto en disco se delata al leerlo", () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const ticket = triagedTicket("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    store.save(ticket);

    fs.writeFileSync(path.join(dir, "tickets", `${ticket.id}.json`), "{ esto no es json", "utf8");
    assert.throws(
      () => store.get(ticket.id),
      (error) => error instanceof IntegrityError && error.code === "TICKET_UNREADABLE",
    );
  });

  test("un ticket manipulado a mano se delata en sus invariantes", () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const ticket = triagedTicket("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    store.save(ticket);

    // Alguien edita el fichero y pone un estado que no existe.
    const file = path.join(dir, "tickets", `${ticket.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.status = "inventado";
    fs.writeFileSync(file, JSON.stringify(raw), "utf8");

    assert.throws(
      () => store.get(ticket.id),
      (error) => error instanceof IntegrityError && error.code === "TICKET_INVALID",
    );
  });

  test("un ticket con una credencial metida a mano se rechaza al leerlo", () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const ticket = triagedTicket("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    store.save(ticket);

    const file = path.join(dir, "tickets", `${ticket.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.request.text = "mi contrasena es Tr3boleta2026 y no entro";
    fs.writeFileSync(file, JSON.stringify(raw), "utf8");

    assert.throws(
      () => store.get(ticket.id),
      (error) => error instanceof IntegrityError && error.code === "TICKET_PRIVACY",
    );
  });

  test("guardar un ticket con material sensible se rechaza antes de escribir", () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const ticket = triagedTicket("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const sucio = { ...ticket, resolution: { summary: "hecho, contrasena Tr3boleta2026" } };

    assert.throws(() => store.save(sucio));
    assert.equal(fs.readdirSync(path.join(dir, "tickets")).length, 0, "no debe quedar nada escrito");
  });

  test("listar devuelve los tickets ordenados", () => {
    const dir = tempDir();
    const store = createStore({ dir });
    const textos = [
      "Usuario E-10482 con la cuenta bloqueada por exceso de intentos",
      "No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway",
      "Solicito acceso de escritura al repositorio data-platform para el usuario E-10482",
    ];
    for (const texto of textos) store.save(triagedTicket(texto));

    const ids = store.all().map((t) => t.id);
    assert.equal(ids.length, 3);
    assert.deepEqual(ids, [...ids].sort());
  });
});

suite("infra/bitacora", () => {
  test("la bitacora encadena las entradas y se verifica", () => {
    const store = createStore({ dir: tempDir() });
    for (const action of ["intake", "triage", "resolve"]) {
      store.audit.append({ at: NOW.toISOString(), ticketId: "HD-AAAAAA", actor: "test", action, rationale: `paso ${action}` });
    }
    const result = store.audit.verify();
    assert.equal(result.ok, true);
    assert.equal(result.checked, 3);
  });

  test("alterar una entrada vieja rompe la cadena", () => {
    const store = createStore({ dir: tempDir() });
    for (const action of ["intake", "triage", "resolve"]) {
      store.audit.append({ at: NOW.toISOString(), ticketId: "HD-AAAAAA", actor: "test", action, rationale: `paso ${action}` });
    }
    const file = store.audit.file;
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const segunda = JSON.parse(lines[1]);
    segunda.rationale = "paso triage (mentira)";
    lines[1] = JSON.stringify(segunda);
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

    const result = store.audit.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2);
  });

  test("una entrada con material sensible se rechaza", () => {
    const store = createStore({ dir: tempDir() });
    assert.throws(() =>
      store.audit.append({
        at: NOW.toISOString(),
        ticketId: "HD-AAAAAA",
        actor: "test",
        action: "intake",
        rationale: "el usuario dijo contrasena Tr3boleta2026",
      }),
    );
  });
});

suite("infra/almacenamiento-integrado", () => {
  test("el ciclo completo de un ticket sobrevive a ir y venir de disco", () => {
    const dir = tempDir();
    const store = createStore({ dir });

    let ticket = triagedTicket("No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway");
    ticket = handoff({ ticket, to: "infra-support", now: NOW });
    store.save(ticket);

    const leido = store.get(ticket.id);
    assert.equal(leido.assignedAgent, "infra-support");
    assert.deepEqual(leido.handoffs.trail, ["helpdesk-orchestrator"]);

    const { escalation, patch } = escalate({ ticket: leido, reason: "missing_diagnosis", now: NOW });
    const escalado = applyTransition(leido, {
      to: STATUS.ESCALATED,
      patch,
      actor: ACTOR.AGENT,
      rationale: "diagnostico insuficiente",
      now: NOW,
    });
    store.save(escalado);

    const final = store.get(ticket.id);
    assert.equal(final.status, STATUS.ESCALATED);
    assert.equal(final.escalation.id, escalation.id);
    assert.equal(final.escalation.acknowledgedBy, null);
  });
});

suite("ids: las cifras del comentario las verifica un test", () => {
  // El comentario de `src/core/ids.js` afirma "28 caracteres" y "481.890.304
  // combinaciones". Dos cifras escritas a mano se pudren en silencio: el dia
  // que alguien anade un caracter al alfabeto, el codigo pasa los 244 tests y
  // el comentario sigue mintiendo. Asi que las cifras se derivan aqui de la
  // expresion regular que usa el sistema y se comparan contra el texto real
  // del comentario. Si divergen, el test falla.
  const clase = TICKET_ID_RE.source.match(/\[([^\]]+)\]/)[1];
  const alfabeto = [...clase];
  const combinaciones = alfabeto.length ** 6;

  /** 481890304 -> "481.890.304", el separador que usa el comentario. */
  const enEspanol = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  const comentario = fs.readFileSync(new URL("../src/core/ids.js", import.meta.url), "utf8");

  test("el alfabeto no tiene caracteres repetidos", () => {
    assert.equal(new Set(alfabeto).size, alfabeto.length);
  });

  test("los caracteres que se confunden al dictar estan fuera", () => {
    for (const ambiguo of ["0", "1", "O", "I", "L", "5", "S"]) {
      assert.equal(alfabeto.includes(ambiguo), false, `"${ambiguo}" no deberia estar en el alfabeto`);
    }
  });

  test("el validador acepta cualquier caracter del alfabeto que genera", () => {
    // Determinista, no muestreo aleatorio. Si ALPHABET y TICKET_ID_RE se
    // separaran, generar 200 ids lo detectaria casi siempre; esto lo detecta
    // siempre, y ademas cubre el caso en que el alfabeto se encoge, que el
    // muestreo nunca veria porque todo lo generado seguiria siendo valido.
    for (const caracter of ALPHABET) {
      assert.ok(
        TICKET_ID_RE.test(`HD-${caracter.repeat(6)}`),
        `el alfabeto genera "${caracter}" pero el validador lo rechaza`,
      );
    }
    assert.equal(ALPHABET.length, alfabeto.length, "el validador debe cubrir el alfabeto entero");
  });

  test("el comentario dice cuantos caracteres tiene, y dice bien", () => {
    assert.match(
      comentario,
      new RegExp(`son ${alfabeto.length} en vez de 36`),
      `el comentario deberia decir "son ${alfabeto.length} en vez de 36"; el alfabeto tiene ${alfabeto.length}`,
    );
  });

  test("el comentario dice cuantas combinaciones deja, y dice bien", () => {
    const esperado = enEspanol(combinaciones);
    assert.ok(
      comentario.includes(esperado),
      `el comentario deberia mencionar ${esperado} combinaciones; ${alfabeto.length}^6 son ${combinaciones}`,
    );
  });
});
