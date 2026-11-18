import { describe, expect, it } from 'vitest';
import { ICONS, MASCOT, MASCOT_COLORS } from './sprites';

describe('pixel art', () => {
  it.each(Object.entries(ICONS))('l’icône %s est une grille 12×12 valide', (_name, sprite) => {
    expect(sprite.rows).toHaveLength(sprite.h);
    for (const row of sprite.rows) {
      expect(row).toHaveLength(sprite.w);
      expect(row).toMatch(/^[.#o]+$/);
    }
    expect(sprite.rows.join('')).toContain('#');
  });

  it('la mascotte est rectangulaire et n’utilise que des couleurs définies', () => {
    for (const row of MASCOT.rows) {
      expect(row).toHaveLength(MASCOT.w);
      for (const ch of row) if (ch !== '.') expect(MASCOT_COLORS[ch]).toBeDefined();
    }
    expect(MASCOT.rows).toHaveLength(MASCOT.h);
  });
});
