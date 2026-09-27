/**
 * Errores de dominio de la mesa de soporte.
 *
 * Todos los errores operacionales heredan de `AppError` y exponen un `code`
 * estable. Ese `code` es parte del contrato publico: la CLI lo imprime, los
 * agentes lo interpretan para decidir el siguiente paso y los tests lo
 * comprueban. Nunca se capturan y silencian.
 */

export class AppError extends Error {
  /**
   * @param {string} code    Codigo estable y legible por maquina (SNAKE_CASE).
   * @param {string} message Mensaje apto para operador (no para usuario final).
   * @param {object} [details] Contexto estructurado y ya saneado.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: this.code, message: this.message, details: this.details };
  }
}

/** Entrada invalida (argumentos de CLI, payload corrupto, ticket inexistente). */
export class ValidationError extends AppError {}

/**
 * Transicion de ciclo de vida no permitida o incompleta.
 *
 * `missing` lista los campos obligatorios que faltaron, de modo que el agente
 * puede corregirse en una sola iteracion en lugar de preguntar al usuario.
 */
export class TransitionError extends AppError {
  constructor(code, message, details = {}) {
    super(code, message, details);
  }
}

/** Violacion de una politica de privacidad o de seguridad. */
export class PolicyError extends AppError {}

/** Fallo de una dependencia auxiliar (script de skill, servicio, fichero). */
export class DependencyError extends AppError {}

/** Integridad de la bitacora de auditoria comprometida. */
export class IntegrityError extends AppError {}

/** Codigos de salida de la CLI, fijos para permitir automatizacion. */
export const EXIT = {
  OK: 0,
  USAGE: 1,
  POLICY: 2,
  DEPENDENCY: 3,
  INTERNAL: 4,
};

const EXIT_BY_ERROR = new Map([
  [ValidationError, EXIT.USAGE],
  [TransitionError, EXIT.POLICY],
  [PolicyError, EXIT.POLICY],
  [IntegrityError, EXIT.INTERNAL],
  [DependencyError, EXIT.DEPENDENCY],
  [AppError, EXIT.INTERNAL],
]);

/** Traduce una excepcion a un codigo de salida estable. */
export function exitCodeFor(error) {
  for (const [ctor, code] of EXIT_BY_ERROR) {
    if (error instanceof ctor) return code;
  }
  return EXIT.INTERNAL;
}
