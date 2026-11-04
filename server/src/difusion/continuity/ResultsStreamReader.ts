import { RedisKeys, Topic, type StreamId, type Totals } from '@votaciones/shared';
import type { RedisClient } from '../../infra/RedisConnections.js';
import { toNumberRecord, toStreamRecords, type StreamRecord } from './StreamRecord.js';

export interface StreamWindow {
  /** Primera entrada que aún conserva el stream (si el cursor es anterior, fue recortado). */
  first: StreamId | null;
  /** Última entrada del stream. */
  last: StreamId | null;
  /** Entradas posteriores al cursor (exclusivo), máximo "count". */
  records: StreamRecord[];
}

export interface TopicSnapshot {
  totals: Totals;
  /** Id de la última entrada incluida en esos totales; null si el tópico aún no tiene actas. */
  lastId: StreamId | null;
}

/** Fuente de resultados por tópico. En producción es Redis; en pruebas, memoria. */
export interface ResultsSource {
  readAfter(topic: string, after: StreamId | null, count: number): Promise<StreamRecord[]>;
  readWindow(topic: string, after: StreamId | null, count: number): Promise<StreamWindow>;
  snapshot(topic: string): Promise<TopicSnapshot>;
}

/**
 * Acceso de solo lectura a los Streams st:{tópico} y Hashes tot:{tópico} que escribe
 * aplicar_acta.lua (Persona A). Pub/Sub NUNCA es la fuente de recuperación: lo es el stream.
 */
export class ResultsStreamReader implements ResultsSource {
  constructor(private readonly redis: RedisClient) {}

  /** XRANGE st:{tópico} (cursor + : lo nuevo desde el último id enviado. */
  async readAfter(topic: string, after: StreamId | null, count: number): Promise<StreamRecord[]> {
    const reply = await this.redis.xRange(streamKey(topic), exclusiveStart(after), '+', { COUNT: count });
    return toStreamRecords(reply);
  }

  /**
   * Lee en un solo MULTI los extremos del stream y lo posterior al cursor, para decidir
   * sin carreras si el cursor fue recortado o si el cliente está demasiado atrás.
   */
  async readWindow(topic: string, after: StreamId | null, count: number): Promise<StreamWindow> {
    const key = streamKey(topic);
    const replies = (await this.redis
      .multi()
      .xRange(key, '-', '+', { COUNT: 1 })
      .xRevRange(key, '+', '-', { COUNT: 1 })
      .xRange(key, exclusiveStart(after), '+', { COUNT: count })
      .exec()) as unknown[];
    return {
      first: toStreamRecords(replies[0])[0]?.id ?? null,
      last: toStreamRecords(replies[1])[0]?.id ?? null,
      records: toStreamRecords(replies[2]),
    };
  }

  /**
   * Fotografía coherente: totales + id de la última entrada, leídos en la misma
   * transacción MULTI/EXEC (Redis la ejecuta sin intercalar otros comandos), de modo que
   * el id corresponde exactamente a esos totales. Si A publica leer_topico.lua, puede
   * reemplazar este método sin cambiar a quien lo usa.
   */
  async snapshot(topic: string): Promise<TopicSnapshot> {
    const parsed = Topic.parse(topic);
    const replies = (await this.redis
      .multi()
      .hGetAll(RedisKeys.totals(parsed))
      .xRevRange(RedisKeys.resultsStream(parsed), '+', '-', { COUNT: 1 })
      .exec()) as unknown[];
    return {
      totals: toNumberRecord(replies[0]),
      lastId: toStreamRecords(replies[1])[0]?.id ?? null,
    };
  }
}

function streamKey(topic: string): string {
  return RedisKeys.resultsStream(Topic.parse(topic));
}

function exclusiveStart(after: StreamId | null): string {
  return after ? `(${after.toString()}` : '-';
}
