import { ApiError, ensureSession } from '../../backend/api';
import { supabase } from '../../backend/client';
import type { GameResult, GameView, InvitePeek, MultiMode, Rules, SubmitCaseInput } from './types';

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

// Points d'intégration de l'étape suivante (pas encore utilisés par l'interface).
export const reserveSlot = (id: string) => rpc<GameResult>('survivor_reserve', { p_game: id });
export const extendReservation = (id: string) => rpc<GameResult>('survivor_extend_reservation', { p_game: id });
export const submitCase = (c: SubmitCaseInput) =>
  rpc<GameResult>('survivor_submit_case', {
    p_game: c.gameId,
    p_constraint: c.constraintId,
    p_image: c.imagePath,
    p_ink_spent: c.inkSpent,
    p_ink_reward: c.inkReward,
  });
