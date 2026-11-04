import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VerificacionModule } from './verificacion/VerificacionModule.js';
import { readConfig } from './verificacion/config.js';
import { AppConfig } from './config/AppConfig.js';
import type { AppModule } from './infra/AppModule.js';
import { DifusionModule } from './difusion/DifusionModule.js';
import { Application } from './infra/Application.js';

const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const config = AppConfig.fromEnv();
const verificationConfig = {
  ...readConfig(),
  redisUrl: config.redisUrl,
  instance: config.instanceId,
};
process.env.CONSOLE_DIR ??= fileURLToPath(new URL('../../web-dist', import.meta.url));
const diffusion = new DifusionModule();
const modules: AppModule[] = [
  diffusion,
  new VerificacionModule(verificationConfig, undefined, () => diffusion.stats()),
];
const app = new Application(config, modules);

const shutdown = async (signal: string): Promise<void> => {
  console.log(`Señal ${signal} recibida: cerrando la instancia...`);
  await app.stop();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

app.start().catch((error: unknown) => {
  console.error('No se pudo iniciar la instancia', error);
  process.exit(1);
});
