/**
 * Credencial firmada del jurado (HMAC-SHA256). Solo para Node (usa node:crypto):
 * se importa como `@votaciones/shared/credencial`, nunca desde el navegador.
 *
 * Formato: `v1.{jurado}.{vence}.{firma}`
 *   - jurado: identificador `JUR-…` (el mismo de `acta.jurado`)
 *   - vence: segundos Unix
 *   - firma: base64url(HMAC-SHA256(JURADO_SECRETO, "v1.{jurado}.{vence}"))
 *
 * El servidor no confía en `acta.jurado` del cuerpo: deriva el jurado de la
 * credencial verificada, exige que coincida y usa ese valor para el límite de
 * tasa. Las 8 instancias comparten el secreto por variable de entorno; no hay
 * estado de sesión que sincronizar (RT-2).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PATRON_JURADO } from './acta.js';

const VERSION = 'v1';

export interface CredencialVerificada {
  jurado: string;
  vence: number;
}

export type ResultadoCredencial =
  | { ok: true; credencial: CredencialVerificada }
  | { ok: false; motivo: 'AUSENTE' | 'MAL_FORMADA' | 'FIRMA_INVALIDA' | 'VENCIDA' };

const firmar = (secreto: string, cuerpo: string): string =>
  createHmac('sha256', secreto).update(cuerpo).digest('base64url');

/** Emite una credencial (la usa la herramienta de emisión y las pruebas). */
export function emitirCredencial(secreto: string, jurado: string, venceS: number): string {
  if (!PATRON_JURADO.test(jurado)) throw new Error(`Jurado inválido: ${jurado}`);
  if (!Number.isSafeInteger(venceS) || venceS <= 0) throw new Error('Vencimiento inválido');
  const cuerpo = `${VERSION}.${jurado}.${venceS}`;
  return `${cuerpo}.${firmar(secreto, cuerpo)}`;
}

export function verificarCredencial(
  secreto: string,
  credencial: string | undefined,
  ahoraS = Math.floor(Date.now() / 1000),
): ResultadoCredencial {
  if (!credencial) return { ok: false, motivo: 'AUSENTE' };
  const partes = credencial.split('.');
  if (partes.length !== 4 || partes[0] !== VERSION) return { ok: false, motivo: 'MAL_FORMADA' };
  const [, jurado, venceTexto, firma] = partes as [string, string, string, string];
  const vence = Number(venceTexto);
  if (!PATRON_JURADO.test(jurado) || !/^\d{1,12}$/.test(venceTexto)) return { ok: false, motivo: 'MAL_FORMADA' };

  const esperada = Buffer.from(firmar(secreto, `${VERSION}.${jurado}.${venceTexto}`));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) {
    return { ok: false, motivo: 'FIRMA_INVALIDA' };
  }
  if (vence <= ahoraS) return { ok: false, motivo: 'VENCIDA' };
  return { ok: true, credencial: { jurado, vence } };
}

/** Extrae la credencial de `Authorization: Bearer …`. */
export function credencialDeCabecera(autorizacion: string | undefined): string | undefined {
  return autorizacion?.startsWith('Bearer ') ? autorizacion.slice(7).trim() || undefined : undefined;
}
