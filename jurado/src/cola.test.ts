import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Acta } from '@preconteo/shared';
import { borrar, guardar, todos } from './cola';

const acta: Acta = {
  acta:'E14-176-4201-03',mesa:4201,puesto:176,municipio:11,version:1,jurado:'JUR-88134',ts_cierre:1793577600,
  votos:{C1:184,C2:97,C3:311,BLANCO:22,NULO:9,NO_MARCADO:4},sufragantes:627,hash_foto:'prueba',idem:'idem-prueba-1',
};
beforeEach(async()=>{for(const p of await todos())await borrar(p.acta.idem);});
describe('RT-6 · cola local persistente',()=>{
  it('conserva un acta sin recibo y actualiza sus reintentos con el mismo idem',async()=>{
    await guardar({acta,intentos:0,proximo:0});
    await guardar({acta,intentos:3,proximo:5000,ultimoError:'NO_REGISTRADA'});
    const ps=await todos();
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({intentos:3,proximo:5000,ultimoError:'NO_REGISTRADA'});
    expect(ps[0]?.acta.idem).toBe(acta.idem);
  });
  it('mantiene varias actas separadas y elimina solo la confirmada',async()=>{
    await guardar({acta,intentos:0,proximo:0});
    await guardar({acta:{...acta,acta:'E14-176-4202-03',mesa:4202,idem:'idem-prueba-2'},intentos:0,proximo:0});
    await borrar(acta.idem);
    const ps=await todos();
    expect(ps).toHaveLength(1);
    expect(ps[0]?.acta.idem).toBe('idem-prueba-2');
  });
});
