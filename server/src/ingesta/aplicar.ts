import { readFileSync } from 'node:fs';
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
  type Resolution,
  type RespuestaIngesta,
} from '@votaciones/shared';
import type { RedisClient } from '../infra/RedisConnections.js';
import type { ConexionRedis } from '../redis/conexion.js';

export type ModoAplicacion = 'jurado' | 'verificacion' | 'resolucion';

export interface ResolucionContexto {
  caseId: string;
  token: string;
  actorId: string;
  sessionId: string;
  resolution: Resolution;
}

export function clavesDeActa(a: Acta, modo: ModoAplicacion = 'jurado'): string[] {
  const pue = topico.pue(a.puesto);
  const mun = topico.mun(a.municipio);
  const dep = topico.dep();
  return [
    modo === 'resolucion' ? claves.resolucion(a.acta) : claves.idem(a.idem),
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
  ];
}

export function argumentosDeActa(
  a: Acta,
  instancia: string,
  modo: ModoAplicacion,
  resolucion?: ResolucionContexto,
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
  STALE_TOKEN: 'El bloqueo, la sesión o la versión del caso ya no son vigentes.',
  INVALID_CASE: 'El caso de verificación no coincide con el acta registrada.',
  RESOLUCION_CONFLICTO: 'Ya existe una resolución distinta para este acta.',
};

type Ejecutor = (keys: string[], args: string[]) => Promise<unknown>;
const fuenteResolucion = readFileSync(new URL('../redis/lua/aplicar_acta.lua', import.meta.url), 'utf8');

async function ejecutar(
  acta: Acta,
  instancia: string,
  modo: ModoAplicacion,
  resolucion: ResolucionContexto | undefined,
  evaluar: Ejecutor,
): Promise<RespuestaIngesta> {
  const [estado, reciboJson, motivo] = (await evaluar(
    clavesDeActa(acta, modo),
    argumentosDeActa(acta, instancia, modo, resolucion),
  )) as [string, string, string];
  const respuesta: RespuestaIngesta = { estado: estado as Estado, instancia };
  if (reciboJson) respuesta.recibo = JSON.parse(reciboJson) as Recibo;
  if (motivo) respuesta.motivo = motivo as MotivoRechazo;
  respuesta.detalle = DETALLES[motivo || estado] ?? estado;
  return respuesta;
}

export async function aplicarActa(
  redis: ConexionRedis,
  acta: Acta,
  instancia: string,
  modo: ModoAplicacion = 'jurado',
  resolucion?: ResolucionContexto,
): Promise<RespuestaIngesta> {
  return ejecutar(acta, instancia, modo, resolucion, (keys, args) =>
    redis.script('aplicar_acta', keys, args),
  );
}

export async function aplicarActaEnCliente(
  redis: RedisClient,
  acta: Acta,
  instancia: string,
  resolucion: ResolucionContexto,
): Promise<RespuestaIngesta> {
  return ejecutar(acta, instancia, 'resolucion', resolucion, (keys, args) =>
    redis.eval(fuenteResolucion, { keys, arguments: args }),
  );
}
