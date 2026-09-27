/**
 * Ecosistema de agentes: manifiesto, reparto y traspasos.
 */

export {
  AGENTS,
  HANDOFFS,
  MAX_HOPS,
  agentById,
  canHandoff,
  handoffTargetsFor,
  routeFor,
  validateManifest,
} from "./manifest.js";

export { handoff, initialRoute, incomingRoutes, describeHandoff, validateHandoffs } from "./router.js";
