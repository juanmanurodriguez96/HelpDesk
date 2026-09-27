/**
 * Ejecutor de remediaciones.
 *
 * La regla que gobierna todo el modulo:
 *
 *   Un playbook solo se aplica si el DIAGNOSTICO lo sostiene Y el riesgo lo
 *   permite Y la operacion es real.
 *
 * Las tres condiciones se comprueban por separado y en ese orden, y cada salto
 * deja constancia. La mayoria de los errores de un agente autonomo en soporte no
 * vienen de ejecutar mal un comando, sino de ejecutar el comando correcto en una
 * situacion en la que no debia: sin diagnostico que lo justifique, sin aviso, o
 * sin permiso. Por eso las tres compuertas son bloqueos reales, no avisos.
 *
 * El ejecutor no hace nada por su cuenta: delega en un ADAPTADOR inyectado. Asi
 * el flujo completo (diagnostico -> decision -> ejecucion -> registro) se puede
 * probar sin tocar un solo sistema, y en produccion el adaptador es quien habla
 * con el directorio, el portal o la API.
 */

import { playbooksForCategory, playbookById, PLAYBOOKS } from "./playbooks.js";
import { newReference } from "../core/ids.js";
import { PolicyError, ValidationError } from "../core/errors.js";

/**
 * Adaptador por defecto: no hace nada.
 *
 * Es el adaptador por defecto a proposito. Un sistema recien desplegado debe
 * poder responder "¿que harias?" sin tener configurado ningun acceso, y la
 * respuesta tiene que ser "nada, porque no hay adaptador": no "nada, porque se
 * produjo un error" ni, peor, una ejecucion silenciosa contra un backend de
 * pruebas.
 */
export function nullAdapter() {
  return {
    name: "null",
    available: () => false,
    async apply() {
      throw new PolicyError(
        "REMEDIATION_NO_ADAPTER",
        "No hay ningun adaptador de remediacion conectado: la accion NO se ha ejecutado.",
      );
    },
  };
}

/**
 * Decide si un playbook puede aplicarse.
 *
 * Devuelve una lista de BLOQUEOS, no un booleano. Un booleano obliga a quien
 * llama a averiguar el motivo; una lista de bloqueos se puede enseñar al usuario
 * o al operador tal cual, que es lo unico que hace falta para desbloquear el
 * caso.
 *
 * @param {object} args
 * @param {object} args.playbook
 * @param {object} args.ticket
 * @param {object} [args.diagnosis]
 * @param {boolean} [args.confirmed]  Confirmacion humana explicita.
 * @returns {{allowed: boolean, risk: string, blocks: Array<object>, missing: string[]}}
 */
export function evaluate({ playbook, ticket, diagnosis = null, confirmed = false }) {
  const blocks = [];
  const missing = [];

  for (const field of playbook.requires ?? []) {
    if (isEmpty(ticket.entities?.[field])) missing.push(field);
  }
  if (missing.length > 0) {
    blocks.push({
      code: "MISSING_REQUIREMENTS",
      reason: `Faltan datos obligatorios: ${missing.join(", ")}.`,
      resolvableBy: "user",
    });
  }

  // Compuerta 1: el diagnostico tiene que SOSTENER la accion. Un playbook
  // aplicado sin informe es un acto de fe, y en soporte eso se traduce en
  // "reiniciamos el equipo y a ver si se arregla".
  const conclusive = diagnosis?.cause?.conclusive === true;
  if (!conclusive) {
    blocks.push({
      code: "DIAGNOSIS_NOT_CONCLUSIVE",
      reason: diagnosis
        ? `El diagnostico no es concluyente (confianza ${diagnosis.cause?.confidence ?? "n/d"}).`
        : "No se ha ejecutado ningun diagnostico.",
      resolvableBy: "agent",
    });
  }

  // Compuerta 2: el riesgo marca la Via. Nada de esto es negociable por
  // confianza alta del diagnostico: un diagnostico puede estar equivocado, y lo
  // que protege al usuario no es la certeza, es la reversibilidad.
  if (playbook.risk === "destructive" && !confirmed) {
    blocks.push({
      code: "HUMAN_CONFIRMATION_REQUIRED",
      reason: "La accion es destructiva y necesita confirmacion humana explicita.",
      resolvableBy: "human",
    });
  }
  if (playbook.risk === "disruptive" && !confirmed && diagnosis?.cause?.confidence < 0.8) {
    blocks.push({
      code: "DISRUPTIVE_LOW_CONFIDENCE",
      reason: "La accion interrumpe el trabajo del usuario y el diagnostico no es de alta confianza.",
      resolvableBy: "agent",
    });
  }

  return {
    allowed: blocks.length === 0,
    risk: playbook.risk,
    blocks,
    missing,
  };
}

/**
 * Aplica un playbook.
 *
 * Por defecto `dryRun: true`. Escribir en un sistema real tiene que ser una
 * decision consciente de quien lo invoca, no el comportamiento por defecto de una
 * funcion que se llama desde un agente. El dry-run devuelve el mismo plan con
 * `executed: false`, de modo que se puede revisar exactamente lo que habria
 * ocurrido.
 *
 * @param {object} args
 * @returns {Promise<object>}
 */
export async function remediate({
  ticket,
  playbookId,
  diagnosis = null,
  adapter = nullAdapter(),
  confirmed = false,
  dryRun = true,
  lang = "es",
  actor = "system",
  allowNetwork = false,
}) {
  if (!ticket) throw new ValidationError("REMEDIATION_TICKET_REQUIRED", "La remediacion necesita un ticket.");

  const playbook = playbookId ? playbookById(playbookId) : pickPlaybook(ticket);
  if (!playbook) {
    throw new ValidationError("REMEDIATION_NO_PLAYBOOK", "No hay ningun playbook que aplique a este ticket.", {
      category: ticket.category,
    });
  }

  const verdict = evaluate({ playbook, ticket, diagnosis, confirmed });

  const plan = {
    id: newReference("ACT"),
    ticketId: ticket.id,
    playbook: playbook.id,
    action: playbook.action,
    params: { ...playbook.params },
    risk: playbook.risk,
    rollback: playbook.rollback,
    guidance: playbook.guidance[lang] ?? playbook.guidance.en,
    at: new Date().toISOString(),
  };

  if (!verdict.allowed) {
    return {
      ...plan,
      executed: false,
      status: "blocked",
      blocks: verdict.blocks,
      missing: verdict.missing,
      /** Quien puede desbloquearlo: el usuario, otro agente o una persona. */
      awaiting: [...new Set(verdict.blocks.map((b) => b.resolvableBy))],
    };
  }

  if (dryRun) {
    return {
      ...plan,
      executed: false,
      status: "planned",
      note: "Simulacion: no se ha ejecutado nada. Use dryRun: false para aplicarla.",
    };
  }

  if (!adapter.available({ ticket, playbook })) {
    return {
      ...plan,
      executed: false,
      status: "unavailable",
      blocks: [
        {
          code: "ADAPTER_UNAVAILABLE",
          reason: `El adaptador "${adapter.name}" no esta disponible para esta accion.`,
          resolvableBy: "human",
        },
      ],
    };
  }

  const startedAt = Date.now();
  try {
    const result = await adapter.apply({ ticket, playbook, actor, allowNetwork });
    return {
      ...plan,
      executed: true,
      status: "applied",
      result,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    // Un fallo de ejecucion NO es un exito parcial. Se registra como tal, con su
    // codigo, para que el operador sepa que el sistema pudo quedar a medias.
    return {
      ...plan,
      executed: false,
      status: "failed",
      error: { code: error.code ?? "REMEDIATION_FAILED", message: String(error.message ?? error) },
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Elige el playbook mas adecuado para el ticket: el de menor riesgo posible. */
function pickPlaybook(ticket) {
  const candidates = playbooksForCategory(ticket.category);
  if (candidates.length === 0) return null;
  const order = { reversible: 0, disruptive: 1, destructive: 2 };
  return [...candidates].sort((a, b) => order[a.risk] - order[b.risk])[0];
}

function isEmpty(value) {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

export { PLAYBOOKS };
