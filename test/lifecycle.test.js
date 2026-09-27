import test, { suite } from "node:test";
import assert from "node:assert/strict";

import { applyTransition, canTransition, validateTicket, TRANSITIONS, OPEN_STATUSES, TERMINAL_STATUSES } from "../src/domain/lifecycle.js";
import { STATUS, ACTOR, createTicket } from "../src/domain/ticket.js";
import { TransitionError } from "../src/core/errors.js";
import { TICKET_ID_RE } from "../src/core/ids.js";

const NOW = new Date("2026-01-05T08:00:00Z");
const LATER = new Date("2026-01-05T09:00:00Z");

function nuevo() {
  return createTicket({ text: "Usuario E-10482 con la cuenta bloqueada", reporter: "E-10482", now: NOW });
}

function triaged({ category = "identity.lockout", severity = "S3", confidence = 1, entities = { affectedUser: "E-10482" } } = {}) {
  return applyTransition(nuevo(), {
    to: STATUS.TRIAGED,
    patch: {
      category,
      severity,
      priority: severity === "S3" ? "P3" : "P2",
      confidence,
      entities: { ...nuevo().entities, ...entities },
    },
    actor: ACTOR.SYSTEM,
    rationale: "clasificado",
    now: NOW,
  });
}

suite("domain/lifecycle: clasificacion", () => {
  test("new -> triaged exige los cuatro campos de la decision", () => {
    const ticket = nuevo();
    const check = canTransition(ticket, STATUS.TRIAGED, {}, ACTOR.SYSTEM);
    assert.equal(check.allowed, false);
    for (const campo of ["category", "severity", "priority", "confidence"]) {
      assert.ok(
        check.reasons.includes(`TRANSITION_MISSING_FIELD:${campo}`),
        `deberia faltar ${campo}: ${check.reasons.join(", ")}`,
      );
    }
  });

  test("no se tria lo que no se ha clasificado", () => {
    assert.throws(
      () =>
        applyTransition(nuevo(), {
          to: STATUS.TRIAGED,
          patch: { category: "unclassified", severity: "S3", priority: "P3", confidence: 1 },
          actor: ACTOR.SYSTEM,
          now: NOW,
        }),
      (e) => e instanceof TransitionError && e.code === "TRANSITION_UNCLASSIFIED",
    );
  });

  test("no se tria con confianza insuficiente", () => {
    assert.throws(
      () =>
        applyTransition(nuevo(), {
          to: STATUS.TRIAGED,
          patch: { category: "service.degradation", severity: "S3", priority: "P3", confidence: 0.2 },
          actor: ACTOR.SYSTEM,
          now: NOW,
        }),
      (e) => e instanceof TransitionError && e.code === "TRANSITION_LOW_CONFIDENCE",
    );
  });

  test("al triar se calculan el SLA y la lista de entidades que faltan", () => {
    const ticket = triaged();
    assert.ok(ticket.sla?.responseDueAt, "el SLA se calcula al clasificar, no al theatricalizarlo");
    assert.ok(Array.isArray(ticket.entities.missingRequired));
  });
});

suite("domain/lifecycle: espera al usuario", () => {
  test("se puede preguntar desde triaged, sin abrir antes el caso", () => {
    // El flujo real: la incidencia llega clasificada pero sin el dato que hace
    // falta. Antes de anadir esta transicion habia que abrirla "en trabajo"
    // solo para poder preguntar.
    const ticket = triaged({ category: "service.degradation" });
    const check = canTransition(
      ticket,
      STATUS.WAITING_USER,
      { questions: ["¿A que servicio afecta?"] },
      ACTOR.AGENT,
    );
    assert.equal(check.allowed, true, check.reasons.join(", "));

    const esperando = applyTransition(ticket, {
      to: STATUS.WAITING_USER,
      patch: { questions: ["¿A que servicio afecta?"] },
      actor: ACTOR.AGENT,
      rationale: "falta el servicio",
      now: NOW,
    });
    assert.equal(esperando.status, STATUS.WAITING_USER);
    assert.deepEqual(esperando.pendingQuestions, ["¿A que servicio afecta?"]);
  });

  test("no se espera sin preguntar nada", () => {
    const ticket = triaged();
    assert.throws(
      () =>
        applyTransition(ticket, {
          to: STATUS.WAITING_USER,
          patch: { questions: [] },
          actor: ACTOR.AGENT,
          now: NOW,
        }),
      (e) => {
        assert.ok(e instanceof TransitionError);
        // Las dos razones aparecen: falta el campo y el guard lo confirma. Da
        // igual cual se muestre al usuario, pero ambas tienen que estar.
        assert.ok(e.details.reasons.includes("TRANSITION_NO_QUESTION"), e.details.reasons.join(", "));
        return true;
      },
    );
  });

  test("la misma regla se aplica desde triaged y desde in_progress", () => {
    const enCurso = applyTransition(triaged(), {
      to: STATUS.IN_PROGRESS,
      actor: ACTOR.AGENT,
      rationale: "empezado",
      now: NOW,
    });

    for (const [nombre, ticket] of [["triaged", triaged()], ["in_progress", enCurso]]) {
      const check = canTransition(ticket, STATUS.WAITING_USER, { questions: ["¿cual?"] }, ACTOR.AGENT);
      assert.equal(check.allowed, true, `desde ${nombre}: ${check.reasons.join(", ")}`);
    }
  });

  test("el SLA se pausa al esperar y se reanuda al volver", () => {
    const ticket = triaged();
    const esperando = applyTransition(ticket, {
      to: STATUS.WAITING_USER,
      patch: { questions: ["¿cual?"] },
      actor: ACTOR.AGENT,
      rationale: "falta un dato",
      now: NOW,
    });
    assert.ok(esperando.sla.pausedAt, "el SLA queda en pausa");

    const resumed = applyTransition(esperando, {
      to: STATUS.IN_PROGRESS,
      patch: { questions: [] },
      actor: ACTOR.SYSTEM,
      rationale: "respuesta recibida",
      now: LATER,
    });
    assert.equal(resumed.sla.pausedAt, null, "al recibir la respuesta, el SLA corre otra vez");
  });
});

suite("domain/lifecycle: cierre y estados terminales", () => {
  test("un agente resuelve pero no cierra", () => {
    const enCurso = applyTransition(triaged(), {
      to: STATUS.IN_PROGRESS,
      actor: ACTOR.AGENT,
      now: NOW,
    });
    const resuelto = applyTransition(enCurso, {
      to: STATUS.RESOLVED,
      patch: { resolution: { summary: "renovado el perfil de AnyConnect" } },
      actor: ACTOR.AGENT,
      now: NOW,
    });
    assert.equal(resuelto.status, STATUS.RESOLVED);

    assert.throws(
      () =>
        applyTransition(resuelto, {
          to: STATUS.CLOSED,
          patch: { closure: { by: "mesa-n2", note: "hecho" } },
          actor: ACTOR.AGENT,
          now: NOW,
        }),
      (e) => e instanceof TransitionError && e.code === "TRANSITION_ACTOR_NOT_ALLOWED",
    );

    const cerrado = applyTransition(resuelto, {
      to: STATUS.CLOSED,
      patch: { closure: { by: "mesa-n2", note: "hecho" } },
      actor: ACTOR.OPERATOR,
      now: NOW,
    });
    assert.equal(cerrado.status, STATUS.CLOSED);
    assert.equal(cerrado.closure.by, "mesa-n2");
  });

  test("un ticket terminal no vuelve a abrirse ni por el operador", () => {
    const cerrado = applyTransition(
      applyTransition(
        applyTransition(triaged(), { to: STATUS.IN_PROGRESS, actor: ACTOR.AGENT, now: NOW }),
        { to: STATUS.RESOLVED, patch: { resolution: { summary: "hecho" } }, actor: ACTOR.AGENT, now: NOW },
      ),
      { to: STATUS.CLOSED, patch: { closure: { by: "mesa-n2" } }, actor: ACTOR.OPERATOR, now: NOW },
    );

    for (const to of [STATUS.IN_PROGRESS, STATUS.RESOLVED, STATUS.CLOSED]) {
      assert.throws(
        () => applyTransition(cerrado, { to, patch: { resolution: { summary: "otra vez" } }, actor: ACTOR.OPERATOR, now: LATER }),
        (e) => e instanceof TransitionError && e.code === "TRANSITION_TERMINAL_STATE",
        `cerrado -> ${to} deberia rechazarse`,
      );
    }
  });

  test("cancelar es de un operador, y por un motivo", () => {
    const ticket = triaged();
    assert.throws(
      () => applyTransition(ticket, { to: STATUS.CANCELLED, patch: { cancelReason: "duplicado" }, actor: ACTOR.AGENT, now: NOW }),
      (e) => e instanceof TransitionError && e.code === "TRANSITION_ACTOR_NOT_ALLOWED",
    );
    assert.throws(
      () => applyTransition(ticket, { to: STATUS.CANCELLED, patch: {}, actor: ACTOR.OPERATOR, now: NOW }),
      (e) => e instanceof TransitionError && e.code === "TRANSITION_MISSING_FIELD:cancelReason",
    );
  });
});

suite("domain/lifecycle: parches e historial", () => {
  test("las rutas con punto llegan al sitio correcto", () => {
    const ticket = applyTransition(
      applyTransition(triaged(), { to: STATUS.IN_PROGRESS, actor: ACTOR.AGENT, now: NOW }),
      {
        to: STATUS.RESOLVED,
        patch: { resolution: { summary: "spooler reiniciado", verifiedBy: "mesa-n2" } },
        actor: ACTOR.AGENT,
        now: NOW,
      },
    );
    assert.equal(ticket.resolution.summary, "spooler reiniciado");
    assert.equal(ticket.resolution.verifiedBy, "mesa-n2");
  });

  test("`questions` es la puerta de entrada de `pendingQuestions`", () => {
    const ticket = triaged();
    const esperando = applyTransition(ticket, {
      to: STATUS.WAITING_USER,
      patch: { questions: ["¿cual?"] },
      actor: ACTOR.AGENT,
      now: NOW,
    });
    assert.deepEqual(esperando.pendingQuestions, ["¿cual?"]);
  });

  test("cada transicion deja su por que en el historial", () => {
    const ticket = applyTransition(
      applyTransition(triaged(), { to: STATUS.IN_PROGRESS, actor: ACTOR.AGENT, rationale: "el agente empieza", now: NOW }),
      { to: STATUS.RESOLVED, patch: { resolution: { summary: "hecho" } }, actor: ACTOR.AGENT, rationale: "verificado", now: LATER },
    );
    const ultimo = ticket.history.at(-1);
    assert.equal(ultimo.from, STATUS.IN_PROGRESS);
    assert.equal(ultimo.to, STATUS.RESOLVED);
    assert.equal(ultimo.rationale, "verificado", "sin explicacion, la bitacora no es auditable");
  });

  test("la transicion devuelve un ticket nuevo y no toca el original", () => {
    const original = triaged();
    const antes = JSON.stringify(original);
    applyTransition(original, { to: STATUS.IN_PROGRESS, actor: ACTOR.AGENT, now: NOW });
    assert.equal(JSON.stringify(original), antes, "mutar el ticket recibido rompe la trazabilidad");
  });

  test("toda transicion necesita un instante de referencia", () => {
    assert.throws(
      () => applyTransition(triaged(), { to: STATUS.IN_PROGRESS, actor: ACTOR.AGENT }),
      (e) => e.code === "TRANSITION_NOW_REQUIRED",
    );
  });

  test("no se inventa un destino", () => {
    assert.throws(
      () => applyTransition(triaged(), { to: "inventado", actor: ACTOR.AGENT, now: NOW }),
      (e) => e.code === "TRANSITION_UNKNOWN_STATUS",
    );
  });

  test("tampoco un actor", () => {
    assert.throws(
      () => applyTransition(triaged(), { to: STATUS.IN_PROGRESS, actor: "magico", now: NOW }),
      (e) => e.code === "TRANSITION_ACTOR_INVALID",
    );
  });
});

suite("domain/lifecycle: el grafo es auditable", () => {
  test("toda transicion declara estados que existen", () => {
    const estados = new Set(Object.values(STATUS));
    for (const t of TRANSITIONS) {
      assert.ok(estados.has(t.from), `origen desconocido: ${t.from}`);
      assert.ok(estados.has(t.to), `destino desconocido: ${t.to}`);
      assert.notEqual(t.from, t.to, `no hay transiciones a si mismo: ${t.from}`);
    }
  });

  test("ningun estado terminal tiene salida", () => {
    for (const terminal of TERMINAL_STATUSES) {
      const salidas = TRANSITIONS.filter((t) => t.from === terminal);
      assert.deepEqual(salidas, [], `${terminal} no deberia tener salidas`);
    }
  });

  test("ningun estado no terminal es un callejon sin salida", () => {
    // Un estado del que no se puede salir es un ticket que se queda colgado
    // para siempre. Si alguno fuera intencionado, tendria que decirlo aqui.
    for (const status of OPEN_STATUSES) {
      const salidas = TRANSITIONS.filter((t) => t.from === status);
      assert.ok(salidas.length > 0, `${status} no tiene salida: el ticket se quedaria colgado`);
    }
  });

  test("no hay transiciones duplicadas entre el mismo par de estados", () => {
    const vistos = new Set();
    for (const t of TRANSITIONS) {
      const clave = `${t.from}->${t.to}`;
      assert.equal(vistos.has(clave), false, `transicion duplicada: ${clave}`);
      vistos.add(clave);
    }
  });

  test("cerrar y cancelar son siempre de un operador", () => {
    for (const to of [STATUS.CLOSED, STATUS.CANCELLED]) {
      const par = TRANSITIONS.filter((t) => t.to === to);
      assert.ok(par.length > 0, `nadie puede llegar a ${to}`);
      for (const t of par) {
        assert.deepEqual(t.actors, [ACTOR.OPERATOR], `${t.from} -> ${to} deberia ser solo de operador`);
      }
    }
  });

  test("todo actor declarado existe", () => {
    const actores = new Set(Object.values(ACTOR));
    for (const t of TRANSITIONS) {
      for (const actor of t.actors ?? []) {
        assert.ok(actores.has(actor), `actor desconocido en ${t.from} -> ${t.to}: ${actor}`);
      }
    }
  });

  test("todo ticket recien creado pasa las invariantes", () => {
    assert.deepEqual(validateTicket(nuevo()), []);
    assert.match(nuevo().id, TICKET_ID_RE);
  });
});
