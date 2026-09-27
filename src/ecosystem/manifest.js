/**
 * Manifiesto del ecosistema de agentes.
 *
 * Este archivo es la UNICA fuente de verdad del enrutado. Los ficheros de
 * `.opencode/agent/*.md` describen COMO debe comportarse cada agente; este
 * manifiesto declara QUIEN existe, a quien puede traspasar y cuando. La
 * separacion no es puramente estetica:
 *
 *   - El comportamiento (frontmatter) lo lee el runtime de opencode, que no
 *     sabe nada de este repositorio.
 *   - La topologia la necesita el codigo, para poder decidir a donde va un
 *     ticket antes de escribir nada.
 *
 * Si las dos se escribieran en un solo sitio, o el runtime no podria leerla
 * (esta en markdown con prosa) o el codigo no podria validarla. Ademas,
 * duplicar la topologia en dos sitios garantiza que divergen.
 *
 * `tools/validate-ecosystem.mjs` comprueba que ambos lados coinciden. Esa
 * comprobacion es la que convierte "documentado" en "garantizado".
 *
 * Topologia (DAGS, sin ciclos):
 *
 *   orchestrator ──> identity-support ──┐
 *        │          access-provisioning ┼──> escalation-desk
 *        └────────> infra-support ──────┘
 *
 *   escalation-desk es terminal: no delega. Es la unica forma de garantizar que
 *   el ciclo termina, junto con el tope de traspasos.
 */

import { MAX_HANDOFFS } from "../domain/lifecycle.js";
import { TYPOLOGIES } from "../knowledge/taxonomy.js";

/**
 * @typedef {object} AgentSpec
 * @property {string}   id
 * @property {string}   file          Ruta relativa del fichero de agente.
 * @property {string}   mode          `primary` | `subagent`.
 * @property {string}   description
 * @property {string[]} typologies    Tipologias que le corresponden.
 * @property {string[]} categories    Categorias que le corresponden.
 * @property {string[]} owns          Sistemas sobre los que puede actuar.
 * @property {string[]} forbidden     Acciones que jamas ejecuta.
 * @property {string[]} handoffTargets
 * @property {object}   tools         Herramientas permitidas.
 * @property {object}   bash          Reglas de shell,evaluated en orden.
 */

/** @type {AgentSpec[]} */
export const AGENTS = [
  {
    id: "helpdesk-orchestrator",
    file: ".opencode/agents/helpdesk-orchestrator.md",
    mode: "primary",
    description: "Punto de entrada del servicio de soporte. Recibe la incidencia, la redacta, la clasifica, decide a que agente le toca y cierra el ticket.",
    typologies: [],
    categories: [],
    owns: [],
    forbidden: [
      "ejecutar remediaciones directamente",
      "cerrar un ticket sin evidencia de resolucion",
    ],
    handoffTargets: ["identity-support", "infra-support", "access-provisioning", "escalation-desk"],
    tools: { allow: ["read", "glob", "grep", "list", "task", "todowrite", "question"], deny: ["edit", "webfetch", "websearch"] },
    bash: { "node src/cli.js *": "allow", "*": "deny" },
  },
  {
    id: "identity-support",
    file: ".opencode/agents/identity-support.md",
    mode: "subagent",
    description: "Cuentas, bloqueo por intentos, doble factor, contrasenas y bajas de usuario. Agente especialista en identidad corporativa.",
    typologies: [TYPOLOGIES.ACCESO_IDENTIDAD],
    categories: ["identity.lockout", "identity.password_reset", "identity.mfa", "identity.disabled"],
    owns: ["directorio corporativo", "portal de doble factor"],
    forbidden: [
      "pedir contrasenas o codigos de verificacion al usuario",
      "acceder con las credenciales de un usuario",
    ],
    handoffTargets: ["escalation-desk"],
    tools: { allow: ["read", "grep", "list", "task", "skill"], deny: ["edit", "webfetch", "websearch"] },
    bash: { "node src/cli.js identity *": "allow", "*": "deny" },
  },
  {
    id: "infra-support",
    file: ".opencode/agents/infra-support.md",
    mode: "subagent",
    description: "Red, VPN, conectividad, equipos, antivirus y degradacion de servicios. Ejecuta diagnosticos y es el unico agente que puede salir a la red con autorizacion.",
    typologies: [TYPOLOGIES.INFRAESTRUCTURA],
    categories: [
      "network.vpn",
      "network.connectivity",
      "endpoint.performance",
      "endpoint.security_agent",
      "service.degradation",
      "software.app_error",
    ],
    owns: ["inventario de equipos", "probes de servicio"],
    forbidden: [
      "salir a la red sin autorizacion explicita",
      "reiniciar el equipo de un usuario sin confirmacion",
    ],
    handoffTargets: ["escalation-desk"],
    tools: { allow: ["read", "glob", "grep", "list", "task", "skill"], deny: ["edit", "webfetch", "websearch"] },
    bash: { "node src/cli.js diagnose *": "allow", "node src/cli.js remediate * --dry-run": "allow", "*": "deny" },
  },
  {
    id: "access-provisioning",
    file: ".opencode/agents/access-provisioning.md",
    mode: "subagent",
    description: "Permisos, licencias, altas y bajas. Decide sobre accesos, ejecuta la aprobacion y nunca concede un permiso sin recurso identificado.",
    typologies: [TYPOLOGIES.ACCESO_IDENTIDAD, TYPOLOGIES.APROVISIONAMIENTO],
    categories: [
      "provisioning.folder_access",
      "provisioning.license",
      "provisioning.profile_change",
    ],
    owns: ["gestor de permisos", "inventario de licencias"],
    forbidden: [
      "conceder permisos sin recurso identificado",
      "asignar una licencia sin disponibilidad confirmada",
    ],
    handoffTargets: ["escalation-desk"],
    tools: { allow: ["read", "grep", "list", "task", "skill"], deny: ["edit", "webfetch", "websearch"] },
    bash: { "node src/cli.js remediate *": "allow", "node src/cli.js identity *": "deny", "*": "deny" },
  },
  {
    id: "escalation-desk",
    file: ".opencode/agents/escalation-desk.md",
    mode: "subagent",
    description: "Ultimo eslabon del flujo. Recibe lo que los agentes automaticos no pueden resolver y lo decide una persona. No delega.",
    typologies: [],
    categories: [],
    owns: [],
    forbidden: ["delegar en otro agente", "cerrar un ticket sin acuerdo humano"],
    /** Terminal a proposito: no delega, y por eso el ciclo termina siempre. */
    handoffTargets: [],
    tools: { allow: ["read", "grep", "list", "task", "question", "todowrite"], deny: ["edit", "webfetch", "websearch", "bash"] },
    bash: { "*": "deny" },
  },
];

/**
 * Transpasos permitidos. Cada uno lleva la CONDICION que lo justifica, porque
 * un grafo sin condiciones acaba usandose como "reenviar a quien sea" y el
 * reparto se vuelve inexplicable.
 *
 * @type {Array<{from: string, to: string, when: object}>}
 */
export const HANDOFFS = [
  {
    from: "helpdesk-orchestrator",
    to: "identity-support",
    when: { categories: ["identity.*"], description: "La incidencia pertenece al ambito de identidad." },
  },
  {
    from: "helpdesk-orchestrator",
    to: "infra-support",
    when: { typologies: ["infraestructura"], description: "Requiere diagnostico tecnico." },
  },
  {
    from: "helpdesk-orchestrator",
    to: "access-provisioning",
    when: { categories: ["provisioning.*"], description: "Es una peticion de acceso o de alta." },
  },
  {
    from: "helpdesk-orchestrator",
    to: "escalation-desk",
    when: {
      any: ["ambigua", "alcance_empresarial", "fuera_de_alcance"],
      description: "No se puede decidir sola: ambiguedad, impacto de empresa o fuera de alcance.",
    },
  },
  { from: "identity-support", to: "escalation-desk", when: { any: ["sin_permiso", "riesgo_destructivo"], description: "La accion excede lo que puede hacer sin una persona." } },
  { from: "infra-support", to: "escalation-desk", when: { any: ["sin_diagnostico", "sin_permiso"], description: "El diagnostico no concluye o la accion excede su autoridad." } },
  { from: "access-provisioning", to: "escalation-desk", when: { any: ["sin_recurso", "aprobacion_pendiente"], description: "Falta aprobacion o no hay recurso identificado." } },
];

export const MAX_HOPS = MAX_HANDOFFS;

/** Agente por identificador. */
export function agentById(id) {
  return AGENTS.find((a) => a.id === id) ?? null;
}

/** Destinos de traspaso de un agente. */
export function handoffTargetsFor(id) {
  return agentById(id)?.handoffTargets ?? [];
}

/**
 * Decide si `from` puede traspasar a `to`.
 *
 * Tres comprobaciones, en este orden, y las tres importan:
 *
 *   1. El traspaso existe en el manifiesto. Sin esto, un agente podria
 *      "colarse" en cualquier flujo.
 *   2. El destino no es el mismo. Un traspaso a si mismo es un bucle de un paso.
 *   3. El destino no aparece ya en el rastro. Esto es lo que corta los ciclos
 *      LARGOS: A -> B -> C -> A. El agente que ya intervino no vuelve a entrar.
 *
 * @param {object} args
 * @param {string} args.from
 * @param {string} args.to
 * @param {string[]} [args.trail] Agentes por los que ya ha pasado.
 * @returns {{allowed: boolean, reason: string}}
 */
export function canHandoff({ from, to, trail = [] }) {
  const permitted = HANDOFFS.some((h) => h.from === from && h.to === to);
  if (!permitted) {
    return { allowed: false, reason: `No existe un traspaso declarado de "${from}" a "${to}".` };
  }
  if (from === to) {
    return { allowed: false, reason: "Un agente no puede traspasarse a si mismo." };
  }
  if (trail.includes(to)) {
    return { allowed: false, reason: `"${to}" ya intervino en este ticket: volver a el seria un ciclo.` };
  }
  const hops = trail.filter((id) => id !== null && id !== undefined).length;
  if (hops >= MAX_HOPS) {
    return { allowed: false, reason: `Tope de ${MAX_HOPS} traspasos alcanzado.` };
  }
  return { allowed: true, reason: "Traspaso declarado en el manifiesto." };
}

/**
 * Valida el manifiesto en si mismo.
 *
 * Esto NO comprueba los ficheros de agente (eso lo hace el validador de
 * `tools/`); comprueba las propiedades topologicas, que son las que un error
 * humano convierte en un bucle silencioso: un destino inexistente, un ciclo, un
 * agente terminal que delega.
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateManifest() {
  const errors = [];
  const ids = new Set(AGENTS.map((a) => a.id));

  for (const agent of AGENTS) {
    for (const target of agent.handoffTargets) {
      if (!ids.has(target)) {
        errors.push(`El agente "${agent.id}" declara el destino "${target}", que no existe.`);
      }
    }
  }

  for (const handoff of HANDOFFS) {
    if (!ids.has(handoff.from)) {
      errors.push(`El traspaso sale de "${handoff.from}", que no existe.`);
    }
    if (!ids.has(handoff.to)) {
      errors.push(`El traspaso llega a "${handoff.to}", que no existe.`);
    }
  }

  // Cada arista del grafo de traspasos debe existir tambien en `handoffTargets`
  // del agente origen. Si divergen, el codigo y la documentacion mienten.
  for (const handoff of HANDOFFS) {
    const agent = agentById(handoff.from);
    if (agent && !agent.handoffTargets.includes(handoff.to)) {
      errors.push(
        `"${handoff.from}" declara el traspaso a "${handoff.to}" pero no lo lista en handoffTargets.`,
      );
    }
  }
  for (const agent of AGENTS) {
    for (const target of agent.handoffTargets) {
      if (!HANDOFFS.some((h) => h.from === agent.id && h.to === target)) {
        errors.push(`"${agent.id}" lista "${target}" en handoffTargets pero no hay traspaso declarado.`);
      }
    }
  }

  errors.push(...findCycles());

  // La longitud maxima de un camino debe caber en el tope de traspasos, o el
  // sistema topa contra si mismo en el peor caso.
  const longest = longestPath();
  if (longest > MAX_HOPS) {
    errors.push(
      `El camino mas largo del grafo tiene ${longest} saltos y el tope es ${MAX_HOPS}: habria rutas que no pueden completarse.`,
    );
  }

  return { ok: errors.length === 0, errors };
}

/** Detecta ciclos con recorrido en profundidad por color. */
function findCycles() {
  const errors = [];
  const adjacency = new Map(AGENTS.map((a) => [a.id, a.handoffTargets]));
  const state = new Map(); // 0 visiting, 1 done

  const visit = (id, path) => {
    if (state.get(id) === 1) return;
    if (state.get(id) === 0) {
      errors.push(`Ciclo de traspasos: ${[...path, id].join(" -> ")}.`);
      return;
    }
    state.set(id, 0);
    for (const next of adjacency.get(id) ?? []) visit(next, [...path, id]);
    state.set(id, 1);
  };

  for (const agent of AGENTS) visit(agent.id, []);
  return errors;
}

/** Camino mas largo en numero de saltos. */
function longestPath() {
  const adjacency = new Map(AGENTS.map((a) => [a.id, a.handoffTargets]));
  const depth = (id, seen) => {
    if (seen.has(id)) return 0;
    const next = new Set(seen).add(id);
    return Math.max(0, ...(adjacency.get(id) ?? []).map((t) => 1 + depth(t, next)));
  };
  return Math.max(0, ...AGENTS.map((a) => depth(a.id, new Set())));
}

/** Agente que debe recibir un ticket segun su categoria y tipologia. */
export function routeFor({ category, typology }) {
  const direct = AGENTS.find(
    (a) => a.categories.includes(category) || a.typologies.includes(typology),
  );
  if (direct) return direct.id;

  const fallback = HANDOFFS.find((h) => h.from === "helpdesk-orchestrator" && h.to === "escalation-desk");
  return fallback.to;
}
