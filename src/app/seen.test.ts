import { describe, expect, it } from 'vitest';
import { loadSeen, markSeen } from './seen';

function memory(initial?: string) {
  let value = initial ?? null;
  return { getItem: () => value, setItem: (_: string, v: string) => void (value = v) };
}

describe('suites déjà vues', () => {
  it('démarre vide', () => {
    expect(loadSeen(memory())).toEqual({});
  });

  it('retient le nombre de suites vues pour chaque dessin', () => {
    const store = memory();
    markSeen([{ id: 'a', childCount: 2 }, { id: 'b', childCount: 0 }], store);
    markSeen([{ id: 'a', childCount: 3 }], store);
    expect(loadSeen(store)).toEqual({ a: 3, b: 0 });
  });

  it('ignore un stockage corrompu', () => {
    expect(loadSeen(memory('pas du json'))).toEqual({});
    expect(loadSeen(memory('{"a":"x","b":2}'))).toEqual({ b: 2 });
  });
});
