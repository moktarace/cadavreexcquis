import { describe, expect, it } from 'vitest';
import { askLabel, briefTitle, caseRole, drawLabel, nextProposals, planWindow, progressMessage, publishedCopy, shuffle } from './play';

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
    expect(publishedCopy(1)).toEqual({
      title: 'Ta première case est publiée !',
      text: 'Elle attend maintenant qu’un autre joueur imagine la suite.',
      note: 'Retrouve ton dessin dans Mes dessins pour voir ce que les autres en feront.',
    });
  });

  it('cases 2 et 3', () => {
    for (const n of [2, 3]) {
      const c = publishedCopy(n);
      expect(c.title).toBe('Ta suite est publiée !');
      expect(c.text).toBe('Ton dessin rejoint l’histoire. Un autre joueur peut maintenant continuer !');
      expect(c.note).toMatch(/Mes dessins/);
    }
  });

  it('histoire terminée, sans clore les autres chemins', () => {
    expect(publishedCopy(4)).toEqual({
      title: 'Votre histoire est terminée !',
      text: 'Une nouvelle BD à plusieurs est née !',
      note: 'D’autres joueurs peuvent encore imaginer des suites différentes à partir des cases précédentes.',
    });
  });
});

describe('rôle de chaque case', () => {
  it('donne la consigne de chaque étape', () => {
    expect(caseRole(1)).toEqual({ position: 'Case 1 sur 4', prompt: 'Imagine le début de l’histoire !', final: false });
    expect(caseRole(2).prompt).toBe('Dessine ce qui se passe ensuite !');
    expect(caseRole(3).prompt).toBe('L’histoire approche de sa fin !');
    expect(caseRole(4)).toEqual({ position: 'Case 4 sur 4', prompt: 'C’est la dernière case ! Imagine la fin de l’histoire.', final: true });
  });

  it('seule la quatrième case est une conclusion', () => {
    expect([1, 2, 3, 4].map((n) => caseRole(n).final)).toEqual([false, false, false, true]);
  });

  it('compose le repère de l’éditeur avec le thème d’origine', () => {
    expect(briefTitle(3, 'Un boulanger jaloux')).toBe('Case 3 sur 4 · Un boulanger jaloux');
    expect(briefTitle(1)).toBe('Case 1 sur 4');
  });

  it('propose « Dessiner la fin » seulement avant la quatrième case', () => {
    expect([1, 2, 3].map(drawLabel)).toEqual(['Dessiner la suite', 'Dessiner la suite', 'Dessiner la fin']);
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
