# Generadores · Persona A

## Catálogo

Carga en Redis las mesas, puestos y municipios, y el total de mesas por tópico. Por defecto genera 6.400 mesas y 1.842 puestos.

```bash
npm run redis:up
npm run catalogo --workspace @preconteo/herramientas
```

Variables opcionales: `REDIS_URL`, `MESAS`, `PUESTOS` y `MUNICIPIOS`.

## Jornada simulada

Con el servidor de ingesta activo:

```bash
npm run jornada --workspace @preconteo/herramientas
```

Perfil predeterminado: 6.400 actas en 120 minutos, 55 % durante los primeros 40 minutos, 7 % de reenvíos y 7 % de actas dudosas. Cada reenvío usa el mismo `idem`.

Opciones:

```bash
npm run jornada --workspace @preconteo/herramientas -- --actas 100 --duracion 2 --reenvios 10 --dudosas 8
```

`BASE_URL` selecciona el servidor (por defecto `http://localhost:3000`). El catálogo debe cargarse antes con los mismos valores de `MESAS`, `PUESTOS` y `MUNICIPIOS`.
