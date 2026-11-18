import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isoWeeksInYear, themesSql, THEMES_FROM_YEAR, THEMES_TO_YEAR } from './themesSql';

describe('thèmes pré-générés pour Supabase', () => {
  it('le fichier de migration correspond exactement au générateur (pas de dérive)', () => {
    const file = readFileSync('supabase/migrations/0003_themes.sql', 'utf8');
    expect(file).toBe(themesSql(THEMES_FROM_YEAR, THEMES_TO_YEAR));
  });

  it('compte les semaines ISO des années à 52 et 53 semaines', () => {
    expect(isoWeeksInYear(2026)).toBe(53);
    expect(isoWeeksInYear(2027)).toBe(52);
    expect(isoWeeksInYear(2020)).toBe(53);
  });

  it('échappe les apostrophes SQL', () => {
    expect(themesSql(2026, 2030)).toContain("''");
  });
});
