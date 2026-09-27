/**
 * Serializacion canonica.
 *
 * La bitacora de auditoria es una cadena hash: la misma decision debe producir
 * exactamente el mismo hash en cualquier maquina y en cualquier orden de
 * claves. `JSON.stringify` no lo garantiza, asi que aqui se ordenan las claves
 * de forma recursiva antes de serializar.
 */

/**
 * @param {unknown} value
 * @returns {unknown} copia con claves ordenadas
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** @param {unknown} value */
export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

/** Clon profundo sin depender de `structuredClone` (valores simples). */
export function deepClone(value) {
  return structuredClone(value);
}
