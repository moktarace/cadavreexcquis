import { describe, expect, it } from 'vitest';
import { loadUnreadFlag, saveUnreadFlag } from './unread';

function memory(initial?: string) {
  let value = initial ?? null;
  return { getItem: () => value, setItem: (_: string, v: string) => void (value = v) };
}

describe('dernier état des nouveautés', () => {
  it('démarre sans pastille', () => {
    expect(loadUnreadFlag('u1', memory())).toBe(false);
  });

  it('retient la présence de nouveautés pour le même joueur seulement', () => {
    const store = memory();
    saveUnreadFlag('u1', 2, store);
    expect(loadUnreadFlag('u1', store)).toBe(true);
    expect(loadUnreadFlag('u2', store)).toBe(false);
    saveUnreadFlag('u1', 0, store);
    expect(loadUnreadFlag('u1', store)).toBe(false);
  });

  it('ignore un stockage corrompu', () => {
    expect(loadUnreadFlag('u1', memory('pas du json'))).toBe(false);
  });
});
