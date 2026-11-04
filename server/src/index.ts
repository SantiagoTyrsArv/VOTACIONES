import { construirApp } from './app.js';
import { leerConfig } from './config.js';

const config = leerConfig();
const app = await construirApp(config);
const direccion = await app.iniciar();
console.log(`[preconteo] instancia ${config.instancia} escuchando en ${direccion}`);

let cerrando = false;
const apagar = async (senal: string) => {
  if (cerrando) return;
  cerrando = true;
  console.log(`[preconteo] ${senal}: cerrando ${config.instancia}`);
  await app.cerrar();
  process.exit(0);
};
process.on('SIGTERM', () => void apagar('SIGTERM'));
process.on('SIGINT', () => void apagar('SIGINT'));
