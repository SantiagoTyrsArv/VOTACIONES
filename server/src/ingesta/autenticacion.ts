/**
 * Autenticación de jurados para POST /actas y WS /ws/jurados.
 *
 * Con JURADO_SECRETO definido toda transmisión exige una credencial firmada
 * (ver `@votaciones/shared/credencial`). Sin él, la ingesta acepta el jurado
 * del cuerpo: modo de desarrollo, avisado en el log al arrancar.
 */
import { ESTADOS, MOTIVOS_RECHAZO, type RespuestaIngesta } from '@votaciones/shared';
import { credencialDeCabecera, verificarCredencial } from '@votaciones/shared/credencial';
import type { JuradoAutenticado } from './servicio.js';

export type ResultadoAutenticacion = { ok: true; jurado: JuradoAutenticado } | { ok: false; detalle: string };

export class AutenticadorJurados {
  constructor(private readonly secreto: string | undefined) {}

  get activo(): boolean {
    return Boolean(this.secreto);
  }

  /** Recibe la credencial tal cual (o undefined si no vino). */
  autenticar(credencial: string | undefined): ResultadoAutenticacion {
    if (!this.secreto) return { ok: true, jurado: null };
    const r = verificarCredencial(this.secreto, credencial);
    if (r.ok) return { ok: true, jurado: r.credencial.jurado };
    const detalles = {
      AUSENTE: 'Falta la credencial del jurado.',
      MAL_FORMADA: 'La credencial del jurado no tiene el formato esperado.',
      FIRMA_INVALIDA: 'La credencial del jurado no es válida.',
      VENCIDA: 'La credencial del jurado venció. Solicite una nueva.',
    } as const;
    return { ok: false, detalle: detalles[r.motivo] };
  }

  autenticarCabecera(autorizacion: string | undefined): ResultadoAutenticacion {
    return this.autenticar(credencialDeCabecera(autorizacion));
  }

  /** La credencial viaja en la URL del WebSocket: el navegador no deja poner cabeceras. */
  autenticarUrl(url: string | undefined): ResultadoAutenticacion {
    const credencial = new URL(url ?? '/', 'http://local').searchParams.get('credencial') ?? undefined;
    return this.autenticar(credencial);
  }
}

export const respuestaNoAutorizada = (detalle: string, instancia: string): RespuestaIngesta => ({
  estado: ESTADOS.RECHAZADA,
  motivo: MOTIVOS_RECHAZO.NO_AUTORIZADO,
  detalle,
  instancia,
});
