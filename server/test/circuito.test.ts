import { describe, expect, it } from 'vitest';
import { Circuito, CircuitoAbierto } from '../src/redis/circuito.js';

const fallo = () => Promise.reject(new Error('Redis caído'));
describe('RF-10 · circuit breaker de Redis', () => {
  it('abre tras fallos consecutivos y rechaza sin ejecutar mientras está abierto', async () => {
    let ahora = 0; let llamadas = 0;
    const c = new Circuito({ fallosParaAbrir:2, msAbierto:1000, ahora:()=>ahora });
    const ejecutar = () => c.ejecutar(()=>{llamadas++;return fallo();});
    await expect(ejecutar()).rejects.toThrow('Redis caído');
    await expect(ejecutar()).rejects.toThrow('Redis caído');
    await expect(ejecutar()).rejects.toBeInstanceOf(CircuitoAbierto);
    expect(llamadas).toBe(2);
    ahora=1001;
    await expect(ejecutar()).rejects.toThrow('Redis caído');
    expect(c.estado).toBe('ABIERTO');
  });
  it('cierra tras una prueba exitosa y no cuenta respuestas de Redis como caída', async () => {
    let ahora=0;
    const c = new Circuito({fallosParaAbrir:1,msAbierto:10,ahora:()=>ahora});
    await expect(c.ejecutar(fallo)).rejects.toThrow();
    ahora=11;
    await expect(c.ejecutar(()=>Promise.resolve('PONG'))).resolves.toBe('PONG');
    expect(c.estado).toBe('CERRADO');
    const errorRedis=new Error('respuesta de error');
    await expect(c.ejecutar(()=>Promise.reject(errorRedis))).rejects.toBe(errorRedis);
  });
});
