/**
 * RT-7 en la instancia integrada: el tablero de C cuenta las actas que aplica
 * A (actas/min) y la latencia acta → público que mide B al difundir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppConfig } from '../src/config/AppConfig.js';
import { DifusionModule } from '../src/difusion/DifusionModule.js';
import { Application } from '../src/infra/Application.js';
import { IngestaModule } from '../src/ingesta/IngestaModule.js';
import { ConexionRedis } from '../src/redis/conexion.js';
import type { Config } from '../src/verificacion/config.js';
import { VerificacionModule } from '../src/verificacion/VerificacionModule.js';
import { acta, reiniciar } from './ayudas.js';

const url = process.env.REDIS_URL_PRUEBAS_HTTP ?? 'redis://localhost:6379/14';
let redis: ConexionRedis;
let app: Application;
let base: string;
let verificacion: VerificacionModule;

beforeAll(async () => {
  redis = new ConexionRedis({ url, timeoutMs: 2000, nombre: 'pruebas-metricas' });
  await redis.conectar();
  if (!redis.cliente.isReady) throw new Error('Redis de pruebas HTTP no disponible');
  await reiniciar(redis);

  const config = AppConfig.fromEnv({
    PORT: '0',
    REDIS_URL: url,
    INSTANCE_ID: 'prueba-metricas',
    LOG_LEVEL: 'silent',
    PUBLIC_WINDOW_MS: '100',
    PUBLIC_DEP_WINDOW_MS: '100',
  });
  const c: Config = {
    redisUrl: url,
    instance: 'prueba-metricas',
    port: 0,
    host: '127.0.0.1',
    demo: false,
    credentials: { 'credencial-de-coordinacion-larga': { id: 'coord', name: 'Coord', role: 'coordinator' } },
    allowedOrigins: [],
    keyPrefix: '',
    log: false,
  };
  const ingesta = new IngestaModule('prueba-metricas');
  const difusion = new DifusionModule();
  verificacion = new VerificacionModule(c, ingesta.resolucion, () => difusion.stats(), {
    onActaAccepted: (l) => ingesta.onActaRegistrada(l),
    onPublicLatency: (l) => difusion.onPublishLatency(l),
  });
  app = new Application(config, [ingesta, difusion, verificacion]);
  await app.start();
  const address = app.address;
  if (!address || typeof address === 'string') throw new Error('Sin puerto de pruebas');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await app.stop();
  await redis.cerrar();
});

describe('RT-7 · señales de A y B en el tablero de C', () => {
  it('cuenta las actas aplicadas (no los reenvíos) y mide la latencia acta → público', async () => {
    const abort = new AbortController();
    const sse = await fetch(`${base}/publico/sse?topics=dep`, { signal: abort.signal });
    expect(sse.status).toBe(200);
    const lector = sse.body!.getReader();
    void (async () => {
      try {
        while (!(await lector.read()).done);
      } catch {
        /* cancelado al final de la prueba */
      }
    })();

    const a = acta(4201);
    const enviar = () =>
      fetch(`${base}/actas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) });
    expect((await enviar()).status).toBe(201);
    expect((await enviar()).status).toBe(200); // reenvío: no cuenta

    await expect
      .poll(() => verificacion.metrics.sample().publicLatencyP95Ms, { timeout: 5000, interval: 100 })
      .not.toBeNull();
    const muestra = verificacion.metrics.sample();
    expect(muestra.acceptedActasPerMinute).toBe(1);
    expect(muestra.publicLatencyP95Ms).toBeGreaterThanOrEqual(0);
    abort.abort();
  });
});
