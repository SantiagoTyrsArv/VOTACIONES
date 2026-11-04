import { RedisChannels, type ActaNotice } from '@votaciones/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { RedisClient } from '../../infra/RedisConnections.js';

/** Lo que la ventana de agregación necesita del rastreador de tópicos sucios. */
export interface DirtyTopicSource {
  markAll(): void;
  take(filter: (topic: string) => boolean): string[];
}

/**
 * Backplane de difusión: escucha el canal global ch:actas y marca como "sucios" los tópicos
 * que tienen suscriptores en ESTA instancia.
 *
 * Diseño del espacio de canales: un solo canal global. Con ~50.000 clientes por instancia,
 * casi todas las instancias tienen suscriptores de casi todos los municipios, así que un canal
 * por municipio no ahorraría tráfico y sí obligaría a suscribir/desuscribir dinámicamente.
 * Tráfico entre instancias: ~90 avisos/min × 8 instancias en el pico; despreciable.
 *
 * Pub/Sub no tiene memoria: si un aviso se pierde (Redis reconectando), al volver "ready"
 * se marcan todos los tópicos activos como sucios y la ventana relee los streams.
 */
export class DirtyTopicTracker implements DirtyTopicSource {
  private readonly dirty = new Set<string>();
  private subscribed = false;

  constructor(
    private readonly subscriber: RedisClient,
    private readonly isRelevant: (topic: string) => boolean,
    private readonly activeTopics: () => Iterable<string>,
    private readonly onNotice: (notice: ActaNotice) => void,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async start(): Promise<void> {
    this.subscriber.on('ready', () => {
      // Tras una reconexión node-redis restaura la suscripción, pero lo publicado mientras
      // tanto se perdió: forzamos una relectura de los streams.
      if (this.subscribed) this.markAll();
      else void this.subscribe();
    });
    await this.subscribe();
  }

  /** Marca todos los tópicos con suscriptores locales (relectura de seguridad). */
  markAll(): void {
    for (const topic of this.activeTopics()) this.dirty.add(topic);
  }

  /** Extrae los tópicos sucios que cumplen el filtro (p. ej. excluir "dep" hasta su ventana). */
  take(filter: (topic: string) => boolean): string[] {
    const taken: string[] = [];
    for (const topic of this.dirty) {
      if (filter(topic)) {
        taken.push(topic);
        this.dirty.delete(topic);
      }
    }
    return taken;
  }

  private async subscribe(): Promise<void> {
    if (this.subscribed) return;
    try {
      await this.subscriber.subscribe(RedisChannels.actas, (raw: string) => this.handle(raw));
      this.subscribed = true;
      this.markAll();
      this.logger.info(`Suscrito a ${RedisChannels.actas}`);
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, `No se pudo suscribir a ${RedisChannels.actas}; se reintentará`);
    }
  }

  private handle(raw: string): void {
    let notice: ActaNotice;
    try {
      notice = JSON.parse(raw) as ActaNotice;
    } catch {
      this.logger.warn('Aviso de acta con formato inválido');
      return;
    }
    this.onNotice(notice);
    for (const topic of notice.topics ?? []) {
      if (this.isRelevant(topic)) this.dirty.add(topic);
    }
  }
}
