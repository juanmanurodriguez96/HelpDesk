/**
 * Diagnostico: punto de entrada del subsistema.
 */

export { runCheck, summarize } from "./check.js";
export {
  ALL_CHECKS,
  NETWORK_CHECKS,
  SERVICE_CHECKS,
  checkById,
  contextFromTicket,
  networkAllowed,
} from "./network-checks.js";
export { diagnose, veredictRate } from "./engine.js";
