import { Topic } from './topic.js';

/**
 * Espacio de nombres de Redis. ÚNICA fuente de verdad para los nombres de claves.
 * Dueños (ver documento de diseño):
 *  - A (ingesta): acumulados, actas, idempotencia, streams de resultados, límite de tasa.
 *  - B (difusión): consume streams y canal ch:actas; no escribe acumulados.
 *  - C (verificación): cola, bloqueos, cercado, presencia, stream de verificación.
 */
export const RedisKeys = {
  // --- Acumulados (Hash): un campo por candidato + sufragantes + mesas_inf + mesas_total
  totals(topic: Topic): string {
    return `tot:${topic.toString()}`;
  },
  tableTotals(mesa: number): string {
    return `tot:mesa:${mesa}`;
  },
  /** Ranking de candidatos (Sorted Set, score = votos). */
  ranking(topic: Topic): string {
    return `rank:${topic.toString()}`;
  },

  // --- Historial para recuperación (Stream): una entrada por acta aplicada en ese tópico
  resultsStream(topic: Topic): string {
    return `st:${topic.toString()}`;
  },

  // --- Actas e idempotencia
  acta(actaId: string): string {
    return `acta:${actaId}`;
  },
  idempotency(idem: string): string {
    return `idem:${idem}`;
  },
  rateLimit(credential: string, window: number): string {
    return `rl:${credential}:${window}`;
  },

  // --- Verificación
  verificationQueue: 'verif:cola',
  verificationStream: 'st:verif',
  caseLock(actaId: string): string {
    return `lock:caso:${actaId}`;
  },
  caseFence(actaId: string): string {
    return `fence:caso:${actaId}`;
  },
  presenceIndex: 'pres:aud',
  presenceInfo: 'pres:info',
} as const;

/** Canales Pub/Sub. Sin memoria: solo sirven de "timbre", nunca como fuente de recuperación. */
export const RedisChannels = {
  /** Aviso compacto cada vez que un acta modifica acumulados. */
  actas: 'ch:actas',
  /** Eventos de la cola de verificación para las consolas de auditores. */
  verification: 'ch:verif',
} as const;
