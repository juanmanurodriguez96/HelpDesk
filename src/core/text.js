/**
 * Saneado de texto de entrada.
 *
 * Regla de diseno: la redaccion se aplica ANTES de que el texto entre en
 * cualquier logica de negocio. Un ticket nunca se persiste en su forma original
 * si contiene un secreto, ni siquiera "temporalmente" en memoria compartida con
 * los diagnosticos. Ver `src/privacy/pii.js`.
 */

/**
 * Normaliza para comparacion: minusculas, sin diacriticos, espacios colapsados.
 * Castellano y ingles se analizan con la misma tabla de terminos.
 * @param {string} text
 */
export function normalize(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s@._-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Primeras `n` palabras, para titulares y resumenes. */
export function firstWords(text, n = 12) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= n) return clean;
  return `${clean.slice(0, clean.lastIndexOf(" ", n) > 0 ? clean.lastIndexOf(" ", n) : n)}...`;
}

/** Recorta a `max` caracteres agregando elipsis. */
export function truncate(text, max = 240) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
