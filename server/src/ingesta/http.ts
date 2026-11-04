/**
 * Respaldo HTTP de la ingesta: si el WebSocket no conecta (proxy, red muy
 * mala), la PWA reintenta por POST con la MISMA clave idem.
 */
import { ESTADOS, PATRON_ACTA, claves, type Estado, type RespuestaIngesta } from '@votaciones/shared';
import type { FastifyInstance } from 'fastify';
import type { ConexionRedis } from '../redis/conexion.js';
import type { ServicioIngesta } from './servicio.js';

export const CODIGO_HTTP: Record<Estado, number> = {
  [ESTADOS.REGISTRADA]: 201,
  [ESTADOS.YA_REGISTRADA]: 200,
  [ESTADOS.DUDOSA_EN_VERIFICACION]: 202,
  [ESTADOS.VERSION_OBSOLETA]: 409,
  [ESTADOS.RECHAZADA]: 422,
  [ESTADOS.NO_REGISTRADA]: 503,
  [ESTADOS.LIMITE_EXCEDIDO]: 429,
};

interface Dependencias {
  ingesta: ServicioIngesta;
  redis: ConexionRedis;
  instancia: string;
}

export function registrarHttpIngesta(http: FastifyInstance, dep: Dependencias): void {
  // JSON mal formado también recibe una respuesta del contrato.
  http.setErrorHandler((error, _req, rep) => {
    const err = error as { statusCode?: number; message?: string };
    const codigo = err.statusCode ?? 500;
    if (codigo >= 500) {
      console.error('[http]', err);
      return rep.code(500).send({ error: 'interno', instancia: dep.instancia });
    }
    const r: RespuestaIngesta = {
      estado: ESTADOS.RECHAZADA,
      motivo: 'FORMATO',
      detalle: err.message ?? 'solicitud inválida',
      instancia: dep.instancia,
    };
    return rep.code(codigo).send(r);
  });

  http.post('/actas', async (req, rep) => {
    const r = await dep.ingesta.recibir(req.body);
    if (r.reintentar_en_ms) rep.header('Retry-After', String(Math.ceil(r.reintentar_en_ms / 1000)));
    return rep.code(CODIGO_HTTP[r.estado]).send(r);
  });

  /** Estado vigente de un acta: el jurado puede confirmar qué quedó. */
  http.get<{ Params: { id: string } }>('/actas/:id', async (req, rep) => {
    if (!PATRON_ACTA.test(req.params.id)) return rep.code(400).send({ error: 'id de acta inválido' });
    try {
      const plano = await dep.redis.comando<string[]>([
        'HMGET', claves.acta(req.params.id), 'version', 'estado', 'recibo', 'conflicto',
      ]);
      const [version, estado, recibo, conflicto] = plano;
      if (!version) return rep.code(404).send({ acta: req.params.id, registrada: false, instancia: dep.instancia });
      return {
        acta: req.params.id,
        registrada: true,
        version: Number(version),
        estado,
        recibo: recibo ? JSON.parse(recibo) : null,
        conflicto: conflicto === '1',
        instancia: dep.instancia,
      };
    } catch {
      return rep.code(503).send({ error: 'consolidación no disponible', instancia: dep.instancia });
    }
  });
}
