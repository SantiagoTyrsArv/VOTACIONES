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
} from '@preconteo/shared';
import type { ConexionRedis } from '../redis/conexion.js';

export type ModoAplicacion = 'jurado' | 'verificacion';

export function clavesDeActa(a: Acta): string[] {
  const pue = topico.pue(a.puesto);
  const mun = topico.mun(a.municipio);
  const dep = topico.dep();
  return [
    claves.idem(a.idem),
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
  ];
}

export function argumentosDeActa(a: Acta, instancia: string, modo: ModoAplicacion): string[] {
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
  ];
}

const DETALLES: Record<string, string> = {
  REGISTRADA: 'Acta registrada. Ya suma al preconteo.',
  YA_REGISTRADA: 'Esta acta ya estaba registrada; este es su recibo original.',
  VERSION_OBSOLETA: 'Ya hay registrada una versión igual o más reciente de esta acta.',
  DUDOSA_EN_VERIFICACION:
    'Acta registrada, pero la suma de votos no coincide con los sufragantes: pasa a verificación y no suma hasta resolverse.',
  MESA_DESCONOCIDA: 'La mesa no existe en el catálogo.',
  UBICACION_INCONSISTENTE: 'El puesto o municipio no corresponde a la mesa.',
  CONFLICTO_VERSION:
    'Ya existe esta misma versión con otros valores. Si es una corrección, envíela como una versión nueva.',
  IDEM_REUTILIZADO: 'La clave de envío ya se usó para otra acta o versión.',
};

/** Ejecuta el script y traduce su respuesta. Propaga errores de Redis. */
export async function aplicarActa(
  redis: ConexionRedis,
  acta: Acta,
  instancia: string,
  modo: ModoAplicacion = 'jurado',
): Promise<RespuestaIngesta> {
  const [estado, reciboJson, motivo] = await redis.script<[string, string, string]>(
    'aplicar_acta',
    clavesDeActa(acta),
    argumentosDeActa(acta, instancia, modo),
  );
  const r: RespuestaIngesta = { estado: estado as Estado, instancia };
  if (reciboJson) r.recibo = JSON.parse(reciboJson) as Recibo;
  if (motivo) r.motivo = motivo as MotivoRechazo;
  r.detalle = DETALLES[motivo || estado] ?? estado;
  return r;
}
