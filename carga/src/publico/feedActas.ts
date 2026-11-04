import { createClient } from 'redis';
import { TotalsField } from '@votaciones/shared';
import { CliArgs } from './cli.js';
import { FakeActaFeeder, randomVotes, SyntheticGeography, type Mesa } from './FakeActaFeeder.js';

/**
 * Simula el perfil de la jornada sobre el contrato de shared/:
 *   - 55% de las actas en los primeros 40 min, el resto en los 80 siguientes;
 *   - ~3% de correcciones (v1 → v2) un rato después.
 * --acelerar=60 comprime las 2 horas en 2 minutos.
 *
 *   npm run alimentar -w carga -- --redis=redis://... --acelerar=60 --reiniciar
 */
const args = new CliArgs();
const redisUrl = args.string('redis', process.env.REDIS_URL ?? 'redis://localhost:6379');
const speed = args.number('acelerar', 1);
const totalActas = args.number('actas', 6_400);
const correctionRate = args.number('correcciones', 0.03);

const JORNADA_MS = 120 * 60_000;
const PEAK_MS = 40 * 60_000;

interface Scheduled {
  atMs: number;
  mesa: Mesa;
  correction: boolean;
}

function buildSchedule(mesas: Mesa[]): Scheduled[] {
  const schedule: Scheduled[] = mesas.slice(0, totalActas).map((mesa) => ({
    atMs: Math.random() < 0.55 ? Math.random() * PEAK_MS : PEAK_MS + Math.random() * (JORNADA_MS - PEAK_MS),
    mesa,
    correction: false,
  }));
  for (const item of [...schedule]) {
    if (Math.random() < correctionRate) {
      schedule.push({ atMs: Math.min(JORNADA_MS, item.atMs + 5 * 60_000 * Math.random()), mesa: item.mesa, correction: true });
    }
  }
  return schedule.sort((a, b) => a.atMs - b.atMs);
}

async function main(): Promise<void> {
  const redis = createClient({ url: redisUrl });
  await redis.connect();
  // createClient sin opciones infiere RESP3; el alimentador usa el tipo genérico del cliente.
  const feeder = new FakeActaFeeder(redis as unknown as ConstructorParameters<typeof FakeActaFeeder>[0]);
  if (args.flag('reiniciar')) console.log(`Claves de resultados borradas: ${await feeder.reset()}`);

  const geography = new SyntheticGeography();
  await feeder.prepare(geography);
  const schedule = buildSchedule(geography.mesas);
  const applied = new Map<string, Record<string, number>>();
  console.log(`Jornada simulada: ${schedule.length} envíos en ${(JORNADA_MS / speed / 60_000).toFixed(1)} min (x${speed})`);

  const start = Date.now();
  let done = 0;
  for (const item of schedule) {
    const wait = item.atMs / speed - (Date.now() - start);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

    const previous = applied.get(item.mesa.acta);
    if (item.correction && previous) {
      const next = randomVotes();
      const delta: Record<string, number> = {};
      for (const field of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        delta[field] = (next[field] ?? 0) - (previous[field] ?? 0);
      }
      await feeder.apply(item.mesa, delta, 2, 1);
      applied.set(item.mesa.acta, next);
    } else if (!item.correction && !previous) {
      const votes = randomVotes();
      await feeder.apply(item.mesa, { ...votes, [TotalsField.reportedTables]: 1 }, 1, 0);
      applied.set(item.mesa.acta, votes);
    }
    done++;
    if (done % 250 === 0) {
      const minutes = ((Date.now() - start) * speed) / 60_000;
      console.log(`${done}/${schedule.length} envíos · minuto simulado ${minutes.toFixed(0)}`);
    }
  }
  console.log('Jornada simulada completa');
  await redis.quit();
}

main().catch((error: unknown) => {
  console.error('Error en el alimentador', error);
  process.exit(1);
});
