/**
 * Jornada simulada (RT-8, RT-10): geografía y plan de envíos reproducibles.
 *
 * Funciones puras, sin APIs de Node ni del navegador: las usan el servidor
 * (jornada activable desde la consola), las herramientas de línea de comandos
 * y las pruebas. Con la misma semilla se obtiene exactamente el mismo plan.
 *
 * Perfil del documento de diseño: 6.400 actas en 2 h, 55 % en los primeros
 * 40 min (con ráfagas de hasta 300/min), 4–11 % de reenvíos, ~180
 * correcciones y 6–9 % de actas dudosas.
 */
import { CASILLAS, type Acta, type Votos } from './acta.js';

export interface Geografia {
  mesas: number;
  puestos: number;
  municipios: number;
}

export const GEOGRAFIA_DEFECTO: Geografia = { mesas: 6400, puestos: 1842, municipios: 32 };

/** Ubicación de una mesa (1…mesas). La misma regla en el catálogo y en la jornada. */
export function ubicacionDeMesa(mesa: number, g: Geografia = GEOGRAFIA_DEFECTO) {
  const puesto = ((mesa - 1) % g.puestos) + 1;
  const municipio = (puesto % g.municipios) + 1;
  return { mesa, puesto, municipio };
}

export const juradoDeMesa = (mesa: number): string => `JUR-${mesa}`;
export const actaDeMesa = (mesa: number, g: Geografia = GEOGRAFIA_DEFECTO): string =>
  `E14-${ubicacionDeMesa(mesa, g).puesto}-${String(mesa).padStart(4, '0')}-03`;

export interface OpcionesJornada {
  geografia?: Geografia;
  /** Cuántas mesas transmiten (≤ geografia.mesas). */
  actas?: number;
  /** Duración simulada en minutos (antes de acelerar). */
  duracionMin?: number;
  /** Fracción de reenvíos (mismo idem): 0,04–0,11. */
  reenvios?: number;
  /** Fracción de actas dudosas (no cuadran): 0,06–0,09. */
  dudosas?: number;
  /** Correcciones (versión 2) de actas ya enviadas. */
  correcciones?: number;
  /** Ráfagas de 1 min a ~300 actas/min dentro del pico. */
  rafagas?: number;
  semilla?: number;
}

export type TipoEnvio = 'envio' | 'reenvio' | 'correccion';

export interface EnvioPlanificado {
  /** Momento simulado, en ms desde el inicio de la jornada. */
  enMs: number;
  tipo: TipoEnvio;
  acta: Acta;
}

/** PRNG mulberry32: rápido, determinista y suficiente para simular. */
export function aleatorio(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Instante (ms) del envío número k de n: 55 % en el primer tercio y el resto
 * repartido en los dos tercios siguientes; las ráfagas comprimen tramos.
 */
function instante(
  k: number,
  n: number,
  duracionMs: number,
  rafagas: Array<{ desde: number; hasta: number; inicioMs: number }>,
): number {
  const f = k / n;
  const tercio = duracionMs / 3;
  let t = f < 0.55 ? (f / 0.55) * tercio : tercio + ((f - 0.55) / 0.45) * (2 * tercio);
  for (const r of rafagas)
    if (f >= r.desde && f < r.hasta)
      t = r.inicioMs + ((f - r.desde) / (r.hasta - r.desde)) * 60_000;
  return t;
}

export function planJornada(op: OpcionesJornada = {}): EnvioPlanificado[] {
  const g = op.geografia ?? GEOGRAFIA_DEFECTO;
  const n = Math.min(op.actas ?? g.mesas, g.mesas);
  const duracionMs = (op.duracionMin ?? 120) * 60_000;
  const azar = aleatorio(op.semilla ?? 20261103);
  const reenvios = op.reenvios ?? 0.07;
  const dudosas = op.dudosas ?? 0.07;
  const correcciones = Math.min(op.correcciones ?? Math.round((180 * n) / 6400), n);

  // Ráfagas: tramos de ~300 actas (≈ 300/min) dentro del pico, sin solaparse.
  const anchoRafaga = Math.min(300 / n, 0.05);
  const rafagas: Array<{ desde: number; hasta: number; inicioMs: number }> = [];
  for (let i = 0; i < (op.rafagas ?? 3) && n >= 600; i++) {
    const desde = 0.05 + i * 0.15;
    if (desde + anchoRafaga >= 0.55) break;
    // Cada ráfaga ocupa un minuto entero del reloj simulado.
    const inicioMs = Math.floor(((desde / 0.55) * (duracionMs / 3)) / 60_000) * 60_000;
    rafagas.push({ desde, hasta: desde + anchoRafaga, inicioMs });
  }

  // Orden de transmisión: una permutación de las mesas.
  const mesas = Array.from({ length: g.mesas }, (_, i) => i + 1);
  for (let i = mesas.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1));
    [mesas[i], mesas[j]] = [mesas[j]!, mesas[i]!];
  }

  const plan: EnvioPlanificado[] = [];
  const originales: EnvioPlanificado[] = [];
  for (let k = 0; k < n; k++) {
    const mesa = mesas[k]!;
    const u = ubicacionDeMesa(mesa, g);
    const votos = {} as Votos;
    for (const c of CASILLAS)
      votos[c] = c.startsWith('C') ? 40 + Math.floor(azar() * 160) : Math.floor(azar() * 12);
    const suma = CASILLAS.reduce((s, c) => s + votos[c], 0);
    const descuadre = azar() < dudosas ? 1 + Math.floor(azar() * 5) : 0;
    const enMs = instante(k, n, duracionMs, rafagas);
    const acta: Acta = {
      acta: actaDeMesa(mesa, g),
      ...u,
      version: 1,
      jurado: juradoDeMesa(mesa),
      ts_cierre: 1_793_577_600 + Math.floor(enMs / 1000),
      votos,
      sufragantes: suma + descuadre,
      hash_foto: `sim-${mesa}`,
      idem: `sim${(op.semilla ?? 20261103).toString(36)}m${mesa}v1`,
    };
    const envio: EnvioPlanificado = { enMs, tipo: 'envio', acta };
    plan.push(envio);
    originales.push(envio);
    // Reenvío del mismo envío lógico (mismo idem) entre 1 y 30 s después.
    if (azar() < reenvios)
      plan.push({ enMs: enMs + 1000 + azar() * 29_000, tipo: 'reenvio', acta });
  }

  // Correcciones: versión 2 de actas ya transmitidas, entre 2 y 20 min después.
  for (let i = 0; i < correcciones; i++) {
    const base = originales[Math.floor(azar() * originales.length)]!;
    if (
      base.acta.version !== 1 ||
      plan.some((e) => e.tipo === 'correccion' && e.acta.acta === base.acta.acta)
    )
      continue;
    const votos = { ...base.acta.votos };
    const ajuste = 1 + Math.floor(azar() * 6);
    votos.C1 = Math.max(0, votos.C1 - ajuste);
    votos.C2 += ajuste;
    const corregida: Acta = {
      ...base.acta,
      version: 2,
      votos,
      // La corrección cuadra siempre: así resuelve también las dudosas.
      sufragantes: CASILLAS.reduce((s, c) => s + votos[c], 0),
      idem: base.acta.idem.replace(/v1$/, 'v2'),
    };
    plan.push({
      enMs: Math.min(duracionMs, base.enMs + 120_000 + azar() * 1_080_000),
      tipo: 'correccion',
      acta: corregida,
    });
  }

  return plan.sort((a, b) => a.enMs - b.enMs);
}

/** Resumen del plan, para mostrar antes de empezar y para el informe. */
export function resumenPlan(plan: EnvioPlanificado[], duracionMin = 120) {
  const envios = plan.filter((e) => e.tipo === 'envio');
  const corte = (duracionMin / 3) * 60_000;
  const porMinuto = new Map<number, number>();
  for (const e of plan)
    porMinuto.set(
      Math.floor(e.enMs / 60_000),
      (porMinuto.get(Math.floor(e.enMs / 60_000)) ?? 0) + 1,
    );
  return {
    actas: envios.length,
    reenvios: plan.filter((e) => e.tipo === 'reenvio').length,
    correcciones: plan.filter((e) => e.tipo === 'correccion').length,
    dudosas: envios.filter(
      (e) => CASILLAS.reduce((s, c) => s + e.acta.votos[c], 0) !== e.acta.sufragantes,
    ).length,
    fraccionPrimerTercio: envios.filter((e) => e.enMs < corte).length / Math.max(1, envios.length),
    maximoPorMinuto: Math.max(0, ...porMinuto.values()),
    solicitudes: plan.length,
  };
}
