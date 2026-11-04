# PWA del jurado · Persona A

Aplicación de transmisión con cola offline. El acta permanece en IndexedDB hasta recibir una respuesta final del servidor; los reintentos conservan exactamente el mismo `idem`.

## Ejecutar

Desde la raíz del repositorio:

```bash
npm run redis:up
npm run catalogo --workspace @preconteo/herramientas
npm run dev --workspace @preconteo/server
```

En otra terminal:

```bash
npm run dev
```

Vite abre la PWA y redirige `/actas` y `/ws/jurados` al servidor del puerto 3000.

## Comportamiento verificable

- WebSocket como canal principal y `POST /actas` como respaldo.
- Reintentos con espera exponencial y jitter; conservación tras recargas.
- Validación de formato antes de guardar.
- Recibo visible para respuestas definitivas.
- Service Worker y manifiesto para instalación y apertura sin red.
- Controles móviles de al menos 44 px y diseño adaptable.

## Pruebas

```bash
npm test --workspace @preconteo/jurado
npx playwright install chromium
npm run test:e2e
```

Las pruebas de navegador arrancan y detienen automáticamente el servidor y Vite. Comprueban un envío con recibo, el ciclo offline → IndexedDB → reconexión → transmisión y la conservación del envío tras recargar sin red.
