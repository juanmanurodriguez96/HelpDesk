# Servicio de soporte interno (mesa de ayuda)

Un sistema que recibe una incidencia en texto libre y **actúa** sobre ella con
compuertas: la sanea, la clasifica con criterios explicables, calcula el SLA en
calendario laboral, la reparte al agente especialista, la diagnostica, la
remedia si se puede, y escala a una persona cuando no puede seguir solo. Todo
queda en una bitácora encadenada con SHA-256.

No es un chatbot que contesta. Es un sistema que toca sistemas reales y que por
eso está pensado para poder pararse.

```bash
npm test         # suite completa, sin dependencias que instalar
npm run verify   # validacion del ecosistema + tests
npm run demo     # un ticket de principio a fin, con salida narrada
```

## Requisitos

Node.js `>= 20.11`. Sin dependencias: ni de producción, ni de desarrollo.
`npm install` no es necesario para probar ni para validar.

## Empezar

```bash
node src/cli.js intake --text "No puedo conectarme a la VPN desde casa, AnyConnect da error 403" --reporter E-10482
node src/cli.js list
node src/cli.js diagnose --ticket HD-XXXXXX
node src/cli.js remediate --ticket HD-XXXXXX        # simula; no toca nada
node src/cli.js close --ticket HD-XXXXXX --operator mesa-n2
```

`node src/cli.js --help` lista todos los comandos. Los tickets se guardan en
`data/`, que está en `.gitignore`.

## Cómo está montado

```
incidencia
   |
   v
sanear ......... lo que se guarda es lo saneado; el original no existe
   |
   v
clasificar ..... categoria, confianza y por que; si no llega al minimo, escala
   |
   v
extraer ........ entidades obligatorias de la categoria; si faltan, se preguntan
   |
   v
puntuar ........ severidad por hechos duros, con la explicacion a la vista
   |
   v
SLA ......... fecha de respuesta y de resolucion en calendario laboral
   |
   v
decidir ....... diagnosticar / remediar / preguntar / escalar
```

`src/infra/store.js` persiste, `src/audit/audit-log.js` encadena, y
`src/domain/lifecycle.js` es la máquina de estados por la que pasa todo comando.
Ningún comando escribe `ticket.status` directamente.

### Los siete principios

Están desarrollados en [`AGENTS.md`](AGENTS.md), que es la capa portable de
instrucciones. En corto:

1. **Lo saneado es lo único que existe.** No se guarda copia del original, ni
   en el ticket, ni en la bitácora, ni en un fichero temporal. Se conserva la
   *evidencia* de que hubo que sanear, nunca el material.
2. **Ante la duda, no se ejecuta nada.** Se pregunta o se escala.
3. **La severidad la ponen los hechos, no el tono.** Un "¡URGENTE!" no sube la
   prioridad.
4. **El riesgo se declara antes de actuar.** Cada acción tiene nivel
   (`reversible`, `disruptive`, `destructive`) y una vía de vuelta. Lo
   `destructive` exige confirmación humana, siempre.
5. **Un agente que ya vio el ticket no lo vuelve a ver.** El rastro de traspasos
   corta los ciclos.
6. **Todo queda registrado y todo es comprobable.** Alterar una entrada vieja
   rompe la cadena.
7. **La red está cerrada por defecto.** Los checks en vivo requieren
   autorización.

## La capa de opencode

```
.opencode/agents/     5 agentes: orquestador y cuatro especialistas
.opencode/commands/   6 comandos que ve el usuario
.opencode/skills/     4 procedimientos cargables
opencode.json         configuracion del proyecto
AGENTS.md             instrucciones portables
tools/validate-ecosystem.mjs
tools/probe-endpoints.mjs
```

La skill `helpdesk-diagnosis` consume `tools/probe-endpoints.mjs` como recurso
auxiliar: cruza el ticket con el catálogo y devuelve la lista explícita de
destinos comprobables, sin salir a la red salvo que se le pase
`--allow-network`. El script distingue `2` (funciona pero no puede sondear) de
`3` (el recurso no respondió), y el validador falla si una skill cita un
`tools/*.mjs` que no está en disco.

El **manifiesto** (`src/ecosystem/manifest.js`) es la fuente de verdad de la
topología: qué agentes hay, qué categorías cubre cada uno y en qué condiciones se
traspasa. Los ficheros de `.opencode/agents/` cuentan lo mismo en el formato que
lee opencode. El validador compara ambas capas y falla si divergen, para que un
cambio en el manifiesto no deje los prompts diciendo lo contrario.

Ningún agente tiene `edit`: el código que ejecuta las acciones no se modifica
desde una conversación. La remediación es simulada por defecto; `--apply` exige
autorización, y riesgo `destructive` exige confirmación humana.

Para que opencode vea los agentes, los comandos y las skills, hay que reiniciar
la sesión tras cambiarlos.

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
test/          un fichero por area
tools/         validador del ecosistema
```

## Cuando una instrucción y el código no coincidan

**El código gana y `AGENTS.md` es un bug.** La máquina de estados es la fuente de
verdad; el validador existe para que no se nos olvide actualizarla.
