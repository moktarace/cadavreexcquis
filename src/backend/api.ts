import { FINAL_CASE, type Card, type CaseNumber } from '../domain/cards';
import { DECK_ORDER, DECK_PAGE_SIZE, pageBounds, type DeckFilter } from '../domain/discovery';
import type { UnreadReply } from '../domain/discoveries';
import type { Progress } from '../domain/play';
import type { Project } from '../editor/project';
import { previewPng } from '../editor/export';
import { supabase } from './client';

/** Taille de page de PostgREST: au-delà, une lecture simple est tronquée sans erreur. */
const FETCH_SIZE = 1000;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MESSAGES: Record<string, string> = {
  NOT_AUTHENTICATED: 'Session expirée. Recharge la page.',
  GAME_NOT_FOUND: 'Cette partie est introuvable.',
  GAME_NOT_ACTIVE: 'Une nouvelle première case se crée dans le thème actif.',
  ROOM_NOT_FOUND: 'Salle introuvable.',
  ROOM_FULL: 'Cette salle est complète.',
  PARENT_NOT_FOUND: 'Cette case est introuvable.',
  PARENT_IS_FINAL: 'Cette histoire est terminée.',
  CANNOT_CONTINUE_OWN: 'Tu ne peux pas continuer ton propre dessin.',
  RATE_LIMITED: 'Trop de publications en peu de temps, réessaie un peu plus tard.',
  INVALID_PROJECT: 'Ce dessin ne peut pas être publié (déjà publié ou invalide).',
};

export function explain(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const msg = e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e);
  for (const [code, text] of Object.entries(MESSAGES)) if (msg.includes(code)) return text;
  if (/anonymous sign-ins are disabled/i.test(msg)) {
    return 'Les connexions anonymes ne sont pas activées sur le projet Supabase (Authentication > Sign In / Providers).';
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'Pas de connexion au serveur.';
  return msg;
}

function db() {
  if (!supabase) throw new ApiError('NO_BACKEND', "Serveur non configuré (variables VITE_SUPABASE_* manquantes).");
  return supabase;
}

function fail(error: { message: string } | null): asserts error is null {
  if (error) throw new ApiError('SERVER', explain(error));
}

// ───────────── Session anonyme persistante ─────────────

export interface Me {
  userId: string;
  isAnonymous: boolean;
  email: string | null;
}

export async function ensureSession(): Promise<Me> {
  const client = db();
  const { data } = await client.auth.getSession();
  let user = data.session?.user;
  if (!user) {
    const res = await client.auth.signInAnonymously();
    fail(res.error);
    user = res.data.user ?? undefined;
  }
  if (!user) throw new ApiError('NO_USER', 'Connexion impossible.');
  return { userId: user.id, isAnonymous: !!user.is_anonymous, email: user.email ?? null };
}

export async function getNickname(userId: string): Promise<string> {
  const { data, error } = await db().from('profiles').select('nickname').eq('id', userId).single();
  fail(error);
  return data!.nickname;
}

export async function setNickname(userId: string, nickname: string): Promise<void> {
  const clean = nickname.trim();
  if (clean.length < 1 || clean.length > 24) throw new ApiError('NICKNAME', 'Le pseudonyme doit faire de 1 à 24 caractères.');
  const { error } = await db().from('profiles').update({ nickname: clean }).eq('id', userId);
  fail(error);
}

/** Rattache le compte anonyme à une adresse e-mail (un lien de confirmation est envoyé). */
export async function linkEmail(email: string): Promise<void> {
  const { error } = await db().auth.updateUser({ email });
  fail(error);
}

// ───────────── Partie courante ─────────────

export interface CurrentGame {
  gameId: string;
  isoYear: number;
  isoWeek: number;
  themeText: string;
  nextThemeAtMs: number;
  /** Écart entre l'horloge du serveur et celle de l'appareil. */
  serverOffsetMs: number;
  roomId: string;
}

export async function currentGame(): Promise<CurrentGame> {
  const client = db();
  const { data, error } = await client.rpc('current_game');
  fail(error);
  const g = (data as any[])?.[0];
  if (!g) throw new ApiError('NO_GAME', "Aucun thème n'est défini pour cette semaine.");
  const room = await client.rpc('join_game', { p_game: g.game_id });
  fail(room.error);
  return {
    gameId: g.game_id,
    isoYear: g.iso_year,
    isoWeek: g.iso_week,
    themeText: g.theme_text,
    nextThemeAtMs: Date.parse(g.next_theme_at),
    serverOffsetMs: Date.parse(g.server_now) - Date.now(),
    roomId: room.data as string,
  };
}

// ───────────── Lecture des cartes ─────────────

function toCard(r: any): Card {
  return {
    id: r.id,
    gameId: r.game_id,
    roomId: r.room_id,
    authorId: r.author_id,
    authorName: r.author_nickname,
    caseNumber: r.case_number as CaseNumber,
    parentId: r.parent_id,
    previewUrl: db().storage.from('previews').getPublicUrl(r.preview_path).data.publicUrl,
    publishedAt: Date.parse(r.published_at),
    childCount: r.child_count,
  };
}

export type Db = NonNullable<typeof supabase>;
type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Lit toutes les pages d'une requête à ordre total, jusqu'à épuisement: jamais de troncature à 1 000 lignes. */
export async function fetchAll<T>(page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += FETCH_SIZE) {
    const { data, error } = await page(from, from + FETCH_SIZE - 1);
    fail(error);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < FETCH_SIZE) return out;
  }
}

export async function roomCards(roomId: string): Promise<Card[]> {
  const rows = await fetchAll((a, b) =>
    db().from('contribution_cards').select('*').eq('room_id', roomId).order('published_at').order('id').range(a, b),
  );
  return rows.map(toCard);
}

export async function gameCards(gameId: string): Promise<Card[]> {
  const rows = await fetchAll((a, b) =>
    db().from('contribution_cards').select('*').eq('game_id', gameId).order('published_at').order('id').range(a, b),
  );
  return rows.map(toCard);
}

export async function myCards(userId: string): Promise<Card[]> {
  const rows = await fetchAll((a, b) =>
    db()
      .from('contribution_cards')
      .select('*')
      .eq('author_id', userId)
      .order('published_at', { ascending: false })
      .order('id', { ascending: false })
      .range(a, b),
  );
  return rows.map(toCard);
}

/** Cartes précises, par lots (l'URL d'une requête ne doit pas grandir sans limite). */
export async function cardsByIds(ids: readonly string[]): Promise<Card[]> {
  const out: Card[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { data, error } = await db().from('contribution_cards').select('*').in('id', ids.slice(i, i + 50));
    fail(error);
    out.push(...(data ?? []).map(toCard));
  }
  return out;
}

// ───────────── Réponses à mes dessins ─────────────

/** Continuations directes de mes cases que je n'ai pas encore ouvertes (200 au plus), les plus récentes d'abord. */
export async function unreadReplies(limit = 100): Promise<UnreadReply[]> {
  const { data, error } = await db().rpc('unread_replies', { p_limit: limit });
  fail(error);
  return ((data as any[]) ?? []).map((r) => ({ replyId: r.reply_id, parentId: r.parent_id, repliedAt: Date.parse(r.replied_at) }));
}

/** Marque des réponses comme lues; sans effet si elles le sont déjà (autre appareil, double envoi). */
export async function markRepliesRead(userId: string, replyIds: readonly string[]): Promise<void> {
  if (replyIds.length === 0) return;
  const { error } = await db()
    .from('reply_reads')
    .upsert(replyIds.map((reply_id) => ({ user_id: userId, reply_id })), { onConflict: 'user_id,reply_id', ignoreDuplicates: true });
  fail(error);
}

export async function cardPath(id: string): Promise<Card[]> {
  const { data, error } = await db().rpc('contribution_path', { leaf: id });
  fail(error);
  return ((data as any[]) ?? []).map(toCard);
}

export async function cardSubtree(id: string): Promise<Card[]> {
  const rows = await fetchAll<any>((a, b) => db().rpc('contribution_subtree', { root: id }).range(a, b));
  return rows.map(toCard);
}

export async function cardChildren(id: string): Promise<Card[]> {
  const rows = await fetchAll((a, b) =>
    db().from('contribution_cards').select('*').eq('parent_id', id).order('published_at').order('id').range(a, b),
  );
  return rows.map(toCard);
}

// ───────────── Découverte: cases à continuer, par pages ─────────────

export interface DeckQuery extends DeckFilter {
  roomId: string;
  /** Exclut les dessins de ce joueur (on ne continue jamais le sien). */
  userId: string | null;
}

/** Cases continuables de la salle: ni finales, ni de ce joueur; filtrées par profondeur ou « sans suite » si demandé. */
export function deckQuery(client: Db, q: DeckQuery, head = false) {
  let b = client
    .from('contribution_cards')
    .select('*', { count: 'exact', head })
    .eq('room_id', q.roomId)
    .lt('case_number', FINAL_CASE);
  if (q.userId) b = b.neq('author_id', q.userId);
  if (q.depth) b = b.eq('case_number', q.depth);
  if (q.onlyOpen) b = b.eq('child_count', 0);
  return b;
}

export interface DeckPage {
  cards: Card[];
  /** Nombre total de cases correspondant aux filtres, pas seulement celles de la page. */
  total: number;
}

/** Une page, dans l'ordre total `DECK_ORDER` (sans suite d'abord): relire un rang donne toujours la même case. */
export async function deckPage(q: DeckQuery, offset: number, size: number = DECK_PAGE_SIZE, client: Db = db()): Promise<DeckPage> {
  const [from, to] = pageBounds(offset, size);
  let b = deckQuery(client, q);
  for (const column of DECK_ORDER) b = b.order(column, { ascending: true });
  const { data, error, count } = await b.range(from, to);
  fail(error);
  return { cards: (data ?? []).map(toCard), total: count ?? 0 };
}

export async function deckCount(q: DeckQuery, client: Db = db()): Promise<number> {
  const { error, count } = await deckQuery(client, q, true);
  fail(error);
  return count ?? 0;
}

/** Histoires terminées de la salle (leur dernière case), les plus récentes d'abord. */
export async function finishedCards(roomId: string, limit: number): Promise<Card[]> {
  const { data, error } = await db()
    .from('contribution_cards')
    .select('*')
    .eq('room_id', roomId)
    .eq('case_number', FINAL_CASE)
    .order('published_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  fail(error);
  return (data ?? []).map(toCard);
}

/** Le dernier dessin du joueur qui attend encore une suite dans cette salle (de quoi inviter quelqu'un). */
export async function latestOpenOwn(roomId: string, userId: string): Promise<Card | null> {
  const { data, error } = await db()
    .from('contribution_cards')
    .select('*')
    .eq('room_id', roomId)
    .eq('author_id', userId)
    .lt('case_number', FINAL_CASE)
    .order('published_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1);
  fail(error);
  return data?.[0] ? toCard(data[0]) : null;
}

/** Ce que les autres ont fait de ces dessins: suites, histoire terminée et sa dernière case. */
export async function contributionProgress(ids: readonly string[]): Promise<Map<string, Progress>> {
  const out = new Map<string, Progress>();
  if (ids.length === 0) return out;
  const { data, error } = await db().rpc('contribution_progress', { p_ids: ids.slice(0, 100) });
  fail(error);
  for (const r of (data as any[]) ?? []) out.set(r.id, { descendants: r.descendants, finished: r.finished, finishedLeaf: r.finished_leaf });
  return out;
}

/** Derniers dessins de la salle, les plus récents d'abord. */
export async function recentRoomCards(roomId: string, limit: number): Promise<Card[]> {
  const { data, error } = await db()
    .from('contribution_cards')
    .select('*')
    .eq('room_id', roomId)
    .order('published_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  fail(error);
  return (data ?? []).map(toCard);
}

export interface WeekSummary {
  gameId: string;
  isoYear: number;
  isoWeek: number;
  themeText: string;
}

/** Semaines publiques qui ont reçu au moins une contribution, la plus récente d'abord. */
export async function archives(): Promise<WeekSummary[]> {
  const rows = await fetchAll<any>((a, b) => db().rpc('archive_weeks').range(a, b));
  return rows.map((g) => ({ gameId: g.game_id, isoYear: g.iso_year, isoWeek: g.iso_week, themeText: g.theme_text ?? '' }));
}

export interface ArchiveCard extends Card {
  isoYear: number;
  isoWeek: number;
  themeText: string;
}

/** Dessins publics d'autres parties, à lire seulement: jamais ceux de la partie courante, jamais d'une partie privée. */
export async function archiveHighlights(currentGameId: string, limit = 8): Promise<ArchiveCard[]> {
  const { data, error } = await db().rpc('archive_highlights', { p_game: currentGameId, p_limit: limit });
  fail(error);
  return ((data as any[]) ?? []).map((r) => ({ ...toCard(r), isoYear: r.iso_year, isoWeek: r.iso_week, themeText: r.theme_text ?? '' }));
}

export async function gameTheme(gameId: string): Promise<WeekSummary> {
  const { data, error } = await db()
    .from('weekly_games')
    .select('id, iso_year, iso_week, themes(text)')
    .eq('id', gameId)
    .single();
  fail(error);
  const g = data as any;
  return { gameId: g.id, isoYear: g.iso_year, isoWeek: g.iso_week, themeText: g.themes?.text ?? '' };
}

// ───────────── Publication ─────────────

export type Target = { kind: 'root' } | { kind: 'continue'; parentId: string };

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Envoie le dessin puis demande au serveur de publier. Les règles (parent, auteur, thème actif, salle,
 * débit) sont toutes appliquées par `publish_contribution`; le client ne décide de rien.
 */
export async function publish(project: Project, target: Target, game: CurrentGame, userId: string): Promise<string> {
  const client = db();
  const projectId = crypto.randomUUID();
  const preview = await previewPng(project);

  const created = await client.from('drawing_projects').insert({ id: projectId, owner_id: userId });
  fail(created.error);

  const cleanup = async () => {
    await client.from('drawing_projects').delete().eq('id', projectId);
  };

  try {
    const previewPath = `${userId}/${projectId}.png`;
    const up1 = await client.storage.from('previews').upload(previewPath, preview, { contentType: 'image/png' });
    fail(up1.error);

    const assets = await client
      .from('drawing_assets')
      .insert({ project_id: projectId, kind: 'preview', path: previewPath, bytes: preview.length, sha256: await sha256(preview) })
      .select('id')
      .single();
    fail(assets.error);
    const previewAsset = (assets.data as any).id as string;

    const { data, error } = await client.rpc('publish_contribution', {
      p_room: target.kind === 'root' ? game.roomId : null,
      p_parent: target.kind === 'continue' ? target.parentId : null,
      p_project: projectId,
      p_preview: previewAsset,
    });
    fail(error);
    return data as string;
  } catch (e) {
    await cleanup();
    throw e;
  }
}

export async function report(contributionId: string, reporterId: string, reason: string): Promise<void> {
  const { error } = await db()
    .from('reports')
    .insert({ contribution_id: contributionId, reporter_id: reporterId, reason: reason.slice(0, 500) });
  if (error && !/duplicate key/i.test(error.message)) fail(error);
}
