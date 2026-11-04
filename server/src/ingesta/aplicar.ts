/**
 * Puente TypeScript ↔ aplicar_acta.lua: arma KEYS/ARGV desde el contrato y
 * traduce la respuesta del script a una RespuestaIngesta.
 */
import {
  CANDIDATOS,
  CASILLAS,
  RETENCION,
  canales,
  claves,
  firmaContenido,
  topico,
  type Acta,
  type Estado,
  type MotivoRechazo,
  type Recibo,
  type RespuestaIngesta,
} from '@votaciones/shared';
import type { Resolution } from '@votaciones/shared/verificacion';
import type { ConexionRedis } from '../redis/conexion.js';

export type ModoAplicacion = 'jurado' | 'verificacion' | 'resolucion';

/** Lo que el auditor resolvió, con la concesión que lo autoriza (RF-7). */
export interface ResolucionContexto {
  caseId: string;
  token: string;
  actorId: string;
  sessionId: string;
  resolution: Resolution;
}

export function clavesDeActa(a: Acta, resolucion?: ResolucionContexto): string[] {
  const pue = topico.pue(a.puesto);
  const mun = topico.mun(a.municipio);
  const dep = topico.dep();
  return [
    resolucion ? claves.resolucion(a.acta, resolucion.token) : claves.idem(a.idem),
    claves.acta(a.acta),
    claves.catMesa(a.mesa),
    claves.totMesa(a.mesa),
    claves.tot(pue),
    claves.tot(mun),
    claves.tot(dep),
    claves.rank(pue),
    claves.rank(mun),
    claves.rank(dep),
    claves.stream(pue),
    claves.stream(mun),
    claves.stream(dep),
    claves.seqRecibo(),
    claves.verifCola(),
    claves.streamVerif(),
    claves.verifCasos(),
    claves.verifAsignados(),
    claves.lockCaso(a.acta),
    claves.fenceCaso(a.acta),
    claves.presAud(),
    claves.presInfo(),
    claves.mesasJurado(a.jurado),
  ];
}

export function argumentosDeActa(
  a: Acta,
  instancia: string,
  modo: ModoAplicacion,
  resolucion?: ResolucionContexto,
  exigirAsignacion = false,
): string[] {
  return [
    JSON.stringify(a),
    CASILLAS.join(','),
    CANDIDATOS.join(','),
    firmaContenido(a),
    instancia,
    String(RETENCION.IDEM_TTL_S),
    String(RETENCION.STREAM_MAXLEN),
    canales.actas,
    canales.verif,
    modo,
    resolucion ? JSON.stringify(resolucion) : '',
    exigirAsignacion ? '1' : '0',
  ];
}

const DETALLES: Record<string, string> = {
  REGISTRADA: 'Acta registrada.',
  YA_REGISTRADA: 'Esta acta ya estaba registrada; se devuelve el recibo original.',
  VERSION_OBSOLETA: 'Ya hay registrada una versión más reciente de esta acta.',
  DUDOSA_EN_VERIFICACION: 'El acta no cuadra y quedó en verificación; no suma al preconteo.',
  MESA_DESCONOCIDA: 'La mesa no existe en el catálogo.',
  UBICACION_INCONSISTENTE: 'El puesto o municipio no corresponde a la mesa.',
  CONFLICTO_VERSION:
    'Ya existe esta misma versión con otros valores. Si es una corrección, envíela como una versión nueva.',
  IDEM_REUTILIZADO: 'La clave de envío ya se usó para otra acta o versión.',
  NO_AUTORIZADO: 'La credencial falta, venció o no corresponde al jurado del acta.',
  MESA_NO_ASIGNADA: 'La mesa no está asignada a este jurado.',
  STALE_TOKEN: 'El bloqueo, la sesión o la versión del caso ya no son vigentes.',
  INVALID_CASE: 'El caso de verificación no coincide con el acta registrada.',
  RESOLUCION_CONFLICTO: 'Esta toma del caso ya se resolvió con otra decisión.',
};

export interface OpcionesAplicacion {
  /** Con credenciales activas, la mesa debe estar en jur:{jurado}:mesas. */
  exigirAsignacion?: boolean;
}

/** Ejecuta el script y traduce su respuesta. Propaga errores de Redis. */
export async function aplicarActa(
  redis: ConexionRedis,
  acta: Acta,
  instancia: string,
  modo: ModoAplicacion = 'jurado',
  resolucion?: ResolucionContexto,
  opciones: OpcionesAplicacion = {},
): Promise<RespuestaIngesta> {
  if ((modo === 'resolucion') !== (resolucion !== undefined)) {
    throw new Error('El modo resolucion exige (solo él) un contexto de resolución');
  }
  const [estado, reciboJson, motivo] = await redis.script<[string, string, string]>(
    'aplicar_acta',
    clavesDeActa(acta, resolucion),
    argumentosDeActa(acta, instancia, modo, resolucion, opciones.exigirAsignacion),
  );
  const r: RespuestaIngesta = { estado: estado as Estado, instancia };
  if (reciboJson) r.recibo = JSON.parse(reciboJson) as Recibo;
  if (motivo) r.motivo = motivo as MotivoRechazo;
  r.detalle = DETALLES[motivo || estado] ?? estado;
  return r;
}
