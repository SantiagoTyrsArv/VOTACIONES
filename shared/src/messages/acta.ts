/**
 * Contrato de ingesta (dueño: Persona A).
 * Formato del acta tal como lo define el enunciado (sección 3.1).
 */
export interface ActaSubmission {
  /** puesto-mesa-corporación, p. ej. "E14-176-0042-03" */
  acta: string;
  mesa: number;
  puesto: number;
  municipio: number;
  /** 1, 2, 3... si el acta se corrige */
  version: number;
  jurado: string;
  ts_cierre: number;
  /** Votos por candidato más BLANCO, NULO y NO_MARCADO */
  votos: Record<string, number>;
  sufragantes: number;
  hash_foto: string;
  /** Clave de idempotencia del envío lógico; se reutiliza en cada reintento */
  idem: string;
}

/** Respuestas inequívocas al jurado (RF-1). */
export const ReceiptStatus = {
  Registered: 'REGISTRADA',
  AlreadyRegistered: 'YA_REGISTRADA',
  ObsoleteVersion: 'VERSION_OBSOLETA',
  UnderVerification: 'DUDOSA_EN_VERIFICACION',
  Rejected: 'RECHAZADA',
  NotRegistered: 'NO_REGISTRADA',
} as const;

export type ReceiptStatus = (typeof ReceiptStatus)[keyof typeof ReceiptStatus];

export interface ActaReceipt {
  status: ReceiptStatus;
  acta: string;
  version: number;
  idem: string;
  /** Momento (ms) en que quedó registrada; ausente si no se registró */
  registeredAt?: number;
  message: string;
  instance: string;
}
