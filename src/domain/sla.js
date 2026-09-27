/**
 * Calculo y seguimiento de SLA.
 *
 * Dos decisiones de diseno que conviene destacar:
 *
 * 1. **El SLA corre en horario laboral, no en tiempo de reloj.** Un ticket abierto
 *    un viernes a las 19:00 no puede incumplir su plazo de 4 horas a las 23:00 del
 *    viernes. `addBusinessMinutes` salta noches, fines de semana y festivos.
 *
 * 2. **El reloj se pausa mientras se espera al usuario.** Cuando el ticket pasa a
 *    `waiting_user` se congela el computo y sereanuda al salir. Es lo que evita el
 *    fallo clasico de cerrar como incumplimiento un ticket que el usuario dejo
 *    parado dos semanas.
 *
 * La aritmetica se hace en minutos enteros desde epoch, sin dependencias de zona
 * horaria: el calendario se define con un desfase fijo y documentado. Es
 * determinista y testeable, que es el requisito; anadir soporte IANA completo es
 * un cambio localised en `toWorkingMinutes`/`fromWorkingMinutes`.
 */

import { ValidationError } from "../core/errors.js";

/**
 * @typedef {object} Calendar
 * @property {number} startHour      Hora de inicio de jornada (0-23).
 * @property {number} endHour        Hora de fin de jornada (0-24).
 * @property {number[]} weekdays     0 = domingo ... 6 = sabado.
 * @property {string[]} holidays     Fechas ISO `YYYY-MM-DD` no laborables.
 * @property {number} utcOffsetHours Desfase de la sede respecto a UTC.
 */

/** @type {Calendar} */
export const DEFAULT_CALENDAR = Object.freeze({
  startHour: 8,
  endHour: 18,
  weekdays: Object.freeze([1, 2, 3, 4, 5]),
  holidays: Object.freeze(["2026-01-01", "2026-01-06", "2026-04-03", "2026-05-01"]),
  utcOffsetHours: 1,
});

/** Minutos de respuesta y resolucion por severidad. */
export const SLA_TARGETS = Object.freeze({
  S1: Object.freeze({ responseMinutes: 15, resolutionMinutes: 240 }),
  S2: Object.freeze({ responseMinutes: 30, resolutionMinutes: 480 }),
  S3: Object.freeze({ responseMinutes: 240, resolutionMinutes: 1440 }),
  S4: Object.freeze({ responseMinutes: 480, resolutionMinutes: 4800 }),
});

const MINUTE = 60_000;

/** Mismo instante, expresado en la hora local de la sede. */
function toLocal(date, calendar) {
  return new Date(date.getTime() + calendar.utcOffsetHours * 60 * MINUTE);
}

/**
 * Convierte una hora de pared local a instante UTC real.
 *
 * `Date.UTC` devuelve la marca temporal leida como si fuera UTC; hay que
 * restar el desfase de la sede para obtener el instante verdadero. Confundir
 * ambos Produce plazos desplazados exactamente `utcOffsetHours`.
 */
function localWallToInstant(year, month, day, hour, calendar) {
  return new Date(
    Date.UTC(year, month, day, hour, 0, 0, 0) - calendar.utcOffsetHours * 60 * MINUTE,
  );
}

function isWorkingDay(date, calendar) {
  const local = toLocal(date, calendar);
  if (!calendar.weekdays.includes(local.getUTCDay())) return false;
  const iso = local.toISOString().slice(0, 10);
  return !calendar.holidays.includes(iso);
}

/** Avanza `days` dias naturales. El desfase de la sede es fijo, sin DST. */
function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * MINUTE);
}

/** Inicio de la jornada laborable (hora local de sede) que contiene a `date`. */
function startOfWorkingDay(date, calendar) {
  const local = toLocal(date, calendar);
  return localWallToInstant(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    calendar.startHour,
    calendar,
  );
}

/** Fin de la jornada laborable (hora local de sede) que contiene a `date`. */
function endOfWorkingDay(date, calendar) {
  const local = toLocal(date, calendar);
  return localWallToInstant(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    calendar.endHour,
    calendar,
  );
}

/**
 * Anade minutos laborables a una fecha de referencia.
 *
 * @param {Date} from
 * @param {number} minutes
 * @param {Calendar} [calendar]
 * @returns {Date}
 */
export function addBusinessMinutes(from, minutes, calendar = DEFAULT_CALENDAR) {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new ValidationError("SLA_INVALID_MINUTES", "Los minutos de SLA deben ser un entero no negativo.", {
      minutes,
    });
  }

  // Ancla al primer minuto laborable >= `from`; si `from` esta fuera de jornada,
  // el plazo empieza cuando la sede abre.
  let cursor = advanceToWorkingTime(from, calendar);
  let remaining = minutes;

  // Tope defensivo: 400 dias laborables. Un calendario degenerado (sin dias
  // laborables) no debe producir un bucle infinito.
  for (let day = 0; remaining > 0 && day < 400; day += 1) {
    const end = endOfWorkingDay(cursor, calendar);
    const available = Math.floor((end - cursor.getTime()) / MINUTE);
    if (remaining <= available) {
      cursor = new Date(cursor.getTime() + remaining * MINUTE);
      remaining = 0;
    } else {
      remaining -= available;
      cursor = advanceToWorkingTime(new Date(end.getTime() + MINUTE), calendar);
    }
  }

  if (remaining > 0) {
    throw new ValidationError("SLA_CALENDAR_DEGENERATE", "El calendario no permite computar el plazo de SLA.");
  }

  return cursor;
}

/**
 * Primer instante laborable >= `from`.
 *
 * Se avanza DIA A DIA en vez de sumar 24 horas al fin de jornada: restar una hora
 * al desfasaje fijo de la sede hacia dentro del mismo dia de pared, y el bucle
 * no avanzaria nunca.
 */
function advanceToWorkingTime(from, calendar) {
  let cursor = new Date(from.getTime());
  for (let day = 0; day < 400; day += 1) {
    if (!isWorkingDay(cursor, calendar)) {
      // Saltar al INICIO del dia siguiente, no a la misma hora: avanzar 24 h desde
      // las 20:00 locales dejaria el cursor fuera de jornada y volveria a rodar.
      cursor = addDays(startOfWorkingDay(cursor, calendar), 1);
      continue;
    }
    const start = startOfWorkingDay(cursor, calendar);
    const end = endOfWorkingDay(cursor, calendar);
    if (cursor.getTime() < start.getTime()) return start;
    if (cursor.getTime() >= end.getTime()) {
      cursor = addDays(start, 1);
      continue;
    }
    return cursor;
  }
  throw new ValidationError("SLA_CALENDAR_DEGENERATE", "No se ha encontrado un instante laborable en 400 dias.");
}

/**
 * Construye el bloque SLA de un ticket recien clasificado.
 *
 * @param {object} args
 * @param {Date}   args.from        Momento de la primera accion (el triaje).
 * @param {string} args.severity    `S1`..`S4`
 * @param {Calendar} [args.calendar]
 */
export function computeSla({ from, severity, calendar = DEFAULT_CALENDAR }) {
  const target = SLA_TARGETS[severity];
  if (!target) {
    throw new ValidationError("SLA_UNKNOWN_SEVERITY", `Severidad desconocida: ${severity}`, { severity });
  }
  return {
    severity,
    calendar: { ...calendar },
    responseDueAt: addBusinessMinutes(from, target.responseMinutes, calendar).toISOString(),
    resolutionDueAt: addBusinessMinutes(from, target.resolutionMinutes, calendar).toISOString(),
    responseTargetMinutes: target.responseMinutes,
    resolutionTargetMinutes: target.resolutionMinutes,
    firstRespondedAt: null,
    resolvedAt: null,
    pausedAt: null,
    /** Minutos de espera al usuario acumulados; desplazan los plazos. */
    pausedMinutes: 0,
  };
}

/**
 * Congela el computo del SLA. Idempotente: pausar dos veces no altera el total.
 * @param {object} sla
 * @param {Date} now
 */
export function pauseSla(sla, now) {
  if (sla.pausedAt) return sla;
  return { ...sla, pausedAt: now.toISOString() };
}

/**
 * Reanuda el computo y desplaza los plazos por el tiempo pausado.
 * El desplazamiento se expresa en minutos laborables, no en minutos de reloj.
 *
 * @param {object} sla
 * @param {Date} now
 * @param {Calendar} [calendar]
 */
export function resumeSla(sla, now, calendar = DEFAULT_CALENDAR) {
  if (!sla.pausedAt) return sla;
  const pausedAt = new Date(sla.pausedAt);
  const wallMinutes = Math.max(0, Math.round((now.getTime() - pausedAt.getTime()) / MINUTE));
  // Minutos laborables equivalentes: se mide la parte del intervalo que cae en
  // jornada, para no regalar ni penalizar horas fuera de horario.
  const businessMinutes = countBusinessMinutes(pausedAt, now, calendar);
  const responseDueAt = addBusinessMinutes(new Date(sla.responseDueAt), businessMinutes, calendar);
  const resolutionDueAt = addBusinessMinutes(new Date(sla.resolutionDueAt), businessMinutes, calendar);

  return {
    ...sla,
    responseDueAt: responseDueAt.toISOString(),
    resolutionDueAt: resolutionDueAt.toISOString(),
    pausedAt: null,
    pausedMinutes: sla.pausedMinutes + businessMinutes,
    // `wallMinutes` se conserva solo para auditoria del tiempo real transcurrido.
    lastPauseWallMinutes: wallMinutes,
  };
}

/** Minutos laborables que hay en el intervalo `[from, to]`. */
export function countBusinessMinutes(from, to, calendar = DEFAULT_CALENDAR) {
  if (to <= from) return 0;
  let cursor = advanceToWorkingTime(from, calendar);
  const end = to.getTime();
  let total = 0;
  for (let day = 0; day < 400; day += 1) {
    const start = cursor.getTime();
    const stop = Math.min(end, endOfWorkingDay(cursor, calendar).getTime());
    if (stop <= start) break;
    total += Math.floor((stop - start) / MINUTE);
    cursor = advanceToWorkingTime(new Date(endOfWorkingDay(cursor, calendar).getTime() + MINUTE), calendar);
    if (cursor.getTime() >= end) break;
  }
  return total;
}

/**
 * Estado del SLA en un instante dado.
 *
 * @param {object} ticket
 * @param {Date} now
 * @returns {{response: object, resolution: object, atRisk: boolean, riskLevel: string}}
 */
export function evaluateSla(ticket, now) {
  const sla = ticket.sla;
  if (!sla) {
    return {
      response: { state: "not_applicable" },
      resolution: { state: "not_applicable" },
      atRisk: false,
      riskLevel: "none",
    };
  }

  const response = evaluateOne(sla.responseDueAt, sla.firstRespondedAt, now, sla.pausedAt);
  const resolution = evaluateOne(sla.resolutionDueAt, sla.resolvedAt, now, sla.pausedAt);

  const open = !resolution.met;
  const remainingMs = new Date(sla.resolutionDueAt).getTime() - now.getTime();
  const hoursLeft = remainingMs / (60 * MINUTE);
  const riskLevel = !open || sla.pausedAt
    ? "none"
    : hoursLeft <= 0
      ? "breached"
      : hoursLeft <= 2
        ? "high"
        : hoursLeft <= 8
          ? "medium"
          : "low";

  return { response, resolution, atRisk: riskLevel === "high" || riskLevel === "breached", riskLevel };
}

function evaluateOne(dueAt, metAt, now, pausedAt) {
  const due = new Date(dueAt).getTime();
  if (metAt) {
    const met = new Date(metAt).getTime();
    return { met: true, metAt, dueAt, late: met > due, deltaMinutes: Math.round((met - due) / MINUTE) };
  }
  if (pausedAt) {
    return { met: false, dueAt, state: "paused", deltaMinutes: null, note: "SLA en pausa esperando al usuario" };
  }
  const deltaMinutes = Math.round((now.getTime() - due) / MINUTE);
  return {
    met: false,
    dueAt,
    state: deltaMinutes > 0 ? "breached" : "on_track",
    deltaMinutes,
    minutesRemaining: -deltaMinutes,
  };
}

/**
 * Registra la primera respuesta al usuario. Solo la primera cuenta: responder
 * antes de tiempo no "recompra" un plazo ya consumido.
 */
export function markResponded(sla, now) {
  if (!sla || sla.firstRespondedAt) return sla;
  return { ...sla, firstRespondedAt: now.toISOString() };
}

/** Marca la resolucion efectiva y cierra el reloj. */
export function markResolved(sla, now) {
  if (!sla) return sla;
  return { ...sla, resolvedAt: now.toISOString() };
}
