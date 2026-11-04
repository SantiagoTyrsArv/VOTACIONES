/**
 * Resolución de casos de verificación (RF-7) del lado de A.
 *
 * C valida el mensaje del auditor y entrega la orden; A la aplica con
 * aplicar_acta.lua en modo "resolucion". El mismo script comprueba la
 * concesión (lock, fencing token, sesión, presencia y actividad), cambia los
 * votos, escribe el recibo y cierra el caso: comprobar en Node y luego
 * aplicar dejaría una carrera (TOCTOU) con un auditor tardío.
 */
import { CASILLAS, claves, type Acta, type Votos } from '@votaciones/shared';
import type { ConexionRedis } from '../redis/conexion.js';
import type {
  ResolutionAdapter,
  ResolutionCommand,
} from '../verificacion/integration.js';
import type { OperationResult } from '../verificacion/store.js';
import { aplicarActa } from './aplicar.js';

export interface OpcionesResolucion {
  /** La conexión de A se crea al registrar el módulo; por eso se pide tarde. */
  redis: () => ConexionRedis | null;
  instancia: string;
}

/** Arma los votos finales: los del caso, o los corregidos por el auditor. */
function votosResueltos(actual: Votos, corregidos: Record<string, number> | undefined): Votos | null {
  if (!corregidos) return actual;
  const votos = {} as Votos;
  for (const casilla of CASILLAS) {
    const v = corregidos[casilla];
    if (v === undefined || !Number.isSafeInteger(v) || v < 0) return null;
    votos[casilla] = v;
  }
  if (Object.keys(corregidos).some((k) => !(CASILLAS as readonly string[]).includes(k))) return null;
  return votos;
}

export class ResolucionAtomica implements ResolutionAdapter {
  readonly status = 'connected' as const;
  readonly detail = 'Las resoluciones se aplican en aplicar_acta.lua junto con el cierre del caso.';

  constructor(private readonly op: OpcionesResolucion) {}

  async apply(_store: unknown, cmd: ResolutionCommand): Promise<OperationResult> {
    const redis = this.op.redis();
    if (!redis) return { code: 'UNAVAILABLE' };

    // Lectura previa solo para armar el acta; el script vuelve a validar todo.
    const plano = await redis.comando<string[]>(['HGETALL', claves.acta(cmd.caseId)]);
    const h: Record<string, string> = {};
    for (let i = 0; i < plano.length; i += 2) h[plano[i]!] = plano[i + 1]!;
    if (!h.version || !h.votos) return { code: 'INVALID_CASE' };

    const votos = votosResueltos(JSON.parse(h.votos) as Votos, cmd.resolution.votes);
    if (!votos) return { code: 'INVALID_VOTES' };
    const recibo = h.recibo ? (JSON.parse(h.recibo) as { idem?: string }) : {};

    const acta: Acta = {
      acta: cmd.caseId,
      mesa: Number(h.mesa),
      puesto: Number(h.puesto),
      municipio: Number(h.municipio),
      version: Number(h.version),
      jurado: h.jurado ?? '',
      ts_cierre: Number(h.ts_cierre ?? 0),
      votos,
      sufragantes: Number(h.sufragantes),
      hash_foto: h.hash_foto ?? '',
      idem: recibo.idem ?? `resolucion-${cmd.token}`,
    };

    const r = await aplicarActa(redis, acta, this.op.instancia, 'resolucion', {
      caseId: cmd.caseId,
      token: cmd.token,
      actorId: cmd.actor.identity.id,
      sessionId: cmd.actor.sessionId,
      resolution: cmd.resolution,
    });
    if (r.motivo === 'STALE_TOKEN' || r.motivo === 'INVALID_CASE') return { code: r.motivo };
    if (r.motivo === 'RESOLUCION_CONFLICTO') return { code: 'RESOLUTION_CONFLICT' };
    if (!r.recibo) return { code: 'UNAVAILABLE' };
    return { code: 'APPLIED', caseId: cmd.caseId, receipt: r.recibo.recibo };
  }
}
