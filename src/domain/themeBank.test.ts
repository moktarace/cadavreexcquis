import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  THEME_MAX, THEME_MIN, analyzeImport, areNearDuplicates, checkThemeText, parseImport, themeKey,
} from './themeBank';

const bank = JSON.parse(readFileSync(new URL('../../supabase/themes.json', import.meta.url), 'utf8')) as {
  themes: { text: string; source: string }[];
};
const seed = readFileSync(new URL('../../supabase/migrations/0012_theme_bank_seed.sql', import.meta.url), 'utf8');

describe('themeKey', () => {
  // Mêmes exemples que le test SQL de scripts/check-sql.mjs: les deux calculs doivent rester identiques.
  it.each([
    ['À deux minutes près', 'deux minutes pres'],
    ['L’invité surprise', 'invite surprise'],
    ['Le jour où tout a changé', 'jour ou tout change'],
    ['Ça ne s’invente pas', 'ca ne s invente pas'],
    ['Le cœur sur la main', 'coeur sur main'],
    ['Là-haut, tout là-haut', 'haut tout haut'],
    ['Une mauvaise nouvelle', 'mauvaise nouvelle'],
    ['Le', 'le'],
  ])('%s → %s', (text, key) => expect(themeKey(text)).toBe(key));
});

describe('checkThemeText', () => {
  it('normalise les espaces et borne la longueur', () => {
    expect(checkThemeText('  Pas   de   panique ')).toEqual({ ok: true, text: 'Pas de panique' });
    expect(checkThemeText('ab').ok).toBe(false);
    expect(checkThemeText('x'.repeat(THEME_MAX + 1)).ok).toBe(false);
    expect(checkThemeText('!!!').ok).toBe(false);
  });
});

describe('doublons', () => {
  it('repère les variantes trop proches', () => {
    expect(areNearDuplicates(themeKey('Le dernier à partir'), themeKey('Dernier à partir !'))).toBe(true);
    expect(areNearDuplicates(themeKey('Au pied du mur'), themeKey('Sous le même toit'))).toBe(false);
  });
});

describe('parseImport', () => {
  it('lit du texte libre avec puces et numéros', () => {
    expect(parseImport('- Un titre\n2) Autre titre\n\n• Encore').map((i) => i.text)).toEqual(['Un titre', 'Autre titre', 'Encore']);
  });
  it('lit du JSON (liste ou objet themes)', () => {
    expect(parseImport('["A b c", {"text":"D e f","note":"n"}]')).toEqual([{ text: 'A b c' }, { text: 'D e f', note: 'n' }]);
    expect(parseImport('{"themes":["X y z"]}')).toEqual([{ text: 'X y z' }]);
  });
});

describe('analyzeImport', () => {
  it('classe nouveaux, doublons exacts, titres proches et invalides', () => {
    const rows = analyzeImport(
      [{ text: 'La nuit des chaises' }, { text: 'AU PIED DU MUR' }, { text: 'Au pied du mur !' }, { text: 'x' }, { text: 'la nuit des CHAISES' }, { text: 'Sous la pluie fine' }],
      ['Au pied du mur'],
    );
    expect(rows.map((r) => r.status)).toEqual(['new', 'duplicate', 'duplicate', 'invalid', 'duplicate', 'new']);
  });
  it('signale un titre très voisin sans le refuser', () => {
    const [r] = analyzeImport([{ text: 'Sous les mêmes toits' }], ['Sous le même toit']);
    expect(r.status).toBe('similar');
    expect(r.detail).toContain('Sous le même toit');
  });
});

describe('supabase/themes.json', () => {
  const texts = bank.themes.map((t) => t.text);
  it('contient au moins 200 titres', () => expect(texts.length).toBeGreaterThanOrEqual(200));
  it('a des titres courts et propres', () => {
    for (const t of texts) {
      expect(t.length, t).toBeGreaterThanOrEqual(THEME_MIN);
      expect(t.length, t).toBeLessThanOrEqual(THEME_MAX);
      expect(t, t).toBe(t.replace(/\s+/g, ' ').trim());
    }
  });
  it('n’a ni doublon ni variante trop proche', () => {
    const keys = texts.map(themeKey);
    expect(new Set(keys).size).toBe(keys.length);
    const near: string[] = [];
    keys.forEach((a, i) => keys.slice(i + 1).forEach((b, j) => { if (areNearDuplicates(a, b)) near.push(`${texts[i]} / ${texts[i + 1 + j]}`); }));
    expect(near).toEqual([]);
  });
  it('déclare honnêtement sa provenance', () => {
    expect(bank.themes.every((t) => t.source === 'original' || t.source === 'referee' || t.source === 'imported')).toBe(true);
  });
  it('est identique à la migration de départ (npm run db:themes -- --seed)', () => {
    const m = seed.match(/\$themes\$(.*)\$themes\$/s);
    expect(m).not.toBeNull();
    expect((JSON.parse(m![1]) as { text: string }[]).map((t) => t.text)).toEqual(texts);
  });
});
