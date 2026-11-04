// El contrato de ingesta pertenece al paquete compartido.
export type {
  ActaSubmission as ActaSubmissionV1,
  ActaReceipt as ActaReceiptV1,
} from '../messages/acta.js';
export type { ActaNotice as PublicNoticeV1 } from '../messages/broadcast.js';

export type AppliedResolutionReceiptV1 = {
  status: 'APPLIED';
  receiptId: string;
  actaId: string;
  caseVersion: number;
  fencingToken: string;
  newVersion: number;
  streamIds: Record<string, string>;
  appliedAt: number;
};
