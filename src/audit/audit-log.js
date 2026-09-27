/**
 * Bitacora de auditoria encadenada por hash.
 *
 * Requisito cubierto: "manteniendo una bitacora auditable de cada decision tomada".
 *
 * Cada entrada encadena el hash de la anterior, de forma que alterar o borrar una
 * linea historica rompe la cadena de forma detectable por `verify()`. No es
 * criptografia de produccion (no hay firma ni clave), pero convierte "el registro
 * dice que..." en una afirmacion comprobable, que es lo que un auditor necesita
 * para fiarse de un registro generado por un agente.
 *
 * Formato: JSON Lines. Append-only. Nunca se reescribe una entrada existente.
 *
 * Limite conocido, dicho aqui para que nadie lo descubra tarde: esta cadena
 * detecta ALTERACIONES, no SUPRESIONES. Borrar las tres ultimas lineas deja un
 * prefijo perfectamente valido, porque el encadenamiento solo mira hacia atras.
 * Para cerrar ese hueco hay que anclar la cabeza fuera del fichero (el `head` que
 * devuelve `verify()` en un sistema de vigilancia externo, en una nota de cambio, o
 * en la propia salida de un proceso de auditoria).
 */

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { IntegrityError } from "../core/errors.js";
import { stableStringify } from "../core/canonical-json.js";
import { containsSecret } from "../privacy/pii.js";

/** Hash raiz de una bitacora vacia. */
export const GENESIS = "0".repeat(64);

/**
 * @typedef {object} AuditEntryInput
 * @property {string}  ticketId
 * @property {string}  actor     Agente, sistema u operador que decidio.
 * @property {string}  action    Verbo estable: `ticket.created`, `ticket.transitioned`...
 * @property {string} [rationale] Por que se decidio. Es lo que se audita.
 * @property {object} [before]   Estado previo (solo claves permitidas).
 * @property {object} [after]    Estado posterior.
 * @property {object} [context]  Contexto adicional ya saneado.
 */

/**
 * Claves que jamas se escriben en la bitacora, por muy anchas que sean
 * `before`/`after`. Se cubren las dos convenciones porque un registro serializado
 * desde Python traera `api_key` y desde JavaScript `apiKey`, y el descuido suele
 * ser justo en el lado que nadie revisa.
 */
const FORBIDDEN_KEYS =
  /^(password|passwd|pwd|secret|secrets|token|access[_-]?token|refresh[_-]?token|credential|credentials|api[_-]?key|authorization|auth|private[_-]?key|session[_-]?id|cookie)$/i;

/**
 * Calcula el hash de una entrada.
 * @param {string} prevHash
 * @param {object} entry  Entrada SIN `prevHash` ni `hash`.
 */
export function hashEntry(prevHash, entry) {
  return createHash("sha256").update(`${prevHash}\n${stableStringify(entry)}`, "utf8").digest("hex");
}

/**
 * Elimina recursivamente claves prohibidas.
 * Es una red de seguridad: el diseno ya impide que lleguen secretos (se redacta al
 * ingreso), pero un.descuido al construir un payload no debe romper la promesa.
 */
function stripForbidden(value, trail = "root") {
  if (Array.isArray(value)) return value.map((v, i) => stripForbidden(v, `${trail}[${i}]`));
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) continue;
    out[key] = stripForbidden(v, `${trail}.${key}`);
  }
  return out;
}

/**
 * Crea (o reabre) una bitacora sobre un fichero JSON Lines.
 *
 * @param {string} file
 * @returns {{append: Function, all: Function, verify: Function, tail: Function, file: string}}
 */
export function createAuditLog(file) {
  function ensureDir() {
    const dir = dirname(file);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  function all() {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new IntegrityError("AUDIT_LINE_CORRUPT", `Linea ${index + 1} de la bitacora ilegible.`, {
            file,
            line: index + 1,
          });
        }
      });
  }

  function append(input) {
    assertAuditable(input);
    const entries = all();
    const prev = entries.length ? entries[entries.length - 1].hash : GENESIS;
    const seq = entries.length + 1;

    const entry = stripForbidden({
      seq,
      at: input.at,
      ticketId: input.ticketId,
      actor: input.actor,
      action: input.action,
      rationale: input.rationale ?? null,
      decision: input.decision ?? null,
      evidence: input.evidence ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      context: input.context ?? null,
      prevHash: prev,
    });

    // El hash se calcula sobre la entrada SIN el campo `hash`; `verify()`
    // reconstruye exactamente ese mismo objeto al quitar el campo. Ambas partes
    // deben coincidir byte a byte o la cadena dira que alguien la manipulo.
    entry.hash = hashEntry(prev, entry);

    ensureDir();
    appendFileSync(file, `${stableStringify(entry)}\n`, "utf8");
    return entry;
  }

  function verify() {
    const entries = all();
    let prev = GENESIS;
    for (const entry of entries) {
      const { hash, ...rest } = entry;
      const expected = hashEntry(prev, rest);
      if (expected !== hash) {
        return {
          ok: false,
          checked: entries.length,
          brokenAt: entry.seq,
          expected,
          found: hash,
        };
      }
      prev = hash;
    }
    return { ok: true, checked: entries.length, head: prev };
  }

  function tail(count = 10) {
    const entries = all();
    return entries.slice(Math.max(0, entries.length - count));
  }

  return { append, all, verify, tail, file };
}

/**
 * Aserciones previas a la escritura. Una bitacora que dice "nunca hubo secretos"
 * no puede contenerlos: si la detectamos, es preferible fallar a fingir.
 */
function assertAuditable(input) {
  if (!input.ticketId) {
    throw new IntegrityError("AUDIT_TICKET_REQUIRED", "Una entrada de bitacora necesita un ticket.");
  }
  if (!input.action) {
    throw new IntegrityError("AUDIT_ACTION_REQUIRED", "Una entrada de bitacora necesita una accion.");
  }
  const serialized = stableStringify(input);
  if (containsSecret(serialized)) {
    throw new IntegrityError("AUDIT_SECRET_REJECTED", "Se ha rechazado una entrada de bitacora con material sensible.", {
      ticketId: input.ticketId,
      action: input.action,
    });
  }
}

/**
 * Vista de una entrada pensada para un humano: sin los hashes ni los objetos
 * completos, que en consola no aportan nada.
 */
export function humanize(entry) {
  return {
    seq: entry.seq,
    at: entry.at,
    ticket: entry.ticketId,
    actor: entry.actor,
    accion: entry.action,
    motivo: entry.rationale,
    transicion: entry.decision ? `${entry.decision.from} -> ${entry.decision.to}` : null,
  };
}
