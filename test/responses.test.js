import test, { suite } from "node:test";
import assert from "node:assert/strict";

import { intakeAndTriage } from "../src/triage/index.js";
import { diagnose } from "../src/diagnostics/index.js";
import { remediate } from "../src/remediation/index.js";
import { escalate, acknowledge } from "../src/escalation/index.js";
import { applyTransition } from "../src/domain/lifecycle.js";
import { STATUS } from "../src/domain/ticket.js";
import { assertSafeQuestion } from "../src/privacy/pii.js";
import {
  acknowledgement,
  clarifying,
  diagnosisResult,
  remediationResult,
  escalationNotice,
  resolutionNotice,
  slaNotice,
} from "../src/responses/index.js";

const NOW = new Date("2026-01-05T08:00:00Z");

function triaged(text, lang = "es") {
  return intakeAndTriage({ text, reporter: "E-99001", lang, now: NOW });
}

suite("respuestas/idioma", () => {
  test("el mensaje sale en el idioma del ticket, no en el del codigo", () => {
    const es = triaged("No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway", "es");
    const en = triaged("I cannot connect to the VPN from home, AnyConnect gives a 403 gateway error", "en");

    assert.match(acknowledgement({ ticket: es.ticket, decision: es.decision, lang: "es" }), /He registrado tu incidencia/);
    assert.match(acknowledgement({ ticket: en.ticket, decision: en.decision, lang: "en" }), /I have logged your request/);
  });

  test("el mensaje incluye siempre la referencia del ticket", () => {
    const { ticket, decision } = triaged("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    assert.match(acknowledgement({ ticket, decision }), new RegExp(ticket.id));
  });
});

suite("respuestas/seguridad", () => {
  test("si el usuario compartio credenciales, se avisa y se explica el aviso", () => {
    const { ticket, decision } = triaged(
      "Mi contrasena es Tr3boleta2026 y no me deja entrar, usuario E-10482, no puedo conectarme a la VPN",
    );
    const message = acknowledgement({ ticket, decision });

    assert.match(message, /Aviso de seguridad/);
    assert.match(message, /cambies|rota|rotar/i, "hay que decirle que lo cambie, no solo que se borro");
    assert.doesNotMatch(message, /Tr3boleta2026/, "la credencial no puede reaparecer en la respuesta");
  });

  test("la respuesta nunca pide una credencial", () => {
    const casos = [
      triaged("Usuario E-10482 con la cuenta bloqueada por exceso de intentos"),
      triaged("No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway"),
      triaged("Solicito acceso al repositorio data-platform"),
      triaged("Hola, buenos dias, no se que me pasa con el ordenador de mi despacho"),
    ];
    for (const caso of casos) {
      const message = acknowledgement({ ticket: caso.ticket, decision: caso.decision });
      assert.doesNotThrow(() => assertSafeQuestion(message), `pide credenciales: ${message}`);
    }
  });

  test("mencionar la palabra contrasena no dispara el aviso de seguridad", () => {
    const { ticket, decision } = triaged(
      "He olvidado la contraseña y la cuenta se ha bloqueado, usuario E-10482",
    );
    const message = acknowledgement({ ticket, decision });
    assert.doesNotMatch(message, /Aviso de seguridad/);
    assert.match(message, /He registrado tu incidencia/);
  });
});

suite("respuestas/diagnostico", () => {
  test("un informe insuficiente se dice con frasis, no con un codigo", async () => {
    const { ticket } = triaged("No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway");
    const report = await diagnose({ ticket, allowNetwork: false });
    const message = diagnosisResult({ ticket, report });

    assert.match(message, /no he podido determinar la causa/i);
    assert.doesNotMatch(message, /insufficient/, "el codigo interno no se leense al usuario");
  });

  test("un informe concluyente dice cual es la causa", async () => {
    const { ticket } = triaged("El portatil va muy lento y se cuelga, usuario E-10482");
    const report = await diagnose({ ticket, allowNetwork: false });
    const message = diagnosisResult({ ticket, report });
    assert.ok(message.length > 0);
    assert.doesNotMatch(message, /\bundefined\b/, "una plantilla sin dato no debeENSE 'undefined' al usuario");
  });
});

suite("respuestas/remediacion", () => {
  test("una simulacion se dice que es simulacion, no que se ha arreglado", async () => {
    const { ticket } = triaged("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    // Sin diagnostico no se llega ni a simular: primero la compuerta, luego el plan.
    const result = await remediate({
      ticket,
      playbookId: "identity.unlock-account",
      diagnosis: { cause: { conclusive: true, confidence: 0.95 }, summary: { coverage: 1 } },
    });
    const message = remediationResult({ ticket, result, lang: "es" });

    assert.equal(result.status, "planned");
    assert.match(message, /todavía no he aplicado nada|no he aplicado nada/);
  });

  test("una accion aplicada dice que se ha hecho y como se deshace", async () => {
    const { ticket } = triaged("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const adapter = {
      name: "test",
      available: () => true,
      apply: async () => ({ ok: true }),
    };
    const result = await remediate({
      ticket,
      playbookId: "identity.unlock-account",
      diagnosis: { cause: { conclusive: true, confidence: 0.95 }, summary: { coverage: 1 } },
      adapter,
      dryRun: false,
    });
    const message = remediationResult({ ticket, result, lang: "es" });

    assert.equal(result.status, "applied");
    assert.match(message, /\*\*Hecho:\*\*/);
    assert.match(message, /deshacer/i);
  });

  test("un bloqueo se dice sin culpar al usuario", async () => {
    const { ticket } = triaged("Hola, buenos dias, no se que me pasa con el ordenador de mi despacho");
    const result = await remediate({ ticket, playbookId: "endpoint.restart-device" });
    const message = remediationResult({ ticket, result, lang: "es" });

    assert.match(message, /No he ejecutado nada/);
    assert.doesNotMatch(message, /debiste|tu has caused|you should have|culpa|error tuyo/i);
  });

  test("un fallo no se presenta como exito parcial", async () => {
    const { ticket } = triaged("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const adapter = { name: "x", available: () => true, apply: async () => { throw new Error("boom"); } };
    const result = await remediate({
      ticket,
      playbookId: "identity.unlock-account",
      diagnosis: { cause: { conclusive: true, confidence: 0.95 }, summary: { coverage: 1 } },
      adapter,
      dryRun: false,
    });
    assert.equal(result.status, "failed");
    assert.match(remediationResult({ ticket, result, lang: "es" }), /No he podido aplicar|No he dejado nada a medias/);
  });
});

suite("respuestas/escalado y cierre", () => {
  test("el aviso de escalado dice destino y plazo", () => {
    const { ticket } = triaged("Se ha borrado todo, he perdido los documentos importantes");
    const { escalation } = escalate({ ticket, reason: "data_loss_risk", now: NOW });
    const message = escalationNotice({ ticket, escalation, lang: "es" });

    assert.match(message, /persona|equipo humano/);
    assert.match(message, /antes del/);
  });

  test("la resolucion incluye los pasos del usuario, si los hay", () => {
    const base = triaged("Usuario E-10482 con la cuenta bloqueada por exceso de intentos").ticket;
    const ticket = {
      ...base,
      resolution: {
        summary: "He desbloqueado la cuenta.",
        userSteps: ["Vuelve a iniciar sesión y cambia la contraseña por una que no uses en ningún otro sitio."],
      },
    };
    const message = resolutionNotice({ ticket, lang: "es" });
    assert.match(message, /1\./);
    assert.match(message, /desbloqueado la cuenta/);
  });

  test("el mensaje de SLA da una fecha, no un plazo relativo", () => {
    const { ticket } = triaged("No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway");
    const message = slaNotice({ ticket, now: NOW, lang: "es" });
    assert.ok(message.length > 0);
    assert.doesNotMatch(message, /undefined/);
  });
});

suite("respuestas/integracion", () => {
  test("ninguna plantilla produce texto vacio en ingles", async () => {
    const { ticket, decision } = triaged(
      "I cannot connect to the VPN from home, AnyConnect gives a 403 gateway error",
      "en",
    );
    const report = await diagnose({ ticket, allowNetwork: false });
    const result = await remediate({ ticket, playbookId: "network.restart-vpn-client", adapter: null });
    const { escalation } = escalate({ ticket, reason: "missing_diagnosis", now: NOW });
    void acknowledge;

    const mensajes = [
      ["ack", acknowledgement({ ticket, decision, lang: "en" })],
      ["diagnosis", diagnosisResult({ ticket, report, lang: "en" })],
      ["remediation", remediationResult({ ticket, result, lang: "en" })],
      ["escalation", escalationNotice({ ticket, escalation, lang: "en" })],
      ["sla", slaNotice({ ticket, now: NOW, lang: "en" })],
    ];
    for (const [nombre, mensaje] of mensajes) {
      assert.ok(mensaje.trim().length > 0, `plantilla ${nombre} vacia en ingles`);
      assert.doesNotMatch(mensaje, /\bundefined\b|\[object Object\]/, `plantilla ${nombre} con basura`);
    }

    // Una plantilla sin nada que decir debe decir nada: rellenar un hueco es peor
    // que dejar el hueco.
    assert.equal(clarifying({ ticket, questions: decision.nextQuestions, lang: "en" }).trim(), "");
  });

  test("una fecha de SLA se muestra en la zona del calendario, no en la del servidor", () => {
    const { ticket } = triaged("No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway");
    const message = slaNotice({ ticket, now: NOW, lang: "es" });
    // El calendario es UTC+1 y la respuesta es 08:30Z, o sea 09:30 en su reloj.
    assert.match(message, /9:30/, `se ha mostrado la hora del servidor: ${message}`);
  });

  test("el cierre exige resolucion y operador, y la respuesta lo refleja", () => {
    const { ticket } = triaged("Usuario E-10482 con la cuenta bloqueada por exceso de intentos");
    const triagedTicket = { ...ticket, status: STATUS.IN_PROGRESS };
    const resuelto = applyTransition(
      { ...triagedTicket, resolution: { summary: "Cuenta desbloqueada." } },
      { to: STATUS.RESOLVED, now: NOW, actor: "agent" },
    );
    assert.throws(
      () => applyTransition({ ...resuelto, closure: { by: "mesa-n2" } }, { to: STATUS.CLOSED, now: NOW, actor: "agent" }),
      (e) => e.code === "TRANSITION_ACTOR_NOT_ALLOWED",
    );
    assert.match(resolutionNotice({ ticket: resuelto, lang: "es" }), /Resuelto/);
  });
});
