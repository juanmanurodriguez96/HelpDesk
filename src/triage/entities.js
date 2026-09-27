/**
 * Extraccion de entidades.
 *
 * El pliego pide extraer "usuario afectado, servicio impactado y criticidad de
 * negocio". Estos son los datos que deciden si un caso se puede cerrar o si hay
 * que pedir informacion, asi que la extraccion es conservadora por principio:
 *
 *  - Preferimos el IDENTIFICADOR corporativo (`E-10482`) al nombre y al correo.
 *    El correo se redacta en el ingreso, asi que buscarlo aqui seria buscar algo
 *    que ya no existe: precisamente por eso la entidad se resuelve por id.
 *  - Ante duda, no se inventa. Un campo que no se puede determinar con certeza se
 *    deja en `null` y aparece en `missingRequired`, que es lo que dispara la
 *    pregunta al usuario.
 *
 * Cuando hay varias candidates se devuelven todas en `candidates`, para que un
 * agente pueda confirmar en vez de suponer.
 */

import { normalize } from "../core/text.js";
import { matchServices, serviceById, LOCATIONS } from "../knowledge/catalog.js";

/** Identificador corporativo: prefijo de letras + digitos, p. ej. `E-10482`. */
const EMPLOYEE_ID = /\b([A-Z]{1,3})-?(\d{4,6})\b/g;

/**
 * Prefijos que el sistema se reserva para si mismo. Un identificador con estos
 * prefijos NUNCA es un usuario, aunque tenga la forma de uno.
 */
const RESERVED_ID_PREFIXES = new Set([
  "HD", // referencia de ticket
  "ACT", // accion de remediacion
  "SLA", // referencia de acuerdo de nivel de servicio
  "ERR", // codigo de error
  "INC", // identificador de incidente de proveedor
]);

/** Etiquetas que preceden a un identificador o nombre de usuario. */
const USER_LABEL =
  /\b(?:usuario|user|empleado|empleada|colaborador|worker|account|cuenta de|para el usuario|affected user)\s*(?:de\s+|para\s+|of\s+)?[:]?\s*([A-Za-z0-9._-]{3,40})/gi;

/** Inventario de equipo: `LT-MADRID-042`, `PC-BCN-17`. */
const ASSET_TAG = /\b((?:LT|PC|DT|LTPT|MOB)[-_][A-Z]{2,10}[-_]?\d{1,4})\b/g;

/** Recurso solicitado: carpeta, repositorio o grupo concreto. */
const RESOURCE_LABEL =
  /\b(?:carpeta|folder|repositorio|repo|directorio|share|recurso|espacio de trabajo|proyecto|grupo)\s+(?:llamado\s+|denominado\s+|nombre\s+)?["']?([\w.\-/ ]{3,80}?)["']?(?=\s*(?:,|\.|\s+(?:para|que|necesito|y|pero|porque|no)\b)|$)/gi;

/** Frases de alcance del impacto. */
const SCOPE_RULES = [
  { scope: "company", weight: 1, terms: ["toda la empresa", "todos los usuarios", "toda la organizacion", "company wide", "all users", "para todos"] },
  { scope: "department", weight: 1, terms: ["todo el departamento", "mi equipo", "todo mi equipo", "several users", "varios usuarios", "todo el area"] },
  {
    scope: "single",
    weight: 1,
    terms: ["solo a mi", "unicamente a mi", "unicamente yo", "solo yo", "only me", "just me"],
    // En lenguaje real el cuantificador y el sujeto aparecen separados por otras
    // palabras ("unicamente me ocurre a mi"). Un patron lo cubre sin enumerar
    // cada variante posible.
    patterns: [/\b(?:solo|unicamente|unico|only|just)\s+(?:me|yo|a mi)\b/],
  },
];

/** Senales de urgencia Genuinas. */
const URGENCY_RULES = [
  {
    code: "blocks_work",
    terms: ["no puedo trabajar", "me para el trabajo", "paraliza", "bloqueado totalmente"],
    patterns: [/\bme\s+bloquea\s+(?:el\s+|mi\s+|la\s+)?trabajo\b/, /\bno\s+puedo\s+(?:hacer\s+mi\s+)?trabajo\b/],
  },
  { code: "exec_visibility", terms: ["me ve el cliente", "reunion con el cliente", "presentacion hoy", "demo hoy", "direccion espera"] },
  { code: "explicit_urgent", terms: ["urgente", "urgentemente", "es una urgencia", "urgency", "asap", "prioridad maxima", "critico"] },
  { code: "deadline", terms: ["para hoy", "antes de las", "deadline", "fecha limite", "antes de que cierre"] },
];

/** Indicios de que existe una alternativa operativa. */
const WORKAROUND_TERMS = ["puedo trabajar desde", "he podido", "workaround", "solucion temporal", "mientras tanto", "con otro equipo"];

/**
 * @typedef {object} Entities
 * @property {string|null} affectedUser
 * @property {string|null} impactedService
 * @property {string|null} targetResource
 * @property {string|null} asset
 * @property {string|null} location
 * @property {string|null} impactScope
 * @property {1|2|3|4|null} businessCriticality
 * @property {boolean|null} workaroundAvailable
 * @property {string[]} urgencySignals
 * @property {object} candidates  Candidatos alternativos por si hay ambiguedad.
 */

/**
 * @param {string} text Texto ya saneado.
 * @param {object} [context] `{ reporterId }` para usar al propio usuario como
 *        afectado por defecto cuando el ticket es claramente personal.
 * @returns {Entities}
 */
export function extractEntities(text, context = {}) {
  const raw = String(text ?? "");
  const flat = normalize(raw);

  // El alcance se detecta antes que el usuario: que el caso se declare de un solo
  // usuario es en si mismo la senal mas fuerte de que el afectado es quien escribe.
  const impactScope = detectScope(flat);
  const userCandidates = extractUsers(raw, flat, context.reporterId, { scope: impactScope });
  const serviceCandidates = matchServices(flat);
  const resourceCandidates = extractResources(raw);
  const assetCandidates = extractAssets(raw);
  const location = matchLocation(flat);
  const urgencySignals = detectSignals(flat, URGENCY_RULES);
  const workaroundAvailable = detectWorkaround(flat);

  const impactedService = serviceCandidates[0]?.id ?? null;
  const criticality = impactedService ? serviceById(impactedService).criticality : null;

  return {
    // Un ticket que no menciona a nadie y habla en primera persona ("no me deja
    // entrar") se atribuye a quien lo reporta. Es la unica inferencia que se
    // permite, y el resto de candidatas queda en `candidates` para que el agente
    // confirme en lugar de suponer.
    affectedUser: userCandidates[0] ?? null,
    impactedService,
    targetResource: resourceCandidates[0] ?? null,
    asset: assetCandidates[0] ?? null,
    location,
    impactScope,
    businessCriticality: criticality,
    workaroundAvailable,
    urgencySignals,
    candidates: {
      affectedUser: userCandidates,
      impactedService: serviceCandidates.map((s) => s.id),
      targetResource: resourceCandidates,
      asset: assetCandidates,
    },
  };
}

/** Marcadores de primera persona: el caso es del propio solicitante. */
const FIRST_PERSON =
  /\b(?:no me|me pasa|me ocurre|mis|yo|unicamente|a mi|para mi|my|only me|i can|i cannot)\b/;

/**
 * Identificadores de usuario mencionados.
 *
 * La ultima rama atribuye el caso al solicitante cuando el texto es claramente
 * personal (primera persona o alcance "un solo usuario") y no se nombra a nadie
 * mas. Es la unica inferencia que se admite, y por eso es la unica que se
 * documenta como tal: el resto de casos se dejan en `null` y se preguntan.
 */
function extractUsers(raw, flat, reporterId, { scope } = {}) {
  const found = [];

  for (const match of raw.matchAll(EMPLOYEE_ID)) {
    const prefix = match[1].toUpperCase();
    // El sistema tambien genera identificadores con este mismo patron (`HD-4821`,
    // `ACT-77120`). Sin este filtro, la referencia del propio ticket se
    // interpretaria como el usuario afectado.
    if (RESERVED_ID_PREFIXES.has(prefix)) continue;
    const id = `${match[1]}-${match[2]}`;
    if (!found.includes(id)) found.push(id);
  }

  for (const match of raw.matchAll(USER_LABEL)) {
    const candidate = match[1].replace(/[.,;:]$/, "");
    // Se descartan valores que en realidad son servicios ("acceso a la cuenta vpn").
    if (!candidate || candidate.length < 3) continue;
    if (serviceById(candidate.toLowerCase())) continue;
    if (["usuario", "user", "cuenta", "cuenta de", "sistema", "ninguno", "nadie"].includes(candidate.toLowerCase())) {
      continue;
    }
    if (!found.includes(candidate)) found.push(candidate);
  }

  // Si el texto es claramente personal y el solicitante es conocido, el afectado
  // es el solicitante. Se exige que no haya ninguna otra pista (found vacio) para
  // no pisar un usuario nombrado explicitamente.
  const clearlyPersonal = scope === "single" || FIRST_PERSON.test(flat);
  if (found.length === 0 && reporterId && clearlyPersonal) {
    found.push(reporterId);
  }

  return found;
}

function extractResources(raw) {
  const found = [];
  for (const match of raw.matchAll(RESOURCE_LABEL)) {
    const value = match[1].trim().replace(/\s+/g, " ");
    if (!value || value.length < 3) continue;
    if (found.includes(value)) continue;
    found.push(value);
  }
  return found;
}

function extractAssets(raw) {
  const found = [];
  for (const match of raw.matchAll(ASSET_TAG)) {
    const value = match[1].toUpperCase();
    if (!found.includes(value)) found.push(value);
  }
  return found;
}

function matchLocation(flat) {
  for (const location of LOCATIONS) {
    for (const alias of location.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(flat)) {
        return location.id;
      }
    }
  }
  return null;
}

function detectScope(flat) {
  for (const rule of SCOPE_RULES) {
    for (const pattern of rule.patterns ?? []) {
      if (pattern.test(flat)) return rule.scope;
    }
    for (const term of rule.terms) {
      if (flat.includes(normalize(term))) return rule.scope;
    }
  }
  return null;
}

function detectSignals(flat, rules) {
  const signals = [];
  for (const rule of rules) {
    if ((rule.patterns ?? []).some((p) => p.test(flat))) {
      signals.push(rule.code);
      continue;
    }
    for (const term of rule.terms ?? []) {
      if (flat.includes(normalize(term))) {
        if (!signals.includes(rule.code)) signals.push(rule.code);
        break;
      }
    }
  }
  return signals;
}

function detectWorkaround(flat) {
  for (const term of WORKAROUND_TERMS) {
    if (flat.includes(normalize(term))) return true;
  }
  return null;
}

/**
 * Preguntas de aclaracion derivadas de las entidades que faltan. Se generan de
 * forma mecanica y en el idioma del ticket, y todas pasan el filtro de politica:
 * ninguna puede pedir credenciales.
 *
 * @param {object} ticket
 * @returns {string[]}
 */
export function buildClarifyingQuestions(ticket, lang = "es") {
  const missing = ticket.entities?.missingRequired ?? [];
  const es = lang === "es";
  const questions = [];

  for (const field of missing) {
    switch (field) {
      case "affectedUser":
        questions.push(
          es
            ? "¿A que usuario afecta? Indique su identificador corporativo (por ejemplo, E-10482), no su contrasena."
            : "Which user is affected? Please give their corporate ID (for example, E-10482), not their password.",
        );
        break;
      case "impactedService":
        questions.push(
          es ? "¿A que servicio o aplicacion afecta?" : "Which service or application is affected?",
        );
        break;
      case "targetResource":
        questions.push(
          es
            ? "¿A que recurso concreto necesita acceso? Indique la carpeta, el repositorio o el proyecto."
            : "Which specific resource do you need access to? Please name the folder, repository or project.",
        );
        break;
      default:
        questions.push(es ? `Falta el dato "${field}".` : `The field "${field}" is missing.`);
    }
  }

  return questions;
}
