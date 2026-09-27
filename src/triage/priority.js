/**
 * Puntuacion de severidad y prioridad.
 *
 * Severidad (S1-S4) mide el impacto si no se resuelve; prioridad (P1-P4) mide el
 * orden de trabajo. No son lo mismo, y confundirlas es el error clasico de una
 * mesa de soporte: un solo usuario sin contrasena un viernes a las 18:00 tiene
 * impacto bajo, pero si forma parte de un cierre contable, su prioridad es alta.
 *
 * Cada ajuste deja_factor registrado. Un numero sin explicacion no se puede
 * defender ante el usuario ni auditar, asi que el factor forma parte del
 * resultado y no es un comentario interno.
 */

/** Severidad -> prioridad por defecto, antes de aplicar factores. */
const DEFAULT_PRIORITY = { S1: "P1", S2: "P2", S3: "P3", S4: "P4" };

/**
 * Factos DUROS: evidencia directa de dano. Additive entre si.
 * `delta` negativo = mas severo.
 *
 * Se separan de los blandos porque no se acumulan igual. "Bloquea el trabajo" y
 * "hay reunion con el cliente" se refuerzan; "solo le pasa a el" y "tiene
 * apano" rebajar el mismo caso dos veces lo deja por debajo de su importancia
 * real, que es como un ticket acaba enterrado en la cola.
 */
const HARD_FACTORS = [
  {
    code: "business_critical",
    delta: -1,
    when: (e) => e.businessCriticality === 4,
    explain: (es) => "servicio no critico para el negocio",
  },
  {
    code: "business_critical_max",
    delta: 0,
    when: (e) => e.businessCriticality === 1,
    explain: (es) =>
      es
        ? "afecta a un servicio critico (nomina, facturacion, autenticacion)"
        : "affects a business-critical service (payroll, billing, authentication)",
  },
  {
    code: "impact_company",
    delta: -2,
    when: (e) => e.impactScope === "company",
    explain: (es) => "alcance de toda la empresa",
  },
  {
    code: "impact_department",
    delta: -1,
    when: (e) => e.impactScope === "department",
    explain: (es) => "alcance de varias personas del equipo",
  },
  {
    code: "blocks_work",
    delta: -1,
    when: (e) => e.urgencySignals?.includes("blocks_work"),
    explain: (es) => "el usuario declara que no puede trabajar",
  },
  {
    code: "exec_visibility",
    delta: -1,
    when: (e) => e.urgencySignals?.includes("exec_visibility"),
    explain: (es) => "hay compromiso externo o de direccion",
  },
  {
    code: "explicit_urgent",
    delta: -1,
    when: (e) => e.urgencySignals?.includes("explicit_urgent"),
    explain: (es) => "el usuario declara urgencia",
  },
  {
    code: "deadline",
    delta: -1,
    when: (e) => e.urgencySignals?.includes("deadline"),
    explain: (es) => "hay una fecha limite declarada",
  },
  {
    code: "no_workaround",
    delta: -1,
    when: (e) => e.workaroundAvailable === false,
    explain: (es) => "el usuario confirma que no tiene alternativa",
  },
];

/**
 * Factos BLANDOS: atenuantes. Todos rebajan, y en conjunto solo pueden bajar UN
 * escalon. Dos atenuantes juntos describen un caso de menor alcance, no un caso
 * dos veces menos importante.
 */
const SOFT_FACTORS = [
  {
    code: "impact_single",
    when: (e) => e.impactScope === "single",
    explain: (es) => "confirmado como un solo usuario",
  },
  {
    code: "has_workaround",
    when: (e) => e.workaroundAvailable === true,
    explain: (es) => "el usuario indica que puede apanarse mientras tanto",
  },
  {
    code: "single_user_no_criticality",
    when: (e) => e.businessCriticality === null && e.impactScope === "single",
    explain: (es) => "incidencia individual sin servicio critico identificado",
  },
];

/** Cuantos escalos puede bajar la severidad como maximo el conjunto de atenuantes. */
const SOFT_MAX_STEPS = 1;

/**
 * @typedef {object} PriorityResult
 * @property {1|2|3|4} severity
 * @property {string}  priority
 * @property {Array<{code: string, delta: number, explanation: string}>} factors
 */

/**
 * Calcula severidad y prioridad.
 *
 * @param {object} args
 * @param {object} args.category    Definicion de la categoria.
 * @param {object} args.entities    Entidades extraidas.
 * @param {string} [args.lang]
 * @returns {PriorityResult}
 */
export function scorePriority({ category, entities, lang = "es" }) {
  const es = lang === "es";
  const factors = [];
  let hardDelta = 0;

  for (const factor of HARD_FACTORS) {
    if (!factor.when(entities)) continue;
    hardDelta += factor.delta;
    factors.push({ code: factor.code, delta: factor.delta, explanation: factor.explain(es) });
  }

  let severity = clamp(category.baseSeverity + hardDelta);

  // Atenuantes: se aplican, pero solo pueden bajar un escalo en conjunto.
  const softs = SOFT_FACTORS.filter((f) => f.when(entities));
  if (softs.length > 0) {
    const steps = Math.min(SOFT_MAX_STEPS, softs.length);
    severity = clamp(severity + steps);
    for (const factor of softs) {
      factors.push({
        code: factor.code,
        delta: steps > 0 ? 1 : 0,
        explanation:
          steps > 0
            ? factor.explain(es)
            : `${factor.explain(es)} (sin efecto adicional: los atenuantes solo bajan un escalo)`,
      });
    }
  }

  // Politica de mesa, aplicada al final y por encima de cualquier factor:
  // S1 esta reservado a impacto confirmado de toda la empresa.
  //
  // Sin este suelo, "bloquea mi trabajo" + servicio critico convierte cualquier
  // bloqueo individual en P1, y un ticket de un solo usuario desplaza a una
  // caida real de produccion. El coste de equivocarse aqui es alto en ambos
  // sentidos, asi que el S1 se gana declarando el alcance, no insinuandolo.
  //
  // Se evalua DESPUES de atenuantes, no antes: un atenuante puede subir un S1
  // calculado a S2, y en ese caso la politica ya se cumple sin tocar nada. De
  // hecho al reves, un S1 aqui significa que ni atenuantes ni alcance lo frenaron.
  if (severity < 2 && entities.impactScope !== "company") {
    severity = 2;
    factors.push({
      code: "individual_severity_ceiling",
      delta: 1,
      explanation: es
        ? `S1 requiere impacto confirmado de toda la empresa; el alcance declarado es "${
            entities.impactScope ?? "sin determinar"
          }", asi que la severidad se limita a S2`
        : `S1 requires confirmed company-wide impact; the declared scope is "${
            entities.impactScope ?? "undetermined"
          }", so severity is capped at S2`,
    });
  }

  const priority = DEFAULT_PRIORITY[`S${severity}`];

  return { severity, priority, factors };
}

function clamp(value) {
  return Math.min(4, Math.max(1, value));
}

/** Texto de una linea para explicar la puntuacion al usuario o al operador. */
export function explainPriority({ severity, priority, factors }, lang = "es") {
  const es = lang === "es";
  const base = es
    ? `Severidad ${severity} (${priority})`
    : `Severity ${severity} (${priority})`;
  if (factors.length === 0) return base;
  // Un factor con delta 0 explica por que se EVALUO la severidad (el tono, la
  // urgencia...) pero no la mueve. Se conserva su explicacion y se calla la
  // cifra: mostrar "(0)" sugiere un peso que no se aplico, y quitar el factor
  // entero esconde un termino que se tenido en cuenta y no sumo.
  const details = factors.map((f) =>
    f.delta === 0 ? f.explanation : `${f.explanation} (${f.delta > 0 ? "+" : ""}${f.delta})`,
  );
  return `${base}: ${details.join("; ")}`;
}
