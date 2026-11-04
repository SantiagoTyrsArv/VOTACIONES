/**
 * Ingesta con credenciales activas (JURADO_SECRETO): el jurado sale de la
 * credencial firmada, no del cuerpo del acta.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SUBPROTOCOLO_JURADOS, claves } from '@votaciones/shared';
import { emitirCredencial } from '@votaciones/shared/credencial';
import { AppConfig } from '../src/config/AppConfig.js';
import { Application } from '../src/infra/Application.js';
import { IngestaModule } from '../src/ingesta/IngestaModule.js';
import { ConexionRedis } from '../src/redis/conexion.js';
import { acta, reiniciar } from './ayudas.js';

const SECRETO = 'secreto-de-pruebas-con-32-caracteres!';
const vence = () => Math.floor(Date.now() / 1000) + 3600;
const credencial = (jurado: string) => emitirCredencial(SECRETO, jurado, vence());

let redis: ConexionRedis;
let app: Application;
let base: string;

beforeAll(async () => {
  const url = process.env.REDIS_URL_PRUEBAS_HTTP ?? 'redis://localhost:6379/14';
  redis = new ConexionRedis({ url, timeoutMs: 2000, nombre: 'pruebas-auth' });
  await redis.conectar();
  if (!redis.cliente.isReady) throw new Error('Redis de pruebas HTTP no disponible');
  app = new Application(
    AppConfig.fromEnv({
      PORT: '0',
      REDIS_URL: url,
      INSTANCE_ID: 'prueba-auth',
      LOG_LEVEL: 'silent',
      LIMITE_ACTAS_POR_MINUTO: '3',
      JURADO_SECRETO: SECRETO,
    }),
    [new IngestaModule('prueba-auth')],
  );
  await app.start();
  const address = app.address;
  if (!address || typeof address === 'string') throw new Error('Sin puerto de pruebas');
  base = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await reiniciar(redis);
  // JUR-88134 (el de las actas de prueba) tiene asignadas las mesas 4201 y 4202.
  await redis.comando(['SADD', claves.mesasJurado('JUR-88134'), '4201', '4202']);
  await redis.comando(['SADD', claves.mesasJurado('JUR-99999'), '4301']);
});
afterAll(async () => {
  await app.stop();
  await redis.cerrar();
});

const post = (cuerpo: unknown, token?: string) =>
  fetch(`${base}/actas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(cuerpo),
  });

describe('POST /actas con credenciales', () => {
  it('sin credencial o con una inválida responde 401 y no registra', async () => {
    const a = acta(4201);
    const sin = await post(a);
    expect(sin.status).toBe(401);
    expect(await sin.json()).toMatchObject({ estado: 'RECHAZADA', motivo: 'NO_AUTORIZADO' });
    expect((await post(a, `${credencial('JUR-88134')}x`)).status).toBe(401);
    expect(await redis.comando(['EXISTS', claves.acta(a.acta)])).toBe(0);
  });

  it('con credencial válida y mesa asignada registra', async () => {
    expect((await post(acta(4201), credencial('JUR-88134'))).status).toBe(201);
  });

  it('la credencial de otro jurado no sirve para un acta ajena', async () => {
    const r = await post(acta(4201), credencial('JUR-99999'));
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ motivo: 'NO_AUTORIZADO' });
  });

  it('un jurado no puede transmitir una mesa que no tiene asignada', async () => {
    const r = await post(acta(4301), credencial('JUR-88134'));
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ motivo: 'MESA_NO_ASIGNADA' });
  });

  it('el límite de tasa cuenta por credencial verificada', async () => {
    const token = credencial('JUR-88134');
    const estados: number[] = [];
    for (let i = 0; i < 4; i++) estados.push((await post(acta(4201, { version: i + 1 }), token)).status);
    expect(estados.slice(0, 3)).toEqual([201, 201, 201]);
    expect(estados[3]).toBe(429);
  });
});

describe('WS /ws/jurados con credenciales', () => {
  const abrir = (credencialWs?: string, consulta = '') =>
    new Promise<WebSocket>((resolve, reject) => {
      const protocolos = credencialWs ? [SUBPROTOCOLO_JURADOS, credencialWs] : [SUBPROTOCOLO_JURADOS];
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/jurados${consulta}`, protocolos);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });

  it('rechaza el upgrade sin credencial válida', async () => {
    await expect(abrir()).rejects.toThrow(/401/);
    await expect(abrir('v1.JUR-1.1.x')).rejects.toThrow(/401/);
    // En la URL ya no se acepta (quedaría en logs de proxies).
    const enUrl = `?credencial=${encodeURIComponent(credencial('JUR-88134'))}`;
    await expect(abrir(undefined, enUrl)).rejects.toThrow(/401/);
  });

  it('con credencial en la URL registra el acta del propio jurado', async () => {
    const ws = await abrir(credencial('JUR-88134'));
    expect(ws.protocol).toBe(SUBPROTOCOLO_JURADOS);
    const a = acta(4202);
    const respuesta = new Promise<Record<string, unknown>>((resolve) =>
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as Record<string, unknown>;
        if (m.tipo === 'respuesta') resolve(m);
      }),
    );
    ws.send(JSON.stringify({ tipo: 'acta', acta: a }));
    expect(await respuesta).toMatchObject({ idem: a.idem, respuesta: { estado: 'REGISTRADA' } });
    ws.close();
  });
});
