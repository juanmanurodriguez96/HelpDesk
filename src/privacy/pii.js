/**
 * Privacidad y proteccion de secretos.
 *
 * Objetivo exigido por el pliego: el sistema no debe solicitar, almacenar ni
 * divulgar credenciales, tokens, secretos ni PII en texto plano.
 *
 * Decision de arquitectura: la redaccion se ejecuta en el **ingreso** ( intake )
 * y el ticket solo persiste texto ya saneado. No existe ninguna ruta de codigo
 * que escriba el texto original en disco, en la bitacora ni en un payload de
 * traspaso. Los identificadores de usuario se guardan como identificador
 * corporativo, nunca como nombre completo.
 *
 * Las IP y los nombres de host SI se conservan: son datos de diagnostico
 * necesarios para el caso de uso y no son PII por si solos. Se documenta de
 * forma explicita la decision para que un auditor pueda evaluarla.
 */

import { PolicyError } from "../core/errors.js";

/** Etiquetas de redaccion. Formato estable: se usa en tests y en auditoria. */
export const REDACTION = Object.freeze({
  EMAIL: "[REDACTED_EMAIL]",
  PHONE: "[REDACTED_PHONE]",
  NATIONAL_ID: "[REDACTED_NATIONAL_ID]",
  TAX_ID: "[REDACTED_TAX_ID]",
  CREDIT_CARD: "[REDACTED_CARD]",
  IBAN: "[REDACTED_IBAN]",
  SECRET: "[REDACTED_SECRET]",
  TOKEN: "[REDACTED_TOKEN]",
  PRIVATE_KEY: "[REDACTED_PRIVATE_KEY]",
  USERNAME: "[REDACTED_USER]",
  PASSPORT: "[REDACTED_PASSPORT]",
});

/** Tipos de hallazgo considerados "secreto" (no simple PII). */
export const SECRET_FINDING_TYPES = Object.freeze(["PRIVATE_KEY", "SECRET", "TOKEN"]);

const PRIVATE_KEY = /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)* PRIVATE KEY-----/g;

/** Etiquetas que identifican un secreto cuando aparecen junto a un valor. */
const SECRET_LABEL =
  /contrase(?:ñ|n)a|clave|password|passwd|pwd|passphrase|pin|token|api[\s_-]?key|apikey|secret|secreto|bearer|authorization|auth[\s_-]?token|access[\s_-]?token|session[\s_-]?id/;

/**
 * Palabras que jamas son un valor de secreto.
 *
 * Actuan como lista negra del grupo de captura del valor. Sin ella,
 * "authorization: Bearer abc" se empareja con valor="Bearer" (que tiene mayuscula
 * y supera el filtro de forma) y deja el token real huerfano en el texto.
 */
const VALUE_STOPLIST =
  "de|del|la|el|los|las|un|una|unos|unas|para|por|con|sin|sobre|my|of|the|this|that|is|are|was|were|and|to|from|in|on|at|se|su|sus|es|son|esta|estan|ser|hace|bearer|basic|dummy|here|xxxxx|redacted|null|none|sugerencia|ejemplo|value";

/**
 * Ancla de la deteccion: un separador explicito (`:`, `=`) o una copula
 * (`es`, `son`, `is`, `are`).
 *
 * Anclar en el SEPARADOR, y no en la mera adyacencia etiqueta+valor, es lo que
 * hace la regla precisa: "la clave de la carpeta compartida es X" contiene hasta
 * cuatro palabras puente entre la etiqueta y el valor, y ninguna de ellas puede
 * ser el secreto. Admitir hasta seis palabras intermedias cubre frases largas
 * sin abrir la puerta a emparejar una palabra cualquiera.
 */
const SEPARATOR = "(?::|=|\\b(?:es|son|is|are|era|eran)\\b)";

/** Hasta seis palabras puente entre la etiqueta y el separador. */
const BRIDGE = "(?:\\s+[^\\s\"',;:]{1,24}){0,6}";

/** "clave: X", "password = X", "la clave de la carpeta es X". */
const SECRET_ASSIGNMENT = new RegExp(
  `\\b(${SECRET_LABEL.source})\\b${BRIDGE}\\s*${SEPARATOR}\\s*["']?(?!(?:${VALUE_STOPLIST})\\b)([^\\s"',;]{3,})`,
  "gi",
);

/**
 * Red de seguridad activada por INTENCION, no por forma.
 *
 * Se aplica al final del recorrido y solo si el texto completo declara que
 * contiene credenciales. Destruye el valor aunque sea una palabra sin digitos ni
 * simbolos, y es la unica regla que no filtra por forma. Sin ella,
 * "mi contrasena es veranovale" se escaparia.
 */
const SECRET_INTENT = new RegExp(
  `\\b(${SECRET_LABEL.source})\\b${BRIDGE}\\s*${SEPARATOR}\\s*["']?([^\\s"',;]{2,})`,
  "gi",
);

/**
 * Etiqueta pegada a un valor, SIN separador: "contrasena Tr3boleta2026".
 *
 * La regla de asignacion exige `:`/`=`/copula, que es lo que la hace precisa. Pero
 * pegar un credencial en una frase no siempre viene con copula: "mi usuario es X
 * y la contrasena X" es la forma mas comun de pegarlos en un mensaje. Sin esta
 * regla, ese texto se guardaba tal cual.
 *
 * Se mantiene la disciplina de la regla de asignacion: el valor tiene que
 * PARECER un secreto (`looksLikeSecretValue`), no ser cualquier palabra. Asi
 * "clave compartida", "token rotation" o "clave del portal" siguen passando
 * intactos, porque "compartida", "rotation" y "del" no tienen digito, ni
 * mayuscula, ni simbolo, ni doce caracteres.
 */
const SECRET_ADJACENT = new RegExp(
  `\\b(${SECRET_LABEL.source})\\b[\\s:]+["']?(?!(?:${VALUE_STOPLIST})\\b)([^\\s"',;]{6,})`,
  "gi",
);

/** Cabecera de autorizacion HTTP (RFC 6750 / RFC 7617). */
const AUTH_SCHEME = /\b(bearer|basic)\s+([A-Za-z0-9\-._~+/]{8,}=*)/gi;

const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g;
const SLACK_TOKEN = /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g;
const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]{2,})+\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g;
const TAX_ID = /\b(?:NIF|NIE|CIF|RFC|ITIN|TAX\s?ID)[\s:.-]*[A-Z0-9-]{6,15}\b/gi;
const DNI = /\b\d{8}[A-HJ-NP-TV-Z]\b/g;
const NIE = /\b[XYZ]\d{7}[A-HJ-NP-TV-Z]\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const PASSPORT = /\b[A-Z]{1,2}\d{7}\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}\b/g;
const HOME_PATH = /((?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/))([^\\/\s"']+)/g;

/**
 * Heuristica de forma para decidir si un valor tras una etiqueta de secreto es
 * realmente un secreto y no una palabra cualquiera ("la clave es importante").
 *
 * Se aceptan: 6+ caracteres con digito, mayuscula o simbolo; o 12+ caracteres
 * aunque sean solo minusculas. Se rechazan las palabras cortas en lenguaje
 * natural, que de otro modo producing redacciones masivas e inutiles.
 */
function looksLikeSecretValue(value) {
  const v = String(value ?? "");
  if (v.length < 6) return false;
  if (/^\[REDACTED/.test(v)) return false;
  return /\d/.test(v) || /[A-Z]/.test(v) || /[^A-Za-z0-9]/.test(v) || v.length >= 12;
}

/** Un numero de tarjeta valido segun el algoritmo de Luhn. */
export function isLuhnValid(digits) {
  const clean = String(digits).replace(/\D/g, "");
  if (clean.length < 13 || clean.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    let d = clean.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** `2026-01-05` o `05/01/2026`: no es un telefono. */
function looksLikeDate(value) {
  return /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/.test(value);
}

/** `10.20.30.40`: son datos de diagnostico, se conservan. */
function looksLikeIpv4(value) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

/**
 * Reglas en ORDEN DE EJECUCION. El orden importa:
 *
 *  1. Bloques largos (claves privadas) que contienen subcadenas de otras reglas.
 *  2. Tokens con formato estructurado y cabeceras de autorizacion HTTP, que
 *     deben clasificarse como token y no como "etiqueta + valor".
 *  3. Etiqueta de credencial + separador + valor, con filtro de forma.
 *  4. Identificadores personales y financieros.
 *  5. Red de seguridad por intencion (`condition`), ya sin filtros.
 *
 * Ejecutar (2) antes que (3) es lo que evita el defecto observado en la primera
 * iteracion: un JWT disfrazado de "token <jwt>" quedaba enmascarado dos veces y
 * producia una etiqueta huerfana. Ejecutar (5) al final es lo que evita un falso
 * negativo en "mi contrasena es veranovale", donde la forma no delata el secreto.
 */
const RULES = [
  {
    type: "PRIVATE_KEY",
    pattern: PRIVATE_KEY,
    replacement: () => REDACTION.PRIVATE_KEY,
  },
  { type: "TOKEN", pattern: JWT, replacement: () => REDACTION.TOKEN },
  { type: "TOKEN", pattern: GITHUB_TOKEN, replacement: () => REDACTION.TOKEN },
  { type: "TOKEN", pattern: SLACK_TOKEN, replacement: () => REDACTION.TOKEN },
  { type: "TOKEN", pattern: AWS_KEY, replacement: () => REDACTION.TOKEN },
  {
    type: "TOKEN",
    pattern: AUTH_SCHEME,
    groupCount: 1,
    // Igual que en la regla de asignacion: el marcador reemplaza al bloque
    // entero. Dejar "Authorization: = [REDACTED_TOKEN]" produce un texto que la
    // siguiente pasada vuelve a marcar, y rompe la idempotencia.
    replacement: () => REDACTION.TOKEN,
  },
  {
    type: "SECRET",
    pattern: SECRET_ASSIGNMENT,
    groupCount: 2,
    // El marcador sustituye a la asignacion COMPLETA, etiqueta incluida.
    //
    // Conservar la etiqueta ("clave = [REDACTED_SECRET]") es mas legible, pero
    // deja un texto que vuelve a casar con esta misma regla en la siguiente
    // pasada: la redaccion no seria idempotente. El tipo de dato ya queda
    // registrado en `findings` y en la auditoria, que es donde se consulta.
    replacement: () => REDACTION.SECRET,
    filter: (_match, groups) => looksLikeSecretValue(groups?.[1]),
  },
  {
    type: "SECRET",
    pattern: SECRET_ADJACENT,
    groupCount: 2,
    replacement: () => REDACTION.SECRET,
    filter: (_match, groups) => looksLikeSecretValue(groups?.[1]),
  },
  {
    // La intencion manda sobre la forma. Solo se evalua si el texto completo
    // declara que contiene credenciales, y por eso no puede activarse sobre
    // "la clave es importante".
    type: "SECRET",
    pattern: SECRET_INTENT,
    groupCount: 2,
    condition: (text) => offersCredentials(text) || asksForCredentials(text),
    replacement: () => REDACTION.SECRET,
    filter: (match, groups, context) =>
      isDeclaredValue(match, groups?.[1], context?.offset, context?.whole),
  },
  { type: "IBAN", pattern: IBAN, replacement: () => REDACTION.IBAN },
  {
    type: "CREDIT_CARD",
    pattern: CARD_CANDIDATE,
    filter: (match) => isLuhnValid(match),
    replacement: () => REDACTION.CREDIT_CARD,
  },
  { type: "EMAIL", pattern: EMAIL, replacement: () => REDACTION.EMAIL },
  { type: "TAX_ID", pattern: TAX_ID, replacement: () => REDACTION.TAX_ID },
  { type: "NATIONAL_ID", pattern: NIE, replacement: () => REDACTION.NATIONAL_ID },
  { type: "NATIONAL_ID", pattern: SSN, replacement: () => REDACTION.NATIONAL_ID },
  {
    type: "NATIONAL_ID",
    pattern: DNI,
    filter: (match) => /^\d{8}[A-HJ-NP-TV-Z]$/.test(match),
    replacement: () => REDACTION.NATIONAL_ID,
  },
  {
    type: "PHONE",
    pattern: PHONE,
    filter: (match) => {
      if (looksLikeIpv4(match)) return false;
      if (looksLikeDate(match)) return false;
      const digits = match.replace(/\D/g, "");
      return digits.length >= 9 && digits.length <= 15;
    },
    replacement: () => REDACTION.PHONE,
  },
  {
    type: "USERNAME",
    pattern: HOME_PATH,
    groupCount: 2,
    // Se conserva la ruta raiz; solo se enmascara el nombre de usuario del sistema.
    replacement: (_match, groups) => `${groups[0]}${REDACTION.USERNAME}`,
    // Si el nombre ya es un marcador, la regla no ha hecho nada: sin este filtro
    // redactaria una y otra vez, contando una coincidencia que no existe y
    // declarando el texto como saneado cuando ya lo estaba.
    filter: (_match, groups) => !/^\[?REDACTED_/.test(groups?.[1] ?? ""),
  },
  { type: "PASSPORT", pattern: PASSPORT, replacement: () => REDACTION.PASSPORT },
];

/**
 * Redacta PII y secretos de un texto.
 *
 * @param {string} text
 * @returns {{ text: string, findings: Array<{type: string, count: number}>, redacted: boolean }}
 */
/**
 * Etiqueta que sobrevive pegada a un marcador de redaccion previa:
 * "contrasena = [REDACTED_SECRET]", "Authorization: Bearer [REDACTED_TOKEN]".
 *
 * Se normalizan a marcador puro ANTES de escanear. Sin este paso, un texto ya
 * saneado se marca otra vez: la etiqueta y el separador siguen en su sitio, asi
 * que la regla vuelve a casar con un valor que ya no es un secreto. Las
 * consecuencias no son cosmeticas:
 *
 *   - la redaccion deja de ser idempotente, y `redact(redact(x)) !== redact(x)`;
 *   - `assertPrivacyInvariant` rechazaria justamente los tickets bien limpiados;
 *   - `assertAuditable` se negaria a registrar entradas legitimas.
 *
 * Y el dano de fondo: una alarma que suena con el ticket correcto hace que el
 * equipo deje a mirar la que suena con el secreto dentro.
 *
 * Solo se actúa cuando el valor es EXACTAMENTE un marcador, de modo que aqui no
 * se puede perder material real por accidente.
 */
const REDACTED_ASSIGNMENT =
  /\b[\w.-]+(?:\s+(?:bearer|basic|token|secret))?\s*[:=]\s*(?:(?:bearer|basic|token|secret)\s*[:=]\s*)?(\[REDACTED_[A-Z_]+\])/gi;

/** El valor declarado termina la clausula: punto, cierre o fin de texto. */
const VALUE_ENDS_CLAUSE = /^\s*(?:[.!?;:"')\]]|$)/;

/** El valor declarado abre otra clausula: "mi clave es X y no me deja entrar". */
const VALUE_FOLLOWS_CONJUNCTION =
  /^\s*[,;]?\s*(?:y|e|o|u|pero|although|but|and|or|so|then)\b/i;

/**
 * Lo que sigue NO es continuacion de clausula, es prosa: "la contrasena es
 * importante PARA la seguridad". Aqui el valor declarado no es un secreto.
 */
const PROSE_CONTINUATION =
  /^\s*[,;]?\s*(?:para|por|con|que|porque|cuando|como|segun|since|so\s+that|because|which|that|while|although|dejando|dejandose)\b/i;

/**
 * Decide si lo capturado tras una etiqueta de credencial es un VALOR declarado o
 * PROSA del usuario.
 *
 * "mi contrasena es veranovale y no me deja entrar" cierra el valor con "y": es
 * una credencial, y aunque no tenga digitos ni mayusculas se elimina. En cambio
 * "la contrasena es importante para la seguridad" continua con preposicion: ahi
 * lo que hay tras "es" no es un secreto sino una frase del usuario, y borrarla
 * seria destruir su mensaje en lugar de protegerlo.
 *
 * Lo comparten la regla de redaccion y `offersCredentials`, porque las dos
 * decisiones tienen que coincidir: si la regla destruye un texto que la senal no
 * considera credencial, el usuario recibe un aviso de seguridad sin motivo, y un
 * aviso que suena de mas es un aviso que nadie escucha.
 */
function isDeclaredValue(match, value, offset, whole) {
  const rest = String(whole ?? "").slice((offset ?? 0) + match.length);
  if (PROSE_CONTINUATION.test(rest)) return false;
  if (VALUE_FOLLOWS_CONJUNCTION.test(rest) || VALUE_ENDS_CLAUSE.test(rest)) return true;
  return looksLikeSecretValue(value);
}

/** `true` si el texto DECLARA una credencial con valor. */
function declaresCredentialValue(text) {
  // Se exige ademas que alguna de las formas de intencion reconozca el texto: el
  // patron por si solo casaria con cualquier "clave: algo" de un documento.
  if (!CREDENTIAL_OFFER_PATTERNS.some((re) => re.test(text))) return false;
  const scanner = new RegExp(SECRET_INTENT.source, SECRET_INTENT.flags);
  for (const match of text.matchAll(scanner)) {
    if (isDeclaredValue(match[0], match[2], match.index, text)) return true;
  }
  return false;
}

/**
 * Deja solo el marcador, sin la etiqueta que lo precedia.
 *
 * Se aplica al ENTRADA y a la SALIDA. En la entrada protege a un texto ya
 * saneado; en la salida garantiza que el resultado de una pasada es el mismo que
 * daria una segunda pasada, es decir, que `redact` es un punto fijo y no una
 * operacion que se "asienta" con el tiempo.
 */
function normalizeRedactionMarkers(text) {
  return text.replace(REDACTED_ASSIGNMENT, "$1");
}

export function redact(text) {
  const source = String(text ?? "");
  const counts = new Map();

  let result = normalizeRedactionMarkers(source);
  for (const rule of RULES) {
    if (rule.condition && !rule.condition(result)) continue;
    // El contador se incrementa dentro del reemplazo, de modo que `count`
    // refleja coincidencias realmente redactadas y no candidatas descartadas.
    let hits = 0;
    result = result.replace(rule.pattern, (match, ...args) => {
      const groups = rule.groupCount ? args.slice(0, rule.groupCount) : [];
      // Tras los grupos, `String.replace` pasa la posicion y la cadena completa.
      // Se entregan al filtro porque hay decisiones que dependen de lo que hay
      // DESPUES de la coincidencia, no solo de lo que contiene.
      const context = {
        offset: rule.groupCount ? args[rule.groupCount] : args[0],
        whole: rule.groupCount ? args[rule.groupCount + 1] : args[1],
      };
      if (rule.filter && !rule.filter(match, groups, context)) return match;
      hits += 1;
      return rule.replacement(match, groups);
    });
    if (hits > 0) counts.set(rule.type, (counts.get(rule.type) ?? 0) + hits);
  }

  const findings = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => a.type.localeCompare(b.type));

  return { text: normalizeRedactionMarkers(result), findings, redacted: findings.length > 0 };
}

/** Detecta material sensible sin transformarlo. */
export function detect(text) {
  return redact(text).findings;
}

/**
 * `true` si el texto contiene un secreto. Se usa para dos decisiones de
 * seguridad: (1) marcar el ticket como "contenia secreto" y (2) permitir que
 * la remediation niegue cualquier operacion que lo requiera.
 */
export function containsSecret(text) {
  return detect(text).some((f) => SECRET_FINDING_TYPES.includes(f.type));
}

/**
 * Verifica que una cadena destinada a un usuario o a un log no contenga
 * secretos. Falla ruidosamente: es una asercion, no un aviso.
 *
 * @param {string} text
 * @param {object} [context]
 * @throws {PolicyError} `SECRET_LEAK`
 */
export function assertNoSecret(text, context = {}) {
  const findings = detect(text).filter((f) => SECRET_FINDING_TYPES.includes(f.type));
  if (findings.length > 0) {
    throw new PolicyError(
      "SECRET_LEAK",
      "Se ha bloqueado una operacion: la cadena contendria material sensible en texto plano.",
      { types: findings.map((f) => f.type), context },
    );
  }
}

/**
 * Patrones de intencion: el usuario esta a punto de COMPARTIR una credencial.
 * Se rechazan proactivamente.
 */
const CREDENTIAL_OFFER_PATTERNS = [
  /\b(?:te|os)\s+(?:paso|env[ií]o|comparto|adjunto|dict[eo])\b[^\n]{0,40}\b(?:contrase(?:ñ|n)a|clave|password|token|api[\s_-]?key|secreto)\b/i,
  // El determinante es indiferente: en castellano lo natural es "la contrasena es"
  // o "el token es", no "mi contrasena es". Sin esta lista, la forma mas
  // corriente de compartir un secreto en un ticket en español no se detectaba.
  /\b(?:mi|mis|el|la|los|las|este|esta|esto|nuestro|nuestra)\s+(?:contrase(?:ñ|n)a|clave|password|token|api[\s_-]?key|secreto|pin)\b\s*(?:es|son|:|=)/i,
  /\b(?:aqu[ií]|esto)\s+es\s+(?:mi\s+|la\s+|el\s+)?(?:contrase(?:ñ|n)a|clave|password|token|clave\s+de)\b/i,
  /\b(?:username|usuario|user)\s*[:=]\s*\S+\s*(?:,|;|\/|y)\s*(?:contrase(?:ñ|n)a|password|pwd)\s*[:=]/i,
  // Formato pegado desde un gestor o un formulario: "contrasena: hunter2".
  // Sin determinante y sin "es", asi que los patrones anteriores no lo ven.
  /\b(?:contrase(?:ñ|n)a|clave|password|pwd|token|api[\s_-]?key|pin|secreto)\s*[:=]\s*\S+/i,
  /\bplease\s+(?:send|share)\s+(?:me\s+)?(?:your|the)\s+(?:password|credential|api[\s_-]?key|token)\b/i,
  /\b(?:necesito|env[ií]ame|dime|pasame)\s+(?:tu|su)\s+(?:contrase(?:ñ|n)a|clave|password|token|api[\s_-]?key|credencial)/i,
];

/**
 * Patrones de intencion: el TEXTO ESTA PIDIENDO una credencial.
 *
 * Es la otra mitad del riesgo. Un ticket de entrada es texto de usuario y solo
 * se analiza; una pregunta al usuario la escribe el agente, y ahi la peticion es
 * un fallo del agente, no una descripcion de un fallo. Se comprueba por patron
 * de intencion, no por contenido, porque "cual es tu contrasena" no contiene
 * ningun secreto y aun asi es una violacion de la politica.
 */
const CREDENTIAL_REQUEST_PATTERNS = [
  /\bplease\s+(?:send|share|forward|provide)\s+(?:me\s+)?(?:your|the)\s+(?:password|passcode|credential|api[\s_-]?key|token)\b/i,
  /\b(?:cual|qué|que)\s+(?:es\s+)?(?:tu|su|la|el)\s+(?:contrase(?:ñ|n)a|clave|password|clave\s+de\s+acceso|pin|token|api[\s_-]?key)\b/i,
  /\b(?:what|which)\s+(?:is\s+)?(?:your|the)\s+(?:password|passcode|passphrase|api[\s_-]?key|token|pin)\b/i,
  /\b(?:necesito|necesitamos|requiero|env[ií]ame|reenv[ií]ame|pasa|pasame|dime|conf[ií]rmame|comparte)\b[^\n?]{0,30}\b(?:contrase(?:ñ|n)a|password|credencial(?:es)?|api[\s_-]?key|token)\b/i,
  /\b(?:can you|i need)\s+(?:send|share|provide|forward)\b[^\n?]{0,20}\b(?:password|credential|api[\s_-]?key|token)\b/i,
];

/**
 * `true` si el texto DECLARA una credencial. El ticket se marca, se redacta y la
 * respuesta al usuario debe instruirle que no las comparta.
 */
/**
 * `true` si el texto MANIPULA credenciales de una forma que exige avisar al
 * usuario: declara un valor ("mi contrasena es X", "contrasena: X") o pide una
 * ("enviame la contrasena", "please send me the password").
 *
 * Cubre las dos mitades a proposito, porque la respuesta que recibe el usuario es
 * la misma en ambos casos: no compartas credenciales por este canal. Lo que NO
 * incluye es hablar ABOUT credenciales ("la contrasena es importante para la
 * seguridad"): ahi no hay nada que avisar, y un aviso sin motivo es ruido que
 * enseña al usuario a ignorar el siguiente.
 */
export function offersCredentials(text) {
  const source = String(text ?? "");
  return declaresCredentialValue(source) || asksForCredentials(source);
}

/**
 * `true` si el texto PIDE una credencial.
 */
export function asksForCredentials(text) {
  const source = String(text ?? "");
  return CREDENTIAL_REQUEST_PATTERNS.some((re) => re.test(source));
}

/**
 * Valida una pregunta al usuario final. Escribir "cual es tu contraseña" es una
 * violacion aunque no contenga ningun secreto, asi que se bloquea por patron de
 * intencion y no solo por contenido.
 *
 * @param {string} question
 * @throws {PolicyError} `CREDENTIAL_REQUEST`
 */
export function assertSafeQuestion(question) {
  const text = String(question ?? "");
  if (asksForCredentials(text)) {
    throw new PolicyError(
      "CREDENTIAL_REQUEST",
      "Pregunta bloqueada: no se pueden solicitar credenciales, tokens ni secretos al usuario final.",
      { reason: "credential_request" },
    );
  }
  if (containsSecret(text)) {
    throw new PolicyError("SECRET_IN_QUESTION", "La pregunta contiene material sensible.", {
      reason: "secret_in_question",
    });
  }
  return text;
}

/**
 * Devuelve el aviso estandar que se adjunta cuando el usuario compartio algo
 * sensible. Redactado, sin accusingar y con una instruccion concreta.
 */
export const SECRET_NOTICE = Object.freeze({
  es: "Por seguridad hemos eliminado de la incidencia cualquier clave o token que haya compartido. No vuelva a enviar credenciales por este canal: el equipo de soporte nunca se las pedira.",
  en: "For your security we removed any key or token you may have included in this ticket. Please do not send credentials through this channel: support will never ask you for them.",
});
