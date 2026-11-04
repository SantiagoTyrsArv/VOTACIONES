import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AppConfig } from '../src/config/AppConfig.js';
import { Application } from '../src/infra/Application.js';
import { IngestaModule } from '../src/ingesta/IngestaModule.js';
import { ConexionRedis } from '../src/redis/conexion.js';
import { acta, reiniciar } from './ayudas.js';

let redis: ConexionRedis;
let app: Application;
let base: string;

beforeAll(async () => {
  const url = process.env.REDIS_URL_PRUEBAS_HTTP ?? 'redis://localhost:6379/14';
  redis = new ConexionRedis({ url, timeoutMs: 2000, nombre: 'pruebas-http' });
  await redis.conectar();
  if (!redis.cliente.isReady) throw new Error('Redis de pruebas HTTP no disponible');
  app = new Application(AppConfig.fromEnv({
    PORT: '0',
    REDIS_URL: url,
    INSTANCE_ID: 'prueba-http',
    LOG_LEVEL: 'silent',
    LIMITE_ACTAS_POR_MINUTO: '30',
  }), [new IngestaModule()]);
  await app.start();
  const address = app.address;
  if (!address || typeof address === 'string') throw new Error('Sin puerto de pruebas');
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => { await reiniciar(redis); });
afterAll(async () => { await app.stop(); await redis.cerrar(); });

describe('Ingesta HTTP y WebSocket', () => {
  it('POST registra, devuelve 201 y luego el mismo recibo con 200', async () => {
    const a = acta();
    const primero = await fetch(`${base}/actas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) });
    expect(primero.status).toBe(201);
    const r1 = (await primero.json()) as { recibo?: unknown };
    const repetido = await fetch(`${base}/actas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) });
    expect(repetido.status).toBe(200);
    expect(((await repetido.json()) as { recibo?: unknown }).recibo).toEqual(r1.recibo);
  });

  it('GET informa el estado vigente y POST rechaza formato inválido', async () => {
    const a = acta();
    await fetch(`${base}/actas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) });
    const estado = await fetch(`${base}/actas/${a.acta}`);
    expect(estado.status).toBe(200);
    expect(await estado.json()).toMatchObject({ registrada: true, version: 1, instancia: 'prueba-http' });
    const invalido = await fetch(`${base}/actas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(invalido.status).toBe(422);
    expect(await invalido.json()).toMatchObject({ estado: 'RECHAZADA', motivo: 'FORMATO' });
  });

  it('WS entrega bienvenida y una respuesta correlacionada por idem', async () => {
    const a = acta();
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/jurados`);
    const mensajes: Record<string, unknown>[] = [];
    ws.on('message', (d) => mensajes.push(JSON.parse(d.toString())));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ tipo: 'acta', acta: a }));
    await new Promise<void>((resolve, reject) => {
      const limite = setTimeout(() => reject(new Error('Sin respuesta WS')), 2000);
      const revisar = () => {
        if (mensajes.some((m) => m.tipo === 'respuesta')) { clearTimeout(limite); resolve(); } else setTimeout(revisar, 10);
      };
      revisar();
    });
    expect(mensajes[0]).toMatchObject({ tipo: 'bienvenida', instancia: 'prueba-http' });
    expect(mensajes.find((m) => m.tipo === 'respuesta')).toMatchObject({ idem: a.idem, respuesta: { estado: 'REGISTRADA' } });
    ws.close();
  });

  it('/live permanece disponible y /ready refleja la conexión', async () => {
    expect((await fetch(`${base}/live`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(200);
  });
});
