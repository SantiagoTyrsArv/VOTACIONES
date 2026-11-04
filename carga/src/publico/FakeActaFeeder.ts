import { RedisChannels, RedisKeys, Topic, TotalsField } from '@votaciones/shared';
import type { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;

/**
 * IMITACIÓN de aplicar_acta.lua solo para desarrollar y medir la difusión sin depender de
 * la Persona A. Escribe EXACTAMENTE el contrato de shared/ (hashes tot:*, streams st:* y
 * aviso en ch:actas) de forma atómica. No valida idempotencia ni versiones: eso es de A.
 *
 * KEYS: tot:dep, tot:mun:m, tot:pue:p, st:dep, st:mun:m, st:pue:p
 * ARGV: acta, version, version_anterior, motivo, deltaJSON, recibida_ms, maxlen,
 *       topico_dep, topico_mun, topico_pue, canal
 */
const APPLY_SCRIPT = `
local delta = cjson.decode(ARGV[5])
local topics = { ARGV[8], ARGV[9], ARGV[10] }
local ids = {}
for i = 1, 3 do
  for field, value in pairs(delta) do
    if value ~= 0 then redis.call('HINCRBY', KEYS[i], field, value) end
  end
  local flat = redis.call('HGETALL', KEYS[i])
  local totals = {}
  for j = 1, #flat, 2 do totals[flat[j]] = tonumber(flat[j + 1]) end
  ids[topics[i]] = redis.call('XADD', KEYS[i + 3], 'MAXLEN', '~', ARGV[7], '*',
    'acta', ARGV[1], 'version', ARGV[2], 'version_anterior', ARGV[3], 'motivo', ARGV[4],
    'delta', ARGV[5], 'totales', cjson.encode(totals), 'recibida_ms', ARGV[6])
end
redis.call('PUBLISH', ARGV[11], cjson.encode({ acta = ARGV[1], topics = topics, streamIds = ids }))
return ids[topics[1]]
`;

export interface Mesa {
  acta: string;
  mesa: number;
  puesto: number;
  municipio: number;
}

export const CANDIDATES = ['C1', 'C2', 'C3', 'C4', 'BLANCO'] as const;

/** Geografía sintética: 1.842 puestos y 6.400 mesas repartidos en N municipios. */
export class SyntheticGeography {
  readonly mesas: Mesa[] = [];

  constructor(municipios = 40, puestos = 1_842, mesas = 6_400) {
    for (let n = 0; n < mesas; n++) {
      const puesto = n < puestos ? n + 1 : 1 + Math.floor(Math.random() * puestos);
      const municipio = 1 + (puesto % municipios);
      this.mesas.push({ acta: `E14-${puesto}-${String(n + 1).padStart(4, '0')}-03`, mesa: n + 1, puesto, municipio });
    }
  }

  /** Total de mesas por tópico, para el porcentaje de mesas informadas. */
  tablesPerTopic(): Map<string, number> {
    const counts = new Map<string, number>([['dep', this.mesas.length]]);
    for (const mesa of this.mesas) {
      for (const topic of [Topic.municipality(mesa.municipio), Topic.pollingStation(mesa.puesto)]) {
        counts.set(topic.toString(), (counts.get(topic.toString()) ?? 0) + 1);
      }
    }
    return counts;
  }
}

export class FakeActaFeeder {
  private sha: string | null = null;

  constructor(
    private readonly redis: RedisClient,
    private readonly maxLen = 10_000,
  ) {}

  async prepare(geography: SyntheticGeography): Promise<void> {
    this.sha = await this.redis.scriptLoad(APPLY_SCRIPT);
    const pipeline = this.redis.multi();
    for (const [topic, tables] of geography.tablesPerTopic()) {
      pipeline.hSet(RedisKeys.totals(Topic.parse(topic)), TotalsField.totalTables, tables);
    }
    await pipeline.exec();
  }

  /** Borra solo resultados departamentales, municipales y de puestos. Conserva st:verif. Úselo únicamente en ambientes de prueba. */
  async reset(): Promise<number> {
    let deleted = 0;
    for (const pattern of ['tot:dep', 'tot:mun:*', 'tot:pue:*', 'st:dep', 'st:mun:*', 'st:pue:*']) {
      for await (const key of this.redis.scanIterator({ MATCH: pattern, COUNT: 500 })) {
        deleted += await this.redis.del(key);
      }
    }
    return deleted;
  }

  async apply(mesa: Mesa, delta: Record<string, number>, version: number, previousVersion: number): Promise<string> {
    if (!this.sha) throw new Error('Llame a prepare() antes de aplicar actas');
    const topics = [Topic.DEPARTMENT, Topic.municipality(mesa.municipio), Topic.pollingStation(mesa.puesto)];
    const keys = [...topics.map((t) => RedisKeys.totals(t)), ...topics.map((t) => RedisKeys.resultsStream(t))];
    const args = [
      mesa.acta,
      String(version),
      String(previousVersion),
      previousVersion > 0 ? 'correccion' : 'nueva',
      JSON.stringify(delta),
      String(Date.now()),
      String(this.maxLen),
      ...topics.map((t) => t.toString()),
      RedisChannels.actas,
    ];
    return (await this.redis.evalSha(this.sha, { keys, arguments: args })) as string;
  }
}

/** Votos aleatorios coherentes con la regla contable. */
export function randomVotes(): Record<string, number> {
  const votes: Record<string, number> = {};
  let voters = 0;
  for (const candidate of CANDIDATES) {
    const value = Math.floor(Math.random() * (candidate === 'BLANCO' ? 30 : 250));
    votes[candidate] = value;
    voters += value;
  }
  votes.NULO = Math.floor(Math.random() * 12);
  votes.NO_MARCADO = Math.floor(Math.random() * 6);
  voters += votes.NULO + votes.NO_MARCADO;
  votes[TotalsField.voters] = voters;
  return votes;
}
