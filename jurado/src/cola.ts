import type { Acta } from '@votaciones/shared';

const DB = 'preconteo-jurado';
const STORE = 'salida';
export interface Pendiente { acta: Acta; intentos: number; proximo: number; ultimoError?: string }

function abrir(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'acta.idem' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function operar<T>(modo: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await abrir();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, modo);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch (e) { db.close(); throw e; }
}
export const guardar = (p: Pendiente) => operar('readwrite', (s) => s.put(p));
export const borrar = (idem: string) => operar('readwrite', (s) => s.delete(idem));
export const todos = () => operar('readonly', (s) => s.getAll() as IDBRequest<Pendiente[]>);
