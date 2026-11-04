import { readConfig } from '../server/config.js';
import { VerificationStore } from '../server/store.js';
const config = readConfig();
if (!config.demo)
  throw new Error('La carga de ejemplos requiere DEMO_MODE=true. Nunca carga casos reales.');
const store = new VerificationStore(config);
await store.open(() => {});
try {
  const examples = [
    {
      id: 'E14-176-0042-03',
      mesa: '03',
      municipality: 'Pasto',
      reason: 'La suma por candidato no coincide con el total de sufragantes.',
      priority: 90,
      votes: { 'Candidato-01': 142, 'Candidato-02': 116, 'Voto-blanco': 8 },
    },
    {
      id: 'E14-176-0018-07',
      mesa: '07',
      municipality: 'Ipiales',
      reason: 'Dos transmisiones de la misma versión contienen votos diferentes.',
      priority: 80,
      votes: { 'Candidato-01': 98, 'Candidato-02': 154, 'Voto-blanco': 12 },
    },
    {
      id: 'E14-176-0026-01',
      mesa: '01',
      municipality: 'Túquerres',
      reason: 'El número de votos supera el censo reportado para la mesa.',
      priority: 75,
      votes: { 'Candidato-01': 174, 'Candidato-02': 132, 'Voto-blanco': 6 },
    },
    {
      id: 'E14-176-0031-04',
      mesa: '04',
      municipality: 'La Unión',
      reason: 'Se solicita revisar la transcripción de la segunda columna.',
      priority: 55,
      votes: { 'Candidato-01': 127, 'Candidato-02': 109, 'Voto-blanco': 11 },
    },
    {
      id: 'E14-176-0053-02',
      mesa: '02',
      municipality: 'Sandoná',
      reason: 'El acta recibida tiene una anotación de corrección sin observación.',
      priority: 40,
      votes: { 'Candidato-01': 121, 'Candidato-02': 103, 'Voto-blanco': 7 },
    },
  ];
  for (const [index, input] of examples.entries())
    console.log(
      input.id,
      await store.enqueue({
        ...input,
        version: 1,
        receivedAt: 1_793_750_400_000 + index,
        source: 'demo',
      }),
    );
} finally {
  await store.close();
}
