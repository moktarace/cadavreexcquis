import { expect } from 'vitest';

/** Compare deux images indexées octet par octet: `toEqual` sur 76 800 octets coûte ~50 ms l'appel (récursion de typed arrays), cette boucle ~0,1 ms. */
export function samePixels(actual: ArrayLike<number>, expected: ArrayLike<number>) {
  expect(actual.length).toBe(expected.length);
  let diff = 0;
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) diff++;
  expect(diff, `${diff} pixel(s) différent(s)`).toBe(0);
}
