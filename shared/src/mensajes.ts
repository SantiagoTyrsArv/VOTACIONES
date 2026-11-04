/**
 * Mensajes que cruzan fronteras entre personas: protocolo WebSocket de
 * jurados, aviso de Pub/Sub y entradas de los streams.
 */
import type { Acta, Casilla } from './acta.js';
import type { RespuestaIngesta } from './recibo.js';
import type { Topico } from './claves.js';

export const PROTOCOLO_JURADOS = 1;
export const RUTA_WS_JURADOS = '/ws/jurados';

// ─────────────────────────── WebSocket de jurados ───────────────────────────

/** Cliente → servidor. */
export type MensajeJurado = { tipo: 'acta'; acta: Acta };

/** Servidor → cliente. */
export type MensajeServidorJurado =
  | { tipo: 'bienvenida'; instancia: string; protocolo: number }
  /** Respuesta a un `acta`. Se correlaciona por `idem`. */
  | { tipo: 'respuesta'; idem: string; respuesta: RespuestaIngesta }
  /** El mensaje no se pudo interpretar (no es JSON o no tiene `tipo`). */
  | { tipo: 'error'; codigo: 'MENSAJE_INVALIDO'; detalle: string };

/** Código de cierre cuando el servidor se apaga de forma ordenada. */
export const CIERRE_APAGADO = 4001;

// ─────────────────────────── Pub/Sub ch:actas ───────────────────────────────

/**
 * Aviso que publica `aplicar_acta.lua` cuando cambia algún acumulado.
 * Es un timbre: lo que importa está en los streams, cuyos ids viajan aquí.
 */
export interface AvisoActa {
  acta: string;
  version: number;
  motivo: MotivoCambio;
  /** Stream id escrito en cada tópico tocado. */
  ids: Partial<Record<Topico, string>>;
  /** Hora de Redis (ms) en que se aplicó; sirve para medir acta→pantalla. */
  ts: number;
}

// ─────────────────────────── Streams st:{topico} ────────────────────────────

/**
 * - `nueva`: primera versión válida de la mesa.
 * - `correccion`: una versión más alta reemplaza a la vigente (delta).
 * - `retiro_dudosa`: llegó una versión más alta que no cuadra; se retira lo
 *    que la mesa sumaba hasta que verificación la resuelva.
 * - `verificacion`: un auditor resolvió el acta y su versión se aplicó.
 */
export type MotivoCambio = 'nueva' | 'correccion' | 'retiro_dudosa' | 'verificacion';

/**
 * Totales de un nivel. Además de las casillas lleva `sufragantes`,
 * `mesas_inf` (mesas que suman) y `mesas_tot` (mesas del catálogo).
 */
export type Totales = Partial<Record<Casilla | 'sufragantes' | 'mesas_inf' | 'mesas_tot', number>>;

/**
 * Entrada de `st:{topico}` tal como la entrega `XRANGE` (todos los campos son
 * texto en Redis; `delta` y `totales` van como JSON).
 */
export interface EntradaStream {
  tipo: 'acta';
  acta: string;
  mesa: string;
  version: string;
  /** Versión que se reemplazó ("0" si es nueva). */
  version_anterior: string;
  motivo: MotivoCambio;
  /** JSON de `Totales`: cambio que produjo esta acta en este nivel. */
  delta: string;
  /** JSON de `Totales`: totales del nivel DESPUÉS de aplicar. */
  totales: string;
  /** Hora de Redis en ms. */
  ts: string;
  instancia: string;
}

/** Fotografía atómica de un tópico (resultado de `leer_topico.lua`). */
export interface Fotografia {
  topico: Topico;
  totales: Totales;
  /** Candidatos de mayor a menor. */
  ranking: Array<{ candidato: string; votos: number }>;
  /** Último id del stream del tópico ("0-0" si está vacío). Coincide con `totales`. */
  ultimo_id: string;
}
