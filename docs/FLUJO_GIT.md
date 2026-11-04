# Flujo de trabajo con Git

Regla de oro: **nadie hace commit directo en `main`**. Cada persona trabaja en su rama y entra a `main`
por Pull Request (PR) aprobado por otra persona (A revisa a B, B revisa a C, C revisa a A).

## Ramas

| Rama | Dueño | Contenido |
|---|---|---|
| `main` | todos (solo por PR) | Lo que está desplegado en Azure Container Apps |
| `chore/contrato-esqueleto` | los tres | `shared/` + esqueleto de `server/`. Se fusiona primero |
| `feature/a-ingesta` | Santiago (A) | `server/src/ingesta/`, `jurado/`, scripts Lua |
| `feature/b-difusion-publica` | David (B) | `server/src/difusion/`, `publico/`, `carga/publico/` |
| `feature/c-verificacion-plataforma` | Camila (C) | `server/src/verificacion/`, `consola/`, despliegue, k6 |

## Configuración inicial (una sola vez por persona)

```bash
git clone https://github.com/SantiagoTyrsArv/VOTACIONES.git
cd VOTACIONES
git config user.name "Nombre Apellido"
git config user.email "correo-de-github@ejemplo.com"   # el mismo de GitHub para que el commit cuente
```

## Día a día

```bash
git switch main
git pull                                   # traer lo último
git switch feature/b-difusion-publica      # tu rama
git merge main                             # ponerla al día (resolver conflictos si aparecen)

# ... programar ...
git add server/src/difusion                # agregar SOLO tus archivos
git commit -m "feat(difusion): fan-out por lotes cediendo el Event Loop"
git push                                   # la primera vez: git push -u origin feature/b-difusion-publica
```

Luego en GitHub: **Compare & pull request** → base `main` ← tu rama → asignar revisor.

## Mensajes de commit

Formato `tipo(área): descripción en español`:

- `feat` funcionalidad nueva · `fix` corrección · `test` pruebas · `docs` documentación · `chore` configuración
- Áreas: `shared`, `ingesta`, `difusion`, `verificacion`, `publico`, `jurado`, `consola`, `carga`, `infra`

## Archivos compartidos (donde puede haber conflictos)

- `server/src/main.ts`: cada uno agrega **una línea** con su módulo.
- `package.json` raíz: cada uno agrega su carpeta a `workspaces`.
- `shared/`: solo se cambia con acuerdo de los tres (es el contrato).

Si al hacer `git merge main` aparece un conflicto en esos archivos, normalmente la solución es
**conservar las dos líneas** (la tuya y la del compañero).
