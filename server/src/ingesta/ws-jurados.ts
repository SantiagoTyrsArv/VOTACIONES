/**
 * WebSocket de jurados (/ws/jurados).
 *
 * Una respuesta por cada acta, correlacionada por `idem`, y solo después de
 * que aplicar_acta.lua terminó. Latido ping/pong cada 15 s: un celular que se
 * quedó sin señal se detecta y su socket se cierra (la PWA reconecta sola).
 */
import {
  CIERRE_APAGADO,
  PROTOCOLO_JURADOS,
  RUTA_WS_JURADOS,
  type MensajeServidorJurado,
} from '@votaciones/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServicioIngesta } from './servicio.js';

export interface OpcionesWsJurados {
  ingesta: ServicioIngesta;
  instancia: string;
  latidoMs?: number;
}

export function crearWsJurados(op: OpcionesWsJurados) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const vivos = new WeakMap<WebSocket, boolean>();

  const enviar = (ws: WebSocket, m: MensajeServidorJurado) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };

  wss.on('connection', (ws) => {
    vivos.set(ws, true);
    ws.on('pong', () => vivos.set(ws, true));
    ws.on('error', () => ws.terminate());
    enviar(ws, { tipo: 'bienvenida', instancia: op.instancia, protocolo: PROTOCOLO_JURADOS });

    ws.on('message', async (datos, binario) => {
      let msg: unknown;
      try {
        msg = binario ? null : JSON.parse(datos.toString());
      } catch {
        msg = null;
      }
      const m = msg as { tipo?: unknown; acta?: { idem?: unknown } } | null;
      if (!m || m.tipo !== 'acta' || typeof m.acta !== 'object' || m.acta === null) {
        enviar(ws, { tipo: 'error', codigo: 'MENSAJE_INVALIDO', detalle: 'Se esperaba {"tipo":"acta","acta":{…}}' });
        return;
      }
      const respuesta = await op.ingesta.recibir(m.acta);
      const idem = typeof m.acta.idem === 'string' ? m.acta.idem : '';
      enviar(ws, { tipo: 'respuesta', idem, respuesta });
    });
  });

  const latido = setInterval(() => {
    for (const ws of wss.clients) {
      if (!vivos.get(ws)) {
        ws.terminate();
        continue;
      }
      vivos.set(ws, false);
      ws.ping();
    }
  }, op.latidoMs ?? 15_000);
  latido.unref();

  return {
    ruta: RUTA_WS_JURADOS,
    wss,
    async cerrar() {
      clearInterval(latido);
      for (const ws of wss.clients) ws.close(CIERRE_APAGADO, 'reinicio de instancia');
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
