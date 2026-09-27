/**
 * Almacenamiento en disco.
 *
 * Un ticket por fichero JSON dentro de `data/tickets/`, y una bitacora JSONL por
 * dia dentro de `data/audit/`.
 *
 * Por que un fichero por ticket y no una base de datos: porque el diagnostico y
 * la bitacora tienen que poder **leerse con un editor de texto** cuando algo va
 * mal a las tres de la manana. Un ticket es JSON plano, asi que se abre, se
 * busca, se diferencia y se corrige a mano. Una base de datos exigiria un
 * cliente para leer un ticket, y eso convierte "mirar que paso" en un tramite.
 *
 * Y por que JSON en vez de JSONL en los tickets: cada ticket cambia de estado
 * muchas veces, y reescribir un fichero entero es idempotente. JSONL solo tiene
 * sentido para lo que es un flujo de SOLO ANADIDO, como la bitacora.
 */

import fs from "node:fs";
import path from "node:path";
import { createAuditLog } from "../audit/audit-log.js";
import { validateTicket } from "../domain/lifecycle.js";
import { validateHandoffs } from "../ecosystem/router.js";
import { assertPrivacyInvariant } from "../domain/ticket.js";
import { ValidationError, IntegrityError } from "../core/errors.js";
import { stableStringify } from "../core/canonical-json.js";

/**
 * @typedef {object} Store
 * @property {(id: string) => object} get
 * @property {(ticket: object) => object} save
 * @property {() => object[]} all
 * @property {(id: string) => boolean} exists
 */

/**
 * Crea un almacen sobre un directorio.
 *
 * @param {object} [options]
 * @param {string} [options.dir] Raiz de datos.
 * @param {boolean}[options.strict] Recalcular invariantes al leer (por defecto true).
 * @returns {Store & {audit: object}}
 *
 * No hay `close()` que llamar: cada escritura es sincrona (`writeFileSync` con
 * renombrado atomico), asi que no queda nada en un bucle pendiente cuando
 * `save()` devuelve. Un `close()` aqui seria una promesa de que hay algo que
 * cerrar.
 */
export function createStore({ dir = "data", strict = true } = {}) {
  const root = path.resolve(dir);
  const ticketsDir = path.join(root, "tickets");
  const auditDir = path.join(root, "audit");
  fs.mkdirSync(ticketsDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  const fileFor = (id) => path.join(ticketsDir, `${id}.json`);

  const store = {
    dir: root,
    ticketsDir,
    auditDir,

    exists(id) {
      return fs.existsSync(fileFor(id));
    },

    /**
     * Lee un ticket y comprueba sus invariantes.
     *
     * Se validan AL LEER, no solo al escribir: un fichero editado a mano, o
     * corrupto, tiene que delatarlo en este momento y no cuando alguien intente
     * operar sobre el ticket creyendo que esta bien.
     */
    get(id) {
      const file = fileFor(id);
      if (!fs.existsSync(file)) {
        throw new ValidationError("TICKET_NOT_FOUND", `No existe el ticket ${id}.`, { id });
      }
      let ticket;
      try {
        ticket = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        throw new IntegrityError("TICKET_UNREADABLE", `El ticket ${id} no se puede leer: ${error.message}`, { id, file });
      }

      if (strict) {
        const problems = [...validateTicket(ticket), ...validateHandoffs(ticket)];
        if (problems.length > 0) {
          throw new IntegrityError("TICKET_INVALID", `El ticket ${id} esta corrupto.`, { id, problems });
        }
        try {
          assertPrivacyInvariant(ticket);
        } catch (error) {
          throw new IntegrityError("TICKET_PRIVACY", `El ticket ${id} incumple la invariante de privacidad.`, {
            id,
            fields: error.details?.fields,
          });
        }
      }
      return ticket;
    },

    /**
     * Guarda un ticket. Escritura atomica: se escribe a un temporal y se
     * renombra. Un corte de luz a mitad de escritura deja el fichero
     * anterior intacto, no uno truncado que no se puede ni leer ni borrar
     * por el sistema.
     */
    save(ticket) {
      assertPrivacyInvariant(ticket);
      const problems = validateTicket(ticket);
      if (problems.length > 0) {
        throw new ValidationError("TICKET_INVALID", "El ticket no cumple sus invariantes.", { problems });
      }
      const file = fileFor(ticket.id);
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${stableStringify(ticket)}\n`, "utf8");
      fs.renameSync(temp, file);
      return ticket;
    },

    all() {
      return fs
        .readdirSync(ticketsDir)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => store.get(path.basename(file, ".json")));
    },

    remove(id) {
      const file = fileFor(id);
      if (!fs.existsSync(file)) return false;
      fs.unlinkSync(file);
      return true;
    },

    /** Sin estado abierto: la bitacora se escribe de forma sincrona. */
    audit: createAuditLog(path.join(auditDir, "bitacora.jsonl")),
  };

  return store;
}
