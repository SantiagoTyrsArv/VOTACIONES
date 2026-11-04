import { z } from 'zod';

// Propuesta v1: pendiente de revisión conjunta con A y B.
export * from './constants.js';
export const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const identitySchema = z.object({
  id: identifier,
  name: z.string().min(1).max(100),
  role: z.enum(['auditor', 'coordinator']),
});
export type Identity = z.infer<typeof identitySchema>;
export const caseInputSchema = z
  .object({
    id: identifier,
    version: z.number().int().positive().max(1_000_000),
    mesa: z.string().min(1).max(100),
    municipality: z.string().min(1).max(100),
    reason: z.string().min(1).max(1000),
    priority: z.number().int().min(0).max(100),
    receivedAt: z.number().int().nonnegative(),
    votes: z.record(identifier, z.number().int().min(0).max(1_000_000)),
    source: z.enum(['A', 'demo']),
  })
  .strict();
export type CaseInput = z.infer<typeof caseInputSchema>;
export type CaseRecord = CaseInput & {
  status: 'pending' | 'assigned' | 'resolved';
  owner?: string;
  ownerName?: string;
  sessionId?: string;
  token?: string;
  assignedAt?: number;
  lastActivity?: number;
  leaseUntil?: number;
  resolution?: Resolution;
  appliedReceipt?: string;
};
export const resolutionSchema = z
  .object({
    action: z.enum(['approve', 'correct', 'reject']),
    note: z.string().min(5).max(1000),
    votes: z.record(identifier, z.number().int().min(0).max(1_000_000)).optional(),
  })
  .strict()
  .refine((v) => v.action !== 'correct' || v.votes !== undefined, 'Una corrección necesita votos');
export type Resolution = z.infer<typeof resolutionSchema>;
const claim = { caseId: identifier, token: z.string().regex(/^[1-9][0-9]{0,15}$/) };
export const clientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('auth'),
      requestId: identifier,
      credential: z.string().min(1).max(512),
    })
    .strict(),
  z.object({ type: z.literal('heartbeat'), requestId: identifier, active: z.boolean() }).strict(),
  z.object({ type: z.literal('sync'), requestId: identifier }).strict(),
  z.object({ type: z.literal('take'), requestId: identifier, caseId: identifier }).strict(),
  z.object({ type: z.literal('release'), requestId: identifier, ...claim }).strict(),
  z
    .object({
      type: z.literal('resolve'),
      requestId: identifier,
      ...claim,
      resolution: resolutionSchema,
    })
    .strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type Presence = {
  id: string;
  name: string;
  role: Identity['role'];
  sessionId: string;
  instance: string;
  since: number;
  lastSeen: number;
  caseId?: string;
};
export type Snapshot = {
  cases: CaseRecord[];
  presence: Presence[];
  integration: { status: 'pending-A' | 'connected'; detail: string };
  demo: boolean;
  serverTime: number;
};
export type ServerMessage = {
  protocol: 1;
  instance: string;
  type: 'hello' | 'snapshot' | 'changed' | 'ack' | 'error';
  requestId?: string;
  code?: string;
  detail?: string;
  identity?: Identity;
  snapshot?: Snapshot;
  token?: string;
  caseId?: string;
};
export type InstanceMetrics = {
  instance: string;
  sampledAt: number;
  uptimeSeconds: number;
  connections: number;
  messagesIn: number;
  messagesOut: number;
  messagesPerSecond: number;
  rssBytes: number;
  heapBytes: number;
  rssBytesPerConnection: number | null;
  eventLoopP50Ms: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  acceptedActasPerMinute: number | null;
  publicLatencyP95Ms: number | null;
};
