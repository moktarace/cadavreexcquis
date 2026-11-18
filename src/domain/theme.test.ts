import { describe, expect, it } from 'vitest';
import { rngFromSeed } from './prng';
import { generateTheme, weeklySeed } from './theme';
import { CHARACTERS, SITUATIONS, TRAITS } from './themeData';

describe('PRNG', () => {
  it('est répétable pour une même graine', () => {
    const a = rngFromSeed('abc');
    const b = rngFromSeed('abc');
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it('produit des séquences figées (garde-fou contre toute modification de l’algorithme)', () => {
    const r = rngFromSeed('case-ludique');
    expect([r.int(1000), r.int(1000), r.int(1000)]).toMatchInlineSnapshot(`
      [
        822,
        637,
        359,
      ]
    `);
  });

  it('reste dans [0, 1)', () => {
    const r = rngFromSeed('range');
    for (let i = 0; i < 10_000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('générateur de thèmes', () => {
  it('produit le même thème pour la même graine et la même version', () => {
    expect(generateTheme('x', 'v1')).toEqual(generateTheme('x', 'v1'));
  });

  it('utilise année + semaine ISO comme graine hebdomadaire', () => {
    expect(weeklySeed(2026, 7)).toBe('case-ludique/2026-W07');
  });

  it('refuse une version inconnue plutôt que de produire un thème différent', () => {
    expect(() => generateTheme('x', 'v999')).toThrow();
  });

  it('figé: le thème de la semaine 2026-W47 ne change jamais', () => {
    expect(generateTheme(weeklySeed(2026, 47)).text).toMatchInlineSnapshot(`"Un boulanger jaloux"`);
  });

  it('ne produit jamais de combinaison incompatible ni mal accordée', () => {
    const seen = new Set<string>();
    for (let week = 1; week <= 53; week++) {
      for (let year = 2026; year < 2056; year++) {
        const t = generateTheme(weeklySeed(year, week));
        seen.add(t.text);
        const c = CHARACTERS.find((x) => x.id === t.characterId)!;
        const trait = TRAITS.find((x) => x.id === t.traitId)!;
        const s = SITUATIONS.find((x) => x.id === t.situationId);
        expect(trait.forbids?.some((tag) => c.tags.includes(tag)) ?? false).toBe(false);
        if (trait.requiresAny) expect(trait.requiresAny.some((tag) => c.tags.includes(tag))).toBe(true);
        if (s?.forbids) expect(s.forbids.some((tag) => c.tags.includes(tag))).toBe(false);
        if (s?.requiresAny) expect(s.requiresAny.some((tag) => c.tags.includes(tag))).toBe(true);
        const expectedAdj = c.gender === 'm' ? trait.m : trait.f;
        expect(t.text.toLowerCase()).toContain(`${c.gender === 'm' ? 'un' : 'une'} ${c.noun} ${expectedAdj}`);
      }
    }
    expect(seen.size).toBeGreaterThan(1000);
  });

  it('permet un seed manuel pour les tests et les parties privées', () => {
    expect(generateTheme('partie-privee').seed).toBe('partie-privee');
  });
});
