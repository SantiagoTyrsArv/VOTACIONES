/**
 * Jornada simulada por HTTP contra una instancia (o el balanceador).
 *
 * Usa el mismo plan que el botón de la consola (`planJornada` de shared):
 * 55 % en el primer tercio, ráfagas de ~300/min, reenvíos con el mismo idem,
 * correcciones y actas dudosas. A diferencia del botón, aquí cada envío viaja
 * por la red (POST /actas), útil para medir desde fuera.
 *
 *   npm run jornada -w @preconteo/herramientas -- --actas 6400 --duracion 120 --acelerar 60
 */
import { planJornada, resumenPlan, type Acta } from '@votaciones/shared';
import { cabecerasJurado } from './jurados.js';

const arg = (nombre: string, defecto: number) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? Number(process.argv[i + 1]) : defecto;
};
const base = process.env.BASE_URL ?? 'http://localhost:3000';
const geografia = { mesas: arg('mesas', 6400), puestos: arg('puestos', 1842), municipios: arg('municipios', 32) };
const duracionMin = arg('duracion', 120);
const acelerar = Math.max(1, arg('acelerar', 1));
const plan = planJornada({
  geografia,
  actas: arg('actas', geografia.mesas),
  duracionMin,
  reenvios: arg('reenvios', 7) / 100,
  dudosas: arg('dudosas', 7) / 100,
  semilla: arg('semilla', 20261103),
});

const porEstado: Record<string, number> = {};
let fallidas = 0;
async function transmitir(a: Acta): Promise<void> {
  try {
    const r = await fetch(`${base}/actas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cabecerasJurado(a.jurado) },
      body: JSON.stringify(a),
    });
    const cuerpo = (await r.json()) as { estado?: string };
    porEstado[cuerpo.estado ?? r.status] = (porEstado[cuerpo.estado ?? r.status] ?? 0) + 1;
  } catch {
    fallidas++;
  }
}

console.log('Plan:', resumenPlan(plan, duracionMin), `· ×${acelerar} contra ${base}`);
const inicio = Date.now();
const enVuelo = new Set<Promise<void>>();
let i = 0;
for (const envio of plan) {
  const espera = inicio + envio.enMs / acelerar - Date.now();
  if (espera > 0) await new Promise((ok) => setTimeout(ok, espera));
  while (enVuelo.size >= 100) await Promise.race(enVuelo);
  const t: Promise<void> = transmitir(envio.acta).finally(() => enVuelo.delete(t));
  enVuelo.add(t);
  if (++i % 500 === 0) console.log(`${i}/${plan.length}`, porEstado);
}
await Promise.all(enVuelo);
console.log(`Fin en ${Math.round((Date.now() - inicio) / 1000)} s:`, porEstado, `fallidas de red: ${fallidas}`);
