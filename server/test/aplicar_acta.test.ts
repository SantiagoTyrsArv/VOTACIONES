/**
 * Pruebas de aplicar_acta.lua contra Redis real (base 15).
 * Cubren las "pruebas propias" de la Persona A en el documento de diseño:
 * reenvíos ×5, permutaciones de versiones, caída entre registro y ack y
 * regla contable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claves, canales, type AvisoActa } from '@votaciones/shared';
import { aplicarActa } from '../src/ingesta/aplicar.js';
import type { ConexionRedis } from '../src/redis/conexion.js';
import { acta, conectarPruebas, reiniciar, totales, volcado } from './ayudas.js';

let r: ConexionRedis;
beforeAll(async () => {
  r = await conectarPruebas();
});
afterAll(async () => {
  await r.cerrar();
});
beforeEach(async () => {
  await reiniciar(r);
});

const aplicar = (a: Parameters<typeof aplicarActa>[1], modo?: 'jurado' | 'verificacion') =>
  aplicarActa(r, a, 'prueba-1', modo);

describe('RF-1 · idempotencia', () => {
  it('registra un acta nueva y suma en los cuatro niveles', async () => {
    const a = acta(4201);
    const res = await aplicar(a);
    expect(res.estado).toBe('REGISTRADA');
    expect(res.recibo).toMatchObject({ acta: a.acta, version: 1, estado: 'REGISTRADA', idem: a.idem });

    for (const k of ['tot:mesa:4201', 'tot:pue:176', 'tot:mun:11', 'tot:dep']) {
      const t = await totales(r, k);
      expect(t).toMatchObject({ C1: 184, C2: 97, C3: 311, BLANCO: 22, NULO: 9, NO_MARCADO: 4, sufragantes: 627, mesas_inf: 1 });
    }
    expect(await totales(r, 'tot:pue:176')).toMatchObject({ mesas_tot: 2 });
  });

  it('un acta reenviada cinco veces suma una sola vez y cada reenvío recibe el recibo original', async () => {
    const a = acta(4201);
    const primero = await aplicar(a);
    const reenvios = await Promise.all(Array.from({ length: 5 }, () => aplicar(a)));

    for (const res of reenvios) {
      expect(res.estado).toBe('YA_REGISTRADA');
      expect(res.recibo).toEqual(primero.recibo);
    }
    expect(await totales(r, 'tot:dep')).toMatchObject({ C1: 184, mesas_inf: 1 });
    // Un solo registro en el historial.
    expect(await r.comando(['XLEN', 'st:dep'])).toBe(1);
  });

  it('caída entre registrar y confirmar: el reintento con el mismo idem devuelve el recibo original', async () => {
    const a = acta(4201);
    // La instancia ejecuta el script y "muere" antes de responder al jurado:
    // descartamos la respuesta.
    await aplicar(a);
    // El jurado no vio el ack; su cola reintenta, ahora contra otra instancia.
    const reintento = await aplicarActa(r, a, 'otra-instancia');
    expect(reintento.estado).toBe('YA_REGISTRADA');
    expect(reintento.recibo?.instancia).toBe('prueba-1');
    expect(await totales(r, 'tot:dep')).toMatchObject({ C1: 184 });
  });

  it('si la clave idem expiró, la versión sigue impidiendo el doble conteo', async () => {
    const a = acta(4201);
    const primero = await aplicar(a);
    await r.comando(['DEL', claves.idem(a.idem)]);
    const res = await aplicar(a);
    expect(res.estado).toBe('YA_REGISTRADA');
    expect(res.recibo).toEqual(primero.recibo);
    expect(await totales(r, 'tot:dep')).toMatchObject({ C1: 184, mesas_inf: 1 });
  });

  it('rechaza un idem reutilizado para otra acta', async () => {
    const a = acta(4201);
    await aplicar(a);
    const otra = acta(4202, { idem: a.idem });
    const res = await aplicar(otra);
    expect(res).toMatchObject({ estado: 'RECHAZADA', motivo: 'IDEM_REUTILIZADO' });
  });

  it('cada recibo tiene un consecutivo distinto', async () => {
    const r1 = await aplicar(acta(4201));
    const r2 = await aplicar(acta(4202));
    expect(r1.recibo?.recibo).not.toBe(r2.recibo?.recibo);
  });
});

describe('RF-2 · correcciones y convergencia', () => {
  const v1 = () => acta(4201, { version: 1 });
  const v2 = () => acta(4201, { version: 2, votos: { C1: 180, C2: 101 } });
  const v3 = () => acta(4201, { version: 3, votos: { C1: 170, C2: 111, BLANCO: 20, NULO: 11 } });

  it('v2 revierte v1 y aplica la nueva con delta', async () => {
    await aplicar(v1());
    const res = await aplicar(v2());
    expect(res.estado).toBe('REGISTRADA');
    expect(await totales(r, 'tot:mun:11')).toMatchObject({ C1: 180, C2: 101, mesas_inf: 1 });

    const [, ultima] = (await r.comando<[string, string[]][]>(['XRANGE', 'st:dep', '-', '+'])).map(
      ([, campos]) => Object.fromEntries(campos.flatMap((_, i, a) => (i % 2 ? [] : [[a[i], a[i + 1]]]))),
    );
    expect(ultima).toMatchObject({ motivo: 'correccion', version: '2', version_anterior: '1' });
    expect(JSON.parse(ultima!.delta!)).toEqual({ C1: -4, C2: 4 });
  });

  it('una versión vieja que llega tarde no retrocede el estado', async () => {
    await aplicar(v3());
    const res = await aplicar(v2());
    expect(res.estado).toBe('VERSION_OBSOLETA');
    expect(res.recibo?.version).toBe(3);
    expect(await totales(r, 'tot:dep')).toMatchObject({ C1: 170, C2: 111 });
  });

  const permutaciones = <T>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutaciones([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  it('las 6 permutaciones de v1, v2, v3 dejan acumulados idénticos', async () => {
    const estados: string[] = [];
    for (const orden of permutaciones([v1, v2, v3])) {
      await reiniciar(r);
      for (const f of orden) await aplicar(f());
      estados.push(JSON.stringify(await volcado(r)));
    }
    expect(new Set(estados).size).toBe(1);
    await reiniciar(r);
    await aplicar(v3());
    expect(JSON.stringify(await volcado(r))).toBe(estados[0]);
  });

  it('la misma versión con otros votos es un conflicto: no toca el acumulado y va a verificación', async () => {
    await aplicar(v1());
    const distinta = acta(4201, { version: 1, votos: { C1: 1, C2: 280 } });
    const res = await aplicar(distinta);
    expect(res).toMatchObject({ estado: 'RECHAZADA', motivo: 'CONFLICTO_VERSION' });
    expect(await totales(r, 'tot:dep')).toMatchObject({ C1: 184, C2: 97 });
    expect(await r.comando(['ZSCORE', claves.verifCola(), distinta.acta])).not.toBeNull();
    expect(await r.comando(['HGET', claves.acta(distinta.acta), 'conflicto'])).toBe('1');
  });
});

describe('Regla contable · actas dudosas', () => {
  it('un acta que no cuadra se registra como dudosa, no suma y entra a la cola', async () => {
    const a = acta(4201, { sufragantes: 600 });
    const res = await aplicar(a);
    expect(res.estado).toBe('DUDOSA_EN_VERIFICACION');
    expect(res.recibo?.estado).toBe('DUDOSA_EN_VERIFICACION');
    expect(await totales(r, 'tot:dep')).toEqual({ mesas_tot: 4 });
    expect(await r.comando(['ZSCORE', claves.verifCola(), a.acta])).not.toBeNull();
    expect(await r.comando(['XLEN', claves.streamVerif()])).toBe(1);
    // Sin cambio en los acumulados no hay entrada en los streams públicos.
    expect(await r.comando(['EXISTS', 'st:dep'])).toBe(0);
  });

  it('el reenvío de una dudosa también es inequívoco', async () => {
    const a = acta(4201, { sufragantes: 600 });
    const primero = await aplicar(a);
    const res = await aplicar(a);
    expect(res.estado).toBe('YA_REGISTRADA');
    expect(res.recibo).toEqual(primero.recibo);
  });

  it('una corrección válida de una dudosa suma y la saca de la cola', async () => {
    await aplicar(acta(4201, { version: 1, sufragantes: 600 }));
    const res = await aplicar(acta(4201, { version: 2 }));
    expect(res.estado).toBe('REGISTRADA');
    expect(await totales(r, 'tot:dep')).toMatchObject({ C1: 184, mesas_inf: 1 });
    expect(await r.comando(['ZCARD', claves.verifCola()])).toBe(0);
  });

  it('una corrección dudosa retira lo que la mesa sumaba, con motivo explícito, en cualquier orden', async () => {
    const valida = () => acta(4201, { version: 1 });
    const dudosa = () => acta(4201, { version: 2, sufragantes: 1 });

    await aplicar(valida());
    await aplicar(dudosa());
    expect(await totales(r, 'tot:dep')).toMatchObject({ C1: 0, sufragantes: 0, mesas_inf: 0 });
    const a = await volcado(r);
    const entradas = await r.comando<[string, string[]][]>(['XRANGE', 'st:dep', '-', '+']);
    expect(entradas.at(-1)![1]).toContain('retiro_dudosa');

    await reiniciar(r);
    await aplicar(dudosa());
    await aplicar(valida());
    expect(await volcado(r)).toEqual(a);
  });

  it('verificación puede aceptar un acta con descuadre', async () => {
    await aplicar(acta(4201, { version: 1, sufragantes: 600 }));
    const res = await aplicar(acta(4201, { version: 2, sufragantes: 600 }), 'verificacion');
    expect(res.estado).toBe('REGISTRADA');
    expect(await totales(r, 'tot:dep')).toMatchObject({ C1: 184, sufragantes: 600, mesas_inf: 1 });
  });
});

describe('Catálogo', () => {
  it('rechaza una mesa que no existe', async () => {
    const a = { ...acta(4201), mesa: 9999 };
    expect(await aplicar(a)).toMatchObject({ estado: 'RECHAZADA', motivo: 'MESA_DESCONOCIDA' });
  });

  it('rechaza un municipio que no corresponde a la mesa', async () => {
    const a = { ...acta(4201), municipio: 12 };
    expect(await aplicar(a)).toMatchObject({ estado: 'RECHAZADA', motivo: 'UBICACION_INCONSISTENTE' });
  });
});

describe('RF-3 · atomicidad y aviso', () => {
  it('publica un aviso en ch:actas con los ids de los tres streams', async () => {
    const sub = r.cliente.duplicate();
    sub.on('error', () => {});
    await sub.connect();
    const recibidos: AvisoActa[] = [];
    await sub.subscribe(canales.actas, (m) => recibidos.push(JSON.parse(m)));

    await aplicar(acta(4201));
    await new Promise((res) => setTimeout(res, 100));
    await sub.close();

    expect(recibidos).toHaveLength(1);
    expect(recibidos[0]).toMatchObject({ motivo: 'nueva', version: 1, topics: ['pue:176', 'mun:11', 'dep'] });
    expect(Object.keys(recibidos[0]!.ids).sort()).toEqual(['dep', 'mun:11', 'pue:176']);
    expect(recibidos[0]!.streamIds).toEqual(recibidos[0]!.ids);
  });

  it('con 200 actas concurrentes, cada nivel es exactamente la suma de sus hijos', async () => {
    // 200 envíos repartidos en 4 mesas con correcciones y reenvíos mezclados.
    const envios = [];
    for (let i = 0; i < 200; i++) {
      const mesa = [4201, 4202, 4301, 5001][i % 4]!;
      const version = 1 + (i % 5);
      envios.push(acta(mesa, { version, idem: `concurrente-${mesa}-${version}`, votos: { C1: 100 + version, C2: 50 - version } }));
    }
    await Promise.all(envios.map((a) => aplicar(a)));

    const mesas = await Promise.all([4201, 4202, 4301, 5001].map((m) => totales(r, `tot:mesa:${m}`)));
    const suma = (ts: Record<string, number>[], c: string) => ts.reduce((s, t) => s + (t[c] ?? 0), 0);
    const pue176 = await totales(r, 'tot:pue:176');
    const mun11 = await totales(r, 'tot:mun:11');
    const dep = await totales(r, 'tot:dep');

    for (const c of ['C1', 'C2', 'sufragantes', 'mesas_inf']) {
      expect(pue176[c]).toBe(suma(mesas.slice(0, 2), c));
      expect(mun11[c]).toBe(suma(mesas.slice(0, 3), c));
      expect(dep[c]).toBe(suma(mesas, c));
    }
    // Ganó la versión 5 en todas las mesas.
    expect(dep.C1).toBe(4 * 105);
    expect(await r.comando(['ZSCORE', 'rank:dep', 'C1'])).toBe(String(4 * 105));
  });
});
