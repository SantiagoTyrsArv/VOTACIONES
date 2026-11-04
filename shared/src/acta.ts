/**
 * Mensaje de transmisión de acta (enunciado, sección 3.1) y su validación de
 * formato. La validación es pura (sin Redis) para que la usen por igual el
 * servidor y la PWA del jurado antes de encolar.
 */

/** Candidatos de la corporación. Cambiar esta lista es un cambio de contrato. */
export const CANDIDATOS = ['C1', 'C2', 'C3'] as const;

/** Casillas no nominales que también cuentan en la regla contable. */
export const CASILLAS_ESPECIALES = ['BLANCO', 'NULO', 'NO_MARCADO'] as const;

/** Todas las casillas que debe traer `votos`, en orden canónico. */
export const CASILLAS = [...CANDIDATOS, ...CASILLAS_ESPECIALES] as const;

export type Candidato = (typeof CANDIDATOS)[number];
export type Casilla = (typeof CASILLAS)[number];
export type Votos = Record<Casilla, number>;

export interface Acta {
  /** Identificador del acta: `E14-{puesto}-{mesa local}-{corporación}`. */
  acta: string;
  /** Número global de la mesa (único en el departamento). */
  mesa: number;
  puesto: number;
  municipio: number;
  /** 1 para el envío original; 2, 3… para cada corrección. */
  version: number;
  jurado: string;
  /** Cierre de la mesa en segundos Unix. */
  ts_cierre: number;
  votos: Votos;
  sufragantes: number;
  /** Hash de la foto del acta física (la foto no viaja por este canal). */
  hash_foto: string;
  /** Clave de idempotencia: una por envío lógico, igual en cada reintento. */
  idem: string;
}

export const PATRON_ACTA = /^E14-(\d{1,4})-(\d{4})-(\d{2})$/;
export const PATRON_IDEM = /^[A-Za-z0-9_-]{8,64}$/;
export const PATRON_JURADO = /^JUR-\d{1,8}$/;

export type ResultadoValidacion =
  | { ok: true; acta: Acta }
  | { ok: false; errores: string[] };

const esEnteroNoNegativo = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const esEnteroPositivo = (v: unknown): v is number =>
  esEnteroNoNegativo(v) && v > 0;

/**
 * Valida el FORMATO del acta (tipos, rangos, campos obligatorios).
 * No valida la regla contable: un acta que no cuadra es válida en formato y
 * se registra como dudosa (ver `cuadraContable`).
 */
export function validarActa(entrada: unknown): ResultadoValidacion {
  const errores: string[] = [];
  if (typeof entrada !== 'object' || entrada === null || Array.isArray(entrada)) {
    return { ok: false, errores: ['el acta debe ser un objeto JSON'] };
  }
  const a = entrada as Record<string, unknown>;

  if (typeof a.acta !== 'string' || !PATRON_ACTA.test(a.acta)) {
    errores.push('acta: debe tener la forma E14-PPP-MMMM-CC');
  }
  if (!esEnteroPositivo(a.mesa)) errores.push('mesa: entero positivo');
  if (!esEnteroPositivo(a.puesto)) errores.push('puesto: entero positivo');
  if (!esEnteroPositivo(a.municipio)) errores.push('municipio: entero positivo');
  if (!esEnteroPositivo(a.version) || (a.version as number) > 999) {
    errores.push('version: entero entre 1 y 999');
  }
  if (typeof a.jurado !== 'string' || !PATRON_JURADO.test(a.jurado)) {
    errores.push('jurado: debe tener la forma JUR-NNNN');
  }
  if (!esEnteroPositivo(a.ts_cierre)) errores.push('ts_cierre: segundos Unix');
  if (!esEnteroNoNegativo(a.sufragantes)) errores.push('sufragantes: entero ≥ 0');
  if (typeof a.hash_foto !== 'string' || a.hash_foto.length < 4 || a.hash_foto.length > 128) {
    errores.push('hash_foto: texto de 4 a 128 caracteres');
  }
  if (typeof a.idem !== 'string' || !PATRON_IDEM.test(a.idem)) {
    errores.push('idem: 8 a 64 caracteres [A-Za-z0-9_-]');
  }

  if (typeof a.votos !== 'object' || a.votos === null || Array.isArray(a.votos)) {
    errores.push('votos: objeto con una casilla por candidato y especiales');
  } else {
    const votos = a.votos as Record<string, unknown>;
    for (const casilla of CASILLAS) {
      if (!esEnteroNoNegativo(votos[casilla])) errores.push(`votos.${casilla}: entero ≥ 0`);
    }
    for (const clave of Object.keys(votos)) {
      if (!(CASILLAS as readonly string[]).includes(clave)) {
        errores.push(`votos.${clave}: casilla desconocida`);
      }
    }
  }

  // El puesto del identificador debe coincidir con el campo puesto.
  if (typeof a.acta === 'string' && esEnteroPositivo(a.puesto)) {
    const m = PATRON_ACTA.exec(a.acta);
    if (m && Number(m[1]) !== a.puesto) {
      errores.push('acta: el puesto del identificador no coincide con el campo puesto');
    }
  }

  if (errores.length > 0) return { ok: false, errores };

  // Copia canónica: solo los campos del contrato, votos en orden fijo.
  const votos = a.votos as Record<string, number>;
  const acta: Acta = {
    acta: a.acta as string,
    mesa: a.mesa as number,
    puesto: a.puesto as number,
    municipio: a.municipio as number,
    version: a.version as number,
    jurado: a.jurado as string,
    ts_cierre: a.ts_cierre as number,
    votos: Object.fromEntries(CASILLAS.map((c) => [c, votos[c]])) as Votos,
    sufragantes: a.sufragantes as number,
    hash_foto: a.hash_foto as string,
    idem: a.idem as string,
  };
  return { ok: true, acta };
}

/**
 * Regla contable del enunciado: suma de votos (candidatos + blanco) + nulos +
 * no marcados = sufragantes. Si no cuadra, el acta es dudosa.
 */
export function cuadraContable(acta: Pick<Acta, 'votos' | 'sufragantes'>): boolean {
  const total = CASILLAS.reduce((s, c) => s + acta.votos[c], 0);
  return total === acta.sufragantes;
}

/**
 * Firma del contenido de una versión. Dos envíos con el mismo número de
 * versión y distinta firma son un conflicto (RF-2).
 */
export function firmaContenido(acta: Pick<Acta, 'votos' | 'sufragantes' | 'hash_foto'>): string {
  return [...CASILLAS.map((c) => acta.votos[c]), acta.sufragantes, acta.hash_foto].join('|');
}
