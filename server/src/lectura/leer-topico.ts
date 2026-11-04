/**
 * Fotografía atómica de un tópico (leer_topico.lua). La usa B para
 * `event: snapshot` y el polling, y A para la página de estado del jurado.
 */
import { claves, type Fotografia, type Topico, type Totales } from '@preconteo/shared';
import type { ConexionRedis } from '../redis/conexion.js';

export const PATRON_TOPICO = /^(dep|mun:\d+|pue:\d+)$/;

export async function leerTopico(redis: ConexionRedis, t: Topico): Promise<Fotografia> {
  const [plano, rank, ultimo] = await redis.script<[string[], string[], string]>(
    'leer_topico',
    [claves.tot(t), claves.rank(t), claves.stream(t)],
    [],
  );
  const totales: Totales = {};
  for (let i = 0; i < plano.length; i += 2) {
    (totales as Record<string, number>)[plano[i]!] = Number(plano[i + 1]);
  }
  const ranking: Fotografia['ranking'] = [];
  for (let i = 0; i < rank.length; i += 2) {
    ranking.push({ candidato: rank[i]!, votos: Number(rank[i + 1]) });
  }
  return { topico: t, totales, ranking, ultimo_id: ultimo };
}
