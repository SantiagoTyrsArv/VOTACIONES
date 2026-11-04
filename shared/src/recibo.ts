/**
 * Respuestas inequívocas al jurado (RF-1). Toda transmisión recibe exactamente
 * una de estas respuestas, también los reenvíos.
 */

export const ESTADOS = {
  /** Primera vez que se registra esta versión; ya suma al acumulado. */
  REGISTRADA: 'REGISTRADA',
  /** Reenvío de algo ya registrado: se devuelve el recibo ORIGINAL. */
  YA_REGISTRADA: 'YA_REGISTRADA',
  /** Ya hay una versión igual o más alta; se devuelve el recibo vigente. */
  VERSION_OBSOLETA: 'VERSION_OBSOLETA',
  /** Registrada, pero no cuadra la regla contable: no suma, va a verificación. */
  DUDOSA_EN_VERIFICACION: 'DUDOSA_EN_VERIFICACION',
  /** Formato inválido o inconsistente: reintentar no sirve, hay que corregir. */
  RECHAZADA: 'RECHAZADA',
  /** Redis no respondió: NO quedó registrada; la cola local reintenta sola. */
  NO_REGISTRADA: 'NO_REGISTRADA',
  /** Límite de tasa excedido: NO quedó registrada; reintentar tras `reintentar_en_ms`. */
  LIMITE_EXCEDIDO: 'LIMITE_EXCEDIDO',
} as const;

export type Estado = (typeof ESTADOS)[keyof typeof ESTADOS];

/**
 * Estados después de los cuales el jurado NO debe reintentar el mismo envío.
 * NO_REGISTRADA y LIMITE_EXCEDIDO son transitorios: la cola sigue intentando.
 */
export const ESTADOS_FINALES: ReadonlySet<Estado> = new Set<Estado>([
  ESTADOS.REGISTRADA,
  ESTADOS.YA_REGISTRADA,
  ESTADOS.VERSION_OBSOLETA,
  ESTADOS.DUDOSA_EN_VERIFICACION,
  ESTADOS.RECHAZADA,
]);

export const esEstadoFinal = (e: Estado): boolean => ESTADOS_FINALES.has(e);

export const MOTIVOS_RECHAZO = {
  FORMATO: 'FORMATO',
  MESA_DESCONOCIDA: 'MESA_DESCONOCIDA',
  UBICACION_INCONSISTENTE: 'UBICACION_INCONSISTENTE',
  CONFLICTO_VERSION: 'CONFLICTO_VERSION',
  IDEM_REUTILIZADO: 'IDEM_REUTILIZADO',
  // Autenticación del jurado (credencial firmada).
  NO_AUTORIZADO: 'NO_AUTORIZADO',
  MESA_NO_ASIGNADA: 'MESA_NO_ASIGNADA',
  // Solo en la resolución de un caso de verificación (RF-7).
  STALE_TOKEN: 'STALE_TOKEN',
  INVALID_CASE: 'INVALID_CASE',
  RESOLUCION_CONFLICTO: 'RESOLUCION_CONFLICTO',
} as const;

export type MotivoRechazo = (typeof MOTIVOS_RECHAZO)[keyof typeof MOTIVOS_RECHAZO];

/**
 * Comprobante que emite el script Lua en el mismo paso atómico en que aplica el
 * acta. Se guarda en `idem:{idem}` y en `acta:{id}`; nunca existe un recibo
 * sin registro ni un registro sin recibo.
 */
export interface Recibo {
  /** Consecutivo global, p. ej. `R-000123`. */
  recibo: string;
  acta: string;
  version: number;
  /** Estado con el que quedó la versión al registrarse. */
  estado: typeof ESTADOS.REGISTRADA | typeof ESTADOS.DUDOSA_EN_VERIFICACION | typeof ESTADOS.RECHAZADA;
  idem: string;
  /** Hora de Redis (ms) en que se registró: común a las 8 instancias. */
  ts: number;
  /** Instancia que ejecutó el registro. */
  instancia: string;
}

/** Respuesta que recibe el jurado por WebSocket o por `POST /actas`. */
export interface RespuestaIngesta {
  estado: Estado;
  /** Recibo original (YA_REGISTRADA), nuevo (REGISTRADA/DUDOSA) o vigente (VERSION_OBSOLETA). */
  recibo?: Recibo;
  motivo?: MotivoRechazo;
  /** Explicación legible para mostrar al jurado. */
  detalle?: string;
  /** Solo en NO_REGISTRADA / LIMITE_EXCEDIDO. */
  reintentar_en_ms?: number;
  /** Instancia que respondió (RT-1). */
  instancia: string;
}
