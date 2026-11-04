import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
// Los 6.400 envíos originales se distribuyen sin redondeos que alteren los totales.
function distribute(total, minutes, bursts) {
  const remainder = total - Object.values(bursts).reduce((a, b) => a + b, 0),
    normal = minutes - Object.keys(bursts).length;
  let seen = 0;
  return Array.from(
    { length: minutes },
    (_, m) =>
      bursts[m] ??
      Math.floor((++seen * remainder) / normal) - Math.floor(((seen - 1) * remainder) / normal),
  );
}
const counts = [
  ...distribute(3520, 40, { 12: 300, 28: 300 }),
  ...distribute(2880, 80, { 31: 300 }),
];
const replayPercent = Number(process.env.REPLAY_PERCENT || 7);
assert.ok(replayPercent >= 4 && replayPercent <= 11, 'REPLAY_PERCENT debe estar entre 4 y 11');
const originals = [];
let sequence = 0;
for (const [minute, count] of counts.entries())
  for (let i = 0; i < count; i++) {
    const n = ++sequence;
    originals.push({
      offsetMs: minute * 60000 + Math.floor((i * 60000) / count),
      kind: 'original',
      payload: {
        acta: `CARGA-${String(n).padStart(5, '0')}`,
        version: 1,
        idem: `jornada-${n}-v1`,
        mesa: 1 + ((n - 1) % 4),
        puesto: Math.ceil(n / 4),
        municipio: 1 + Math.floor((n - 1) / 640),
        jurado: `jurado-carga-${n}`,
        ts_cierre: 1793750400000,
        votos: { c1: 90 + (n % 30), c2: 110 + (n % 25), BLANCO: 5, NULO: 1, NO_MARCADO: 0 },
        sufragantes: 206 + (n % 30) + (n % 25),
        hash_foto: createHash('sha256').update(`fixture-${n}`).digest('hex'),
      },
    });
  }
const corrections = Array.from({ length: 180 }, (_, i) => {
  const original = originals[i * 13];
  return {
    offsetMs: 40 * 60000 + Math.floor((i * 80 * 60000) / 180),
    kind: 'correction',
    payload: {
      ...original.payload,
      version: 2,
      idem: `jornada-${i * 13 + 1}-v2`,
      votos: { ...original.payload.votos, c1: original.payload.votos.c1 + 1 },
      hash_foto: createHash('sha256').update(`fixture-correction-${i}`).digest('hex'),
      sufragantes: original.payload.sufragantes + 1,
    },
  };
});
const replays = Array.from({ length: Math.round((6400 * replayPercent) / 100) }, (_, i) => {
  const original = originals[(i * 17) % originals.length];
  return { ...original, offsetMs: Math.min(7199999, original.offsetMs + 15000), kind: 'replay' };
});
const events = [...originals, ...corrections, ...replays].sort((a, b) => a.offsetMs - b.offsetMs);
assert.equal(originals.length, 6400);
assert.equal(
  counts.slice(0, 40).reduce((a, b) => a + b, 0),
  3520,
);
assert.equal(Math.max(...counts), 300);
const plan = {
  proposal: 'Contrato de carga pendiente de A; adaptar en electoral.js',
  originals: 6400,
  corrections: 180,
  replayPercent,
  replays: replays.length,
  counts,
  events,
};
writeFileSync(new URL('./profile.json', import.meta.url), JSON.stringify(plan));
console.log(
  JSON.stringify({
    originals: 6400,
    first40Minutes: 3520,
    percentage: 55,
    burstPerMinute: 300,
    corrections: 180,
    replays: replays.length,
    replayPercent,
    totalEvents: events.length,
  }),
);
