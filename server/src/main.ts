import { AppConfig } from './config/AppConfig.js';
import type { AppModule } from './infra/AppModule.js';
import { DifusionModule } from './difusion/DifusionModule.js';
import { IngestaModule } from './ingesta/IngestaModule.js';
import { Application } from './infra/Application.js';

/**
 * Punto de entrada. Cada persona agrega aquí UNA línea con su módulo:
 *   A → new IngestaModule()
 *   B → new DifusionModule()
 *   C → new VerificacionModule()
 */
const modules: AppModule[] = [
  new IngestaModule(), // Persona A
  new DifusionModule(), // Persona B
];

const app = new Application(AppConfig.fromEnv(), modules);

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
