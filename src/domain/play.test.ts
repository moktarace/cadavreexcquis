import { describe, expect, it } from 'vitest';
import { askLabel, newContinuations, nextProposals, planWindow, progressMessage, publishedCopy, shuffle } from './play';

describe('messages de « Mes dessins »', () => {
  it('dit qu’un dessin attend une suite', () => {
    expect(progressMessage(1, 0)).toBe('Personne n’a encore continué ton dessin.');
  });

  it('compte les personnes qui ont imaginé une suite', () => {
    expect(progressMessage(1, 1)).toBe('1 personne a imaginé une suite !');
    expect(progressMessage(2, 3)).toBe('3 personnes ont imaginé une suite !');
  });

  it('annonce une histoire complète née du dessin', () => {
    expect(progressMessage(1, 2, { descendants: 4, finished: 1, finishedLeaf: 'z' })).toBe('Une histoire complète est née de ton dessin !');
  });

  it('annonce la fin quand le dessin est la dernière case', () => {
    expect(progressMessage(4, 0)).toBe('Ton histoire est terminée !');
  });
});

describe('messages après publication', () => {
  it('première case', () => {
    expect(publishedCopy(1)).toEqual({ title: 'Ta première case est publiée !', text: 'Elle attend maintenant qu’un autre joueur imagine la suite.' });
  });

  it('cases 2 et 3', () => {
    for (const n of [2, 3]) expect(publishedCopy(n)).toEqual({ title: 'Ta suite est publiée !', text: 'Un autre joueur peut maintenant continuer l’histoire.' });
  });

  it('histoire terminée', () => {
    expect(publishedCopy(4)).toEqual({ title: 'Votre histoire est terminée !', text: 'Découvre les quatre cases.' });
  });
});

describe('proposition de jeu', () => {
  it('dit quelle case dessiner', () => {
    expect(askLabel(1)).toBe('À toi de dessiner la case 2 !');
    expect(askLabel(3)).toBe('À toi de dessiner la case 4 !');
  });

  it('mélange sans perdre ni dupliquer de case', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = shuffle(items, () => 0.37);
    expect([...out].sort((a, b) => a - b)).toEqual(items);
    expect(items).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('ne repropose pas la case affichée', () => {
    const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(nextProposals(pool, 'b', () => 0.5).map((c) => c.id).sort()).toEqual(['a', 'c']);
    expect(nextProposals([{ id: 'a' }], 'a')).toEqual([]);
  });

  it('privilégie les dessins sans suite et reste dans les bornes', () => {
    expect(planWindow(40, 300, 24, () => 0.99)).toEqual({ onlyOpen: true, offset: 16 });
    expect(planWindow(10, 300, 24, () => 0.99)).toEqual({ onlyOpen: true, offset: 0 });
    expect(planWindow(0, 100, 24, () => 0)).toEqual({ onlyOpen: false, offset: 0 });
    expect(planWindow(0, 100, 24, () => 1)).toEqual({ onlyOpen: false, offset: 76 });
  });

  it('ne propose rien quand rien n’est éligible', () => {
    expect(planWindow(0, 0, 24)).toBeNull();
  });
});

describe('nouvelles suites', () => {
  const cards = [{ id: 'a', childCount: 2 }, { id: 'b', childCount: 0 }, { id: 'c', childCount: 1 }];

  it('repère les dessins dont le nombre de suites a augmenté', () => {
    expect(newContinuations(cards, { a: 1, c: 1 }).map((c) => c.id)).toEqual(['a']);
  });

  it('considère comme nouvelle une suite jamais vue', () => {
    expect(newContinuations(cards, {}).map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('ne signale rien quand tout a été vu', () => {
    expect(newContinuations(cards, { a: 2, b: 0, c: 1 })).toEqual([]);
  });
});
