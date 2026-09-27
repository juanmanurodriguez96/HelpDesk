---
name: helpdesk-privacy
description: Use when handling user text, tickets, logs or any data that may contain credentials or personal data. Triggers on "PII", "datos personales", "contrasena", "password", "token", "API key", "redact", "sanear", "GDPR", "RGPD", "el usuario ha pegado su contrasena".
---

# Privacidad y datos sensibles

La regla que gobierna todas las demás: **lo saneado es lo único que existe**.
No hay copia del original "por si acaso".

## Qué se enmascara

| Se elimina                                  | Se conserva                        |
| ------------------------------------------- | ---------------------------------- |
| Contraseñas, tokens, claves API, claves privadas | IPs, host internos, puertos     |
| Correo electrónico                          | Nombres de servicio y de sistema   |
| DNI / NIE                                   | Códigos de incidencia (`HD-...`)   |
| Teléfono                                    |                                |
| Tarjeta e IBAN                              |                                |

Las IP y los host internos se conservan **a propósito**: son la evidencia con la
que se diagnostica. Enmascararlas haría el sistema inútil. Eso no son datos
personales en este contexto.

## Las dos señales, y cuándo se calculan

```js
containsSecret(text)      // ¿hay material que eliminar?
offersCredentials(text)   // ¿el usuario DECLARA un valor o PIDE uno?
```

Calcula las dos **sobre el texto original, antes de sanear**. Es el error más
frecuente del proyecto: si las calculas sobre el texto ya redactado, ambas dan
`false` siempre, porque el único rastro de un secreto es precisamente que ya no
está. El aviso de seguridad al usuario desaparecería sin dejar rastro.

## `offersCredentials()` tiene una semántica precisa

Significa **"manipula credenciales de forma que requiere aviso"**, no "menciona
contraseñas". Marca `true` cuando el usuario declara un valor o pide que le
manden uno. No marca `true` un ticket que dice "he olvidado la contraseña": eso
es un síntoma, no una petición.

## Idempotencia

```js
redact(redact(x)) === redact(x)   // los marcadores no se re-marcan
```

`normalizeRedactionMarkers()` se aplica antes y después del escaneo. Si ves dos
marcadores anidados o un hallazgo duplicado, el escaneo se está comiendo su
propia salida.

## Nunca se pide una credencial

`assertSafeQuestion()` lanza si una pregunta pide contraseña, código de doble
factor o sesión. Se usa en dos sitios, y ambos son obligatorios:

- Al construir las preguntas de aclaración.
- En la transición a `waiting_user` (guard `TRANSITION_QUESTION_REJECTED`).

Se puede **mencionar** el problema ("se ha bloqueado por intentos"). No se puede
**pedir** el material.

## Invariante de almacenamiento

`assertPrivacyInvariant(ticket)` comprueba que el ticket no lleva material
sensible en texto plano. Se ejecuta **al escribir y también al leer de disco**:
un fichero corrupto debe delatarlo al cargarse, no al siguiente incidente.

## La auditoría también está sujeta

`audit-log.js` rechaza claves prohibidas (`password`, `token`, `apiKey`,
`cookie`, `session_id` y sus variantes snake_case/camelCase). Un log con
credenciales es una fuga con directorio propio.

## Si aparece material sensible en un ticket ya creado

1. No lo reproduzcas en ninguna respuesta.
2. No lo reenvíes, no lo cites, no lo guardes en otro sitio.
3. Escala como `security_concern`.
4. Avisa al usuario de que debe **rotar** lo expuesto: quitar el texto no
   deshace el hecho de que se compartió.
