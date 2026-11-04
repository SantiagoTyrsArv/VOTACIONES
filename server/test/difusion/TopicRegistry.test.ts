import { describe, expect, it } from 'vitest';
import { TopicRegistry } from '../../src/difusion/topics/TopicRegistry.js';
import { FakeConnection } from './FakeConnection.js';

describe('TopicRegistry (RF-5)', () => {
  it('entrega a cada tópico solo sus suscriptores', () => {
    const registry = new TopicRegistry<FakeConnection>();
    const a = new FakeConnection(['dep', 'mun:11']);
    const b = new FakeConnection(['dep', 'pue:176']);
    registry.add(a);
    registry.add(b);

    expect([...registry.subscribersOf('dep')]).toEqual([a, b]);
    expect([...registry.subscribersOf('mun:11')]).toEqual([a]);
    expect([...registry.subscribersOf('mun:99')]).toEqual([]);
    expect(registry.size).toBe(2);
  });

  it('al quitar la última conexión de un tópico lo reporta vacío', () => {
    const registry = new TopicRegistry<FakeConnection>();
    const a = new FakeConnection(['dep', 'mun:11']);
    const b = new FakeConnection(['dep']);
    registry.add(a);
    registry.add(b);

    expect(registry.remove(a)).toEqual(['mun:11']);
    expect(registry.hasSubscribers('mun:11')).toBe(false);
    expect(registry.subscriberCount('dep')).toBe(1);
    expect(registry.remove(a)).toEqual([]);
  });

  it('el recorrido de un tópico no depende del total de conexiones', () => {
    const registry = new TopicRegistry<FakeConnection>();
    for (let i = 0; i < 20_000; i++) registry.add(new FakeConnection(['dep']));
    const target = new FakeConnection(['pue:1']);
    registry.add(target);

    let visited = 0;
    for (const _ of registry.subscribersOf('pue:1')) visited++;
    expect(visited).toBe(1);
  });

  it('se puede iterar mientras se cierran conexiones', () => {
    const registry = new TopicRegistry<FakeConnection>();
    const connections = Array.from({ length: 10 }, () => new FakeConnection(['dep']));
    connections.forEach((c) => registry.add(c));

    let visited = 0;
    for (const connection of registry.subscribersOf('dep')) {
      visited++;
      if (visited === 1) registry.remove(connections[9]!);
      void connection;
    }
    expect(visited).toBe(9);
  });
});
