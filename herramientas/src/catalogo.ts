import { createClient } from 'redis';
import { claves, topico } from '@votaciones/shared';

const total = Number(process.env.MESAS ?? 6400);
const puestos = Number(process.env.PUESTOS ?? 1842);
const municipios = Number(process.env.MUNICIPIOS ?? 32);
if (total < puestos) throw new Error('MESAS debe ser mayor o igual que PUESTOS');
const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
await redis.connect();
const porTopico = new Map<string, number>();
const pipeline = redis.multi();
for (let i = 0; i < total; i++) {
  const mesa = i + 1;
  const puesto = (i % puestos) + 1;
  const municipio = (puesto % municipios) + 1;
  pipeline.hSet(claves.catMesa(mesa), { puesto, municipio });
  for (const t of [topico.pue(puesto), topico.mun(municipio), topico.dep()]) porTopico.set(t, (porTopico.get(t) ?? 0) + 1);
}
for (const [t, n] of porTopico) pipeline.hSet(claves.tot(t as Parameters<typeof claves.tot>[0]), 'mesas_tot', n);
await pipeline.exec();
await redis.close();
console.log(`Catálogo cargado: ${total} mesas, ${puestos} puestos y ${municipios} municipios.`);
