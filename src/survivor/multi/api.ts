import { ApiError, ensureSession } from '../../backend/api';
import { supabase } from '../../backend/client';
import { casePath, type GameResult, type GameView, type InvitePeek, type MpResult, type MpState, type MultiMode, type Rules, type SubmitCaseInput } from './types';

/** Messages des erreurs levées par les RPC `survivor_*`. */
const MESSAGES: Record<string, string> = {
  NOT_AUTHENTICATED: 'Session expirée. Recharge la page.',
  GAME_NOT_FOUND: 'Cette partie est introuvable.',
  GAME_NOT_OPEN: 'Ce défi n’est plus ouvert.',
  GAME_NOT_ACTIVE: 'Cette partie n’est pas (ou plus) en cours.',
  GAME_FULL: 'Cette BD a déjà ses 16 participants.',
  OWN_CHALLENGE: 'Tu ne peux pas rejoindre ton propre défi.',
  INVITE_NOT_FOUND: 'Invitation introuvable.',
  INVITE_TAKEN: 'Cette invitation a déjà été acceptée par quelqu’un d’autre.',
  DUEL_LIMIT: 'Tu as déjà trop de Duels non terminés.',
  BATTLE_LIMIT: 'Tu as déjà trop de Battles non terminées.',
  RESERVED_BY_OTHER: 'Cette case est réservée par un autre joueur.',
  ALREADY_RESERVED: 'Tu as déjà une case réservée dans une autre BD.',
  LAST_CONTRIBUTOR: 'Tu ne peux pas continuer ta propre case.',
  NO_RESERVATION: 'Ta réservation a expiré.',
  NOT_YOUR_TURN: 'Ce n’est pas ton tour.',
  NOT_CANCELLABLE: 'Ce défi a déjà été accepté.',
  NOT_ABANDONABLE: 'Cette partie ne peut pas être abandonnée.',
  INVALID_MODE: 'Mode inconnu.',
  RATE_LIMITED: 'Trop d’actions en peu de temps: réessaie dans une minute.',
  STEP_MISMATCH: 'Cette étape est déjà passée: la partie a été actualisée.',
  STALE_STATE: 'La partie a changé: elle a été actualisée.',
  STALE_POSITION: 'Cette case n’est plus la prochaine: la partie a été actualisée.',
  PICK_LOCKED: 'Ta demande est déjà choisie.',
  CONSTRAINT_NOT_ALLOWED: 'Cette demande ne fait pas partie des propositions.',
  UPGRADE_PENDING: 'L’amélioration de la case précédente n’est pas encore choisie.',
  UPGRADE_NOT_OFFERED: 'Cette amélioration n’est pas proposée.',
  INVALID_DEMAND: 'Les demandes doivent être une facile, une intermédiaire et une difficile, adaptées à ce moment de l’histoire.',
  NO_JOKER: 'Plus de Joker.',
  NO_EMERGENCY: 'Plus de Dernier souffle.',
  NOT_STUCK: 'Tu as encore un secours: pas de panne d’encre.',
  INVALID_INK: 'La dépense d’encre déclarée est invalide.',
  INVALID_IMAGE: 'Le dessin envoyé n’est pas valide pour cette case.',
  IMAGE_MISSING: 'Le dessin n’a pas été reçu: réessaie.',
  INVALID_SUBMISSION: 'Cet envoi ne t’appartient pas.',
};

function db() {
  if (!supabase) throw new ApiError('NO_BACKEND', 'Serveur non configuré (variables VITE_SUPABASE_* manquantes).');
  return supabase;
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  await ensureSession();
  const { data, error } = await db().rpc(name, args);
  if (error) {
    const code = Object.keys(MESSAGES).find((c) => error.message.includes(c));
    const offline = /failed to fetch|networkerror|load failed/i.test(error.message);
    throw new ApiError(code ?? 'SERVER', code ? MESSAGES[code] : offline ? 'Pas de connexion au serveur.' : error.message);
  }
  return data as T;
}

/** Règles appliquées par le serveur: la seule source des paramètres affichés. */
export const fetchRules = () => rpc<Rules>('survivor_rules');

export const myGames = () => rpc<GameView[]>('survivor_my_games').then((rows) => rows ?? []);
export const getGame = (id: string) => rpc<GameView>('survivor_get_game', { p_game: id });

/** Trouve ou crée une partie; la recherche reste active côté serveur après fermeture de l'application. */
export const matchmake = (mode: MultiMode) => rpc<GameResult>('survivor_matchmake', { p_mode: mode });
export const createChallenge = (mode: Exclude<MultiMode, 'relay'>, visibility: 'open' | 'invite') =>
  rpc<GameResult>('survivor_create_challenge', { p_mode: mode, p_visibility: visibility });
export const peekInvite = (token: string) => rpc<InvitePeek>('survivor_peek_invite', { p_token: token });
export const acceptInvite = (token: string) => rpc<GameResult>('survivor_accept_invite', { p_token: token });
export const cancelChallenge = (id: string) => rpc<GameResult>('survivor_cancel', { p_game: id });
export const abandonGame = (id: string) => rpc<GameResult>('survivor_abandon', { p_game: id });

export const reserveSlot = (id: string) => rpc<GameResult>('survivor_reserve', { p_game: id });
export const extendReservation = (id: string) => rpc<GameResult>('survivor_extend_reservation', { p_game: id });

// ───────────── Jeu (les règles et l'économie sont calculées par le serveur) ─────────────
export const fetchState = (id: string) => rpc<MpState>('survivor_state', { p_game: id });
export const pickConstraint = (id: string, constraintId: string) => rpc<MpResult>('survivor_pick', { p_game: id, p_constraint: constraintId });
export const playJoker = (id: string, uses: number) => rpc<MpResult>('survivor_joker', { p_game: id, p_uses: uses });
export const playEmergency = (id: string, uses: number) => rpc<MpResult>('survivor_use_emergency', { p_game: id, p_uses: uses });
export const chooseUpgrade = (id: string, upgrade: string) => rpc<MpResult>('survivor_choose_upgrade', { p_game: id, p_upgrade: upgrade });
export const setDemands = (id: string, ids: readonly string[]) => rpc<MpResult>('survivor_set_demands', { p_game: id, p_ids: ids });
export const declareStuck = (id: string) => rpc<MpResult>('survivor_declare_stuck', { p_game: id });
export const submitCase = (c: SubmitCaseInput) =>
  rpc<MpResult>('survivor_submit_case', {
    p_game: c.gameId,
    p_position: c.position,
    p_submission: c.submissionId,
    p_constraint: c.constraintId,
    p_image: c.imagePath,
    p_ink_spent: c.inkSpent,
  });

// ───────────── Stockage privé des dessins ─────────────
const BUCKET = 'survivor';

/** Envoie le PNG d'une case. Un fichier déjà reçu (relance après un échec) n'est pas une erreur: le chemin ne change pas. */
export async function uploadCaseImage(gameId: string, submissionId: string, png: Uint8Array): Promise<string> {
  const me = await ensureSession();
  const path = casePath(me.userId, gameId, submissionId);
  const { error } = await db().storage.from(BUCKET).upload(path, png, { contentType: 'image/png', upsert: false });
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new ApiError('UPLOAD', /failed to fetch|networkerror|load failed/i.test(error.message) ? 'Pas de connexion au serveur.' : error.message);
  }
  return path;
}

/** Adresses temporaires de lecture des dessins que le joueur a le droit de voir. */
export async function signedUrls(paths: readonly string[]): Promise<Record<string, string>> {
  if (!paths.length) return {};
  await ensureSession();
  const { data, error } = await db().storage.from(BUCKET).createSignedUrls([...paths], 3600);
  if (error) throw new ApiError('SERVER', error.message);
  const out: Record<string, string> = {};
  for (const d of data ?? []) if (d.signedUrl && d.path) out[d.path] = d.signedUrl;
  return out;
}
