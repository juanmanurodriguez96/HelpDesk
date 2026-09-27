---
description: Simula una remediación y muestra el plan, la guía al usuario y cómo se deshace. No ejecuta nada salvo que se pida explícitamente.
agent: infra-support
---

Prepara la remediación del ticket `$1`.

```bash
node src/cli.js remediate --ticket $1 --playbook {{playbook}} --dry-run
```

Primero **simula**. La simulación no toca nada: construye el plan y te dice si
las compuertas dejarían pasar la acción.

Devuelve, sin saltarte nada:

1. **Estado**: `planned`, `blocked`, `unavailable` o `failed`.
2. **Si está `blocked`**: los motivos, y de cada uno **quién** puede
   desbloquearlo (`resolvableBy`).
3. **La guía para el usuario** (`guidance`), en el idioma del ticket. Léela antes
   de enviarla: comprueba que no pide ninguna credencial.
4. **Cómo se deshace** (`rollback`). Si está vacío, esa acción no se puede
   revertir y eso cambia la conversación con el usuario.
5. **Riesgo** de la acción: `reversible`, `disruptive` o `destructive`.

## Antes de ejecutar de verdad

No pases `--dry-run` a `false` sin las tres cosas:

- **Autorización explícita** de quien puede autorizarla.
- **Un adaptador conectado** (si no hay, el estado es `unavailable` y no hay nada
  que autorizar).
- **Confirmación humana** si el riesgo es `destructive`, o si es `disruptive` y
  la confianza de la causa no llega al umbral.

Si el adaptador falla, el estado es `failed` y se conserva el error. **Nunca lo
representes como un éxito parcial.**
