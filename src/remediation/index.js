/**
 * Remediacion: punto de entrada del subsistema.
 */

export { PLAYBOOKS, playbooksForCategory, playbookById } from "./playbooks.js";
export { evaluate, remediate, nullAdapter } from "./executor.js";
