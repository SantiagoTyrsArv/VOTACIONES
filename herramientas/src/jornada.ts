import type { Acta, Votos } from '@votaciones/shared';
import { cabecerasJurado, juradoDeMesa } from './jurados.js';

const arg = (nombre: string, defecto: number) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? Number(process.argv[i + 1]) : defecto;
};
const total = arg('actas', 6400);
const puestos = arg('puestos', 1842);
const municipios = arg('municipios', 32);
const duracionMs = arg('duracion', 120) * 60_000;
const base = process.env.BASE_URL ?? 'http://localhost:3000';
const reenvios = arg('reenvios', 7) / 100;
const dudosas = arg('dudosas', 7) / 100;
const inicio = Date.now();
let enviadas = 0;
let confirmadas = 0;
let fallidas = 0;

function actaDe(i: number): Acta {
  const mesa = i + 1;
  const puesto = (i % puestos) + 1;
  const municipio = (puesto % municipios) + 1;
  const votos: Votos = { C1: 80 + (i % 90), C2: 60 + (i % 50), C3: 100 + (i % 70), BLANCO: 5 + (i % 8), NULO: 2 + (i % 5), NO_MARCADO: 3 + (i % 4) };
  const sufragantes = Object.values(votos).reduce((s, n) => s + n, 0) + (Math.random() < dudosas ? 1 : 0);
  return { acta:`E14-${puesto}-${String(mesa).padStart(4,'0')}-03`, mesa, puesto, municipio, version:1, jurado:juradoDeMesa(mesa), ts_cierre:Math.floor(Date.now()/1000), votos, sufragantes, hash_foto:`demo-${mesa}`, idem:`demo-${mesa}-${Date.now().toString(36)}` };
}
async function transmitir(a: Acta): Promise<void> {
  try {
    const r = await fetch(`${base}/actas`, { method:'POST', headers:{'content-type':'application/json', ...cabecerasJurado(a.jurado)}, body:JSON.stringify(a) });
    if (r.ok) confirmadas++; else fallidas++;
  } catch { fallidas++; }
  finally { enviadas++; }
}
console.log(`Jornada: ${total} actas en ${duracionMs / 60000} min; 55% durante el primer tercio.`);
const tareas: Promise<void>[] = [];
for (let i = 0; i < total; i++) {
  const fraccion = i / total;
  const objetivo = fraccion < .55 ? (fraccion / .55) * (duracionMs / 3) : duracionMs / 3 + ((fraccion - .55) / .45) * (duracionMs * 2 / 3);
  const espera = Math.max(0, inicio + objetivo - Date.now());
  if (espera) await new Promise((r) => setTimeout(r, espera));
  const a = actaDe(i);
  tareas.push(transmitir(a));
  if (Math.random() < reenvios) tareas.push(transmitir(a));
  if (tareas.length >= 100) { await Promise.all(tareas.splice(0)); }
  if (i % 250 === 0) console.log(`${i}/${total} actas preparadas; ${confirmadas} confirmadas, ${fallidas} fallidas.`);
}
await Promise.all(tareas);
console.log(`Fin: ${enviadas} solicitudes, ${confirmadas} confirmadas y ${fallidas} fallidas en ${Math.round((Date.now()-inicio)/1000)} s.`);
