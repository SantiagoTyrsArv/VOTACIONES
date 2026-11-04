# Generadores · Persona A

## Catálogo

Carga en Redis las mesas, puestos y municipios, el total de mesas por tópico y la asignación jurado → mesa (`jur:JUR-{mesa}:mesas`, un jurado por mesa). Por defecto genera 6.400 mesas y 1.842 puestos.

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

Usa el mismo plan que el botón **Jornada simulada** de la consola de coordinación (`planJornada` en `shared/src/jornada.ts`, con semilla fija). El perfil predeterminado es:

- 6.400 actas en 120 minutos, el 55 % durante los primeros 40;
- tres ráfagas de ~300 actas/min;
- 7 % de reenvíos (cada uno con el mismo `idem`);
- ~180 correcciones (versión 2);
- 7 % de actas dudosas.

`--acelerar 60` comprime las 2 horas en 2 minutos.

**Sin terminal (RT-10):** en la consola, la cuenta de coordinación tiene el panel *Plataforma → Jornada simulada*. Ese panel ejecuta el plan dentro de una sola réplica (candado en Redis) con la ingesta real y carga el catálogo si falta. Repetirla sin borrar reenvía las mismas actas, que vuelven `YA_REGISTRADA`.

Opciones:

```bash
npm run jornada --workspace @preconteo/herramientas -- --actas 100 --duracion 2 --reenvios 10 --dudosas 8 --acelerar 10
```

`BASE_URL` selecciona el servidor (por defecto `http://localhost:3000`). El catálogo debe cargarse antes con los mismos valores de `MESAS`, `PUESTOS` y `MUNICIPIOS`.

Si las instancias tienen `JURADO_SECRETO`, defina la misma variable al correr la jornada: el simulador firma la credencial de cada jurado.

## Credenciales de jurados

```bash
JURADO_SECRETO=… npm run credenciales --workspace @preconteo/herramientas -- --desde 1 --hasta 50 --horas 24
```

Imprime `jurado,mesa,credencial,enlace`. El enlace abre la PWA con la credencial ya cargada; la PWA la quita de la barra de direcciones y la guarda con cada acta de la cola. `BASE_URL` define el servidor del enlace.

