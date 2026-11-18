/** Parcours de découverte: pagination, filtres et tirage au sort, indépendants du réseau. */

export type Depth = 1 | 2 | 3;
export const DEPTHS: readonly Depth[] = [1, 2, 3];

/** Cases chargées d'un coup: assez pour feuilleter sans rendre des centaines d'images. */
export const DECK_PAGE_SIZE = 12;

/** Ordre total: sans suite d'abord, puis du plus ancien au plus récent, l'identifiant départageant les ex æquo. */
export const DECK_ORDER = ['child_count', 'published_at', 'id'] as const;

export interface DeckFilter {
  depth: Depth | null;
  /** Seulement les dessins sans suite. */
  onlyOpen: boolean;
}

/** Bornes (incluses) de la page demandée, au format de `range()` de PostgREST. */
export function pageBounds(offset: number, size: number = DECK_PAGE_SIZE): [number, number] {
  return [offset, offset + size - 1];
}

/** Ajoute une page en ignorant les cases déjà connues (une publication entre deux pages décale les rangs). */
export function appendUnique<T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(current.map((c) => c.id));
  return [...current, ...incoming.filter((c) => !seen.has(c.id))];
}

/** Charger la page suivante quand on approche de la fin de ce qui est déjà chargé. */
export function shouldLoadMore(index: number, loaded: number, total: number, margin = 3): boolean {
  return loaded < total && index >= loaded - margin;
}

/** Seules les cases proches de la case affichée sont rendues (les autres gardent juste leur place). */
export function isNear(slide: number, index: number, radius = 1): boolean {
  return Math.abs(slide - index) <= radius;
}

export interface RandomPlan {
  onlyOpen: boolean;
  offset: number;
}

/**
 * Tirage au sort: parmi les dessins sans suite s'il y en a, sinon parmi tous.
 * Le rang tiré est lu avec le même ordre total que le feuilletage: la requête reste déterministe.
 */
export function planRandom(openTotal: number, total: number, rng: () => number = Math.random): RandomPlan | null {
  const pick = (n: number) => Math.min(n - 1, Math.floor(rng() * n));
  if (openTotal > 0) return { onlyOpen: true, offset: pick(openTotal) };
  if (total > 0) return { onlyOpen: false, offset: pick(total) };
  return null;
}

/** Les archives n'apparaissent que si la salle courante est vide; jamais en complément d'une salle qui a des dessins. */
export function showArchives(roomCardCount: number, archiveCount: number): boolean {
  return roomCardCount === 0 && archiveCount > 0;
}

export function archiveCaption(c: { isoWeek: number; authorName: string }): string {
  return `Sem. ${c.isoWeek} · ${c.authorName}`;
}
