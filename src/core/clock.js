/**
 * Reloj inyectable.
 *
 * Ningun modulo lee `Date.now()` directamente: todo recibe un reloj. Eso hace
 * que los SLA, los tiempos de espera y la bitacora sean reproducibles en tests
 * y que el modo "simulacion" de los diagnosticos sea determinista.
 */

/** @typedef {{ now: () => Date }} Clock */

/** @type {Clock} */
export const systemClock = {
  now: () => new Date(),
};

/**
 * Reloj fijo o programable, para tests y para el comando `demo`.
 * @param {string|Date} [start]
 */
export function fixedClock(start = "2026-01-05T09:00:00.000Z") {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set(next) {
      current = new Date(next);
    },
    advanceMinutes(minutes) {
      current = new Date(current.getTime() + minutes * 60_000);
    },
  };
}

/** ISO-8601 con precision de milisegundos, formato unico de timestamps. */
export function iso(date) {
  return new Date(date).toISOString();
}
