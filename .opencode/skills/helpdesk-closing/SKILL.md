---
name: helpdesk-closing
description: Use when resolving, closing, cancelling or reopening a helpdesk ticket, and when writing the message to the user. Triggers on "cerrar ticket", "close", "resolver", "resolve", "cancelar", "reabrir", "reopen", "redactar respuesta al usuario", "confirmar con el usuario".
---

# Cierre de tickets y respuesta al usuario

## Dos pasos distintos que se confunden

| Estado     | Qué significa                          | Quién lo hace            |
| ---------- | -------------------------------------- | ------------------------- |
| `resolved` | El problema está resuelto y documentado | Cualquier agente        |
| `closed`   | El usuario lo ha aceptado              | **Solo un `operator`**    |

Un ticket `resolved` con el SLA detenido y la resolución escrita. Un ticket
`closed` es el final del ciclo de vida. Un agente que cierra un ticket está
quitando al usuario la posibilidad de decir "esto no se arregló".

## Compuertas para resolver

`resolvabilityErrors()` bloquea `resolved` si:

- Faltan entidades obligatorias de la categoría.
- Hay `pendingQuestions` sin responder.
- El ticket está escalado y nadie ha aceptado el escalado.

La tercera es la que se olvida: mientras `ticket.escalation.acknowledgedBy` sea
`null`, el ticket no se puede cerrar por mucho que se sepa la respuesta.

## Cerrar

`RESOLVED -> CLOSED` exige:

- `actor === "operator"`. Un agente recibe `TRANSITION_ACTOR_NOT_ALLOWED`.
- `closure` informado.
- `sla.resolvedAt` existente: primero se marca la resolución, luego se cierra.
- Cero preguntas pendientes.

## Cancelar

Solo manual y **siempre con motivo**. Un ticket cancelado sin explicación es un
ticket perdido: nadie sabe si se resolvió, se descartó o se olvidó. Si lo que
pasa es que no es asunto de soporte interno, ese motivo es
`out_of_scope` y es una respuesta válida.

## Reabrir

`RESOLVED -> IN_PROGRESS` exige `reopenReason` y ninguna pregunta pendiente. El
SLA vuelve a correr. Y ojo con el rastro: si el ticket vuelve a un agente que ya
lo tuvo, el traspaso se rechaza. Eso no es un obstáculo, es una señal de que el
enfoque tiene que cambiar.

## Cómo se escribe la respuesta al usuario

Cinco cosas, siempre, en este orden:

1. **Qué se ha hecho** — en pasado, en concreto. "He desbloqueado tu cuenta",
   no "se ha tramitado la solicitud".
2. **Qué tiene que hacer el usuario**, si algo. Pasos numerados.
3. **Qué se ha hecho para protegerle**, si el caso lo requería (rotar
   credenciales expuestas, avisar de lo detectado).
4. **Cuándo se espera respuesta**, o que no hace falta ninguna.
5. **Referencia del ticket**, para que pueda citarlo.

Y lo que **no** se hace:

- No se piden credenciales. Jamás. `assertSafeQuestion()` lo impide.
- No se culpa al usuario.
- No se promete un plazo que el SLA no contemplate.
- No se mencionan datos internos de otros usuarios ni de otros tickets.
- No se declara resuelto nada que no se haya verificado.

## Idioma

El ticket trae `lang` (`es` | `en`) y las plantillas son bilingües. Responde en
el idioma del ticket, no en el tuyo. Si el usuario escribe en español, todo lo
que ve, incluidos los mensajes de error, va en español.
