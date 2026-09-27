/**
 * Catalogo de servicios internos.
 *
 * Es la unica fuente de verdad sobre "que sistemas existen en la empresa". De el
 * dependen tres cosas: la extraccion de entidades (para saber si el usuario nombra
 * un servicio real), la criticidad de negocio (que determina severidad) y los
 * diagnosticos (que necesitan un objetivo concreto que sondear).
 *
 * En un despliegue real este catalogo se alimenta del CMDB. Aqui se declara de
 * forma estatica y explicita, con la misma forma de datos, para que la
 * sustitucion sea un cambio de adaptador y no un rediseño.
 */

/**
 * @typedef {object} Service
 * @property {string}  id            Identificador estable.
 * @property {string}  name          Nombre visible para el usuario.
 * @property {string}  kind          `identity` | `network` | `endpoint` | `service` | `software`
 * @property {string}  owner         Equipo propietario (destino de escalado).
 * @property {1|2|3|4} criticality   Criticidad de negocio: 1 = parada total.
 * @property {string[]} aliases      Sinónimos que el usuario final puede usar.
 * @property {string}  [fqdn]        Nombre tecnico, solo para diagnostico.
 * @property {string}  [probe]       Objetivo por defecto de los diagnosticos.
 */

/** @type {Service[]} */
export const SERVICES = [
  // --- Identidad ---------------------------------------------------------
  {
    id: "sso",
    name: "Inicio de sesion corporativo (SSO)",
    kind: "identity",
    owner: "identity-support",
    criticality: 1,
    fqdn: "sso.corp.example",
    probe: "sso.corp.example",
    aliases: ["sso", "inicio de sesion", "login corporativo", "single sign on", "azure ad", "okta"],
  },
  {
    id: "vpn",
    name: "Acceso remoto (VPN)",
    kind: "network",
    owner: "infra-support",
    criticality: 1,
    fqdn: "vpn.corp.example",
    probe: "vpn.corp.example:443",
    aliases: ["vpn", "acceso remoto", "conexion remota", "anyconnect", "globalprotect", "tunel"],
  },
  {
    id: "wifi-corp",
    name: "Red corporativa inalambrica",
    kind: "network",
    owner: "infra-support",
    criticality: 2,
    fqdn: "wifi.corp.example",
    aliases: ["wifi", "red inalambrica", "wi-fi", "red movil", "hotspot corporativo"],
  },
  {
    id: "mfa",
    name: "Verificacion en dos pasos (MFA)",
    kind: "identity",
    owner: "identity-support",
    criticality: 1,
    aliases: ["mfa", "doble factor", "2fa", "verificacion en dos pasos", "codigo de verificacion", "totp"],
  },

  // --- Infraestructura y software local ---------------------------------
  {
    id: "email",
    name: "Correo corporativo",
    kind: "service",
    owner: "infra-support",
    criticality: 1,
    fqdn: "mail.corp.example",
    probe: "mail.corp.example:443",
    aliases: ["correo", "email", "outlook", "exchange", "buzon", "mail"],
  },
  {
    id: "erp",
    name: "ERP de finanzas y facturacion",
    kind: "service",
    owner: "infra-support",
    criticality: 1,
    fqdn: "erp.corp.example",
    probe: "erp.corp.example:443",
    aliases: ["erp", "sap", "facturacion", "finanzas", "contabilidad", "nominas"],
  },
  {
    id: "crm",
    name: "CRM comercial",
    kind: "service",
    owner: "infra-support",
    criticality: 2,
    fqdn: "crm.corp.example",
    probe: "crm.corp.example:443",
    aliases: ["crm", "salesforce", "clientes", "pipeline comercial"],
  },
  {
    id: "intranet",
    name: "Portal interno del empleado",
    kind: "service",
    owner: "infra-support",
    criticality: 3,
    fqdn: "intranet.corp.example",
    probe: "intranet.corp.example:443",
    aliases: ["intranet", "portal del empleado", "portal interno", "home intranet"],
  },
  {
    id: "hr-portal",
    name: "Portal de recursos humanos",
    kind: "service",
    owner: "infra-support",
    criticality: 2,
    fqdn: "hr.corp.example",
    probe: "hr.corp.example:443",
    aliases: ["portal de rrhh", "recursos humanos", "portal de personal", "vacaciones", "nominas"],
  },
  {
    id: "print-service",
    name: "Servicio de impresion",
    kind: "service",
    owner: "infra-support",
    criticality: 3,
    fqdn: "print.corp.example",
    probe: "print.corp.example:631",
    // Sin esta entrada, una incidencia de impresora se clasificaba bien pero se
    // quedaba sin `impactedService`, que es obligatoria en su categoria: el
    // ticket no podia resolverse nunca, por muy bien que se atendiera. Faltaba
    // el servicio, no la regla.
    aliases: ["impresora", "impresoras", "impresion", "imprimir", "printing", "printer", "spooler", "cola de impresion", "laserjet"],
  },
  {
    id: "gitlab",
    name: "Repositorio de codigo",
    kind: "software",
    owner: "access-provisioning",
    criticality: 2,
    fqdn: "gitlab.corp.example",
    aliases: ["gitlab", "repositorio", "repos", "control de versiones", "repositorio de codigo", "merge request"],
  },
  {
    id: "office-suite",
    name: "Suite de ofimatica",
    kind: "software",
    owner: "infra-support",
    criticality: 2,
    aliases: ["office", "word", "excel", "powerpoint", "outlook de escritorio", "suite de ofimatica"],
  },
  {
    id: "endpoint-agent",
    name: "Agente de seguridad del equipo",
    kind: "endpoint",
    owner: "infra-support",
    criticality: 2,
    aliases: ["antivirus", "defender", "agente de seguridad", "edr", "endpoint", "proteccion del equipo"],
  },
];

/** @type {Map<string, Service>} */
const BY_ID = new Map(SERVICES.map((s) => [s.id, s]));

/**
 * @param {string} id
 * @returns {Service|undefined}
 */
export function serviceById(id) {
  return BY_ID.get(id);
}

/**
 * Busca un servicio por nombre o alias. La busqueda es exacta sobre el texto
 * normalizado y elige la coincidencia mas larga, de modo que "repositorio de
 * codigo" gane a "repositorio" en lugar de empatar.
 *
 * @param {string} normalizedText texto ya normalizado (ver `core/text.js`)
 * @returns {Service[]}
 */
export function matchServices(normalizedText) {
  const found = [];
  for (const service of SERVICES) {
    const candidates = [service.id, service.name, ...service.aliases].map(normalizeLoose);
    for (const alias of candidates) {
      if (!alias) continue;
      const pattern = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Se exige un limite de token para que "crm" no empareje dentro de otra palabra.
      const re = new RegExp(`(?:^|[^a-z0-9])${pattern}(?:$|[^a-z0-9])`, "i");
      if (re.test(normalizedText)) {
        found.push({ service, alias, weight: alias.length });
        break;
      }
    }
  }
  // Mas especifico primero: desempata por longitud de alias.
  return found.sort((a, b) => b.weight - a.weight).map((f) => f.service);
}

/** Reutiliza la normalizacion de `core/text.js` sin importacion circular. */
function normalizeLoose(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Sites y centros con coste de negocio conocido, para el impacto. */
export const LOCATIONS = [
  { id: "mad", name: "Madrid (HQ)", aliases: ["madrid", "hq", "sede central", "calle serrano"] },
  { id: "bcn", name: "Barcelona", aliases: ["barcelona", "bcn", "oficina barcelona"] },
  { id: "vlc", name: "Valencia", aliases: ["valencia", "vlc"] },
  { id: "svq", name: "Sevilla", aliases: ["sevilla", "svq"] },
  { id: "bil", name: "Bilbao", aliases: ["bilbao", "bil"] },
  { id: "tele", name: "Teletrabajo", aliases: ["teletrabajo", "home office", "remoto", "trabajo desde casa"] },
];
