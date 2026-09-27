import { test, describe, suite } from "node:test";
import assert from "node:assert/strict";

import {
  redact,
  detect,
  containsSecret,
  offersCredentials,
  asksForCredentials,
  assertNoSecret,
  assertSafeQuestion,
  isLuhnValid,
  SECRET_NOTICE,
  REDACTION,
} from "../src/privacy/pii.js";
import { PolicyError } from "../src/core/errors.js";

const BS = String.fromCharCode(92);

/** Valor centinela: si aparece en la salida, la redaccion ha fallado. */
const SECRETS = [
  "Hunter2!123",
  "sk-proj-abc123def456",
  "veranovale",
  "Confidencial2026",
  "abcDEF123456xyz",
];

describe("pii/redact", () => {
  test("enmascara correo y credencial declarada en la misma frase", () => {
    const input = "No puedo entrar a mi cuenta, usuario mgarcia@corp.com, mi password es Hunter2!123";
    const { text, findings, redacted } = redact(input);
    assert.equal(redacted, true);
    assert.ok(text.includes(REDACTION.EMAIL), "el correo debe quedar enmascarado");
    assert.ok(text.includes(REDACTION.SECRET), "la contrasena debe quedar enmascarada");
    assert.ok(!text.includes("Hunter2!123"), "el valor del secreto no debe sobrevivir");
    assert.ok(!text.includes("mgarcia@corp.com"));
    assert.deepEqual(
      findings.map((f) => f.type).sort(),
      ["EMAIL", "SECRET"],
    );
  });

  test("clasifica un JWT como token, no como etiqueta+valor", () => {
    const input =
      "API key: sk-proj-abc123def456 y token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk";
    const { text, findings } = redact(input);
    assert.ok(text.includes(REDACTION.TOKEN), "el JWT debe marcarse como token");
    assert.equal(
      findings.filter((f) => f.type === "SECRET").length,
      1,
      "solo la API key debe contar como SECRET",
    );
    assert.ok(!text.includes("eyJhbGciOiJIUzI1NiJ9"));
  });

  test("no produce falsos positivos con lenguaje natural", () => {
    const input = "la clave es importante para el informe y el portal va lento";
    const { text, redacted } = redact(input);
    assert.equal(redacted, false, `no deberia redactarse: ${text}`);
    assert.equal(text, input);
  });

  test("la intencion manda sobre la forma: palabra sin digitos tras 'mi contrasena es'", () => {
    const { text, findings } = redact("mi contrasena es veranovale y no me deja entrar");
    assert.ok(!text.includes("veranovale"), "una credencial sin digitos tambien se destruye");
    assert.ok(findings.some((f) => f.type === "SECRET"));
  });

  test("encuentra el valor real tras palabras puente", () => {
    const { text } = redact("la clave de la carpeta compartida es Confidencial2026");
    assert.ok(!text.includes("Confidencial2026"), `no debe sobrevivir: ${text}`);
  });

  test("enmascara la etiqueta pegada al valor, sin separador", () => {
    // Forma habitual de pegar usuario y contrasena en un mismo mensaje: el
    // segundo valor llega sin copula, y con la regla de asignacion se quedaba
    // en el ticket en claro.
    const { text, findings } = redact("mi usuario es E-10482 y la contrasena Tr3boleta2026");
    assert.ok(!text.includes("Tr3boleta2026"), `no debe sobrevivir: ${text}`);
    assert.ok(findings.some((f) => f.type === "SECRET"));
  });

  test("la adyacencia etiqueta+valor no se dispara con palabras normales", () => {
    for (const input of [
      "la clave compartida con el equipo",
      "la clave de la carpeta compartida",
      "la politica de rotacion de token",
      "el portal corporativo va lento",
    ]) {
      const { text, redacted } = redact(input);
      assert.equal(redacted, false, `no deberia redactarse: ${text}`);
      assert.equal(text, input);
    }
  });

  test("enmascara rutas del perfil de usuario y conserva la IP de diagnostico", () => {
    const path = `C:${BS}Users${BS}jgarcia${BS}AppData${BS}no responde, ip 10.20.30.40`;
    const { text, findings } = redact(path);
    assert.ok(!text.includes("jgarcia"), "el nombre de usuario del sistema se enmascara");
    assert.ok(text.includes("10.20.30.40"), "la IP es dato de diagnostico y se conserva");
    assert.ok(findings.some((f) => f.type === "USERNAME"));
  });

  test("enmascara IBAN, tarjeta (Luhn), DNI y telefono; no toca fechas ni referencias", () => {
    const input =
      "Mi tarjeta es 4111 1111 1111 1111 y el IBAN ES91 2100 0418 4502 0005 1332, DNI 12345678Z, tel +34 600 123 456, el fallo ocurre el 05/01/2026, ref HD-4821";
    const { text, findings } = redact(input);
    const types = findings.map((f) => f.type);
    for (const expected of ["CREDIT_CARD", "IBAN", "NATIONAL_ID", "PHONE"]) {
      assert.ok(types.includes(expected), `falta ${expected}: ${JSON.stringify(findings)}`);
    }
    assert.ok(text.includes("05/01/2026"), "una fecha no es un telefono");
    assert.ok(text.includes("HD-4821"), "una referencia de ticket no es un telefono");
    assert.ok(text.includes("10.20") === false, "no deberia aparecer IPs nuevas");
  });

  test("destruye un bloque de clave privada completa", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJYozo2t60EG8L0561g13R29LvMR5hy",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const { text, findings } = redact(input);
    assert.ok(text.includes(REDACTION.PRIVATE_KEY));
    assert.ok(!text.includes("MIIEowIBAAKCAQEAy8"));
    assert.ok(findings.some((f) => f.type === "PRIVATE_KEY"));
  });

  test("conserva texto de soporte sin datos sensibles intacto", () => {
    const input =
      "salto error TLS en vpn.corp.example timeout 30000ms, nodo BCN-EDGE-02, usuario PENDIENTE";
    const { text, redacted } = redact(input);
    assert.equal(redacted, false);
    assert.equal(text, input);
  });

  test("la redaccion es idempotente", () => {
    const once = redact("mi password es Hunter2!123").text;
    const twice = redact(once).text;
    assert.equal(twice, once, "re-redactar no debe volver a tocar el texto");
  });

  test("ningun centinela sobrevive a la redaccion en ningun caso de uso", () => {
    const inputs = [
      `password=${SECRETS[0]}`,
      `api_key: ${SECRETS[1]}`,
      `mi token es ${SECRETS[2]}`,
      `Authorization: Bearer ${SECRETS[4]}`,
      `clave de la carpeta: ${SECRETS[3]}`,
    ];
    for (const input of inputs) {
      const { text } = redact(input);
      for (const secret of SECRETS) {
        assert.ok(!text.includes(secret), `se filtro "${secret}" en: ${text}`);
      }
    }
  });
});

describe("pii/luhn", () => {
  test("acepta una tarjeta valida y rechaza una invalida", () => {
    assert.equal(isLuhnValid("4111111111111111"), true);
    assert.equal(isLuhnValid("4111 1111 1111 1112"), false);
    assert.equal(isLuhnValid("123"), false);
  });
});

describe("pii/guards", () => {
  test("containsSecret distingue secretos de PII simple", () => {
    assert.equal(containsSecret("api_key=abc123456"), true);
    assert.equal(containsSecret("escribeme a ana.garcia@corp.com"), false);
  });

  test("assertNoSecret bloquea la operacion con codigo estable", () => {
    assert.throws(
      () => assertNoSecret("mi clave es Hunter2!123", { where: "respuesta" }),
      (error) => {
        assert.ok(error instanceof PolicyError);
        assert.equal(error.code, "SECRET_LEAK");
        assert.deepEqual(error.details.types, ["SECRET"]);
        return true;
      },
    );
    assert.doesNotThrow(() => assertNoSecret("su ticket es HD-4821"));
  });

  test("offersCredentials detecta la intencion de compartir credenciales", () => {
    assert.equal(offersCredentials("te paso mi contraseña: hunter2"), true);
    assert.equal(offersCredentials("please send me the password"), true);
    assert.equal(offersCredentials("no me puedo conectar a la vpn"), false);
  });

  test("asksForCredentials detecta peticiones de credencial, no descripciones", () => {
    assert.equal(asksForCredentials("Cual es tu contrasena actual?"), true);
    assert.equal(asksForCredentials("Necesito que me envies el token"), true);
    assert.equal(asksForCredentials("What is your password?"), true);
    assert.equal(
      asksForCredentials("El portal no me deja iniciar sesion desde ayer"),
      false,
      "describir un fallo de acceso no es pedir una credencial",
    );
  });

  test("assertSafeQuestion bloquea pedir credenciales aunque la pregunta sea inocua", () => {
    assert.throws(
      () => assertSafeQuestion("Cual es tu contrasena actual?"),
      (error) => {
        assert.equal(error.code, "CREDENTIAL_REQUEST");
        return true;
      },
    );
    assert.equal(
      assertSafeQuestion("En que equipo y en que franja horaria te ocurre?"),
      "En que equipo y en que franja horaria te ocurre?",
    );
  });

  test("el aviso de seguridad existe en ambos idiomas", () => {
    assert.ok(SECRET_NOTICE.es.length > 40);
    assert.ok(SECRET_NOTICE.en.length > 40);
    assert.ok(!containsSecret(SECRET_NOTICE.es));
  });

  test("detect() no muta la entrada", () => {
    const input = "api_key=abc123456";
    detect(input);
    assert.equal(input, "api_key=abc123456");
  });
});

suite("redaccion/idempotencia", () => {
  // Sin esto, un texto ya saneado se marca otra vez en la siguiente pasada:
  // `assertPrivacyInvariant` rechazaria los tickets bien limpiados y
  // `assertAuditable` se negaria a registrarlos.
  const CASOS = [
    "la contrasena es Secreto123!",
    "usuario: E-10482, contrasena: hunter2",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
    "te paso mi contrasena: aB3$xY!",
    "mi iban es ES91 2100 0418 4502 0005 1332",
    "tarjeta 4111 1111 1111 1111",
    "el archivo esta en /home/juan.perez/Documents/informe.docx",
    "escribeme a juan.perez@empresa.com y el movil es 600123456",
  ];

  test("una segunda pasada no cambia el texto ni vuelve a marcarlo", () => {
    for (const input of CASOS) {
      const first = redact(input);
      const second = redact(first.text);
      assert.equal(second.text, first.text, `inestable con: ${input}`);
      assert.equal(second.redacted, false, `vuelve a marcar: ${input} -> ${first.text}`);
      assert.equal(containsSecret(first.text), false, `fuga en: ${first.text}`);
    }
  });

  test("la etiqueta de la credencial no sobrevive al marcador", () => {
    // "contrasena = [REDACTED_SECRET]" seguiria casando con la regla de secretos
    // en la siguiente pasada; solo el marcador es estable.
    const { text } = redact("la contrasena es Secreto123!");
    assert.equal(text, "la [REDACTED_SECRET]");
  });

  test("un texto que habla DE contrasenas no se destruye", () => {
    const inocuo = [
      "la clave es importante para el informe y el portal va lento",
      "la contrasena es importante para la seguridad",
      "Cambie la contrasena en el portal y ya funciona",
    ];
    for (const input of inocuo) {
      const { text, redacted } = redact(input);
      assert.equal(redacted, false, `no deberia redactarse: ${input} -> ${text}`);
      assert.equal(text, input, `el texto del usuario debe intacto: ${input}`);
    }
  });

  test("detecta que se comparte una credencial en las formas habituales en castellano", () => {
    // "la contrasena es ..." es la forma natural en español y la que mas se
    // escribe pegando el valor desde un formulario. Sin el determinante
    // generico, esta senal no saltaba y el usuario no recibia el aviso.
    for (const input of [
      "la contrasena es Secreto123!",
      "el token es abc.def.ghi",
      "la clave es 1234abcd",
      "contrasena: hunter2",
    ]) {
      assert.equal(offersCredentials(input), true, `no detectado: ${input}`);
    }
  });

  test("no confunde una mencion a contrasenas con una entrega de contrasena", () => {
    for (const input of [
      "Cambie la contrasena en el portal y ya funciona",
      "Indique su identificador corporativo, no su contrasena.",
      "la contrasena es importante para la seguridad",
    ]) {
      assert.equal(offersCredentials(input), false, `falso positivo: ${input}`);
    }
  });
});
