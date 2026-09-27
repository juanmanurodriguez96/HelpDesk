# AGENTS.md — Instrucciones personalizadas del servicio de soporte

Este fichero es la capa **portable** de las instrucciones. Es el mismo
contenido que opencode carga desde `opencode.json`, y el mismo que un
colaborador leería en una pizarra: qué es este sistema, cómo se trabaja y qué
no se hace nunca.

Los ficheros de `.opencode/` son la capa **ejecutable** (agentes, comandos,
skills). Esta es la capa que explica el porqué. Las dos se validan entre sí con
`npm run validate`: si divergen, el validador falla.

---

## Qué es esto

Un servicio de soporte interno (mesa de ayuda) que:

1. recibe la incidencia en texto libre,
2. la **sanéa** antes de guardarla,
3. la **clasifica** con criterios explicables,
4. calcula **SLA** en calendario laboral,
5. **reparte** el caso al agente especialista,
6. **diagnostica** y **remedia** con compuertas,
7. **escala** a una persona cuando no puede seguir solo,
8. deja **bitácora auditable** de todo.

No es un chatbot que contesta. Es un sistema que **actúa sobre sistemas
reales**, y por eso todo lo que hace está pensado para poder pararse.

---

## Los siete principios

Estos no son sugerencias. Si una regla concreta parece contradecerse con uno de
ellos, gana el principio.

### 1. Lo saneado es lo único que existe

No se guarda copia del texto original. Ni en el ticket, ni en la bitácora, ni en
un fichero temporal. Se conserva la **evidencia** de que hubo que sanear (un
recuento de hallazgos), nunca el material.

La consecuencia incómoda: una credencial que el usuario pegó **no está** en el
sistema, y por eso el aviso de seguridad tiene que calcularse **antes** de sanear.
Calcularlo después da `false` siempre, y el usuario se queda sin avisar.

### 2. Ante la duda, no se ejecuta nada

Se pregunta o se escala. Nunca se toca producción con una clasificación dudosa,
un diagnóstico insuficiente o un dato que falta. El coste de preguntar es un
mensaje; el coste de actuar mal es el trabajo de alguien.

### 3. La severidad la ponen los hechos, no el tono

S1 es para impacto confirmado de toda la empresa. Un mensaje en mayúsculas, un
"¡URGENTE!" o un usuario molesto no suben la prioridad. Los factores duros
suman; los atenuantes, como mucho, uno, y nunca borran lo que ya subió.

### 4. El riesgo se declara antes de actuar

Cada acción tiene un nivel (`reversible`, `disruptive`, `destructive`) y una vía
de vuelta. Lo `destructive` exige confirmación humana **siempre**, no cuando
resulte conveniente. Y el resultado de una acción incluye **cómo se deshace**,
aunque sea a mano.

### 5. Un agente que ya vio el ticket no lo vuelve a ver

El rastro de traspasos corta los ciclos. Es lo que garantiza que un ticket no
rebote entre dos agentes indefinidamente, y lo que distingue un flujo de un
ping-pong.

### 6. Todo queda registrado y todo es comprobable

La bitácora es JSONL encadenada con SHA-256: alterar una entrada vieja rompe la
cadena. Las decisiones se explican con los términos que las dispararon. Un
sistema que actúa sobre producción sin explicación de por qué es una caja negra
con permisos de escritura.

### 7. La red está cerrada por defecto

Los checks en vivo requieren autorización explícita. Un diagnóstico parcial y
honesto (`insufficient`, con la lista de lo que falta) es más útil que un
`fail` inventado con la red forzada.

---

## Cómo se trabaja

### El orden no se negocia

```
entrada -> sanear -> clasificar -> extraer -> puntuar -> SLA -> decidir
                                                                  |
                                        +-------------------------+-------------------+
                                        |                                             |
                              preguntar al usuario                        diagnosticar
                                        |                                             |
                                   waiting_user                                    v
                                        |                                  diagnostico conclusivo?
                                        |                                    /            \
                                   respuesta                          si                  no
                                        |                              /                    \
                                        +-----------------> remediar <--+                escalar
                                                                   |                          |
                                                              revisar / cerrar          mesa humana
```

`canTransition()` dice qué transiciones existen desde el estado actual. Si la que
quieres no está, se cambia **el estado del ticket**, no la regla: un comando no
salta la máquina, la máquina se mueve.

Añadir una transición sí es legítimo, pero no es un atajo. Pasa por la tabla, con
su `requires`, su `guard` y su test, y se documenta aquí. La transición
`triaged -> waiting_user` existe por eso: sin ella, preguntar al usuario obligaba
a abrir el caso "en trabajo" solo para poder preguntar, o a avanzarlo con un dato
inventado.

### Al entrar una incidencia

```js
const { ticket, decision, nextQuestions } = intakeAndTriage({ text, reporter, channel, lang, now });
```

De ahí salen: categoría y confianza, severidad y **su explicación**, destino,
preguntas pendientes y SLA. Nada de eso es una etiqueta suelta: es una decisión
con su porqué, y el porqué es lo que permite auditarla.

### Al diagnosticar

```js
const report = await diagnose({ ticket, allowNetwork: false });
```

Léelo antes de actuar. `summary.coverage` y `summary.agreement` dicen cuánto se
pudo saber; `insufficient` dice que no se puede actuar. Un informe `insufficient`
no es un fallo: es la respuesta correcta cuando no hay datos suficientes.

### Al remediar

```js
await remediate({ ticket, playbookId, diagnosis, adapter, dryRun: true });
```

**Simula por defecto.** Una simulación no llama al adaptador: no toca nada. Para
aplicar de verdad hacen falta autorización, un adaptador conectado y, si el
riesgo lo pide, confirmación humana.

---

## Lo que nunca se hace

Estas siete frases no son matices. Son límites duros, y están en el código
además de estar aquí:

1. **Pedir credenciales.** Ni contraseñas, ni códigos de doble factor, ni
   cookies, "por seguridad" ni "es rápido". `assertSafeQuestion()` lo bloquea, y
   el bloqueo está en la transición de estado, no solo en el prompt.

2. **Guardar lo saneado de nuevo como si fuera original.** La redacción es
   idempotente; si ves hallazgos duplicados, el escaneo se está comiendo su
   propia salida.

3. **Actuar sobre una clasificación dudosa.** Confianza por debajo del mínimo
   accionable escala. Punto.

4. **Forzar la red para "tener más datos".** Sin autorización no se abre, y sin
   cobertura completa el informe no autoriza la remediación.

5. **Marcar algo como resuelto sin verificarlo.** Y cerrar, solo un `operator`.

6. **Devolver el ticket a un agente que ya lo tuvo.** El rastro lo impide.

7. **Modificar el código que ejecuta las acciones.** Ningún agente tiene `edit`.

---

## Dónde está cada frontera

Una compuerta que no sabes dónde vive es una compuerta que nadie aplica. Estas son
las suyas, y ninguna se deduce del código: se comprueban o se documentan.

| Frontera | Dónde vive | Qué la hace efectiva |
|---|---|---|
| El texto saneado es el único que existe | `privacy/pii.js`, `domain/ticket.js` | `assertPrivacyInvariant()` al crear, al transicionar y **al leer de disco** |
| No se actúa con clasificación dudosa | `domain/lifecycle.js` | guard de `new -> triaged`: categoría real y confianza `>= 0.4` |
| Nadie pide credenciales | `privacy/pii.js` | `assertSafeQuestion()` en el guard de `* -> waiting_user` |
| La red está cerrada | `diagnostics/engine.js` | `allowNetwork` explícito; sin ella el informe sale `insufficient` |
| El recurso auxiliar existe | `tools/validate-ecosystem.mjs` | el validador comprueba que todo `tools/*.mjs` citado en un `SKILL.md` esté en disco |
| Un recurso que no responde no se disfraza de avería | `tools/probe-endpoints.mjs` | código `3` (`UNAVAILABLE`) frente a `2` (`BLOCKED`); el `fail` solo lo emite un check que ha corrido |
| No se remedia sin diagnóstico | `remediation/executor.js` | compuerta `DIAGNOSIS_NOT_CONCLUSIVE` |
| Lo `destructive` exige humano | `remediation/executor.js` | `playbook.risk === "destructive"` sin `confirmed`; el ejecutor no lo salta |
| Un agente no vuelve a ver el ticket | `ecosystem/router.js` | `handoffs.trail` y `MAX_HANDOFFS` |
| Un agente no cierra | `domain/lifecycle.js` + `.opencode/agents/*.md` | actor `operator` en la transición **y** `close`/`cancel`/`accept` denegados en `bash` |

Sobre las dos últimas filas, porque confundirlas es el error caro: un recurso
auxiliar que no responde **no es una avería del sistema**. Por eso
`probe-endpoints.mjs` distingue `2` (funciona, pero no puede sondear) de `3` (el
recurso no respondió), y un `fail` solo lo puede emitir un check que se ha
ejecutado de verdad.

Sobre la fila del cierre, porque es la que más se confunde: `--operator` en la CLI
**no es un control de seguridad**, es una declaración. La CLI no sabe quién la
escribe. Lo que autoriza el cierre es el permiso de `bash` del agente que la
invoca, y ahí esos tres comandos están denegados para todos. El validador lo
comprueba: si alguien le da `close` a un agente, `npm run validate` falla.

## Comandos de la CLI

Los permisos de cada agente apuntan a comandos concretos, y el validador
comprueba que esos comandos **existan**. Un permiso sobre un comando inexistente
no da error: el agente simplemente no puede trabajar y no dice por qué.

---

## Idioma y tono

El ticket trae `lang` (`es` | `en`) y **todo** lo que ve el usuario va en ese
idioma. Al usuario se le dice qué se ha hecho, qué tiene que hacer, qué se ha
hecho para protegerle y cuándo se espera respuesta. En ese orden, y sin pedir
nunca nada que sea una credencial.

El detalle está en [`.opencode/instructions/estilo.md`](.opencode/instructions/estilo.md).

---

## Comandos

```bash
npm test         # suite completa, sin dependencias que instalar
npm run validate # coherencia del ecosistema (manifiesto <-> ficheros .md)
npm run verify   # las dos cosas
npm run demo     # un ticket de principio a fin, con salida narrada
node src/cli.js --help
```

## Estructura

```
src/
  core/        errores, ids, reloj, json canonico, texto
  privacy/     redaccion e invariante de privacidad
  knowledge/   taxonomia de categorias y catalogo de sistemas
  domain/      ticket, ciclo de vida, SLA
  audit/       bitacora encadenada
  triage/      clasificador, entidades, prioridad, orquestador
  diagnostics/ checks, motor, sondas de red
  remediation/ playbooks, ejecutor con compuertas
  escalation/  motivos, severidad, aceptacion
  ecosystem/   manifiesto de agentes, reparto, traspasos
  responses/   mensajes al usuario, bilingues
  infra/       almacenamiento en disco
  cli.js       interfaz de linea de comandos
.opencode/
  agents/      un fichero por agente (frontmatter + prompt)
  commands/    comandos que ve el usuario
  skills/      procedimientos cargables
tools/
  validate-ecosystem.mjs
```

## Regla de oro

Cuando una instrucción de este documento y una regla del código no coincidan,
**el código gana y este documento es un bug**. La máquina de estados es la
fuente de verdad; el validador existe para que no se nos olvide actualizarla.
