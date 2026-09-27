import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  addBusinessMinutes,
  countBusinessMinutes,
  computeSla,
  evaluateSla,
  pauseSla,
  resumeSla,
  markResponded,
  markResolved,
  DEFAULT_CALENDAR,
  SLA_TARGETS,
} from "../src/domain/sla.js";

/** Sede sin festivos, para aislar la aritmetica. */
const CAL = { ...DEFAULT_CALENDAR, holidays: [] };

/** Sede tal cual, con 2026-01-06 (martes) como festivo. */
const CAL_HOLIDAY = DEFAULT_CALENDAR;

/**
 * 2026-01-05 es lunes. El desfase de la sede es +1h, asi que la jornada laboral
 * 08:00-18:00 local equivale a 07:00Z-17:00Z.
 */
const MON_09 = new Date("2026-01-05T08:00:00.000Z"); // 09:00 local
const MON_17 = new Date("2026-01-05T16:00:00.000Z"); // 17:00 local
const FRI_1730 = new Date("2026-01-09T16:30:00.000Z"); // 17:30 local del viernes

describe("sla/addBusinessMinutes", () => {
  test("suma dentro de la misma jornada", () => {
    // 09:00 local + 120 min = 11:00 local = 10:00Z.
    const out = addBusinessMinutes(MON_09, 120, CAL);
    assert.equal(out.toISOString(), "2026-01-05T10:00:00.000Z");
  });

  test("salta a la jornada siguiente al agotar el dia", () => {
    // 17:00 local + 120 min: 60 min el lunes y 60 el martes (08:00->09:00 local).
    const out = addBusinessMinutes(MON_17, 120, CAL);
    assert.equal(out.toISOString(), "2026-01-06T08:00:00.000Z");
  });

  test("salta el fin de semana", () => {
    // Viernes 17:30 local + 60 min: 30 min el viernes y 30 el lunes (08:00->08:30 local).
    const out = addBusinessMinutes(FRI_1730, 60, CAL);
    assert.equal(out.toISOString(), "2026-01-12T07:30:00.000Z");
  });

  test("arranca el plazo en el primer instante laborable si el alta es fuera de horario", () => {
    // Domingo 20:00 local: el plazo arranca el lunes a las 09:00 local y acaba 10:00.
    const out = addBusinessMinutes(new Date("2026-01-04T19:00:00.000Z"), 60, CAL);
    assert.equal(out.toISOString(), "2026-01-05T08:00:00.000Z");
  });

  test("respeta los festivos configurados", () => {
    // 2026-01-06 es festivo: 30 min el lunes y 30 el miercoles 08:00->08:30 local.
    const out = addBusinessMinutes(new Date("2026-01-05T16:30:00.000Z"), 60, CAL_HOLIDAY);
    assert.equal(out.toISOString(), "2026-01-07T07:30:00.000Z");
  });

  test("cero minutos devuelve el ancla laborable", () => {
    assert.equal(addBusinessMinutes(MON_09, 0, CAL).toISOString(), MON_09.toISOString());
  });

  test("rechaza minutos negativos o no finitos", () => {
    assert.throws(() => addBusinessMinutes(MON_09, -1, CAL), { code: "SLA_INVALID_MINUTES" });
    assert.throws(() => addBusinessMinutes(MON_09, Number.NaN, CAL), { code: "SLA_INVALID_MINUTES" });
  });

  test("falla de forma explicita ante un calendario sin dias laborables", () => {
    assert.throws(() => addBusinessMinutes(MON_09, 60, { ...CAL, weekdays: [] }), {
      code: "SLA_CALENDAR_DEGENERATE",
    });
  });
});

describe("sla/countBusinessMinutes", () => {
  test("cuenta solo la parte laborable del intervalo", () => {
    // Viernes 17:00 local -> lunes 10:00 local:
    // viernes 17:00->18:00 (60) + lunes 08:00->10:00 (120) = 180 minutos laborables.
    const out = countBusinessMinutes(
      new Date("2026-01-09T16:00:00.000Z"),
      new Date("2026-01-12T09:00:00.000Z"),
      CAL,
    );
    assert.equal(out, 180);
  });

  test("un intervalo invertido vale cero", () => {
    assert.equal(countBusinessMinutes(MON_17, MON_09, CAL), 0);
  });
});

describe("sla/computeSla", () => {
  test("deriva los plazos de respuesta y resolucion de la severidad", () => {
    const sla = computeSla({ from: MON_09, severity: "S1", calendar: CAL });
    assert.equal(sla.responseDueAt, "2026-01-05T08:15:00.000Z"); // 09:15 sede
    assert.equal(sla.resolutionDueAt, "2026-01-05T12:00:00.000Z"); // 13:00 sede
    assert.equal(sla.resolutionTargetMinutes, SLA_TARGETS.S1.resolutionMinutes);
  });

  test("un plazo largo de S3 atraviesa varios dias laborables", () => {
    const sla = computeSla({ from: MON_17, severity: "S3", calendar: CAL });
    const due = new Date(sla.resolutionDueAt);
    // 1440 min laborables desde el lunes 17:00 local no caben en ese dia.
    assert.ok(due > new Date("2026-01-06T08:00:00.000Z"), `plazo inesperado: ${sla.resolutionDueAt}`);
    // El plazo cae en jornada laboral, nunca en una noche.
    const localHour = new Date(due.getTime() + 60 * 60_000).getUTCHours();
    assert.ok(localHour >= 8 && localHour <= 18, `el plazo cae fuera de jornada: ${localHour}`);
  });

  test("rechaza una severidad desconocida", () => {
    assert.throws(() => computeSla({ from: MON_09, severity: "S9", calendar: CAL }), {
      code: "SLA_UNKNOWN_SEVERITY",
    });
  });
});

describe("sla/pause-resume", () => {
  test("pausar es idempotente", () => {
    const sla = computeSla({ from: MON_09, severity: "S2", calendar: CAL });
    const once = pauseSla(sla, MON_09);
    const twice = pauseSla(once, MON_17);
    assert.equal(twice.pausedAt, once.pausedAt);
  });

  test("reanudar desplaza los plazos por los minutos laborables esperados", () => {
    const sla = computeSla({ from: MON_09, severity: "S2", calendar: CAL });
    const pauseAt = new Date("2026-01-05T10:00:00.000Z"); // 11:00 local del lunes
    const resumeAt = new Date("2026-01-06T10:00:00.000Z"); // 11:00 local del martes
    const paused = pauseSla(sla, pauseAt);
    const resumed = resumeSla(paused, resumeAt, CAL);

    // Espera real: lunes 11:00->18:00 (420) + martes 08:00->11:00 (180) = 600.
    assert.equal(resumed.pausedMinutes, 600);
    assert.equal(resumed.pausedMinutes, countBusinessMinutes(pauseAt, resumeAt, CAL));
    assert.equal(resumed.pausedAt, null);

    // Plazo de respuesta original 09:30 local (08:30Z) + 600 min laborables.
    assert.equal(resumed.responseDueAt, "2026-01-06T08:30:00.000Z");
    // Plazo de resolucion original 17:00 local (16:00Z) + 600 min laborables.
    assert.equal(resumed.resolutionDueAt, "2026-01-06T16:00:00.000Z");
    // El desplazamiento es real: los plazos se mueven hacia adelante.
    assert.ok(new Date(resumed.resolutionDueAt) > new Date(sla.resolutionDueAt));
  });

  test("reanudar sin haber pausado no altera el SLA", () => {
    const sla = computeSla({ from: MON_09, severity: "S2", calendar: CAL });
    const same = resumeSla(sla, MON_17, CAL);
    assert.equal(same.resolutionDueAt, sla.resolutionDueAt);
  });
});

describe("sla/evaluateSla", () => {
  test("detecta cumplimiento, cumplimiento tardio e incumplimiento", () => {
    const sla = computeSla({ from: MON_09, severity: "S2", calendar: CAL });

    const onTime = evaluateSla({ sla: markResponded(sla, new Date("2026-01-05T08:20:00.000Z")) }, new Date("2026-01-05T08:20:00.000Z"));
    assert.equal(onTime.response.met, true);
    assert.equal(onTime.response.late, false);

    const late = evaluateSla({ sla: markResponded(sla, new Date("2026-01-05T09:00:00.000Z")) }, new Date("2026-01-05T09:00:00.000Z"));
    assert.equal(late.response.met, true);
    assert.equal(late.response.late, true);

    const breached = evaluateSla({ sla }, new Date("2026-01-07T12:00:00.000Z"));
    assert.equal(breached.resolution.state, "breached");
    assert.equal(breached.riskLevel, "breached");
    assert.equal(breached.atRisk, true);
  });

  test("un ticket pausado no se considera en riesgo", () => {
    const sla = computeSla({ from: MON_09, severity: "S2", calendar: CAL });
    const paused = pauseSla(sla, MON_09);
    const state = evaluateSla({ sla: paused }, new Date("2026-01-20T12:00:00.000Z"));
    assert.equal(state.resolution.state, "paused");
    assert.equal(state.atRisk, false);
    assert.equal(state.riskLevel, "none");
  });

  test("clasifica el riesgo por proximity al plazo de resolucion", () => {
    // S1 desde las 09:00 locales: resolucion a las 13:00 locales (12:00Z).
    const sla = computeSla({ from: MON_09, severity: "S1", calendar: CAL });
    assert.equal(sla.resolutionDueAt, "2026-01-05T12:00:00.000Z");
    // 3 h 55 min restantes: riesgo medio.
    assert.equal(evaluateSla({ sla }, new Date("2026-01-05T08:05:00.000Z")).riskLevel, "medium");
    // 1 h 30 min restantes: riesgo alto.
    assert.equal(evaluateSla({ sla }, new Date("2026-01-05T10:30:00.000Z")).riskLevel, "high");
    // Plazo vencido: incumplimiento.
    assert.equal(evaluateSla({ sla }, new Date("2026-01-05T12:30:00.000Z")).riskLevel, "breached");
    assert.equal(evaluateSla({ sla }, new Date("2026-01-05T10:30:00.000Z")).atRisk, true);
  });

  test("sin SLA devuelve un estado neutro en lugar de fallar", () => {
    const state = evaluateSla({}, MON_09);
    assert.equal(state.response.state, "not_applicable");
    assert.equal(state.atRisk, false);
  });

  test("marcar respuesta dos veces conserva la primera marca", () => {
    const sla = computeSla({ from: MON_09, severity: "S2", calendar: CAL });
    const first = markResponded(sla, MON_09);
    const second = markResponded(first, MON_17);
    assert.equal(second.firstRespondedAt, first.firstRespondedAt);
  });

  test("marcar resolucion sella el reloj", () => {
    const sla = markResolved(computeSla({ from: MON_09, severity: "S2", calendar: CAL }), MON_17);
    assert.equal(sla.resolvedAt, MON_17.toISOString());
  });
});
