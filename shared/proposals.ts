// Ingesta y aviso alineados con shared/ de origin/main f43ea97.
// La extensión de resolución de C continúa pendiente de aceptación conjunta.
export type ActaSubmissionV1 = {
  acta: string;
  version: number;
  idem: string;
  mesa: number;
  puesto: number;
  municipio: number;
  jurado: string;
  ts_cierre: number;
  votos: Record<string, number>;
  sufragantes: number;
  hash_foto: string;
};
export type ActaReceiptV1 = {
  status:
    | 'REGISTRADA'
    | 'YA_REGISTRADA'
    | 'VERSION_OBSOLETA'
    | 'DUDOSA_EN_VERIFICACION'
    | 'RECHAZADA'
    | 'NO_REGISTRADA';
  acta: string;
  version: number;
  idem: string;
  registeredAt?: number;
  message: string;
  instance: string;
};
export type PublicNoticeV1 = {
  topics: string[];
  streamIds: Record<string, string>;
  acta: string;
};
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
