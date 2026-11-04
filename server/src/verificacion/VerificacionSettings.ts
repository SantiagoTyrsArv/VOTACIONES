import { identitySchema, type Identity } from '@votaciones/shared';
import type { AppConfig } from '../config/AppConfig.js';

export interface VerificationConfig {
  instance: string;
  demo: boolean;
  credentials: Record<string, Identity>;
  integrationToken?: string;
  allowedOrigins: string[];
  keyPrefix: string;
  expectedReplicas: number;
}

export function verificationConfig(config: AppConfig): VerificationConfig {
  const demo = config.flag('DEMO_MODE', false);
  const raw = JSON.parse(config.string('AUDITOR_CREDENTIALS_JSON', '{}')) as Record<string, unknown>;
  const credentials: Record<string, Identity> = Object.fromEntries(
    Object.entries(raw).map(([token, identity]) => {
      if (token.length < 24) throw new Error('Las credenciales reales deben tener al menos 24 caracteres');
      return [token, identitySchema.parse(identity)];
    }),
  );
  if (demo) {
    Object.assign(credentials, {
      'demo-ana': { id: 'ana', name: 'Ana Torres', role: 'auditor' },
      'demo-luis': { id: 'luis', name: 'Luis Rojas', role: 'auditor' },
      'demo-coord': { id: 'coordinacion', name: 'Coordinación', role: 'coordinator' },
    });
  }
  return {
    instance: config.instanceId,
    demo,
    credentials,
    integrationToken: config.string('INTEGRATION_TOKEN', '') || undefined,
    allowedOrigins: config.string('ALLOWED_ORIGINS', '').split(',').filter(Boolean),
    keyPrefix: config.string('VERIF_KEY_PREFIX', ''),
    expectedReplicas: config.number('EXPECTED_REPLICAS', 2),
  };
}
