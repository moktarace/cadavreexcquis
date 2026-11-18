import { describe, expect, it } from 'vitest';
import { caseShareUrl, shareCase } from './share';

const location = { origin: 'https://exemple.fr', pathname: '/jeu/' };

describe('partage d’un dessin', () => {
  it('construit un vrai lien vers la case', () => {
    expect(caseShareUrl('https://exemple.fr', '/jeu/', 'abc-1')).toBe('https://exemple.fr/jeu/#/case/abc-1');
  });

  it('utilise le partage du système quand il existe', async () => {
    const calls: unknown[] = [];
    const navigator = { share: async (d: unknown) => void calls.push(d) } as unknown as Navigator;
    expect(await shareCase('c1', { location, navigator })).toBe('shared');
    expect(calls).toEqual([{ title: 'Cadavre Exquis', text: 'Imagine la suite de mon dessin !', url: 'https://exemple.fr/jeu/#/case/c1' }]);
  });

  it('copie le lien sinon', async () => {
    let copied = '';
    const navigator = { clipboard: { writeText: async (t: string) => void (copied = t) } } as unknown as Navigator;
    expect(await shareCase('c2', { location, navigator })).toBe('copied');
    expect(copied).toBe('https://exemple.fr/jeu/#/case/c2');
  });

  it('respecte l’annulation du partage', async () => {
    const navigator = { share: async () => Promise.reject(new DOMException('annulé', 'AbortError')) } as unknown as Navigator;
    expect(await shareCase('c3', { location, navigator })).toBe('cancelled');
  });

  it('reste honnête quand rien n’est disponible', async () => {
    expect(await shareCase('c4', { location, navigator: {} as Navigator })).toBe('unavailable');
  });
});
