---
description: Registra una incidencia de texto libre, la sanea y devuelve ticket, clasificación, prioridad y siguiente paso.
agent: helpdesk-orchestrator
---

Registra esta incidencia en el servicio de soporte interno.

```bash
node src/cli.js intake --text "$ARGUMENTS" --reporter {{reporter}}
```

Sustituye `{{reporter}}` por el identificador corporativo de quien escribe
(necesario; si no lo tienes, **pregunta**, no lo inventes).

Después:

1. Muestra el `id` del ticket. Es lo que se cita a partir de ahora.
2. Muestra la categoría, la severidad y **por qué** esa severidad
   (`decision.priorityExplanation`).
3. Muestra el destino (`decision.target`).
4. Si hay preguntas pendientes, léalas **textuales**. Ninguna puede pedir
   credenciales; si crees que falta un dato, la política de privacidad decide si
   se puede preguntar, no tu criterio.
5. Si el texto traía credenciales, **avisa al usuario de que las ha exponido** y
   de que debe rotarlas.

No ejecutes ninguna remediación todavía: esto es solo el ingreso.
