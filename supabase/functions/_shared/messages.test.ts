import { describe, expect, it } from 'vitest';
import { buildMessage, safePath } from './messages.ts';

describe('messages de notification', () => {
  it('annonce le nouveau thème', () => {
    const m = buildMessage('new_theme', 1, { url: '/#/', theme: 'Un pompier amoureux' });
    expect(m.body).toBe('Nouvelle histoire cette semaine : Un pompier amoureux. À toi de commencer !');
    expect(m.url).toBe('/#/');
  });

  it('regroupe les continuations sans envoyer 40 notifications', () => {
    expect(buildMessage('continuation', 1, { url: '/#/case/a' }).body).toMatch(/^Quelqu’un a continué ton dessin/);
    const grouped = buildMessage('continuation', 40, { url: '/#/case/a' });
    expect(grouped.body).toMatch(/^40 personnes ont continué ton dessin/);
    expect(grouped.tag).toBe('continuation:/#/case/a');
  });

  it('décrit une nouvelle branche et une histoire terminée, au singulier et au pluriel', () => {
    expect(buildMessage('new_branch', 1, { url: '/#/case/b' }).body).toContain('Une nouvelle branche est apparue');
    expect(buildMessage('new_branch', 3, { url: '/#/case/b' }).body).toContain('3 nouvelles branches sont apparues');
    expect(buildMessage('story_completed', 1, { url: '/#/story/c' }).body).toContain('vient d’atteindre quatre cases');
    expect(buildMessage('story_completed', 2, { url: '/#/story/c' }).body).toContain('2 histoires contenant ton dessin ont atteint');
  });

  it('ne produit jamais de compteur invalide', () => {
    expect(buildMessage('continuation', 0, {}).body).toMatch(/^Quelqu’un/);
    expect(buildMessage('continuation', Number.NaN, {}).body).toMatch(/^Quelqu’un/);
  });

  it('refuse toute URL externe ou ambiguë: on reste dans l’application', () => {
    expect(safePath('https://evil.example')).toBe('/');
    expect(safePath('//evil.example')).toBe('/');
    expect(safePath('/\\evil')).toBe('/');
    expect(safePath(undefined)).toBe('/');
    expect(safePath('/#/story/abc')).toBe('/#/story/abc');
    expect(buildMessage('continuation', 1, { url: 'javascript:alert(1)' }).url).toBe('/');
  });
});
