import { describe, expect, it } from 'vitest';
import { isPhoneLike } from './platform';

const phone = { coarse: true, canHover: false, maxTouchPoints: 5, shortSide: 390 };

describe('détection d’un téléphone tactile', () => {
  it('reconnaît iPhone et téléphones Android: doigt + petit écran', () => {
    expect(isPhoneLike(phone)).toBe(true);
    expect(isPhoneLike({ ...phone, shortSide: 360 })).toBe(true);
    expect(isPhoneLike({ ...phone, shortSide: 430 })).toBe(true);
  });

  it('écarte un iPad, même avec un petit viewport (écran physique large)', () => {
    expect(isPhoneLike({ ...phone, shortSide: 744 })).toBe(false);
    expect(isPhoneLike({ ...phone, shortSide: 820 })).toBe(false);
  });

  it('écarte un ordinateur, même à fenêtre étroite ou avec écran tactile', () => {
    expect(isPhoneLike({ coarse: false, canHover: true, maxTouchPoints: 0, shortSide: 800 })).toBe(false);
    expect(isPhoneLike({ coarse: false, canHover: true, maxTouchPoints: 0, shortSide: 500 })).toBe(false);
    expect(isPhoneLike({ coarse: true, canHover: true, maxTouchPoints: 10, shortSide: 500 })).toBe(false);
  });

  it('ne se fie pas au nom du navigateur: sans tactile, pas de Mimo', () => {
    expect(isPhoneLike({ ...phone, maxTouchPoints: 0 })).toBe(false);
  });
});
