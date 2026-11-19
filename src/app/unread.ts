/** Dernier état connu des nouveautés, pour afficher la pastille avant (ou sans) réponse du serveur. */

const KEY = 'cl.unreadReplies.v1';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function loadUnreadFlag(userId: string, store: Store = localStorage): boolean {
  try {
    const raw = JSON.parse(store.getItem(KEY) ?? 'null');
    return !!raw && raw.userId === userId && Number.isInteger(raw.count) && raw.count > 0;
  } catch {
    return false;
  }
}

export function saveUnreadFlag(userId: string, count: number, store: Store = localStorage): void {
  try {
    store.setItem(KEY, JSON.stringify({ userId, count }));
  } catch {
    // stockage plein ou refusé: la pastille sera simplement recalculée par le serveur
  }
}
