---
description: Diagnostica un ticket en modo offline por defecto y devuelve causa, cobertura y si el informe autoriza una remediación.
agent: infra-support
---

Diagnostica el ticket `$1` y explica **qué se puede y qué no se puede concluir**.

```bash
node src/cli.js diagnose --ticket $1
```

Red cerrada por defecto. Si la cobertura sale parcial, **no la fuerces**: repórtala
como parcial. Un informe honesto con `insufficient` es un resultado válido, y
forzar la red para "tener más datos" sin autorización es exactamente lo que este
sistema existe para evitar.

Devuelve:

1. **Causa** detectada, con su confianza.
2. **Cobertura** (`x/y` checks ejecutados) y **acuerdo** entre checks.
3. `insufficient`: si es `true`, **no hay acción autorizada**. Di qué datos
   faltan con `missing[]` y escala si no se pueden conseguir.
4. Checks omitidos y por qué (`skipped` + red cerrada).

No ejecutes remediación en este paso. Primero el informe, luego la decisión.
