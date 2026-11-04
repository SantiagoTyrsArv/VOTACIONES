import { caseInputSchema, type CaseInput, type Resolution } from '@votaciones/shared';
import type { Acta } from '@votaciones/shared';
import type { Actor, OperationResult, VerificationStore } from './VerificationStore.js';

export type ResolutionCommand = {
  caseId: string;
  token: string;
  resolution: Resolution;
  actor: Actor;
};

export interface ResolutionAdapter {
  readonly status: 'connected';
  readonly detail: string;
  apply(store: VerificationStore, command: ResolutionCommand): Promise<OperationResult>;
}

export function receiveDoubtfulCase(store: VerificationStore, input: CaseInput): Promise<OperationResult> {
  return store.enqueue(input);
}

export function caseFromActa(
  acta: Acta,
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
