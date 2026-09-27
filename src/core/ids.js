/**
 * Generacion de identificadores.
 *
 * `randomUUID` no se usa para referencias visibles: un ticket necesita un
 * codigo corto y pronunciable por un operador ("HD-7F3K2Q"). El identificador
 * criptografico completo se conserva en `auditRef` para correlación.
 */

import { randomInt, randomUUID } from "node:crypto";

/**
 * Alfabeto sin caracteres ambiguos.
 *
 * Se eliminan los pares que se confunden al leerlos o dictarlos en voz alta:
 * O/0, I/1, L/1 y S/5. El par S/5 importaba de verdad: un ticket con "5" y otro
 * con "S" en la misma posicion se parecen hasta que alguien los copia, y el
 * identificador corto existe precisamente para ser transcrito a mano.
 *
 * Alinear el comentario con el codigo cuesta ocho caracteres de entropia por
 * posicion: son 28 en vez de 36, y a seis posiciones quedan 481.890.304
 * combinaciones. Estas dos cifras las verifica `test/store.test.js` a proposito:
 * un comentario con numeros que nadie comprueba se pudre en silencio, y una
 * referencia corta que se puede confundir entre si es peor que una larga.
 */
export const ALPHABET = "2346789ABCDEFGHJKMNPQRTVWXYZ";

/**
 * El patron de validacion se deriva del alfabeto en vez de escribirse aparte.
 *
 * Habia dos verdades: la constante que genera y la clase de caracteres escrita
 * dentro de la expresion regular. Nadie las comparaba, y divergir solo en una
 * direccion hacia que el sistema fabricara identificadores que su propio
 * validador rechazaba. Divergir en la otra no rompia nada visible: solo
 * reducia el espacio sin avisar. Derivar una de otra deja un unico sitio que
 * cambiar y hace que esa clase de bug no pueda construirse.
 */
const claseSinReglas = ALPHABET.replace(/[.*+?^${}()|[\]\-]/g, "\$&");

/**
 * Genera una referencia corta y no ambigua.
 * @param {number} [length=6]
 * @returns {string} p. ej. `HD-7F3K2Q`
 */
export function newReference(prefix = "HD", length = 6) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return `${prefix}-${out}`;
}

/** Identificador criptografico para correlacion interna. */
export function newCorrelationId() {
  return randomUUID();
}

/** Identificador de ticket en formato estable, equivalente a la referencia. */
export function newTicketId() {
  return newReference("HD");
}

/** Forma que debe cumplir un identificador de ticket. Se usa al leer de disco. */
export const TICKET_ID_RE = new RegExp(`^HD-[${claseSinReglas}]{6}$`);
