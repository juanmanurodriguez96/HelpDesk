/**
 * Reparto y traspasos entre agentes.
 *
 * Traduce el manifiesto en movimientos concretos sobre el ticket. La regla que
 * gobierna todo el modulo:
 *
 *   Un agente que ya ha visto el ticket NO vuelve a verlo.
 *
 * Por que en ese sentido y no en el de "no repetir estados": el bucle que de
 * verdad da problemas en soporte no es A -> B -> A (dos agentes), sino
 * A -> B -> C -> A donde el ticket vuelve a empezar por donde ya estaba. El
 * rastro (`handoffs.trail`) lo corta, y el tope de `MAX_HANDOFFS` es la red
 * debajo por si el rastro se manipulase.
 */

import { ValidationError, PolicyError } from "../core/errors.js";
import { cloneTicket } from "../domain/ticket.js";
import { MAX_HANDOFFS } from "../domain/lifecycle.js";
import { AGENTS, HANDOFFS, agentById, canHandoff, routeFor } from "./manifest.js";

/**
 * Primer destino de un ticket recien triado.
 *
 * @param {object} ticket
 * @returns {string} id de agente
 */
export function initialRoute(ticket) {
  return routeFor({ category: ticket.category, typology: ticket.typology });
}

/**
 * Traspasa un ticket a otro agente.
 *
 * @param {object} args
 * @param {object} args.ticket
 * @param {string} args.to            Agente destino.
 * @param {string} [args.rationale]   Motivo; queda en el historial.
 * @param {Date}   [args.now]
 * @param {boolean}[args.force]       Saltar la regla del rastro (uso administrativo).
 * @returns {object} ticket actualizado
 * @throws {ValidationError} destino inexistente
 * @throws {PolicyError}    traspaso no declarado, ciclo o tope alcanzado
 */
export function handoff({ ticket, to, rationale, now = new Date(), force = false }) {
  if (!agentById(to)) {
    throw new ValidationError("HANDOFF_UNKNOWN_AGENT", `No existe el agente "${to}".`, {
      available: AGENTS.map((a) => a.id),
    });
  }
  if (ticket.assignedAgent === to) {
    return ticket; // Idempotente: traspasar al que ya esta no es un error.
  }

  const check = canHandoff({
    from: ticket.assignedAgent ?? "helpdesk-orchestrator",
    to,
    trail: ticket.handoffs.trail,
  });

  if (!check.allowed && !force) {
    const overLimit = ticket.handoffs.count >= MAX_HANDOFFS;
    throw new PolicyError(overLimit ? "HANDOFF_LIMIT_REACHED" : "HANDOFF_NOT_ALLOWED", check.reason, {
      from: ticket.assignedAgent,
      to,
      trail: ticket.handoffs.trail,
      limit: MAX_HANDOFFS,
    });
  }

  const next = cloneTicket(ticket);
  const from = ticket.assignedAgent ?? "helpdesk-orchestrator";
  next.assignedAgent = to;
  next.handoffs.count += 1;
  next.handoffs.trail = [...next.handoffs.trail, from];
  next.updatedAt = now.toISOString();
  next.history.push({
    at: now.toISOString(),
    from,
    to,
    actor: "agent",
    rationale: rationale ?? describeHandoff(from, to),
  });
  return next;
}

/** Texto legible del motivo de un traspaso declarado. */
export function describeHandoff(from, to) {
  const declared = HANDOFFS.find((h) => h.from === from && h.to === to);
  return declared ? declared.when.description : `Traspaso de "${from}" a "${to}".`;
}

/**
 * Todos los destinos alcanzables desde un agente, con su motivo.
 * Lo usa el agente receptor para saber por que le ha llegado el ticket.
 */
export function incomingRoutes(ticket) {
  return HANDOFFS.filter((h) => h.to === ticket.assignedAgent);
}

/**
 * Comprobacion de invariantes del traspaso. Pensada para el validador y para
 * leer un ticket de disco: si un ticket trae un rastro incoherente, esta
 * fonction lo dice en vez de dejarlo pasar.
 */
export function validateHandoffs(ticket) {
  const problems = [];
  if (!ticket.handoffs) {
    problems.push("Falta el bloque handoffs");
    return problems;
  }
  const trail = ticket.handoffs.trail;
  if (new Set(trail).size !== trail.length) {
    problems.push("El rastro de traspasos repite agente: eso solo puede venir de un ciclo");
  }
  if (ticket.handoffs.count > MAX_HANDOFFS) {
    problems.push(`Traspasos por encima del tope (${ticket.handoffs.count} > ${MAX_HANDOFFS})`);
  }
  if (ticket.assignedAgent && !agentById(ticket.assignedAgent)) {
    problems.push(`Agente asignado desconocido: ${ticket.assignedAgent}`);
  }
  return problems;
}
