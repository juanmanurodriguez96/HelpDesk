/**
 * Checks de diagnostico.
 *
 * Un check es una comprobacion pequena, con nombre estable, que devuelve un
 * VEREDICTO y la EVIDENCIA que lo sostiene. Se prefiere esta forma a la de un
 * script que solo dice "ok": una Mesa de soporte tiene que poder responder
 * "¿por que?" y copiar el resultado en el ticket.
 *
 * Contrato de cada check:
 *
 *   - Es determinista: mismos datos de entrada, mismo veredicto. Sin azar, sin
 *     reloj propio, sin estado global.
 *   - Declara que datos necesita. Un check que necesita algo que no se puede
 *     obtener no se inventa la respuesta: se marca como `unknown`.
 *   - No muta nada. Diagnosticar es observar; si un check cambiara el sistema,
 *     seria remediacion disfrazada.
 *
 * Los tres veredictos posibles, y por que estan los tres:
 *
 *   pass  -> la comprobacion se cumple.
 *   fail  -> la comprobacion NO se cumple: hay un sintoma concreto.
 *   unknown -> no hay datos para saberlo. Es tan distinto de `pass` como de
 *             `fail`, y en un informe de diagnostico se cuenta aparte. Reportar
 *             `pass` cuando no se ha comprobado nada es la forma mas rapida de
 *             cerrar un ticket sin haberlo arreglado.
 */

/** @typedef {"pass"|"fail"|"unknown"} Verdict */

/**
 * @typedef {object} CheckResult
 * @property {string}  id
 * @property {string}  label
 * @property {Verdict} verdict
 * @property {string}  detail
 * @property {object}  evidence  Datos que sostienen el veredicto.
 */

/**
 * @typedef {object} CheckContext
 * @property {string[]} [hostnames]  Nombres a comprobar.
 * @property {string[]} [ips]        Direcciones a comprobar.
 * @property {number[]} [ports]      Puertos esperados.
 * @property {object}   [service]    Servicio del catalogo.
 * @property {string}   [url]        URL de salud del servicio.
 * @property {object}   [ticket]     Ticket en curso, para contexto.
 * @property {number}   [timeoutMs]
 */

/**
 * Ejecuta un check de forma segura.
 *
 * Un check que lanza excepcion NO es un check que falla: es un check roto. La
 * distincion importa, porque "el DNS responde mal" y "el comprobador de DNS
 * tiene un error de programacion" llevan a acciones opuestas. Un error se
 * convierte en `unknown` con el motivo, y el diagnostico sigue siendo utilizable.
 */
export async function runCheck(check, context = {}) {
  const startedAt = Date.now();
  try {
    const verdict = await check.run(context);
    if (verdict !== "pass" && verdict !== "fail" && verdict !== "unknown") {
      throw new Error(`Veredicto invalido: ${JSON.stringify(verdict)}`);
    }
    return {
      id: check.id,
      label: check.label,
      verdict,
      detail: verdict === "unknown" ? (check.unknownDetail ?? "Sin datos para comprobarlo") : check.detail,
      evidence: { source: check.source, ...(check.evidence?.(context) ?? {}) },
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      id: check.id,
      label: check.label,
      verdict: "unknown",
      detail: `El comprobador fallo (${error.code ?? error.name}): no se puede afirmar nada sobre este punto.`,
      evidence: { source: check.source, error: String(error.message ?? error) },
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Resumen agregado de una lista de resultados.
 *
 * Aqui se separan DOS preguntas que es tentador mezclar en un solo numero:
 *
 *   coverage  -> ¿cuanto se ha comprobado de verdad? Los `unknown` no cuentan.
 *   agreement -> de lo comprobado, ¿cuanto coincide en un mismo veredicto?
 *
 * Con un unico "confianza" las dos se contaminan. El caso que lo delata: un
 * informe con un `pass`, un `fail` y dos `unknown` sale con un numero
 * surprisingly alto porque la mitad de los datos faltan, y ese numero es
 * precisamente el que se leeria como "se puede cerrar". Faltan datos y hay
 * datos que se contradicen son dos problemas distintos, y se informan por
 * separado.
 */
export function summarize(results) {
  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const r of results) counts[r.verdict] += 1;

  const known = counts.pass + counts.fail;
  const coverage = results.length === 0 ? 0 : round2(known / results.length);
  const agreement = known === 0 ? 0 : round2(Math.max(counts.pass, counts.fail) / known);

  return {
    ...counts,
    total: results.length,
    /** Comprobaciones que produjeron un veredicto. */
    known,
    coverage,
    agreement,
    /** Producto de ambos: util como cifra unica, nunca como sustituto. */
    confidence: round2(coverage * agreement),
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
