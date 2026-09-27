/**
 * Taxonomia de incidencias.
 *
 * Cada categoria declara:
 *  - sus terminos de deteccion (es/en), con peso;
 *  - la severidad base cuando el usuario no da ninguna pista;
 *  - las ENTIDADES OBLIGATORIAS. Este es el campo mas importante: sin
 *    `affectedUser` no se puede desbloquear una cuenta, y sin `targetResource` no se
 *    puede conceder un acceso. La lista la usa la maquina de estados para
 *    IMPEDIR que un caso se cierre como resuelto con informacion incompleta.
 *
 * No hay categoria "otro" con comportamiento permisivo: `unclassified` es
 * explicita y siempre deriva en escalado, nunca en auto-remediacion.
 */

/**
 * @typedef {object} Category
 * @property {string}   id
 * @property {string}   label
 * @property {string}   typology      Agrupa en las tres tipologias del pliego.
 * @property {1|2|3|4} baseSeverity
 * @property {string[]} requiredEntities
 * @property {Array<{term: string, weight: number}>} terms
 * @property {string}   [queue]       Cola humana por defecto.
 */

/** @type {Category[]} */
export const CATEGORIES = [
  // --- 1. Acceso e identidad ---------------------------------------------
  {
    id: "identity.lockout",
    label: "Cuenta bloqueada por reintentos fallidos",
    typology: "acceso_identidad",
    baseSeverity: 2,
    requiredEntities: ["affectedUser"],
    queue: "identity-support",
    terms: [
      { term: "cuenta bloqueada", weight: 5 },
      { term: "bloqueada", weight: 3 },
      { term: "account locked", weight: 5 },
      { term: "locked out", weight: 5 },
      { term: "lockout", weight: 4 },
      { term: "demasiados intentos", weight: 5 },
      { term: "too many attempts", weight: 5 },
      { term: "too many failed", weight: 4 },
      { term: "intentos fallidos", weight: 3 },
      { term: "acceso denegado", weight: 2 },
      { term: "no me deja entrar", weight: 2 },
      { term: "cannot log in", weight: 2 },
      { term: "bloqueo tras", weight: 3 },
    ],
  },
  {
    id: "identity.password_reset",
    label: "Restablecimiento de contrasena",
    typology: "acceso_identidad",
    baseSeverity: 3,
    requiredEntities: ["affectedUser"],
    queue: "identity-support",
    terms: [
      { term: "restablecer contrasena", weight: 5 },
      { term: "resetear contrasena", weight: 5 },
      { term: "cambiar contrasena", weight: 4 },
      { term: "olvide mi contrasena", weight: 5 },
      { term: "password reset", weight: 5 },
      { term: "forgot my password", weight: 5 },
      { term: "reset password", weight: 4 },
      { term: "contrasena caducada", weight: 4 },
      { term: "expiracion de contrasena", weight: 4 },
      { term: "caducada", weight: 2 },
    ],
  },
  {
    id: "identity.mfa",
    label: "Problema de autenticacion multifactor",
    typology: "acceso_identidad",
    baseSeverity: 2,
    requiredEntities: ["affectedUser"],
    queue: "identity-support",
    terms: [
      { term: "mfa", weight: 5 },
      { term: "doble factor", weight: 5 },
      { term: "2fa", weight: 5 },
      { term: "codigo de verificacion", weight: 5 },
      { term: "verification code", weight: 4 },
      { term: "no me llega el codigo", weight: 5 },
      { term: "no llega el codigo", weight: 5 },
      { term: "authenticator", weight: 4 },
      { term: "totp", weight: 4 },
      { term: "dispositivo de confianza", weight: 3 },
      { term: "sin codigo", weight: 2 },
    ],
  },
  {
    id: "identity.disabled",
    label: "Cuenta deshabilitada por inactividad",
    typology: "acceso_identidad",
    baseSeverity: 2,
    requiredEntities: ["affectedUser"],
    queue: "identity-support",
    terms: [
      { term: "deshabilitada", weight: 5 },
      { term: "deshabilitado", weight: 5 },
      { term: "cuenta inactiva", weight: 4 },
      { term: "por inactividad", weight: 5 },
      { term: "inactive account", weight: 5 },
      { term: "disabled account", weight: 5 },
      { term: "account disabled", weight: 5 },
      { term: "reactivar cuenta", weight: 4 },
      { term: "dar de alta mi cuenta", weight: 3 },
    ],
  },

  // --- 2. Infraestructura y software local -------------------------------
  {
    id: "network.vpn",
    label: "Fallo de conectividad VPN",
    typology: "infraestructura_software",
    baseSeverity: 2,
    requiredEntities: ["affectedUser"],
    queue: "infra-support",
    terms: [
      { term: "vpn", weight: 5 },
      { term: "acceso remoto", weight: 4 },
      { term: "anyconnect", weight: 5 },
      { term: "globalprotect", weight: 5 },
      { term: "no se conecta la vpn", weight: 5 },
      { term: "no puedo conectarme", weight: 3 },
      { term: "timeout vpn", weight: 4 },
      { term: "error 403 vpn", weight: 4 },
      { term: "gateway vpn", weight: 4 },
      { term: "tunel", weight: 3 },
      { term: "no me conecto desde casa", weight: 3 },
    ],
  },
  {
    id: "network.connectivity",
    label: "Fallo de conectividad de red",
    typology: "infraestructura_software",
    baseSeverity: 3,
    requiredEntities: [],
    queue: "infra-support",
    terms: [
      { term: "sin internet", weight: 4 },
      { term: "no tengo conexion", weight: 4 },
      { term: "no tengo red", weight: 4 },
      { term: "wifi", weight: 3 },
      { term: "red inalambrica", weight: 3 },
      { term: "wi-fi", weight: 3 },
      { term: "dns", weight: 3 },
      { term: "no resuelve", weight: 3 },
      { term: "network unreachable", weight: 4 },
      { term: "se cae la conexion", weight: 3 },
      { term: "internet va lento", weight: 2 },
    ],
  },
  {
    id: "endpoint.performance",
    label: "Equipo lento o degradado",
    typology: "infraestructura_software",
    baseSeverity: 3,
    requiredEntities: [],
    queue: "infra-support",
    terms: [
      { term: "equipo lento", weight: 5 },
      { term: "va muy lento", weight: 4 },
      { term: "ordenador lento", weight: 5 },
      { term: "portatil lento", weight: 5 },
      { term: "laptop slow", weight: 5 },
      { term: "computer slow", weight: 5 },
      { term: "se cuelga", weight: 3 },
      { term: "apagas", weight: 3 },
      { term: "consumo de cpu", weight: 4 },
      { term: "usa mucha memoria", weight: 3 },
      { term: "se reinicia solo", weight: 3 },
      { term: "blue screen", weight: 4 },
    ],
  },
  {
    id: "service.degradation",
    label: "Servicio interno degradado o caido",
    typology: "infraestructura_software",
    baseSeverity: 2,
    requiredEntities: ["impactedService"],
    queue: "infra-support",
    terms: [
      { term: "no funciona", weight: 2 },
      { term: "esta caido", weight: 5 },
      { term: "caido", weight: 3 },
      { term: "no me carga", weight: 4 },
      { term: "error del servidor", weight: 4 },
      { term: "internal server error", weight: 5 },
      { term: "error 500", weight: 4 },
      { term: "error 503", weight: 4 },
      { term: "no responde", weight: 3 },
      { term: "degradado", weight: 4 },
      { term: "incidente", weight: 2 },
      { term: "se cae Constantemente", weight: 3 },
    ],
  },
  {
    id: "software.app_error",
    label: "Error en aplicacion corporativa",
    typology: "infraestructura_software",
    baseSeverity: 3,
    requiredEntities: ["impactedService"],
    queue: "infra-support",
    terms: [
      { term: "error al abrir", weight: 4 },
      { term: "no abre", weight: 3 },
      { term: "se cierra solo", weight: 3 },
      { term: "error de la aplicacion", weight: 4 },
      { term: "error inesperado", weight: 3 },
      { term: "no me guarda", weight: 3 },
      { term: "archivo corrupto", weight: 4 },
      { term: "pantalla en blanco", weight: 3 },
      { term: "excel no abre", weight: 5 },
      { term: "outlook no abre", weight: 5 },
    ],
  },
  {
    id: "endpoint.security_agent",
    label: "Incidencia del agente de seguridad",
    typology: "infraestructura_software",
    baseSeverity: 2,
    requiredEntities: [],
    queue: "infra-support",
    terms: [
      { term: "antivirus bloquea", weight: 5 },
      { term: "defender bloquea", weight: 5 },
      { term: "cuarentena", weight: 4 },
      { term: "archivo bloqueado", weight: 4 },
      { term: "agente de seguridad", weight: 4 },
      { term: "edr", weight: 4 },
      { term: "falso positivo", weight: 3 },
    ],
  },

  // --- 3. Aprovisionamiento y permisos ------------------------------------
  {
    id: "provisioning.folder_access",
    label: "Solicitud de acceso a carpeta o repositorio",
    typology: "aprovisionamiento_permisos",
    baseSeverity: 3,
    requiredEntities: ["targetResource", "affectedUser"],
    queue: "access-provisioning",
    terms: [
      { term: "acceso a carpeta", weight: 5 },
      { term: "acceso a la carpeta", weight: 5 },
      { term: "permiso de carpeta", weight: 5 },
      { term: "acceso al repositorio", weight: 5 },
      { term: "acceso al repo", weight: 5 },
      { term: "permiso de escritura", weight: 4 },
      { term: "acceso de lectura", weight: 4 },
      { term: "no tengo permisos", weight: 4 },
      { term: "acceso compartido", weight: 4 },
      { term: "solicito acceso", weight: 4 },
      { term: "alta de acceso", weight: 4 },
      { term: "darme permisos", weight: 4 },
      { term: "agregar a la carpeta", weight: 3 },
    ],
  },
  {
    id: "provisioning.license",
    label: "Solicitud de licencia de software",
    typology: "aprovisionamiento_permisos",
    baseSeverity: 4,
    requiredEntities: ["targetResource", "affectedUser"],
    queue: "access-provisioning",
    terms: [
      { term: "licencia", weight: 5 },
      { term: "license", weight: 5 },
      { term: "nueva licencia", weight: 5 },
      { term: "activar licencia", weight: 5 },
      { term: "sin licencia", weight: 4 },
      { term: "se caduca la licencia", weight: 4 },
      { term: "asignar licencia", weight: 5 },
      { term: "upgrade de licencia", weight: 4 },
    ],
  },
  {
    id: "provisioning.profile_change",
    label: "Cambio en el perfil de usuario",
    typology: "aprovisionamiento_permisos",
    baseSeverity: 3,
    requiredEntities: ["affectedUser"],
    queue: "access-provisioning",
    terms: [
      { term: "cambiar mi perfil", weight: 4 },
      { term: "cambio de perfil", weight: 4 },
      { term: "actualizar mis datos", weight: 4 },
      { term: "cambiar mi correo", weight: 4 },
      { term: "cambiar mi nombre", weight: 4 },
      { term: "cambiar mi telefono", weight: 4 },
      { term: "alta de empleado", weight: 4 },
      { term: "nuevo empleado", weight: 4 },
      { term: "baja de empleado", weight: 4 },
      { term: "traslado", weight: 2 },
    ],
  },

  // --- Sin clasificar -----------------------------------------------------
  {
    id: "unclassified",
    label: "Sin clasificar",
    typology: "sin_clasificar",
    baseSeverity: 3,
    requiredEntities: [],
    queue: "escalation-desk",
    terms: [],
  },
];

/** @type {Map<string, Category>} */
const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

/** @param {string} id */
export function categoryById(id) {
  return BY_ID.get(id);
}

/** Las tres tipologias del pliego, mas `sin_clasificar`. */
export const TYPOLOGIES = Object.freeze({
  ACCESO_IDENTIDAD: "acceso_identidad",
  INFRAESTRUCTURA: "infraestructura_software",
  APROVISIONAMIENTO: "aprovisionamiento_permisos",
  SIN_CLASIFICAR: "sin_clasificar",
});
