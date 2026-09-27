---
description: Trea un ticket existente y muestra a qué agente le toca, con su justificación.
agent: helpdesk-orchestrator
---

Tria el ticket `$1` y explica la decisión.

```bash
node src/cli.js triage --ticket $1
```

Devuelve, en este orden y sin omitir nada:

1. **Categoría y tipología**, con la confianza y las alternativas descartadas.
2. **Severidad y prioridad**, con la explicación. Si no la das, alguien va a
   asumir que te la inventaste.
3. **Destino** (`decision.target`) y la razón del traspaso.
4. **Preguntas pendientes**, si las hay.
5. **SLA**: plazo de respuesta y de resolución, y desde cuándo corre.

Si la decisión es `escalate`, **detente ahí**. No intentes arreglar un ticket que
el sistema ha decidido que necesita una persona: clasificar de más y ejecutarlo es peor que clasificarlo de más y esperar.

Si la decisión es `ask_user`, entrega las preguntas al usuario y espera. No
avances el ticket hasta tener respuesta.
