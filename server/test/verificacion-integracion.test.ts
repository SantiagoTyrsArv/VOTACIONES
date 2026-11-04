/**
 * Integración A ↔ C contra Redis real (base 15):
 * una acta dudosa de A aparece como caso de C, un auditor la toma y su
 * resolución se aplica en aplicar_acta.lua con la comprobación de la
 * concesión (lock + fencing token + sesión) dentro del mismo script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { caseInputSchema, type CaseRecord, type Resolution } from '@votaciones/shared/verificacion';
import { aplicarActa } from '../src/ingesta/aplicar.js';
import { ResolucionAtomica } from '../src/ingesta/resolucion.js';
import type { ConexionRedis } from '../src/redis/conexion.js';
import type { Config } from '../src/verificacion/config.js';
import { VerificationStore, type Actor } from '../src/verificacion/store.js';
import { REDIS_PRUEBAS, acta, conectarPruebas, reiniciar, totales } from './ayudas.js';

const config: Config = {
  redisUrl: REDIS_PRUEBAS,
  instance: 'prueba-c',
  port: 0,
  host: '127.0.0.1',
  demo: false,
  credentials: {},
  allowedOrigins: [],
  keyPrefix: '',
  log: false,
};

const ana: Actor = { identity: { id: 'ana', name: 'Ana', role: 'auditor' }, sessionId: 'sesion-ana' };
const luis: Actor = { identity: { id: 'luis', name: 'Luis', role: 'auditor' }, sessionId: 'sesion-luis' };

let r: ConexionRedis;
let store: VerificationStore;
let adaptador: ResolucionAtomica;

beforeAll(async () => {
  r = await conectarPruebas();
  store = new VerificationStore(config);
  await store.open(() => {});
  adaptador = new ResolucionAtomica({ redis: () => r, instancia: 'prueba-a' });
});
afterAll(async () => {
  await store.close();
  await r.cerrar();
});
beforeEach(async () => {
  await reiniciar(r);
  await store.presence('connect', ana);
  await store.presence('connect', luis);
});

/** Acta de la mesa 4201 con 27 votos de descuadre (Σ casillas = 627). */
const dudosa = (version = 1) => acta(4201, { version, sufragantes: 600 });

async function caso(id: string): Promise<CaseRecord | undefined> {
  return (await store.cases()).find((c) => c.id === id);
}

async function tomar(id: string, quien: Actor): Promise<string> {
  const r = await store.operation('take', id, quien);
  expect(r.code).toBe('TAKEN');
  return r.token!;
}

const resolver = (id: string, token: string, quien: Actor, resolution: Resolution) =>
  adaptador.apply(store, { caseId: id, token, actor: quien, resolution });

describe('A encola actas dudosas como casos de C', () => {
  it('el caso tiene el formato de CaseRecord y la prioridad de C en verif:cola', async () => {
    const a = dudosa();
    expect((await aplicarActa(r, a, 'prueba-a')).estado).toBe('DUDOSA_EN_VERIFICACION');

    const c = await caso(a.acta);
    expect(c).toMatchObject({ id: a.acta, version: 1, status: 'pending', source: 'A', priority: 99 });
    const { status: _status, ...entrada } = c!;
    expect(() => caseInputSchema.parse(entrada)).not.toThrow();
    const score = Number(await r.comando<string>(['ZSCORE', 'verif:cola', a.acta]));
    expect(score).toBe(c!.receivedAt - c!.priority * 10_000_000_000);
    expect(await totales(r, 'tot:dep')).not.toHaveProperty('C1');
  });

  it('una versión válida del jurado cierra el caso abierto aunque esté asignado', async () => {
    const a = dudosa();
    await aplicarActa(r, a, 'prueba-a');
    await tomar(a.acta, ana);

    const v2 = acta(4201, { version: 2 });
    expect((await aplicarActa(r, v2, 'prueba-a')).estado).toBe('REGISTRADA');
    expect(await caso(a.acta)).toMatchObject({ status: 'resolved', resolution: { action: 'approve' } });
    expect(await r.comando(['EXISTS', `lock:caso:${a.acta}`])).toBe(0);
    expect(await r.comando(['ZSCORE', 'verif:asignados', a.acta])).toBeNull();
  });

  it('una versión dudosa nueva reemplaza el caso y deja obsoleto el token anterior', async () => {
    const a = dudosa();
    await aplicarActa(r, a, 'prueba-a');
    const token = await tomar(a.acta, ana);

    await aplicarActa(r, dudosa(2), 'prueba-a');
    expect(await caso(a.acta)).toMatchObject({ version: 2, status: 'pending' });
    expect((await resolver(a.acta, token, ana, { action: 'approve', note: 'Revisada' })).code).toBe('STALE_TOKEN');
  });
});

describe('C resuelve con la operación atómica de A', () => {
  it('aprobar suma la mesa, cierra el caso y es idempotente', async () => {
    const a = dudosa();
    await aplicarActa(r, a, 'prueba-a');
    const token = await tomar(a.acta, ana);

    const primero = await resolver(a.acta, token, ana, { action: 'approve', note: 'Coincide con la foto' });
    expect(primero).toMatchObject({ code: 'APPLIED', caseId: a.acta });
    expect(await totales(r, 'tot:dep')).toMatchObject({ C1: 184, sufragantes: 600, mesas_inf: 1 });
    expect(await caso(a.acta)).toMatchObject({ status: 'resolved', resolution: { action: 'approve' } });
    expect(await caso(a.acta)).not.toHaveProperty('owner');
    expect(await r.comando(['EXISTS', `lock:caso:${a.acta}`])).toBe(0);

    // Reintento de la misma orden (p. ej. se perdió el ack): mismo recibo, sin doble suma.
    const segundo = await resolver(a.acta, token, ana, { action: 'approve', note: 'Coincide con la foto' });
    expect(segundo).toEqual(primero);
    expect(await totales(r, 'tot:dep')).toMatchObject({ C1: 184, mesas_inf: 1 });
  });

  it('corregir aplica los votos del auditor', async () => {
    const a = dudosa();
    await aplicarActa(r, a, 'prueba-a');
    const token = await tomar(a.acta, ana);
    const votes = { C1: 160, C2: 97, C3: 311, BLANCO: 22, NULO: 6, NO_MARCADO: 4 };

    expect((await resolver(a.acta, token, ana, { action: 'correct', note: 'Error de digitación', votes })).code).toBe(
      'APPLIED',
    );
    expect(await totales(r, 'tot:mun:11')).toMatchObject({ C1: 160, NULO: 6, mesas_inf: 1 });
  });

  it('rechazar deja la mesa fuera del preconteo y cierra el caso', async () => {
    const a = dudosa();
    await aplicarActa(r, a, 'prueba-a');
    const token = await tomar(a.acta, ana);

    expect((await resolver(a.acta, token, ana, { action: 'reject', note: 'Acta ilegible' })).code).toBe('APPLIED');
    expect(await totales(r, 'tot:dep')).not.toHaveProperty('mesas_inf', 1);
    expect(await caso(a.acta)).toMatchObject({ status: 'resolved', resolution: { action: 'reject' } });
  });

  it('votos corregidos incompletos se rechazan antes de tocar Redis', async () => {
    const a = dudosa();
    await aplicarActa(r, a, 'prueba-a');
    const token = await tomar(a.acta, ana);
    const res = await resolver(a.acta, token, ana, { action: 'correct', note: 'Faltan casillas', votes: { C1: 1 } });
    expect(res.code).toBe('INVALID_VOTES');
    expect(await caso(a.acta)).toMatchObject({ status: 'assigned' });
  });

  it('bloqueo expirado + liberación tardía: el auditor anterior no pisa al nuevo dueño', async () => {
    const a = dudosa();
    await aplicarActa(r, a, 'prueba-a');
    const tokenAna = await tomar(a.acta, ana);

    // Ana deja de renovar: el lock caduca y el barrido devuelve el caso a la cola.
    await r.comando(['DEL', `lock:caso:${a.acta}`]);
    await r.comando(['ZADD', 'verif:asignados', '0', a.acta]);
    expect((await store.sweep()).recovered).toBe(1);
    const tokenLuis = await tomar(a.acta, luis);
    expect(Number(tokenLuis)).toBeGreaterThan(Number(tokenAna));

    expect((await resolver(a.acta, tokenAna, ana, { action: 'reject', note: 'Llego tarde' })).code).toBe('STALE_TOKEN');
    expect(await totales(r, 'tot:dep')).not.toHaveProperty('C1');
    expect(await caso(a.acta)).toMatchObject({ status: 'assigned', owner: 'luis' });

    expect((await resolver(a.acta, tokenLuis, luis, { action: 'approve', note: 'Revisada por Luis' })).code).toBe(
      'APPLIED',
    );
  });

  it('un caso sin acta registrada en A no se puede resolver', async () => {
    const res = await resolver('E14-176-9999-03', '1', ana, { action: 'approve', note: 'No existe' });
    expect(res.code).toBe('INVALID_CASE');
  });
});
