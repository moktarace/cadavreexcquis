/** Réponses des autres joueurs à mes dessins: règle de nouveauté et libellés, indépendants du réseau. */
import type { Card } from './cards';
import { hiddenLabel } from './moderation';

/** Une continuation directe, pas encore ouverte, d'une case du joueur. */
export interface UnreadReply {
  replyId: string;
  parentId: string;
  repliedAt: number;
}

/** Ma case d'origine et la case qu'un autre joueur a dessinée juste après. */
export interface Discovery {
  original: Card;
  reply: Card;
}

/**
 * Seule une continuation directe, par un autre joueur, d'une case dont on est l'auteur est une nouveauté:
 * les suites plus lointaines ne génèrent rien (elles se lisent dans l'histoire).
 */
export function isReplyTo(
  original: Pick<Card, 'id' | 'authorId'>,
  reply: Pick<Card, 'parentId' | 'authorId'>,
  userId: string | null,
): boolean {
  return userId !== null && original.authorId === userId && reply.parentId === original.id && reply.authorId !== userId;
}

/** Associe chaque nouveauté à ses deux cases, dans l'ordre reçu; une nouveauté dont une case manque est ignorée. */
export function pairDiscoveries(unread: readonly UnreadReply[], cards: ReadonlyMap<string, Card>, userId: string | null): Discovery[] {
  const out: Discovery[] = [];
  for (const u of unread) {
    const reply = cards.get(u.replyId);
    const original = cards.get(u.parentId);
    if (reply && original && isReplyTo(original, reply, userId)) out.push({ original, reply });
  }
  return out;
}

/** Identifiants des cases (du joueur) qui ont au moins une réponse à découvrir. */
export function parentsWithNews(unread: readonly UnreadReply[]): Set<string> {
  return new Set(unread.map((u) => u.parentId));
}

/** Cartes à charger pour afficher les paires: les réponses, plus les cases d'origine qu'on n'a pas déjà. */
export function missingCardIds(unread: readonly UnreadReply[], known: ReadonlyMap<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const u of unread) {
    if (!known.has(u.replyId)) ids.add(u.replyId);
    if (!known.has(u.parentId)) ids.add(u.parentId);
  }
  return [...ids];
}

/** « En attente d'une suite », « 1 suite », « 3 suites » ou « Dernière case ». */
export function suiteLabel(card: Pick<Card, 'caseNumber' | 'childCount' | 'hidden' | 'hiddenKind'>): string {
  if (card.hidden) return hiddenLabel(card.hiddenKind);
  if (card.caseNumber >= 4) return 'Dernière case';
  if (card.childCount === 0) return 'En attente d’une suite';
  return card.childCount === 1 ? '1 suite' : `${card.childCount} suites`;
}

export type MineMood = 'none' | 'discover' | 'allRead' | 'waiting' | 'quiet';

/** Situation de « Mes dessins » pour choisir le message: rien dessiné, nouveautés, tout lu, ou personne n'a répondu. */
export function mineMood(cards: readonly Pick<Card, 'caseNumber' | 'childCount'>[], unreadCount: number): MineMood {
  if (cards.length === 0) return 'none';
  if (unreadCount > 0) return 'discover';
  if (cards.some((c) => c.childCount > 0)) return 'allRead';
  return cards.some((c) => c.caseNumber < 4) ? 'waiting' : 'quiet';
}
