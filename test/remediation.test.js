import test, { suite } from "node:test";
import assert from "node:assert/strict";

import { remediate, evaluate, PLAYBOOKS, playbookById, playbooksForCategory } from "../src/remediation/index.js";
import { intakeAndTriage } from "../src/triage/index.js";
import { diagnose } from "../src/diagnostics/index.js";
import { PolicyError } from "../src/core/errors.js";
import { assertSafeQuestion } from "../src/privacy/pii.js";

const NOW = new Date("2026-01-05T08:00:00Z");

/** Adaptador de pruebas: cuenta llamadas y permite observar la orden. */
function spyAdapter({ available = true, failWith = null } = {}) {
  const calls = [];
  return {
    name: "spy",
    calls,
    available: () => available,
    async apply({ playbook, ticket, actor }) {
      calls.push({ playbook: playbook.id, ticketId: ticket.id, actor });
      if (failWith) throw failWith;
      return { ok: true, action: playbook.action };
    },
  };
}

/** Diagnostico sintetico, sin tocar la red. */
function conclusiveDiagnosis(confidence = 0.9) {
  return { cause: { conclusive: true, confidence, rule: "dns_failure" }, summary: { coverage: 1 } };
}

async function ticketFor(text) {
  const { ticket } = intakeAndTriage({ text, reporter: "E-99001", now: NOW });
  return ticket;
}

suite("remediation/playbooks", () => {
  test("cada playbook declara riesgo, requisitos y como se deshace", () => {
    for (const p of PLAYBOOKS) {
      assert.ok(["reversible", "disruptive", "destructive"].includes(p.risk), `${p.id}: riesgo desconocido`);
      assert.ok(Array.isArray(p.requires), `${p.id}: requisitos`);
      assert.ok(typeof p.rollback === "string" && p.rollback.length > 0, `${p.id}: sin rollback`);
      assert.ok(p.guidance.es && p.guidance.en, `${p.id}: guía incompleta`);
      assert.ok(p.guidance.es.summary && p.guidance.es.steps.length > 0, `${p.id}: guía sin pasos`);
    }
  });

  test("reiniciar el equipo del usuario es destructivo, no disruptive", () => {
    // Es la accion mas parecida a "solo un reinicio" y la que mas trabajo tira.
    assert.equal(playbookById("endpoint.restart-device").risk, "destructive");
  });

  test("las guias no piden credenciales al usuario", () => {
    // La comprobacion va con el guardia real: una guia puede LEGRAR de
    // contrasenas ("si no recuerdas la contrasena, es otra incidencia") sin que
    // este pidiendo una. Lo que prohibimos es la peticion.
    for (const p of PLAYBOOKS) {
      for (const lang of ["es", "en"]) {
        const textos = [
          p.guidance[lang].summary,
          p.guidance[lang].caution,
          ...p.guidance[lang].steps,
        ];
        for (const texto of textos) {
          assert.doesNotThrow(
            () => assertSafeQuestion(texto),
            `${p.id} (${lang}) pide credenciales: ${texto}`,
          );
        }
      }
    }
  });

  test("los playbooks se localizan por categoria", () => {
    const vpn = playbooksForCategory("network.vpn");
    assert.equal(vpn.length, 1);
    assert.equal(vpn[0].action, "restartVpnClient");
  });
});

suite("remediation/compuertas", () => {
  test("sin diagnostico concluyente no se aplica nada", async () => {
    const ticket = await ticketFor("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const resultado = await remediate({ ticket, playbookId: "identity.unlock-account", dryRun: false, adapter: spyAdapter() });
    assert.equal(resultado.executed, false);
    assert.equal(resultado.status, "blocked");
    assert.ok(resultado.blocks.some((b) => b.code === "DIAGNOSIS_NOT_CONCLUSIVE"));
    assert.ok(resultado.awaiting.includes("agent"));
  });

  test("un diagnostico no concluyente bloquea igual que uno ausente", async () => {
    const ticket = await ticketFor("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const sinConfianza = { cause: { conclusive: false, confidence: 0.4 } };
    const resultado = await remediate({
      ticket,
      playbookId: "identity.unlock-account",
      diagnosis: sinConfianza,
      dryRun: false,
      adapter: spyAdapter(),
    });
    assert.equal(resultado.executed, false);
    assert.ok(resultado.blocks.some((b) => b.code === "DIAGNOSIS_NOT_CONCLUSIVE"));
  });

  test("faltan datos obligatorios -> bloqueado y desbloqueable por el usuario", async () => {
    const ticket = await ticketFor("Solicito acceso al repositorio data-platform");
    const resultado = await remediate({
      ticket,
      playbookId: "access.grant-repository",
      diagnosis: conclusiveDiagnosis(),
      dryRun: false,
      adapter: spyAdapter(),
    });
    assert.equal(resultado.executed, false);
    assert.ok(resultado.missing.includes("targetResource") || resultado.missing.includes("affectedUser"));
    assert.ok(resultado.blocks.some((b) => b.resolvableBy === "user"));
  });

  test("una accion destructiva exige confirmacion humana", async () => {
    const ticket = await ticketFor("Mi portatil va muy lento y se cuelga, usuario E-10482");
    const veredicto = evaluate({
      playbook: playbookById("endpoint.restart-device"),
      ticket,
      diagnosis: conclusiveDiagnosis(),
    });
    assert.equal(veredicto.allowed, false);
    assert.ok(veredicto.blocks.some((b) => b.code === "HUMAN_CONFIRMATION_REQUIRED"));
  });

  test("una accion disruptiva con confianza baja tambien se detiene", async () => {
    const ticket = await ticketFor("Usuario E-10482 pide acceso de escritura al repositorio data-platform");
    const veredicto = evaluate({
      playbook: playbookById("access.grant-repository"),
      ticket,
      diagnosis: conclusiveDiagnosis(0.6),
    });
    assert.equal(veredicto.allowed, false);
    assert.ok(veredicto.blocks.some((b) => b.code === "DISRUPTIVE_LOW_CONFIDENCE"));
  });

  test("el evaluador nunca devuelve solo un booleano", () => {
    const veredicto = evaluate({ playbook: playbookById("endpoint.restart-device"), ticket: { entities: {} } });
    assert.ok(Array.isArray(veredicto.blocks));
    assert.ok(veredicto.blocks.length > 0);
    for (const block of veredicto.blocks) {
      assert.ok(block.code && block.reason, "cada bloqueo explica por que y quien lo resuelve");
    }
  });
});

suite("remediation/ejecucion", () => {
  test("por defecto solo simula: nada se ejecuta sin dryRun false", async () => {
    const ticket = await ticketFor("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const adapter = spyAdapter();
    const resultado = await remediate({
      ticket,
      playbookId: "identity.unlock-account",
      diagnosis: conclusiveDiagnosis(),
      adapter,
    });
    assert.equal(resultado.status, "planned");
    assert.equal(resultado.executed, false);
    assert.equal(adapter.calls.length, 0, "una simulacion no puede llamar al adaptador");
  });

  test("con autorizacion y adaptador, la accion se aplica y queda registrada", async () => {
    const ticket = await ticketFor("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const adapter = spyAdapter();
    const resultado = await remediate({
      ticket,
      playbookId: "identity.unlock-account",
      diagnosis: conclusiveDiagnosis(),
      adapter,
      dryRun: false,
      actor: "identity-support",
    });
    assert.equal(resultado.status, "applied");
    assert.equal(resultado.executed, true);
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0].actor, "identity-support");
    assert.match(resultado.id, /^ACT-[A-Z0-9]{6}$/);
    assert.ok(resultado.guidance.summary.length > 0, "el resultado debe incluir el mensaje al usuario");
  });

  test("sin adaptador conectado no se ejecuta y se dice por que", async () => {
    const ticket = await ticketFor("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const resultado = await remediate({
      ticket,
      playbookId: "identity.unlock-account",
      diagnosis: conclusiveDiagnosis(),
      dryRun: false,
    });
    assert.equal(resultado.status, "unavailable");
    assert.equal(resultado.executed, false);
    assert.ok(resultado.blocks[0].reason.includes("null"));
  });

  test("un fallo del adaptador no se reporta como exito", async () => {
    const ticket = await ticketFor("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const adapter = spyAdapter({ failWith: new PolicyError("DIRECTORY_DOWN", "El directorio no responde") });
    const resultado = await remediate({
      ticket,
      playbookId: "identity.unlock-account",
      diagnosis: conclusiveDiagnosis(),
      adapter,
      dryRun: false,
    });
    assert.equal(resultado.status, "failed");
    assert.equal(resultado.executed, false);
    assert.equal(resultado.error.code, "DIRECTORY_DOWN");
  });

  test("el plan de una accion incluye como deshacerla", async () => {
    const ticket = await ticketFor("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const resultado = await remediate({
      ticket,
      playbookId: "identity.unlock-account",
      diagnosis: conclusiveDiagnosis(),
    });
    assert.ok(resultado.rollback.length > 0);
  });

  test("si la categoria no tiene playbook, se dice en vez de inventar uno", async () => {
    const ticket = await ticketFor("Hola, buenos dias, no se que me pasa con el ordenador de mi despacho");
    await assert.rejects(
      () => remediate({ ticket, diagnosis: conclusiveDiagnosis() }),
      /playbook/i,
    );
  });

  test("elige el playbook de menor riesgo cuando no se indica cual", async () => {
    const ticket = await ticketFor("Mi portatil va muy lento y se cuelga, usuario E-10482");
    const resultado = await remediate({ ticket, diagnosis: conclusiveDiagnosis(1) });
    // El endpoint tiene dos playbooks; el de menor riesgo es recoger logs.
    assert.equal(resultado.playbook, "endpoint.collect-diagnostics");
  });
});

suite("remediation/integracion", () => {
  test("un informe insuficiente del motor impide la remediacion", async () => {
    const ticket = await ticketFor("No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway");
    const informe = await diagnose({ ticket, allowNetwork: false });
    assert.equal(informe.insufficient, true);

    const resultado = await remediate({
      ticket,
      playbookId: "network.restart-vpn-client",
      diagnosis: informe,
      dryRun: false,
      adapter: spyAdapter(),
    });
    assert.equal(resultado.executed, false, "un informe incompleto no puede autorizar una accion");
  });

  test("el idioma de la guia sigue al del ticket", async () => {
    const ticket = await ticketFor("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const es = await remediate({ ticket, playbookId: "identity.unlock-account", diagnosis: conclusiveDiagnosis(), lang: "es" });
    const en = await remediate({ ticket, playbookId: "identity.unlock-account", diagnosis: conclusiveDiagnosis(), lang: "en" });
    assert.notEqual(es.guidance.summary, en.guidance.summary);
  });
});
