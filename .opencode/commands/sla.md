---
description: Comprueba el SLA de un ticket y responde si está en riesgo o incumplido.
agent: helpdesk-orchestrator
---

Estado del SLA del ticket `$1`.

```bash
node src/cli.js sla --ticket $1
```

Devuelve:

1. **Severidad** y los plazos asociados (primera respuesta y resolución).
2. **Tiempo consumido** en minutos **laborables**, no en minutos de reloj: el
   calendario laboral está descontando noches, fines de semana y festivos.
3. **Estado**: `on_track` | `at_risk` | `breached`.
4. Si está en riesgo o incumplido, **quién tiene el ticket ahora** y qué puede
   hacer al respecto.

## Al leerlo

- El SLA se **pausa** mientras el ticket está en `waiting_user` o `escalated` sin
  que nadie lo haya aceptado. No es un olvido: contar como incumplimiento el
  tiempo que el sistema estuvo esperando una respuesta suya sería falso.
- Cuando un ticket llega a `escalated`, la ventana de aceptación es corta. Si se
  pasa (`ackDueBy`), dilo con nombre y apellidos: un escalado que nadie acepta
  durante horas es un ticket olvidado, y no se detecta solo.
- `resolved` detiene el reloj; `closed` lo confirma.
