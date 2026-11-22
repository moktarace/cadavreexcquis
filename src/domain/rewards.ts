/** Récompenses collectives: regroupement des nouveautés et messages, indépendants du réseau. */
import { stickerById, type StickerDef } from './stickers';

export type RewardKind = 'story_done' | 'inspired' | 'sticker';

export interface RewardEvent {
  id: string;
  kind: RewardKind;
  endId: string | null;
  rootId: string | null;
  /** Identifiant du tampon (kind « sticker »). */
  ref: string | null;
  /** Nombre d'histoires inspirées par la case 1 (kind « inspired »). */
  n: number | null;
  /** Les dessins ont été supprimés à l'expiration du thème: il ne reste que le souvenir. */
  expired: boolean;
  createdAt: number;
  seen: boolean;
}

export interface RewardProgress {
  completed: number;
  inspired: number;
  stickers: readonly string[];
}

export interface RewardNews {
  stories: RewardEvent[];
  inspired: RewardEvent[];
  stickers: { event: RewardEvent; def: StickerDef }[];
}

/** Regroupe les nouveautés pour les présenter à l'utilisateur à son rythme, sans enchaîner des animations. */
export function groupRewardEvents(events: readonly RewardEvent[]): RewardNews {
  const news: RewardNews = { stories: [], inspired: [], stickers: [] };
  for (const e of events) {
    if (e.kind === 'story_done') news.stories.push(e);
    else if (e.kind === 'inspired') news.inspired.push(e);
    else {
      const def = e.ref ? stickerById(e.ref) : undefined;
      if (def) news.stickers.push({ event: e, def });
    }
  }
  return news;
}

export const hasRewardNews = (news: RewardNews) => news.stories.length + news.inspired.length + news.stickers.length > 0;

/** Les histoires que l'on peut encore ouvrir: l'expiration d'un thème retire les dessins, pas la récompense. */
export const openableStories = (events: readonly RewardEvent[]) => events.filter((e) => e.kind === 'story_done' && !e.expired && e.endId);

const WORDS = ['zéro', 'une', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix'];
const word = (n: number) => (n >= 0 && n < WORDS.length ? WORDS[n] : String(n));
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** « Une histoire à laquelle tu as participé est terminée ! » */
export function storiesDoneMessage(count: number): string {
  return count <= 1 ? 'Une histoire à laquelle tu as participé est terminée !' : `${capital(word(count))} histoires auxquelles tu as participé sont terminées !`;
}

/** « Ton dessin a inspiré 3 histoires différentes ! » */
export function inspiredMessage(n: number): string {
  return `Ton dessin a inspiré ${n} histoire${n > 1 ? 's' : ''} différente${n > 1 ? 's' : ''} !`;
}

/** « Trois histoires sont nées de ton dessin ! » */
export function bornFromYourDrawing(n: number): string {
  return n <= 1 ? 'Une histoire est née de ton dessin !' : `${capital(word(n))} histoires sont nées de ton dessin !`;
}

/** Message de réussite pour la fin de l'histoire que l'on vient de publier. */
export const FINISHED_TITLE = 'Votre histoire est terminée !';
export const FINISHED_SUBTITLE = 'Une nouvelle BD à plusieurs est née !';

/** Auteurs du chemin, sans doublon, dans l'ordre d'apparition. */
export function distinctAuthors(path: readonly { authorId: string; authorName: string }[]): { authorId: string; authorName: string }[] {
  const seen = new Set<string>();
  const out: { authorId: string; authorName: string }[] = [];
  for (const c of path) {
    if (seen.has(c.authorId)) continue;
    seen.add(c.authorId);
    out.push(c);
  }
  return out;
}

/** Les tampons débloqués d'un coup se présentent dans une seule fenêtre: le premier en vedette, les autres à la suite. */
export function unlockQueue(news: RewardNews): StickerDef[] {
  return news.stickers.map((s) => s.def);
}

/** Écarte les nouveautés déjà découvertes sur cet appareil (réponse serveur arrivée avant l'enregistrement). */
export function withoutSeen(events: readonly RewardEvent[], seenHere: ReadonlySet<string>): RewardEvent[] {
  return events.filter((e) => !e.seen && !seenHere.has(e.id));
}
