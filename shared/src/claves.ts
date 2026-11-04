/**
 * Espacio de nombres de Redis. Todas las instancias y los scripts Lua usan
 * exactamente estas claves; cualquier cambio es un cambio de contrato.
 *
 * Dueños: A escribe acumulados, actas, idempotencia, streams de resultados y
 * límite de tasa. B lee acumulados y streams. C es dueño de bloqueos,
 * presencia y la cola de verificación (A solo encola actas dudosas).
 */

/** Tópicos a los que se suscribe el público. */
export type Topico = 'dep' | `mun:${number}` | `pue:${number}`;

export const topico = {
  dep: (): Topico => 'dep',
  mun: (m: number): Topico => `mun:${m}`,
  pue: (p: number): Topico => `pue:${p}`,
};

/** Tópicos que toca un acta, del más fino al más grueso. */
export const topicosDeActa = (a: { puesto: number; municipio: number }): Topico[] => [
  topico.pue(a.puesto),
  topico.mun(a.municipio),
  topico.dep(),
];

export const claves = {
  // ── Acumulados (Hash: un campo por casilla + sufragantes + mesas_inf + mesas_tot)
  totMesa: (n: number) => `tot:mesa:${n}`,
  tot: (t: Topico) => `tot:${t}`,
  // ── Ranking de candidatos (Sorted Set: miembro = candidato, score = votos)
  rank: (t: Topico) => `rank:${t}`,
  // ── Historial para recuperación (Stream). Ids monótonos comunes a todas las instancias.
  stream: (t: Topico) => `st:${t}`,
  // ── Estado de cada acta (Hash: version, estado, votos, votos_aplicados, recibo, firma…)
  acta: (id: string) => `acta:${id}`,
  // ── Idempotencia (String con el recibo JSON, EX 24 h)
  idem: (idem: string) => `idem:${idem}`,
  // ── Catálogo de mesas (Hash: puesto, municipio). Lo carga el generador.
  catMesa: (n: number) => `cat:mesa:${n}`,
  // ── Consecutivo de recibos
  seqRecibo: () => 'seq:recibo',
  // ── Límite de tasa: ventana fija de 60 s por credencial
  limite: (credencial: string, ventana: number) => `rl:${credencial}:${ventana}`,
  // ── Asignación jurado → mesas (la carga el generador de catálogo)
  mesasJurado: (jurado: string) => `jur:${jurado}:mesas`,
  // ── Verificación (dueño C; A encola dudosas y conflictos)
  verifCasos: () => 'verif:casos',
  verifCola: () => 'verif:cola',
  verifAsignados: () => 'verif:asignados',
  lockCaso: (id: string) => `lock:caso:${id}`,
  fenceCaso: (id: string) => `fence:caso:${id}`,
  presAud: () => 'pres:aud',
  presInfo: () => 'pres:info',
  /** Idempotencia de la resolución de un caso: una por toma (token de cercado). */
  resolucion: (id: string, token: string) => `resolucion:${id}:${token}`,
  streamVerif: () => 'st:verif',
} as const;

export const canales = {
  /** Aviso compacto por cada acta aplicada (sin memoria: solo "hay algo nuevo"). */
  actas: 'ch:actas',
  /** Cambios en la cola de verificación. */
  verif: 'ch:verif',
} as const;

/** Retenciones acordadas. */
export const RETENCION = {
  /** Tope de seguridad por stream (XADD MAXLEN ~). */
  STREAM_MAXLEN: 10_000,
  /** Vida de la clave de idempotencia. */
  IDEM_TTL_S: 86_400,
  /** Ventana del límite de tasa. */
  LIMITE_VENTANA_S: 60,
} as const;
