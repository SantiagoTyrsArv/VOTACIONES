/**
 * Emite credenciales firmadas para jurados.
 *
 *   JURADO_SECRETO=… npm run credenciales -w @preconteo/herramientas -- --desde 1 --hasta 5 [--horas 24]
 *
 * Imprime CSV `jurado,mesa,credencial,enlace`. El enlace abre la PWA con la
 * credencial ya cargada (`/jurado/?credencial=…`), útil para un código QR.
 */
import { emitirCredencial } from '@votaciones/shared/credencial';
import { juradoDeMesa } from './jurados.js';

const arg = (nombre: string, defecto: number) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? Number(process.argv[i + 1]) : defecto;
};
const secreto = process.env.JURADO_SECRETO;
if (!secreto || secreto.length < 32) {
  console.error('Defina JURADO_SECRETO (mínimo 32 caracteres), el mismo de las instancias.');
  process.exit(1);
}
const desde = arg('desde', 1);
const hasta = arg('hasta', desde);
const vence = Math.floor(Date.now() / 1000) + arg('horas', 24) * 3600;
const base = process.env.BASE_URL ?? 'http://localhost:3000';

console.log('jurado,mesa,credencial,enlace');
for (let mesa = desde; mesa <= hasta; mesa++) {
  const jurado = juradoDeMesa(mesa);
  const credencial = emitirCredencial(secreto, jurado, vence);
  console.log(`${jurado},${mesa},${credencial},${base}/jurado/?credencial=${encodeURIComponent(credencial)}`);
}
