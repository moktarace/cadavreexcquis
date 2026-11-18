import { describe, expect, it } from 'vitest';
import { DECK_PAGE_SIZE, appendUnique, archiveCaption, isNear, pageBounds, planRandom, shouldLoadMore, showArchives } from './discovery';

describe('pagination du parcours de découverte', () => {
  it('calcule des pages contiguës qui ne se chevauchent pas', () => {
    expect(pageBounds(0)).toEqual([0, DECK_PAGE_SIZE - 1]);
    expect(pageBounds(DECK_PAGE_SIZE)).toEqual([DECK_PAGE_SIZE, 2 * DECK_PAGE_SIZE - 1]);
  });

  it('parcourt plus de 1 000 cases page par page sans en perdre', () => {
    const total = 2347;
    let seen = 0;
    let next = 0;
    while (next < total) {
      const [from, to] = pageBounds(next);
      seen += Math.min(to, total - 1) - from + 1;
      next = to + 1;
    }
    expect(seen).toBe(total);
  });

  it('ignore les doublons quand une publication décale les pages', () => {
    const merged = appendUnique([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]);
    expect(merged.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('charge la suite en approchant de la fin, jamais au-delà du total', () => {
    expect(shouldLoadMore(0, 12, 300)).toBe(false);
    expect(shouldLoadMore(9, 12, 300)).toBe(true);
    expect(shouldLoadMore(11, 12, 12)).toBe(false);
  });

  it('ne rend que les cases voisines de la case affichée', () => {
    const rendered = Array.from({ length: 300 }, (_, i) => i).filter((i) => isNear(i, 150));
    expect(rendered).toEqual([149, 150, 151]);
  });
});

describe('proposition aléatoire', () => {
  it('privilégie les dessins sans suite', () => {
    expect(planRandom(5, 400, () => 0.99)).toEqual({ onlyOpen: true, offset: 4 });
    expect(planRandom(5, 400, () => 0)).toEqual({ onlyOpen: true, offset: 0 });
  });

  it('retombe sur toutes les cases quand aucune n’est sans suite', () => {
    expect(planRandom(0, 400, () => 0.5)).toEqual({ onlyOpen: false, offset: 200 });
  });

  it('ne propose rien quand il n’y a rien à continuer, et reste dans les bornes', () => {
    expect(planRandom(0, 0)).toBeNull();
    expect(planRandom(0, 7, () => 1)).toEqual({ onlyOpen: false, offset: 6 });
  });
});

describe('archives sur l’accueil', () => {
  it('ne s’affichent que lorsque la salle courante est vide', () => {
    expect(showArchives(0, 6)).toBe(true);
    expect(showArchives(3, 6)).toBe(false);
  });

  it('ne s’affichent pas sans archives réelles', () => {
    expect(showArchives(0, 0)).toBe(false);
  });

  it('identifient la semaine et l’auteur', () => {
    expect(archiveCaption({ isoWeek: 46, authorName: 'Léa' })).toBe('Sem. 46 · Léa');
  });
});
