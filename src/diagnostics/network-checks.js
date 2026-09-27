/**
 * Comprobadores de red y de servicio.
 *
 * Cada uno declara su `source`:
 *
 *   static  -> se resuelve con los datos del ticket y el catalogo. No toca la
 *              red. Es el unico modo que se usa en las pruebas y el normal en
 *              una Mesa que no quiere depender de la red para clasificar.
 *   live    -> requiere salida a Internet. Desactivado salvo que se pida
 *              explicitamente con `allowNetwork`.
 *
 * La distincion no es teorica. Un sistema de soporte que "diagnostica" launching
 * peticiones a la red en cuanto recibe un correo puede (1) filtrar la topologia
 * interna hacia fuera, (2) generar trafico desde la red del usuario cuando el
 * problema es justo la red, y (3) dar un diagnostico que cambia cada minuto. Por
 * eso `live` no es el valor por defecto: es una decision consciente.
 */

import { resolve } from "node:dns/promises";
import { createConnection } from "node:net";
import { isIP } from "node:net";

import { DependencyError, PolicyError } from "../core/errors.js";
import { serviceById } from "../knowledge/catalog.js";

/**
 * Puerta de red. Sin este permiso explicito, cualquier check `live` se niega.
 * La funcion es la unica que consulta la variable de entorno, de modo que
 * decide el nucleo y no cada comprobador por su cuenta.
 */
export function networkAllowed(allowNetwork) {
  if (allowNetwork === true) return true;
  return String(process.env.HELPDESK_ALLOW_NETWORK ?? "") === "1";
}

function requireNetwork(allowNetwork, checkId) {
  if (networkAllowed(allowNetwork)) return;
  throw new PolicyError(
    "DIAG_NETWORK_NOT_ALLOWED",
    `El comprobador "${checkId}" necesita salida a la red y no esta autorizado.`,
    { checkId, hint: 'Use allowNetwork: true o HELPDESK_ALLOW_NETWORK=1 solo en un entorno controlado.' },
  );
}

/** @type {import("./check.js").Check[]} */
export const NETWORK_CHECKS = [
  {
    id: "dns.resolve",
    label: "Resolucion de nombres",
    source: "live",
    detail: "Los nombres del ticket resuelven a una direccion IP.",
    unknownDetail: "No hay nombres de host que comprobar en el ticket.",
    evidence: (ctx) => ({ hostnames: ctx.hostnames ?? [] }),
    async run({ hostnames = [] }) {
      const results = [];
      for (const host of hostnames) {
        // Se comprueba host a host: un fallo parcial ("el portal va pero el SSO
        // no") es informacion distinta de un fallo total, y se pierde al promediar.
        const started = Date.now();
        try {
          const answers = await resolve(host);
          results.push({
            host,
            ok: true,
            addresses: answers.map((a) => a.address),
            ms: Date.now() - started,
          });
        } catch (error) {
          results.push({ host, ok: false, error: error.code ?? String(error), ms: Date.now() - started });
        }
      }
      const failed = results.filter((r) => !r.ok);
      return failed.length === 0 ? "pass" : "fail";
    },
  },
  {
    id: "net.reachability",
    label: "Alcanzabilidad de la direccion",
    source: "live",
    detail: "Las direcciones indicadas responden.",
    unknownDetail: "El ticket no trae direcciones IP para comprobar.",
    evidence: (ctx) => ({ ips: ctx.ips ?? [] }),
    async run({ ips = [] }) {
      const unreachable = [];
      for (const ip of ips) {
        try {
          await probeTcp(ip, 443, { timeoutMs: 2000 });
        } catch {
          unreachable.push(ip);
        }
      }
      return unreachable.length === 0 ? "pass" : "fail";
    },
  },
  {
    id: "net.port",
    label: "Puerto esperado abierto",
    source: "live",
    detail: "El servicio escucha en los puertos esperados.",
    unknownDetail: "No hay puertos esperados definidos para este servicio.",
    evidence: (ctx) => ({ ports: ctx.ports ?? [] }),
    async run({ ips = [], ports = [], hostnames = [] }) {
      const targets = [...ips, ...hostnames];
      if (targets.length === 0 || ports.length === 0) return "unknown";
      const closed = [];
      for (const port of ports) {
        const results = await Promise.allSettled(targets.map((t) => probeTcp(t, port, { timeoutMs: 2000 })));
        if (results.every((r) => r.status === "rejected")) closed.push(port);
      }
      return closed.length === 0 ? "pass" : "fail";
    },
  },
];

/**
 * Comprobadores de servicio. Mezclan lo estatico (lo que el catalogo ya sabe) y
 * lo vivo (lo que hay que preguntar al servicio), porque un diagnostico que solo
 * sabe lo que ya teniamos anotado no diagnostica nada.
 */
export const SERVICE_CHECKS = [
  {
    id: "service.catalog",
    label: "Servicio identificado en el catalogo",
    source: "static",
    detail: "El impacto apunta a un servicio con propietario y criticidad conocidos.",
    unknownDetail: "El ticket no identifica ningun servicio del catalogo.",
    evidence: (ctx) => ({ serviceId: ctx.service?.id ?? null }),
    run({ service }) {
      if (!service) return "unknown";
      // Un servicio sin propietario no es diagnosticable: nadie puede actuar.
      return service.owner ? "pass" : "fail";
    },
  },
  {
    id: "service.health-endpoint",
    label: "Endpoint de salud del servicio",
    source: "live",
    detail: "El endpoint de salud responde con estado correcto.",
    unknownDetail: "El servicio no expone un endpoint de salud conocido.",
    evidence: (ctx) => ({ url: ctx.url ?? null }),
    async run(ctx) {
      if (!ctx.url) return "unknown";
      const response = await fetchWithTimeout(ctx.url, ctx.timeoutMs ?? 4000);
      return response.ok ? "pass" : "fail";
    },
  },
  {
    id: "service.sla-known",
    label: "Objetivo de servicio conocido",
    source: "static",
    detail: "Existe un objetivo de nivel de servicio documentado para el servicio.",
    unknownDetail: "El servicio no tiene objetivo de servicio documentado.",
    evidence: (ctx) => ({ criticality: ctx.service?.criticality ?? null }),
    run({ service }) {
      if (!service) return "unknown";
      return service.criticality ? "pass" : "fail";
    },
  },
];

/** Todos los comprobadores, en el orden en que conviene ejecutarlos. */
export const ALL_CHECKS = [...NETWORK_CHECKS, ...SERVICE_CHECKS];

/** Busca un comprobador por identificador. */
export function checkById(id) {
  return ALL_CHECKS.find((c) => c.id === id) ?? null;
}

/**
 * Contexto de comprobacion derivado del ticket y del catalogo.
 *
 * Se separa del recolector para que el motor de diagnostico no sepa leer
 * tickets: recibe datos y devuelve veredictos. Asi el motor se puede probar con
 * datos inventados, y la extraccion se puede cambiar sin tocar los checks.
 */
export function contextFromTicket(ticket, { allowNetwork = false } = {}) {
  const service = ticket.entities?.impactedService
    ? serviceById(ticket.entities.impactedService)
    : null;

  const hostnames = new Set();
  const ips = new Set();
  for (const match of String(ticket.request?.text ?? "").matchAll(
    /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi,
  )) {
    const host = match[1].toLowerCase();
    if (host.endsWith(".doc") || host.endsWith(".pdf")) continue;
    if (isIP(host)) ips.add(host);
    else if (isInternalHost(host)) hostnames.add(host);
  }
  if (service?.fqdn) {
    hostnames.add(service.fqdn);
    if (isIP(service.fqdn)) ips.add(service.fqdn);
  }

  // `url` es `null` cuando el ticket no identifica ningun host comprobable. Se
  // deja explicito en lugar de construir `https://undefined/healthz`: una URL
  // de mentira no falla ruidosamente, falla en la red, y un diagnostico que
  // apunta a un host inexistente reporta un fallo de red que no existe.
  return {
    ticket,
    service,
    hostnames: [...hostnames],
    ips: [...ips],
    ports: service?.ports ?? defaultPorts(service),
    url: service?.healthUrl ?? healthUrlFor(service, [...hostnames]),
    allowNetwork,
    timeoutMs: 4000,
  };
}

/** URL de salud del servicio del catalogo, o del primer host interno nombrado. */
function healthUrlFor(service, hostnames) {
  const host = service?.fqdn ?? hostnames[0];
  return host ? `https://${host}/healthz` : null;
}

/**
 * Puertos que se esperan para un servicio. El 443 aparece en practicamente todos
 * los catalogos internos, asi que es la suposicion por defecto; un servicio que
 * escuche en otro puerto lo declara en su entrada y ese valor manda.
 */
function defaultPorts(service) {
  if (!service) return [];
  return service.ports ?? [443];
}

/**
 * Solo se consideran internos los hosts que pertenecen a la organizacion o al
 * catalogo. Comprobar un host externo desde una Mesa de soporte sale de la
 * organizacion sin motivo, asi que se descarta de entrada.
 */
function isInternalHost(host) {
  if (/\.(?:local|internal|lan|corp|intranet)$/.test(host)) return true;
  return /^(?:vpn|ss[co]|api|portal|intranet|git|erp|crm|hr|files|mail|owa|autodiscover)\./.test(host);
}

/**
 * Apertura de conexion TCP con tiempo limite.
 *
 * No existe un `net/promises` en el runtime, asi que la promesa se construye a
 * mano. El detalle que importa es `socket.destroy()` en todos los caminos de
 * salida: un socket abierto y olvidado mantiene el proceso vivo, y un
 * comprobador de red que cuelga la sesion de diagnostico es peor que no
 * comprobar nada.
 */
function probeTcp(host, port, { timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise();
    };

    socket.setTimeout(timeoutMs, () => finish(new Error(`timeout tras ${timeoutMs} ms`)));
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

async function fetchWithTimeout(url, timeoutMs) {
  if (typeof globalThis.fetch !== "function") {
    throw new DependencyError("DIAG_FETCH_UNAVAILABLE", "Este runtime no expone fetch.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await globalThis.fetch(url, { signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}
