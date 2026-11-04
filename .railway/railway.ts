import { defineRailway, github, image, project, service, volume } from 'railway/iac';

// Propuesta de despliegue. Validable sin credenciales; no aprovisiona recursos al importarla.
export default defineRailway((ctx) => {
  const data = volume('redis-data', { region: 'us-west2', sizeMB: 1024 });
  const redis = service('redis', {
    source: image('redis:7.4-alpine'),
    replicas: 1,
    start:
      '/bin/sh -c \'exec redis-server --bind :: 0.0.0.0 --appendonly yes --appendfsync everysec --maxmemory-policy noeviction --requirepass "$REDIS_PASSWORD"\'',
    env: { REDIS_PASSWORD: ctx.shared.REDIS_PASSWORD },
    volumeMounts: { '/data': data },
  });
  const app = service('votaciones', {
    source: github('SantiagoTyrsArv/VOTACIONES', { branch: 'feature/persona-c' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    start: 'node dist/server/index.js',
    replicas: 8,
    healthcheck: '/ready',
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 5, drainingSeconds: 10 },
    env: {
      REDIS_URL: 'redis://:${{shared.REDIS_PASSWORD}}@${{redis.RAILWAY_PRIVATE_DOMAIN}}:6379',
      DEMO_MODE: 'false',
      EXPECTED_REPLICAS: '8',
      AUDITOR_CREDENTIALS_JSON: ctx.shared.AUDITOR_CREDENTIALS_JSON,
      INTEGRATION_TOKEN: ctx.shared.INTEGRATION_TOKEN,
      ALLOWED_ORIGINS: ctx.shared.ALLOWED_ORIGINS,
    },
  });
  return project('votaciones', { resources: [data, redis, app] });
});
