# Cómo contribuir

## Ramas

- `main` siempre está desplegable. Nadie hace commit directo a `main`.
- Una rama por entrega: `persona-a/…`, `persona-b/…`, `persona-c/…`, o `estructura-…` para lo compartido.
- Se integra por pull request.

## Commits

Mensajes en español, en modo imperativo, con prefijo de tipo:

| Prefijo | Uso |
|---|---|
| `feat:` | Funcionalidad nueva |
| `fix:` | Corrección de un error |
| `test:` | Pruebas |
| `docs:` | Documentación |
| `chore:` | Configuración, dependencias, estructura |
| `refactor:` | Cambio interno sin cambiar el comportamiento |

Ejemplo: `feat(ingesta): aplicar actas con script Lua atómico`.

## Revisión cruzada

Cada pull request lo aprueba **otra persona** antes de integrarlo:

| Autor | Revisa |
|---|---|
| A | C |
| B | A |
| C | B |

Los cambios en [`shared/`](shared/) (el contrato) necesitan la aprobación de **los tres**.

## Antes de abrir un pull request

```bash
npm run typecheck
npm test
```

Ambos deben pasar. Las pruebas que tocan Redis necesitan `npm run redis:up`.

## Plantilla

La plantilla de [`.github/pull_request_template.md`](.github/pull_request_template.md) pide: qué requerimiento cubre, cómo se probó y qué cambia del contrato.
