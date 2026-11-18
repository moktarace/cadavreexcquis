/** Mémorise, sur cet appareil, combien de suites chaque dessin avait à la dernière visite de « Mes dessins ». */

const KEY = 'cl.seenChildren.v1';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function loadSeen(store: Store = localStorage): Record<string, number> {
  try {
    const raw = JSON.parse(store.getItem(KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => Number.isInteger(v) && (v as number) >= 0)) as Record<string, number>;
  } catch {
    return {};
  }
}

export function markSeen(cards: readonly { id: string; childCount: number }[], store: Store = localStorage): void {
  const seen = loadSeen(store);
  for (const c of cards) seen[c.id] = c.childCount;
  try {
    store.setItem(KEY, JSON.stringify(seen));
  } catch {
    // stockage plein ou refusé: les suites seront simplement signalées de nouveau
  }
}
