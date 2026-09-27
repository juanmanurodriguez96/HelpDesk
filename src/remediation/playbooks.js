/**
 * Catalogo de remediaciones.
 *
 * Un playbook NO es un comando: es un contrato. Declara que efecto tiene, que
 * requisitos exige, que riesgo tiene y cual es su siguiente paso. El ejecutor
 * decide si puede aplicarse; el playbook no se aplica a si mismo.
 *
 * Tres niveles de riesgo, porque no todas las acciones merecen el mismo respeto:
 *
 *   reversible   -> se deshace solo. Reiniciar un servicio, releer una
 *                   configuracion. Se puede hacer sin preguntar, si el
 *                   diagnostico lo justifica.
 *   disruptive   -> interrumpe el trabajo de alguien. Cierra sesiones, cambia
 *                   permisos. Se anuncia antes.
 *   destructive  -> deja rastro que hay que reparar a mano. Nunca se ejecuta
 *                   sin confirmacion humana explicita.
 *
 * La accion destructiva mas comun en un helpdesk es reiniciar el equipo del
 * usuario sin avisar. Por eso `device_restart` es `destructive` y no
 * `disruptive`: perder el trabajo abierto de una persona no se deshace con un
 * script.
 */

import { TYPOLOGIES } from "../knowledge/taxonomy.js";

/** @typedef {"reversible"|"disruptive"|"destructive"} Risk */

/**
 * @typedef {object} Playbook
 * @property {string} id
 * @property {string} label
 * @property {string[]} categories   Categorias a las que aplica.
 * @property {string} typology
 * @property {Risk}   risk
 * @property {string[]} requires     Datos que deben estar presentes.
 * @property {string} action         Clave de la operacion en el adaptador.
 * @property {object} params         Parametros de la operacion.
 * @property {object} guidance       Instrucciones y mensaje al usuario, por idioma.
 * @property {string} rollback       Como se deshace. Vacio si no se puede.
 */

/** @type {Playbook[]} */
export const PLAYBOOKS = [
  {
    id: "identity.unlock-account",
    label: "Desbloquear la cuenta tras un bloqueo por intentos fallidos",
    categories: ["identity.lockout"],
    typology: TYPOLOGIES.ACCESO_IDENTIDAD,
    risk: "reversible",
    requires: ["affectedUser"],
    action: "unlockAccount",
    params: { durationMinutes: 15 },
    rollback: "Ninguno necesario: solo se levanta el bloqueo y no toca credenciales.",
    guidance: {
      es: {
        summary: "La cuenta se desbloquea durante 15 minutos para que puedas entrar.",
        steps: [
          "Cierra la sesion que haya quedado abierta en el navegador.",
          "Vuelve a iniciar sesion con tu identificador corporativo.",
          "Si vuelve a pedirte el codigo de verificacion, es normal: se acaba de rearmar el doble factor.",
        ],
        caution: "Este desbloqueo no cambia tu contrasena. Si no recuerdas la contrasena, es otra incidencia.",
      },
      en: {
        summary: "The account is unlocked for 15 minutes so you can sign in.",
        steps: [
          "Close any session left open in the browser.",
          "Sign in again with your corporate ID.",
          "If it asks for a verification code again, that is expected: two-factor has just been re-armed.",
        ],
        caution: "This unlock does not change your password. If you do not remember it, that is a different issue.",
      },
    },
  },
  {
    id: "identity.reset-mfa",
    label: "Re-armar el doble factor tras un problema de codigo",
    categories: ["identity.mfa"],
    typology: TYPOLOGIES.ACCESO_IDENTIDAD,
    risk: "disruptive",
    requires: ["affectedUser"],
    action: "resetMfa",
    params: { keepEnrolledDevices: true },
    rollback: "El usuario vuelve a enrolar su dispositivo en el siguiente inicio de sesion.",
    guidance: {
      es: {
        summary: "Se re-arma el doble factor. Tendras que volver a validar en el siguiente acceso.",
        steps: [
          "Al iniciar sesion aparecera una notificacion para volver a validar el dispositivo.",
          "Aprueba la solicitud desde el movil corporativo.",
        ],
        caution: "Las sesiones abiertas en otros equipos se cerraran.",
      },
      en: {
        summary: "Two-factor is re-armed. You will have to re-verify on your next sign-in.",
        steps: ["A notification will ask you to re-verify the device on your next sign-in.", "Approve it from your corporate phone."],
        caution: "Sessions open on other devices will be closed.",
      },
    },
  },
  {
    id: "network.restart-vpn-client",
    label: "Reiniciar el cliente de VPN en el equipo del usuario",
    categories: ["network.vpn", "network.connectivity"],
    typology: TYPOLOGIES.INFRAESTRUCTURA,
    risk: "disruptive",
    requires: [],
    action: "restartVpnClient",
    params: {},
    rollback: "El cliente vuelve a arrancar por si mismo al iniciar sesion.",
    guidance: {
      es: {
        summary: "Se reinicia el cliente de VPN del equipo.",
        steps: ["Desconecta el cable de red si estas conectado por cable.", "Vuelve a conectar el cliente de VPN."],
        caution: "Se corta la sesion remota durante unos segundos.",
      },
      en: {
        summary: "The VPN client on the device is restarted.",
        steps: ["Disconnect the network cable if you are wired.", "Reconnect the VPN client."],
        caution: "The remote session drops for a few seconds.",
      },
    },
  },
  {
    id: "endpoint.collect-diagnostics",
    label: "Recoger el paquete de diagnostico del antivirus",
    categories: ["endpoint.security_agent", "endpoint.performance"],
    typology: TYPOLOGIES.INFRAESTRUCTURA,
    risk: "reversible",
    requires: [],
    action: "collectEndpointDiagnostics",
    params: {},
    rollback: "No aplica: solo lectura.",
    guidance: {
      es: {
        summary: "Se recogen los registros del antivirus para revisar la deteccion.",
        steps: ["Puedes seguir trabajando con normalidad."],
        caution: "El informe puede incluir el nombre de los ficheros puestos en cuarentena; no contiene su contenido.",
      },
      en: {
        summary: "Antivirus logs are collected to review the detection.",
        steps: ["You can keep working normally."],
        caution: "The report may include quarantined file names; it does not include their contents.",
      },
    },
  },
  {
    id: "endpoint.restart-device",
    label: "Reiniciar el equipo del usuario",
    categories: ["endpoint.performance"],
    typology: TYPOLOGIES.INFRAESTRUCTURA,
    risk: "destructive",
    requires: ["affectedUser"],
    action: "restartDevice",
    params: { delayMinutes: 10 },
    rollback: "Ninguno: no se puede deshacer un reinicio no guardado.",
    guidance: {
      es: {
        summary: "Se solicita el reinicio del equipo con 10 minutos de aviso.",
        steps: ["Guarde todo lo que tenga abierto antes de que termine el aviso."],
        caution: "El trabajo sin guardar se perderia. Por eso se avisa con antelacion y no se hace de forma automatica.",
      },
      en: {
        summary: "A device restart is requested with 10 minutes of notice.",
        steps: ["Save everything you have open before the notice expires."],
        caution: "Unsaved work would be lost. That is why this is never done automatically.",
      },
    },
  },
  {
    id: "access.grant-repository",
    label: "Conceder acceso a un repositorio",
    categories: ["provisioning.folder_access"],
    typology: TYPOLOGIES.APROVISIONAMIENTO,
    risk: "disruptive",
    requires: ["affectedUser", "targetResource"],
    action: "grantRepositoryAccess",
    params: { level: "maintainer" },
    rollback: "Retirar el permiso devuelve el repositorio a su estado anterior.",
    guidance: {
      es: {
        summary: "Se concede acceso de escritura al repositorio solicitado.",
        steps: ["Verifique que la carpeta o repositorio indicado es el correcto antes de continuar."],
        caution: "El acceso de escritura tambien permite borrar ramas. Si solo necesita leer, digalo y se ajusta el nivel.",
      },
      en: {
        summary: "Write access is granted to the requested repository.",
        steps: ["Check that the folder or repository is the right one before continuing."],
        caution: "Write access also allows deleting branches. If you only need to read, say so and the level is adjusted.",
      },
    },
  },
  {
    id: "provision.assign-license",
    label: "Asignar o renovar licencia",
    categories: ["provisioning.license"],
    typology: TYPOLOGIES.APROVISIONAMIENTO,
    risk: "disruptive",
    requires: ["affectedUser"],
    action: "assignLicense",
    params: {},
    rollback: "La licencia se puede retirar de nuevo.",
    guidance: {
      es: {
        summary: "Se comprueba la disponibilidad de la licencia y se asigna al usuario.",
        steps: ["Si no hay licencias libres, se le avisa para que lo coordine con su responsable."],
        caution: "La licencia se consume de la reserva de la unidad.",
      },
      en: {
        summary: "License availability is checked and the license is assigned.",
        steps: ["If there are no free licenses, the user is told to coordinate with their manager."],
        caution: "The license comes from the unit pool.",
      },
    },
  },
];

/** Playbooks que aplican a un ticket, por categoria. */
export function playbooksForCategory(categoryId) {
  return PLAYBOOKS.filter((p) => p.categories.includes(categoryId));
}

export function playbookById(id) {
  return PLAYBOOKS.find((p) => p.id === id) ?? null;
}
