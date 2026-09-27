import test, { suite } from "node:test";
import assert from "node:assert/strict";

import { diagnose, runCheck, summarize, contextFromTicket, networkAllowed } from "../src/diagnostics/index.js";
import { intakeAndTriage } from "../src/triage/index.js";
import { PolicyError } from "../src/core/errors.js";

const NOW = new Date("2026-01-05T08:00:00Z");

/** Comprobadores falsos, para poder fijar el comportamiento sin tocar la red. */
function fakeChecks(results) {
  return Object.entries(results).map(([id, verdict]) => ({
    id,
    label: `check ${id}`,
    source: "static",
    detail: "detalle",
    unknownDetail: "sin datos",
    evidence: () => ({}),
    run: () => verdict,
  }));
}

async function ticketFor(text) {
  const { ticket } = intakeAndTriage({ text, reporter: "E-99001", now: NOW });
  return ticket;
}

suite("diagnostics/check", () => {
  test("un comprobador que lanza excepcion es unknown, no fail", async () => {
    // La distincion es accionable: "el DNS responde mal" y "el comprobador de
    // DNS tiene un error" llevan a decisiones opuestas.
    const roto = {
      id: "roto",
      label: "comprobador roto",
      source: "static",
      detail: "d",
      unknownDetail: "sin datos",
      run() {
        throw new Error("bug de programacion");
      },
    };
    const result = await runCheck(roto, {});
    assert.equal(result.verdict, "unknown");
    assert.match(result.detail, /fallo/i);
  });

  test("un veredicto invalido se considera un comprobador roto", async () => {
    const malo = {
      id: "malo",
      label: "veredicto invalido",
      source: "static",
      detail: "d",
      unknownDetail: "sin datos",
      run: () => "quiza",
    };
    const result = await runCheck(malo, {});
    assert.equal(result.verdict, "unknown");
  });

  test("un check que no puede saberlo dice unknown y no pass", async () => {
    const sinDatos = {
      id: "sin-datos",
      label: "sin datos",
      source: "static",
      detail: "d",
      unknownDetail: "Faltan datos",
      run: () => "unknown",
    };
    const result = await runCheck(sinDatos, {});
    assert.equal(result.verdict, "unknown");
    assert.equal(result.detail, "Faltan datos");
  });

  test("el resumen separa cobertura de acuerdo", () => {
    const resumen = summarize([
      { verdict: "pass" },
      { verdict: "fail" },
      { verdict: "unknown" },
      { verdict: "unknown" },
    ]);
    assert.equal(resumen.total, 4);
    assert.equal(resumen.pass, 1);
    assert.equal(resumen.fail, 1);
    assert.equal(resumen.unknown, 2);
    assert.equal(resumen.known, 2);
    // La mitad de los datos faltan: eso es cobertura, y va aparte.
    assert.equal(resumen.coverage, 0.5);
    // Lo que se comprobo se contradice: eso es acuerdo, y tambien va aparte.
    assert.equal(resumen.agreement, 0.5);
    assert.ok(
      resumen.confidence <= 0.5,
      `un informe a medias y contradictorio no puede dar confianza alta, dio ${resumen.confidence}`,
    );
  });

  test("un informe sin datos que falten tiene cobertura completa", () => {
    const resumen = summarize([{ verdict: "pass" }, { verdict: "pass" }]);
    assert.equal(resumen.coverage, 1);
    assert.equal(resumen.agreement, 1);
    assert.equal(resumen.confidence, 1);
  });

  test("un resumen vacio no es una cobertura perfecta", () => {
    assert.equal(summarize([]).confidence, 0);
  });
});

suite("diagnostics/contexto", () => {
  test("extrae hosts internos y descarta los externos", () => {
    const context = contextFromTicket({
      entities: { impactedService: "vpn" },
      request: { text: "no me conecta vpn.corp.example desde news.yahoo.com" },
    });
    assert.ok(context.hostnames.includes("vpn.corp.example"));
    assert.ok(
      !context.hostnames.includes("news.yahoo.com"),
      "comprobar un host externo saca trafico de la organizacion sin motivo",
    );
  });

  test("no confunde un nombre de fichero con un host", () => {
    const context = contextFromTicket({
      entities: {},
      request: { text: "adjunto informe.doc y annual.pdf, no me deja entrar" },
    });
    assert.equal(context.hostnames.length, 0);
  });

  test("el servicio del catalogo aporta su FQDN como host", () => {
    const context = contextFromTicket({ entities: { impactedService: "sso" }, request: { text: "no entro" } });
    assert.ok(context.hostnames.includes("sso.corp.example"));
    assert.equal(context.service.id, "sso");
  });
});

suite("diagnostics/puerta de red", () => {
  test("sin autorizacion no hay salida a la red", () => {
    assert.equal(networkAllowed(false), false);
    assert.equal(networkAllowed(undefined), process.env.HELPDESK_ALLOW_NETWORK === "1");
  });

  test("la autorizacion explicita si vale", () => {
    assert.equal(networkAllowed(true), true);
  });
});

suite("diagnostics/motor", () => {
  test("sin permiso de red los comprobadores live quedan unknown y el informe es insuficiente", async () => {
    const ticket = await ticketFor(
      "No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway. Solo me pasa a mi",
    );
    const informe = await diagnose({ ticket, allowNetwork: false });
    const live = informe.checks.filter((c) => c.id === "dns.resolve" || c.id === "net.port");
    assert.equal(live.length, 2);
    for (const check of live) {
      assert.equal(check.verdict, "unknown");
      assert.equal(check.evidence.skipped, "network_not_allowed");
    }
    assert.equal(informe.mode, "offline");
    assert.equal(informe.insufficient, true);
    assert.equal(informe.cause.conclusive, false);
    assert.ok(
      informe.missing.some((m) => m.id === "network_authorization"),
      "debe quedar escrito que falta la autorizacion, no solo que no se pudo",
    );
  });

  test("un fallo de DNS es la causa mas especifica y con mas confianza", async () => {
    const ticket = await ticketFor("No me conecto a la VPN desde casa, AnyConnect da error de gateway");
    const informe = await diagnose({
      ticket,
      checks: fakeChecks({
        "service.catalog": "pass",
        "dns.resolve": "fail",
        "net.reachability": "fail",
        "net.port": "fail",
        "service.health-endpoint": "pass",
      }),
      only: ["service.catalog", "dns.resolve", "net.reachability", "net.port", "service.health-endpoint"],
    });
    assert.equal(informe.cause.rule, "dns_failure");
    assert.ok(informe.cause.confidence >= 0.6, "varios comprobadores coinciden en el sintoma");
    assert.equal(informe.cause.conclusive, true);
    assert.equal(informe.insufficient, false);
  });

  test("un servicio que responde mal se atribuye al servicio, no al equipo del usuario", async () => {
    const ticket = await ticketFor("El ERP de facturacion no me carga, error 500");
    const informe = await diagnose({
      ticket,
      checks: fakeChecks({
        "service.catalog": "pass",
        "service.health-endpoint": "fail",
        "dns.resolve": "pass",
        "net.port": "pass",
      }),
      only: ["service.catalog", "service.health-endpoint", "dns.resolve", "net.port"],
    });
    assert.equal(informe.cause.rule, "service_unhealthy");
    assert.match(informe.cause.hypothesis.es, /no es del equipo del usuario/);
  });

  test("una ruta sana NO se convierte en un diagnostico de que todo esta bien", async () => {
    // El fallo clasico: "no veo nada roto" tratado como "no hay nada roto".
    const ticket = await ticketFor("La aplicacion de nomina no me abre");
    const informe = await diagnose({
      ticket,
      checks: fakeChecks({ "service.catalog": "pass", "dns.resolve": "pass", "net.port": "pass" }),
      only: ["service.catalog", "dns.resolve", "net.port"],
    });
    assert.equal(informe.cause.rule, "path_healthy");
    assert.ok(
      informe.cause.confidence <= 0.3,
      `una ruta sana no puede dar una conclusion fiable, dio ${informe.cause.confidence}`,
    );
    assert.equal(informe.cause.conclusive, false);
  });

  test("sin datos suficientes el informe no autoriza remediar", async () => {
    const ticket = await ticketFor("No funciona la intranet");
    const informe = await diagnose({
      ticket,
      checks: fakeChecks({ "service.catalog": "unknown", "service.health-endpoint": "unknown" }),
      only: ["service.catalog", "service.health-endpoint"],
    });
    assert.equal(informe.insufficient, true);
    assert.equal(informe.cause.conclusive, false);
    assert.equal(informe.missing.length, 2);
  });

  test("el informe identifica el ticket y el modo de ejecucion", async () => {
    const ticket = await ticketFor("No me conecto a la VPN desde casa, AnyConnect da error 403 de gateway");
    const informe = await diagnose({ ticket, allowNetwork: false });
    assert.equal(informe.ticketId, ticket.id);
    assert.match(informe.id, /^DIAG-[A-Z0-9]{6}$/);
    assert.equal(typeof informe.at, "string");
  });

  test("un ticket de tipologia personal no ejecuta comprobadores de red", async () => {
    const ticket = await ticketFor("Mi portatil va muy lento y se cuelga");
    assert.equal(ticket.typology, "infraestructura_software");
    const informe = await diagnose({ ticket, allowNetwork: false });
    const ids = informe.checks.map((c) => c.id);
    assert.ok(ids.includes("service.catalog"));
  });

  test("diagnosticar sin ticket es un error de validacion, no un informe vacio", async () => {
    await assert.rejects(() => diagnose({}), /ticket/i);
  });
});

suite("diagnostics/politica de red", () => {
  test("un check live sin permiso lanza error de politica, no de red", async () => {
    // Distinguir "no me dejaste" de "la red fallo" es lo que permite decidir si
    // hay que pedir permiso o escalar.
    const live = {
      id: "net.reachability",
      label: "Alcanzabilidad",
      source: "live",
      detail: "d",
      unknownDetail: "sin datos",
      run() {
        throw new PolicyError("DIAG_NETWORK_NOT_ALLOWED", "nope");
      },
    };
    const result = await runCheck(live, {});
    assert.equal(result.verdict, "unknown");
    assert.match(result.detail, /DIAG_NETWORK_NOT_ALLOWED/);
  });
});
