import { FINAL_CASE, type Card, type CaseNumber } from '../domain/cards';
import { DECK_ORDER, DECK_PAGE_SIZE, pageBounds, type DeckFilter } from '../domain/discovery';
import type { UnreadReply } from '../domain/discoveries';
import { hiddenPlaceholder, type HiddenKind, type ReportCategory } from '../domain/moderation';
import type { Progress } from '../domain/play';
import type { RewardEvent, RewardProgress } from '../domain/rewards';
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
  PARENT_NOT_FOUND: 'Cette case n’est plus disponible : sa période est peut-être terminée.',
  PARENT_HIDDEN: 'Ce dessin est temporairement masqué : on ne peut pas le continuer pour le moment.',
  GAME_EXPIRED: 'Cette période est terminée : les dessins de ce thème ont disparu. Rejoins le thème de la semaine !',
  CONTRIBUTION_NOT_FOUND: 'Ce dessin n’est plus disponible.',
  CANNOT_REPORT_OWN: 'Tu ne peux pas signaler ton propre dessin.',
  ALREADY_REPORTED: 'Tu as déjà signalé ce dessin.',
  REPORT_RATE_LIMITED: 'Trop de signalements en peu de temps, réessaie un peu plus tard.',
  INVALID_CATEGORY: 'Choisis un motif de signalement.',
  FORBIDDEN: 'Accès réservé à l’administration.',
  THEME_DUPLICATE: 'Ce thème existe déjà dans la banque (ou un titre presque identique).',
  THEME_INVALID: 'Titre invalide : entre 3 et 60 caractères.',
  THEME_USED: 'Ce thème a déjà été utilisé : il ne peut plus être modifié ni retiré.',
  THEME_NOT_FOUND: 'Thème introuvable.',
  INVALID_SOURCE: 'Provenance inconnue.',
  PLAN_CHANGED: 'Les dessins ont changé depuis l’aperçu : relance l’aperçu avant de confirmer.',
  CONFIRMATION_REQUIRED: 'Confirmation requise.',
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
  if (error) throw new ApiError(Object.keys(MESSAGES).find((code) => error.message.includes(code)) ?? 'SERVER', explain(error));
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
    previewUrl: r.hidden || !r.preview_path ? hiddenPlaceholder(r.hidden_kind) : db().storage.from('previews').getPublicUrl(r.preview_path).data.publicUrl,
    publishedAt: Date.parse(r.published_at),
    childCount: r.child_count,
    hidden: !!r.hidden,
    hiddenKind: (r.hidden_kind ?? null) as HiddenKind | null,
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
    .eq('hidden', false)
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
    .eq('hidden', false)
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
    .eq('hidden', false)
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
    .eq('hidden', false)
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

/** Premier signalement valide: le dessin est masqué en attendant l'examen. Renvoie « hidden » ou « recorded ». */
export async function reportContribution(contributionId: string, category: ReportCategory, details: string): Promise<'hidden' | 'recorded'> {
  const { data, error } = await db().rpc('report_contribution', { p_contribution: contributionId, p_category: category, p_details: details.trim() || null });
  fail(error);
  return data === 'hidden' ? 'hidden' : 'recorded';
}

// ───────────── Administration (toutes les opérations sont revérifiées côté serveur par is_admin()) ─────────────

export async function isAdmin(): Promise<boolean> {
  const { data, error } = await db().rpc('is_admin');
  return !error && data === true;
}

const previewUrl = (path: string | null) => (path ? db().storage.from('previews').getPublicUrl(path).data.publicUrl : null);
const ms = (v: string | null) => (v ? Date.parse(v) : null);

export interface AdminGame {
  gameId: string;
  isoYear: number;
  isoWeek: number;
  themeText: string;
  isPrivate: boolean;
  expiresAtMs: number | null;
  purgedAtMs: number | null;
  contributions: number;
}

export async function adminGames(): Promise<AdminGame[]> {
  const { data, error } = await db().rpc('admin_games');
  fail(error);
  return ((data as any[]) ?? []).map((g) => ({
    gameId: g.game_id, isoYear: g.iso_year, isoWeek: g.iso_week, themeText: g.theme_text, isPrivate: g.is_private,
    expiresAtMs: ms(g.expires_at), purgedAtMs: ms(g.purged_at), contributions: g.contributions,
  }));
}

export type AdminStatusFilter = 'published' | 'review' | 'removed' | 'deleted' | 'reported';

export interface AdminFilters {
  gameId?: string;
  authorId?: string;
  status?: AdminStatusFilter;
  search?: string;
}

export interface AdminContribution {
  id: string;
  gameId: string;
  isoYear: number;
  isoWeek: number;
  themeText: string;
  authorId: string;
  authorName: string;
  caseNumber: number;
  parentId: string | null;
  previewUrl: string | null;
  status: 'published' | 'hidden';
  hiddenKind: HiddenKind | null;
  publishedAt: number;
  expiresAtMs: number | null;
  childCount: number;
  openReports: number;
}

export const ADMIN_PAGE = 40;

export async function adminContributions(filters: AdminFilters, offset: number): Promise<{ items: AdminContribution[]; total: number }> {
  const { data, error } = await db().rpc('admin_contributions', {
    p_game: filters.gameId ?? null, p_author: filters.authorId ?? null, p_status: filters.status ?? null,
    p_search: filters.search?.trim() || null, p_limit: ADMIN_PAGE, p_offset: offset,
  });
  fail(error);
  const rows = (data as any[]) ?? [];
  return {
    total: rows[0] ? Number(rows[0].total) : 0,
    items: rows.map((r) => ({
      id: r.id, gameId: r.game_id, isoYear: r.iso_year, isoWeek: r.iso_week, themeText: r.theme_text,
      authorId: r.author_id, authorName: r.author_nickname, caseNumber: r.case_number, parentId: r.parent_id,
      previewUrl: previewUrl(r.preview_path), status: r.status, hiddenKind: r.hidden_kind, publishedAt: Date.parse(r.published_at),
      expiresAtMs: ms(r.expires_at), childCount: r.child_count, openReports: r.open_reports,
    })),
  };
}

export interface AdminReport {
  reportId: string;
  contributionId: string;
  category: ReportCategory;
  details: string | null;
  status: 'open' | 'upheld' | 'dismissed' | 'abusive';
  createdAt: number;
  reporterName: string;
  reporterBlocked: boolean;
  reporterReports: number;
  contributionStatus: 'published' | 'hidden';
  hiddenKind: HiddenKind | null;
  previewUrl: string | null;
  caseNumber: number;
  authorName: string;
  themeText: string;
}

export async function adminReports(status: AdminReport['status'] | null, offset = 0): Promise<{ items: AdminReport[]; total: number }> {
  const { data, error } = await db().rpc('admin_reports', { p_status: status, p_limit: ADMIN_PAGE, p_offset: offset });
  fail(error);
  const rows = (data as any[]) ?? [];
  return {
    total: rows[0] ? Number(rows[0].total) : 0,
    items: rows.map((r) => ({
      reportId: r.report_id, contributionId: r.contribution_id, category: r.category, details: r.details, status: r.status,
      createdAt: Date.parse(r.created_at), reporterName: r.reporter_nickname, reporterBlocked: r.reporter_blocked,
      reporterReports: r.reporter_reports, contributionStatus: r.contribution_status, hiddenKind: r.hidden_kind,
      previewUrl: previewUrl(r.preview_path), caseNumber: r.case_number, authorName: r.author_nickname, themeText: r.theme_text,
    })),
  };
}

export async function adminSetHidden(ids: readonly string[], hide: boolean): Promise<number> {
  const { data, error } = await db().rpc('admin_set_hidden', { p_ids: ids, p_hide: hide });
  fail(error);
  return Number(data ?? 0);
}

export async function adminReviewReport(reportId: string, status: 'dismissed' | 'abusive' | 'upheld', blockReporter = false): Promise<void> {
  const { error } = await db().rpc('admin_review_report', { p_report: reportId, p_status: status, p_block: blockReporter });
  fail(error);
}

export type CleanupMode = 'selection' | 'story';

export interface CleanupItem {
  id: string;
  action: 'delete' | 'tombstone';
  caseNumber: number;
  author: string;
  previewUrl: string | null;
  chosen: boolean;
}

export interface CleanupPreview {
  mode: CleanupMode;
  selected: number;
  deleteRows: number;
  tombstoneRows: number;
  cascadedRows: number;
  stories: number;
  authors: number;
  files: number;
  reports: number;
  reads: number;
  notifications: number;
  childrenKept: number;
  signature: string;
  items: CleanupItem[];
}

export async function adminCleanupPreview(ids: readonly string[], mode: CleanupMode): Promise<CleanupPreview> {
  const { data, error } = await db().rpc('admin_cleanup_preview', { p_ids: ids, p_mode: mode });
  fail(error);
  const p = data as any;
  return {
    mode: p.mode, selected: p.selected, deleteRows: p.delete_rows, tombstoneRows: p.tombstone_rows, cascadedRows: p.cascaded_rows,
    stories: p.stories, authors: p.authors, files: p.files, reports: p.reports, reads: p.reads, notifications: p.notifications,
    childrenKept: p.children_kept, signature: p.signature,
    items: (p.items ?? []).map((i: any) => ({ id: i.id, action: i.action, caseNumber: i.case_number, author: i.author, previewUrl: previewUrl(i.path), chosen: i.chosen })),
  };
}

/** La suppression n'a lieu que si l'aperçu confirmé correspond encore à l'état des données. */
export async function adminCleanupExecute(ids: readonly string[], mode: CleanupMode, signature: string): Promise<{ filesQueued: number; pruned: number }> {
  const { data, error } = await db().rpc('admin_cleanup_execute', { p_ids: ids, p_mode: mode, p_signature: signature, p_confirm: 'SUPPRIMER' });
  fail(error);
  const r = data as any;
  return { filesQueued: r.files_queued ?? 0, pruned: r.pruned ?? 0 };
}

export interface PurgeLogEntry {
  id: string;
  kind: 'expiry' | 'cleanup' | 'drafts' | 'orphans';
  gameId: string | null;
  status: 'ok' | 'error';
  details: Record<string, number> | null;
  error: string | null;
  createdAt: number;
}

export async function adminPurgeLog(): Promise<PurgeLogEntry[]> {
  const { data, error } = await db().rpc('admin_purge_log', { p_limit: 30 });
  fail(error);
  return ((data as any[]) ?? []).map((l) => ({ id: l.id, kind: l.kind, gameId: l.game_id, status: l.status, details: l.details, error: l.error, createdAt: Date.parse(l.created_at) }));
}

export async function adminBacklog(): Promise<{ pending: number; failing: number; armed: boolean }> {
  const [b, armed] = await Promise.all([db().rpc('admin_storage_backlog'), db().rpc('admin_purge_armed')]);
  fail(b.error);
  fail(armed.error);
  const row = ((b.data as any[]) ?? [])[0] ?? { pending: 0, failing: 0 };
  return { pending: row.pending, failing: row.failing, armed: armed.data === true };
}

/** Lance tout de suite la suppression des fichiers en attente (sinon la planification s'en charge). */
export async function purgeFilesNow(): Promise<{ removed: number; failed: number }> {
  const { data, error } = await db().functions.invoke('purge', { method: 'POST' });
  if (error) throw new ApiError('PURGE', 'La suppression des fichiers sera reprise automatiquement.');
  return { removed: data?.removed ?? 0, failed: data?.failed ?? 0 };
}

// ───────────── Récompenses collectives (calculées par le serveur) ─────────────

export async function myProgress(): Promise<RewardProgress> {
  const { data, error } = await db().rpc('my_progress');
  fail(error);
  const r = ((data as any[]) ?? [])[0] ?? { completed: 0, inspired: 0, stickers: [] };
  return { completed: r.completed, inspired: r.inspired, stickers: r.stickers ?? [] };
}

export async function myRewardEvents(opts: { unseen?: boolean; kind?: RewardEvent['kind']; limit?: number } = {}): Promise<RewardEvent[]> {
  const { data, error } = await db().rpc('my_reward_events', { p_unseen: opts.unseen ?? true, p_kind: opts.kind ?? null, p_limit: opts.limit ?? 50 });
  fail(error);
  return ((data as any[]) ?? []).map((e) => ({
    id: e.id, kind: e.kind, endId: e.end_id, rootId: e.root_id, ref: e.ref, n: e.n, expired: e.expired, createdAt: Date.parse(e.created_at), seen: e.seen,
  }));
}

/** Idempotent: une nouveauté déjà découverte (autre appareil, double envoi) reste découverte. */
export async function markRewardEventsSeen(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db().rpc('mark_reward_events_seen', { p_ids: ids });
  fail(error);
}

// ───────────── Banque de thèmes (administration) ─────────────

export type ThemeStatus = 'used' | 'scheduled' | 'unused';

export interface BankTheme {
  id: string;
  text: string;
  source: string;
  note: string | null;
  inBank: boolean;
  uses: number;
  scheduled: number;
  lastUsedMs: number | null;
  nextAtMs: number | null;
  status: ThemeStatus;
}

export const BANK_PAGE = 50;

export async function adminThemeBank(status: ThemeStatus | null, search: string, offset: number): Promise<{ items: BankTheme[]; total: number }> {
  const { data, error } = await db().rpc('admin_theme_bank', {
    p_status: status, p_search: search.trim() || null, p_limit: BANK_PAGE, p_offset: offset,
  });
  fail(error);
  const rows = (data as any[]) ?? [];
  return {
    total: rows[0] ? Number(rows[0].total) : 0,
    items: rows.map((r) => ({
      id: r.id, text: r.text, source: r.source, note: r.note, inBank: r.in_bank, uses: r.uses, scheduled: r.scheduled,
      lastUsedMs: ms(r.last_used), nextAtMs: ms(r.next_at), status: r.status,
    })),
  };
}

export interface ScheduledTheme {
  isoYear: number;
  isoWeek: number;
  startsAtMs: number;
  themeId: string;
  text: string;
  source: string;
  /** Déjà sorti du barillet (commencé ou dans les 7 jours): ne change plus. */
  frozen: boolean;
  started: boolean;
}

export async function adminThemeSchedule(weeks = 12): Promise<ScheduledTheme[]> {
  const { data, error } = await db().rpc('admin_theme_schedule', { p_weeks: weeks });
  fail(error);
  const now = Date.now();
  return ((data as any[]) ?? []).map((r) => ({
    isoYear: r.iso_year, isoWeek: r.iso_week, startsAtMs: Date.parse(r.starts_at), themeId: r.theme_id, text: r.text,
    source: r.source, frozen: r.frozen, started: Date.parse(r.starts_at) <= now,
  }));
}

export async function adminThemeAdd(text: string, note?: string): Promise<string> {
  const { data, error } = await db().rpc('admin_theme_add', { p_text: text, p_source: 'original', p_note: note?.trim() || null });
  fail(error);
  return data as string;
}

export async function adminThemeUpdate(id: string, text: string, note?: string): Promise<void> {
  const { error } = await db().rpc('admin_theme_update', { p_id: id, p_text: text, p_note: note?.trim() || null });
  fail(error);
}

export async function adminThemeRemove(id: string): Promise<void> {
  const { error } = await db().rpc('admin_theme_remove', { p_id: id });
  fail(error);
}

export interface ThemeImportReport {
  added: number;
  skipped: { text: string; reason: 'invalid' | 'duplicate' }[];
}

export async function adminThemeImport(items: readonly { text: string; note?: string }[], source: 'imported' | 'referee'): Promise<ThemeImportReport> {
  const { data, error } = await db().rpc('admin_theme_import', { p_items: items, p_source: source });
  fail(error);
  return data as ThemeImportReport;
}

/** Tous les titres de la banque (pour repérer les doublons avant un import). */
export async function adminThemeTexts(): Promise<string[]> {
  const texts: string[] = [];
  for (let offset = 0; offset < 5000; offset += 200) {
    const { data, error } = await db().rpc('admin_theme_bank', { p_status: null, p_search: null, p_limit: 200, p_offset: offset });
    fail(error);
    const rows = (data as any[]) ?? [];
    texts.push(...rows.map((r) => r.text as string));
    if (rows.length < 200) break;
  }
  return texts;
}
