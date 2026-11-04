/**
 * Jurados de la simulación: uno por mesa (`JUR-{mesa}`). Si JURADO_SECRETO
 * está definido, el simulador firma su propia credencial igual que lo haría
 * la autoridad electoral al entregarla.
 */
import { emitirCredencial } from '@votaciones/shared/credencial';

export { juradoDeMesa } from '@votaciones/shared';

const secreto = process.env.JURADO_SECRETO;
const venceS = Math.floor(Date.now() / 1000) + 24 * 3600;
const cache = new Map<string, string>();

export function cabecerasJurado(jurado: string): Record<string, string> {
  if (!secreto) return {};
  let credencial = cache.get(jurado);
  if (!credencial) {
    credencial = emitirCredencial(secreto, jurado, venceS);
    cache.set(jurado, credencial);
  }
  return { authorization: `Bearer ${credencial}` };
}
