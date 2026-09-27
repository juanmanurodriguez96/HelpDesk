---
description: Cierra un ticket ya resuelto, o explica por qué no se puede cerrar todavía.
agent: helpdesk-orchestrator
---

Cierra el ticket `$1` como `$2` (el identificador de la persona operatora).

```bash
node src/cli.js close --ticket $1 --operator $2
```

## Si no se puede cerrar

`TransitionError` con el código de motivo dice exactamente qué falta:

| Motivo                                | Qué hacer                                      |
| ------------------------------------- | ---------------------------------------------- |
| `TRANSITION_ACTOR_NOT_ALLOWED`        | No eres `operator`. Un agente **no cierra**.    |
| `TRANSITION_MISSING_FIELD:resolution` | Falta la resolución. No la inventes.           |
| `TRANSITION_SLA_NOT_STOPPED`          | Marca primero la resolución.                    |
| `TRANSITION_OPEN_QUESTIONS`           | Hay preguntas sin respuesta.                    |
| `TRANSITION_NOT_ACKNOWLEDGED`         | El escalado no lo ha aceptado ninguna persona.  |

No sortees la compuerta: cada una existe por un motivo concreto. Si el estado
real del ticket es distinto de lo que te piden, corrige el ticket, no la regla.

## Antes de cerrar, comprueba

- Que hay una resolución escrita y **verificada**, no una suposición.
- Que el usuario ha sido informado. `resolved` no es "creo que se arregló".
- Que no queda ninguna acción pendiente disfrazada de nota.

## Al cerrar

1. Confirma el cierre con el `id` del ticket.
2. Escribe el mensaje de cierre en el idioma del ticket, diciendo **qué se hizo**
   y **qué tiene que hacer el usuario**, si algo.
3. No pidas credenciales. Nunca. Ni para confirmar que el problema está resuelto.
