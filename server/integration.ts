import { caseInputSchema, type CaseInput, type Resolution } from '../shared/contracts.js';
import type { ActaSubmissionV1 } from '../shared/proposals.js';
import type { Actor, OperationResult, VerificationStore } from './store.js';

export type ResolutionCommand = {
  caseId: string;
  token: string;
  resolution: Resolution;
  actor: Actor;
};
/** A debe validar lock, fence, sesión y versión DENTRO del Lua que modifica los votos.
 * Comprobar aquí y luego llamar a otro servicio deja una carrera (TOCTOU).
 * La aplicación, el recibo y el cierre de verif deben compartir operación atómica.
 */
export interface ResolutionAdapter {
  readonly status: 'pending-A' | 'connected';
  readonly detail: string;
  apply(store: VerificationStore, command: ResolutionCommand): Promise<OperationResult>;
}
export class PendingAAdapter implements ResolutionAdapter {
  readonly status = 'pending-A';
  readonly detail =
    'Falta conectar la aplicación atómica de A. No se han cambiado votos ni cerrado el caso.';
  async apply(store: VerificationStore, cmd: ResolutionCommand) {
    const valid = await store.operation('check', cmd.caseId, cmd.actor, cmd.token);
    return valid.code === 'VALID' ? { code: 'PENDING_A' } : valid;
  }
}
// Punto de entrada para A, dentro del mismo proceso y con el mismo Redis.
export function receiveDoubtfulCase(store: VerificationStore, input: CaseInput) {
  return store.enqueue(input);
}
export function caseFromActa(
  acta: ActaSubmissionV1,
  reason: string,
  priority: number,
  receivedAt: number,
): CaseInput {
  return caseInputSchema.parse({
    id: acta.acta,
    version: acta.version,
    mesa: String(acta.mesa),
    municipality: String(acta.municipio),
    reason,
    priority,
    receivedAt,
    votes: acta.votos,
    source: 'A',
  });
}
