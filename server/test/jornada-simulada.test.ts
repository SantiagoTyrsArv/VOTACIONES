/**
 * RT-10 · jornada simulada activable sin el grupo: corre en una sola réplica,
 * pasa por la ingesta real y la controla solo coordinación.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claves, topico } from '@votaciones/shared';
import { AppConfig } from '../src/config/AppConfig.js';
import { DifusionModule } from '../src/difusion/DifusionModule.js';
import { Application } from '../src/infra/Application.js';
import { IngestaModule } from '../src/ingesta/IngestaModule.js';
import { ConexionRedis } from '../src/redis/conexion.js';
import type { Config } from '../src/verificacion/config.js';
import { VerificacionModule } from '../src/verificacion/VerificacionModule.js';

const url = process.env.REDIS_URL_PRUEBAS_HTTP ?? 'redis://localhost:6379/14';
const COORD = 'credencial-de-coordinacion-larga';
const ANA = 'credencial-de-auditora-ana-larga';
let redis: ConexionRedis;
let app: Application;
let base: string;
let ingesta: IngestaModule;

beforeAll(async () => {
  redis = new ConexionRedis({ url, timeoutMs: 2000, nombre: 'pruebas-jornada' });
  await redis.conectar();
  if (!redis.cliente.isReady) throw new Error('Redis de pruebas HTTP no disponible');
  await redis.comando(['FLUSHDB']);
  const c: Config = {
    redisUrl: url,
    instance: 'prueba-jornada',
    port: 0,
    host: '127.0.0.1',
    demo: false,
    credentials: {
      [COORD]: { id: 'coord', name: 'Coord', role: 'coordinator' },
      [ANA]: { id: 'ana', name: 'Ana', role: 'auditor' },
    },
    allowedOrigins: [],
    keyPrefix: '',
    log: false,
  };
  ingesta = new IngestaModule('prueba-jornada');
  const difusion = new DifusionModule();
  app = new Application(
    AppConfig.fromEnv({ PORT: '0', REDIS_URL: url, INSTANCE_ID: 'prueba-jornada', LOG_LEVEL: 'silent' }),
    [ingesta, difusion, new VerificacionModule(c, ingesta.resolucion, () => difusion.stats(), { simulation: ingesta.jornada })],
  );
  await app.start();
  const address = app.address;
  if (!address || typeof address === 'string') throw new Error('Sin puerto de pruebas');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await app.stop();
  await redis.cerrar();
});

const api = (token: string, cuerpo?: unknown) =>
  fetch(`${base}/api/demo/jornada`, {
    method: cuerpo ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(cuerpo ? { 'content-type': 'application/json' } : {}) },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });

describe('RT-10 · jornada simulada', () => {
  it('solo coordinación la consulta o la inicia', async () => {
    expect((await api(ANA)).status).toBe(403);
    expect((await api(ANA, { accion: 'iniciar', aceleracion: 60 })).status).toBe(403);
    expect(await (await api(COORD)).json()).toEqual({ estado: 'inactiva' });
    expect((await api(COORD, { accion: 'iniciar', aceleracion: 0 })).status).toBe(400);
  });

  it('carga el catálogo, transmite por la ingesta real y no admite dos a la vez', async () => {
    const inicio = await ingesta.jornada.iniciar({ aceleracion: 60, reiniciar: true, actas: 80, duracionMin: 2 });
    expect(inicio).toMatchObject({ ok: true, resumen: { actas: 80 } });
    // Una segunda (desde cualquier réplica) se rechaza mientras el candado esté tomado.
    const segunda = await api(COORD, { accion: 'iniciar', aceleracion: 60 });
    expect(segunda.status).toBe(409);
    expect(await segunda.json()).toMatchObject({ ok: false, motivo: 'EN_CURSO' });

    await expect
      .poll(async () => ((await (await api(COORD)).json()) as { estado: string }).estado, { timeout: 15_000, interval: 250 })
      .toBe('terminada');
    const estado = (await (await api(COORD)).json()) as { enviadas: number; solicitudes: number; porEstado: Record<string, number> };
    expect(estado.enviadas).toBe(estado.solicitudes);
    expect(estado.porEstado.NO_REGISTRADA ?? 0).toBe(0);
    expect(estado.porEstado.RECHAZADA ?? 0).toBe(0);

    expect(await redis.comando(['HGET', claves.catMesa(6400), 'puesto'])).not.toBeNull();
    const dep = await redis.comando<string[]>(['HMGET', claves.tot(topico.dep()), 'mesas_inf', 'mesas_tot']);
    expect(Number(dep[0])).toBeGreaterThan(60);
    expect(Number(dep[1])).toBe(6400);
    expect(await redis.comando(['EXISTS', claves.jornadaCandado()])).toBe(0);
  });

  it('detener corta una jornada en curso', async () => {
    await ingesta.jornada.iniciar({ aceleracion: 1, reiniciar: false, actas: 50, duracionMin: 60 });
    expect(await (await api(COORD, { accion: 'detener' })).json()).toEqual({ ok: true });
    await expect
      .poll(async () => ((await (await api(COORD)).json()) as { estado: string }).estado, { timeout: 8000, interval: 250 })
      .toBe('detenida');
  });
});

describe('RT-10 · repetir la jornada', () => {
  it('sin borrar, la misma jornada vuelve YA_REGISTRADA (no crea conflictos)', async () => {
    const esperar = async () =>
      expect
        .poll(async () => ((await (await api(COORD)).json()) as { estado: string }).estado, { timeout: 15_000, interval: 250 })
        .toBe('terminada');
    await ingesta.jornada.iniciar({ aceleracion: 60, reiniciar: true, actas: 40, duracionMin: 1 });
    await esperar();
    await ingesta.jornada.iniciar({ aceleracion: 60, reiniciar: false, actas: 40, duracionMin: 1 });
    await esperar();
    const { porEstado } = (await (await api(COORD)).json()) as { porEstado: Record<string, number> };
    expect(Object.keys(porEstado).filter((k) => k !== 'YA_REGISTRADA' && k !== 'VERSION_OBSOLETA')).toEqual([]);
  });
});
