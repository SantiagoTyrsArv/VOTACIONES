// Ayuda de pruebas: utiliza el mismo servidor y los mismos módulos que producción.
import { Application } from './src/infra/Application.js';
import { AppConfig } from './src/config/AppConfig.js';
import { DifusionModule } from './src/difusion/DifusionModule.js';
import { VerificacionModule } from './src/verificacion/VerificacionModule.js';
import type { Config } from './src/verificacion/config.js';
import { PendingAAdapter, type ResolutionAdapter } from './src/verificacion/integration.js';
export async function buildApp(config: Config, adapter: ResolutionAdapter = new PendingAAdapter()) {
  const common = AppConfig.fromEnv({
    REDIS_URL: config.redisUrl,
    PORT: String(config.port),
    INSTANCE_ID: config.instance,
    LOG_LEVEL: config.log ? 'info' : 'silent',
    HOST: config.host,
    PUBLIC_DIR: 'publico/dist',
    DEMO_MODE: String(config.demo),
  });
  const diffusion = new DifusionModule();
  const verification = new VerificacionModule(config, adapter, () => diffusion.stats());
  const application = new Application(common, [diffusion, verification]);
  const app = await application.initialize();
  return {
    app,
    store: verification.store,
    metrics: verification.metrics,
    snapshot: verification.snapshot,
  };
}
