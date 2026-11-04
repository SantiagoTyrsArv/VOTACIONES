/** Utilidades comunes de las pruebas. Usan la base 15 de Redis. */
import { CASILLAS, claves, topico, type Acta, type Votos } from '@preconteo/shared';
import { ConexionRedis } from '../src/redis/conexion.js';

export const REDIS_PRUEBAS = process.env.REDIS_URL_PRUEBAS ?? 'redis://localhost:6379/15';

export async function conectarPruebas(): Promise<ConexionRedis> {
  const r = new ConexionRedis({ url: REDIS_PRUEBAS, timeoutMs: 2000, nombre: 'pruebas' });
  await r.conectar();
  if (!r.cliente.isReady) throw new Error(`Redis de pruebas no disponible en ${REDIS_PRUEBAS} (npm run redis:up)`);
  return r;
}

/**
 * Catálogo mínimo: municipio 11 con puestos 176 (mesas 4201, 4202) y 177
 * (mesa 4301); municipio 12 con puesto 200 (mesa 5001).
 */
export const CATALOGO = [
  { mesa: 4201, puesto: 176, municipio: 11 },
  { mesa: 4202, puesto: 176, municipio: 11 },
  { mesa: 4301, puesto: 177, municipio: 11 },
  { mesa: 5001, puesto: 200, municipio: 12 },
];

export async function reiniciar(r: ConexionRedis): Promise<void> {
  await r.comando(['FLUSHDB']);
  const mesasPor = new Map<string, number>();
  for (const m of CATALOGO) {
    await r.comando(['HSET', claves.catMesa(m.mesa), 'puesto', String(m.puesto), 'municipio', String(m.municipio)]);
    for (const t of [topico.pue(m.puesto), topico.mun(m.municipio), topico.dep()]) {
      mesasPor.set(t, (mesasPor.get(t) ?? 0) + 1);
    }
  }
  for (const [t, n] of mesasPor) {
    await r.comando(['HSET', `tot:${t}`, 'mesas_tot', String(n)]);
  }
}

let contador = 0;
export const nuevoIdem = (): string => `prueba${Date.now().toString(36)}${(contador++).toString(36).padStart(4, '0')}`;

/** Acta que cuadra (Σ casillas = sufragantes) para la mesa indicada. */
export function acta(
  mesa = 4201,
  cambios: Partial<Omit<Acta, 'votos'>> & { votos?: Partial<Votos> } = {},
): Acta {
  const cat = CATALOGO.find((c) => c.mesa === mesa)!;
  const votos: Votos = { C1: 184, C2: 97, C3: 311, BLANCO: 22, NULO: 9, NO_MARCADO: 4, ...cambios.votos };
  const sufragantes = CASILLAS.reduce((s, c) => s + votos[c], 0);
  const local = String(mesa % 10000).padStart(4, '0');
  return {
    acta: `E14-${cat.puesto}-${local}-03`,
    mesa,
    puesto: cat.puesto,
    municipio: cat.municipio,
    version: 1,
    jurado: 'JUR-88134',
    ts_cierre: 1793577600,
    hash_foto: '9f2c',
    idem: nuevoIdem(),
    ...cambios,
    votos,
    sufragantes: cambios.sufragantes ?? sufragantes,
  };
}

export async function totales(r: ConexionRedis, clave: string): Promise<Record<string, number>> {
  const plano = await r.comando<string[]>(['HGETALL', clave]);
  const t: Record<string, number> = {};
  for (let i = 0; i < plano.length; i += 2) t[plano[i]!] = Number(plano[i + 1]);
  return t;
}

/**
 * Estado de todos los acumulados, para comparar escenarios. Un campo en 0 y
 * un campo ausente representan el mismo acumulado, así que se omiten los
 * ceros (y las claves que quedan vacías).
 */
export async function volcado(r: ConexionRedis): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  const guardar = (k: string, m: Record<string, number>) => {
    const sinCeros = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0).sort());
    if (Object.keys(sinCeros).length > 0) out[k] = sinCeros;
  };
  for (const k of (await r.comando<string[]>(['KEYS', 'tot:*'])).sort()) guardar(k, await totales(r, k));
  for (const k of (await r.comando<string[]>(['KEYS', 'rank:*'])).sort()) {
    const z = await r.comando<string[]>(['ZRANGE', k, '0', '-1', 'WITHSCORES']);
    const m: Record<string, number> = {};
    for (let i = 0; i < z.length; i += 2) m[z[i]!] = Number(z[i + 1]);
    guardar(k, m);
  }
  return out;
}
