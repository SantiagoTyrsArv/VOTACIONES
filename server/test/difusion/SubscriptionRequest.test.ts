import { describe, expect, it } from 'vitest';
import {
  InvalidSubscriptionError,
  SubscriptionRequest,
} from '../../src/difusion/topics/SubscriptionRequest.js';

describe('SubscriptionRequest (RF-6)', () => {
  it('por defecto se suscribe al departamento sin cursores', () => {
    const request = SubscriptionRequest.parse({});
    expect(request.topics).toEqual(['dep']);
    expect(request.cursors.size).toBe(0);
  });

  it('lee cursores compuestos y descarta los de tópicos no pedidos', () => {
    const request = SubscriptionRequest.parse({
      topics: 'dep,mun:11',
      cursor: 'dep@1793577612345-0,mun:11@1793577611002-3,pue:9@1-0',
    });
    expect(request.cursors.get('dep')?.toString()).toBe('1793577612345-0');
    expect(request.cursors.get('mun:11')?.toString()).toBe('1793577611002-3');
    expect(request.cursors.has('pue:9')).toBe(false);
  });

  it('el parámetro cursor tiene prioridad sobre Last-Event-ID', () => {
    const request = SubscriptionRequest.parse({
      topics: 'dep',
      lastEventId: 'dep@5-0',
      cursor: 'dep@9-0',
    });
    expect(request.cursors.get('dep')?.toString()).toBe('9-0');
  });

  it('ignora cursores mal formados', () => {
    const request = SubscriptionRequest.parse({ topics: 'dep', cursor: 'dep@basura,@,dep' });
    expect(request.cursors.size).toBe(0);
  });

  it('rechaza tópicos inválidos o demasiados tópicos', () => {
    expect(() => SubscriptionRequest.parse({ topics: 'nacion' })).toThrow(InvalidSubscriptionError);
    expect(() => SubscriptionRequest.parse({ topics: 'dep,mun:1,pue:2' })).toThrow(InvalidSubscriptionError);
  });
});
