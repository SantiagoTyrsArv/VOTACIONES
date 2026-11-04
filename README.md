# Votaciones

Parte C: revisión de actas, presencia del equipo y plataforma. Rama `feature/persona-c`.

Para levantar la demostración necesitas Docker Desktop con contenedores Linux:

```sh
docker compose up -d --build
docker compose run --rm seed
```

Abre [localhost:8080](http://localhost:8080). Entra como Ana en una pestaña y como Luis en otra para probar la toma exclusiva. Coordinación tiene acceso al equipo y al tablero. Los ejemplos se guardan separados de los datos reales.

Para comprobar el código con Node.js 22 y Redis de pruebas en el puerto 6380:

```sh
npm ci
docker run -d --name votaciones-c-redis-tests -p 127.0.0.1:6380:6379 redis:7.4-alpine
npm run check
npm run validate:deploy
npm run smoke
npm run test:browser
```

La prueba de navegador utiliza Chrome instalado. `npm run check` comprueba tipos, compila y ejecuta las pruebas contra Redis real, incluida una espera de 30 segundos.

Las resoluciones todavía responden `PENDING_A`: no se cambian votos ni se confirma una aprobación sin el módulo de A. También falta medir la difusión pública de B y ejecutar la carga electoral completa de 20.000 conexiones.

Los contratos están en [docs/contratos.txt](docs/contratos.txt), los comandos de plataforma en [docs/plataforma.txt](docs/plataforma.txt), los resultados en [docs/pruebas.txt](docs/pruebas.txt) y la carga en [carga/uso.txt](carga/uso.txt). Las capturas y las mediciones se conservan en `docs/evidence/`.

No se fusionan las ramas del grupo automáticamente. La integración se revisa entre A, B y C antes de pasar a main.

B publicó su parte durante este desarrollo. La revisión de compatibilidad y los pasos pendientes están en [docs/integracion.txt](docs/integracion.txt).
