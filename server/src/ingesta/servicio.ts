/**
 * Servicio de ingesta: el mismo camino para WebSocket y POST /actas.
 *
 *   validar formato → límite de tasa → aplicar_acta.lua → respuesta
 *
 * La respuesta se construye SOLO después de que el script terminó. Si Redis
 * no responde, la respuesta es NO_REGISTRADA (nunca un silencio, nunca un
 * "ok" optimista).
 */
import {
  ESTADOS,
  MOTIVOS_RECHAZO,
  RETENCION,
  claves,
  validarActa,
  type RespuestaIngesta,
} from '@votaciones/shared';
import { ErrorReply } from 'redis';
import { CircuitoAbierto } from '../redis/circuito.js';
import type { ConexionRedis } from '../redis/conexion.js';
import { aplicarActa } from './aplicar.js';

export interface OpcionesIngesta {
  redis: ConexionRedis;
  instancia: string;
  limiteActasPorMinuto: number;
}

/**
 * Quién envía. `null` = credenciales desactivadas (desarrollo y pruebas):
 * se confía en `acta.jurado`. Con credenciales, el transporte ya verificó la
 * firma y entrega aquí el jurado que dice la credencial.
 */
export type JuradoAutenticado = string | null;

/** Contadores locales de la instancia; C los expone en el tablero (RT-7). */
export interface MetricasIngesta {
  porEstado: Record<string, number>;
  /** Duración de aplicar_acta en ms (últimas 1.000 muestras). */
  latenciasMs: number[];
}

export class ServicioIngesta {
  readonly metricas: MetricasIngesta = { porEstado: {}, latenciasMs: [] };

  constructor(private readonly op: OpcionesIngesta) {}

  async recibir(entrada: unknown, jurado: JuradoAutenticado = null): Promise<RespuestaIngesta> {
    const r = await this.procesar(entrada, jurado);
    this.metricas.porEstado[r.estado] = (this.metricas.porEstado[r.estado] ?? 0) + 1;
    return r;
  }

  private async procesar(entrada: unknown, jurado: JuradoAutenticado): Promise<RespuestaIngesta> {
    const { instancia, redis } = this.op;

    const v = validarActa(entrada);
    if (!v.ok) {
      return {
        estado: ESTADOS.RECHAZADA,
        motivo: MOTIVOS_RECHAZO.FORMATO,
        detalle: v.errores.join('; '),
        instancia,
      };
    }
    const acta = v.acta;
    if (jurado !== null && acta.jurado !== jurado) {
      return {
        estado: ESTADOS.RECHAZADA,
        motivo: MOTIVOS_RECHAZO.NO_AUTORIZADO,
        detalle: 'La credencial no corresponde al jurado del acta.',
        instancia,
      };
    }

    try {
      // El límite cuenta por credencial verificada, no por el campo del cuerpo.
      const limite = await this.revisarLimite(jurado ?? acta.jurado);
      if (limite) return limite;

      const t0 = performance.now();
      const r = await aplicarActa(redis, acta, instancia, 'jurado', undefined, {
        exigirAsignacion: jurado !== null,
      });
      this.registrarLatencia(performance.now() - t0);
      return r;
    } catch (e) {
      if (e instanceof ErrorReply) {
        // Error del script: es un defecto nuestro, no del jurado. Se trata
        // como no registrada para que la cola lo conserve.
        console.error('[ingesta] error en aplicar_acta.lua', e.message);
      }
      return {
        estado: ESTADOS.NO_REGISTRADA,
        detalle: 'Consolidación no disponible. El acta NO quedó registrada; se reintentará sola.',
        reintentar_en_ms: e instanceof CircuitoAbierto ? Math.max(e.reintentarEnMs, 500) : 1000,
        instancia,
      };
    }
  }

  /** Ventana fija de 60 s por jurado (papel "límite de tasa" de Redis). */
  private async revisarLimite(jurado: string): Promise<RespuestaIngesta | null> {
    const ventana = Math.floor(Date.now() / 1000 / RETENCION.LIMITE_VENTANA_S);
    const [permitido, , pttl] = await this.op.redis.script<[number, number, number]>(
      'limite_tasa',
      [claves.limite(jurado, ventana)],
      [String(this.op.limiteActasPorMinuto), String(RETENCION.LIMITE_VENTANA_S)],
    );
    if (permitido === 1) return null;
    return {
      estado: ESTADOS.LIMITE_EXCEDIDO,
      detalle: `Demasiados envíos de ${jurado} en el último minuto. El acta NO quedó registrada; se reintentará sola.`,
      reintentar_en_ms: Math.max(pttl, 1000),
      instancia: this.op.instancia,
    };
  }

  private registrarLatencia(ms: number): void {
    const l = this.metricas.latenciasMs;
    l.push(ms);
    if (l.length > 1000) l.shift();
  }
}
