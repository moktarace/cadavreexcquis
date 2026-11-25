/** Contrat avec les RPC `survivor_*` (supabase/migrations/0013): le serveur calcule états, catégories et actions; ici, seulement des types et des libellés. */
export type MultiMode = 'relay' | 'duel' | 'battle';
export type GameStatus = 'searching' | 'active' | 'finished' | 'abandoned' | 'cancelled';
export type Bucket = 'mine' | 'waiting' | 'done';

export interface Rules {
  total_cases: number;
  relay: { max_players: number; reserve_minutes: number; extend_minutes: number; reserve_max_minutes: number };
  duel: { max_unfinished: number; hours: number };
  battle: { max_unfinished: number; turn_hours: number };
}

export interface PlayerView {
  seat: number;
  nickname: string;
  status: 'playing' | 'done' | 'forfeited';
  cases_done: number;
  is_me: boolean;
}

export interface GameView {
  id: string;
  mode: MultiMode;
  status: GameStatus;
  visibility: 'open' | 'invite';
  theme: string;
  total_cases: number;
  cases_done: number;
  created_at: string;
  deadline_at: string | null;
  ended_reason: 'completed' | 'forfeit' | 'expired' | 'cancelled' | null;
  /** Délai restant (Duel/Battle: partie ou tour; Relay: ma réservation), au moment de la lecture. */
  seconds_left: number | null;
  bucket: Bucket;
  can_play: boolean;
  can_cancel: boolean;
  can_abandon: boolean;
  my_status: PlayerView['status'] | null;
  turn_is_mine: boolean;
  forfeit_by_me: boolean;
  reservation_until: string | null;
  /** Présent seulement pour le créateur d'un défi en attente. */
  invite_token: string | null;
  players: PlayerView[];
}

export type Outcome = 'created' | 'joined' | 'searching' | 'reserved' | 'extended' | 'released' | 'cancelled' | 'abandoned' | 'submitted' | 'duplicate';

export interface GameResult {
  outcome: Outcome;
  game: GameView;
}

export interface InvitePeek {
  mode: MultiMode;
  theme: string;
  status: GameStatus;
  from: string;
  mine: boolean;
  available: boolean;
}

/** Ce que l'étape suivante enverra pour déposer une case terminée (le dessin multijoueur n'est pas encore branché). */
export interface SubmitCaseInput {
  gameId: string;
  constraintId: string;
  /** Chemin de l'image, préfixé par l'identifiant du joueur. */
  imagePath: string;
  inkSpent: number;
  inkReward: number;
}

export const MODE_LABELS: Record<MultiMode, string> = { relay: 'Relay', duel: 'Duel', battle: 'Battle' };

export const MODE_BLURBS: Record<MultiMode, string> = {
  relay: 'Une BD commune, passée de joueur en joueur.',
  duel: 'Deux BD identiques, dessinées chacune de son côté.',
  battle: 'Une BD à deux, dessinée à tour de rôle.',
};

export const BUCKET_LABELS: Record<Bucket, string> = { mine: 'À toi de jouer', waiting: 'En attente des autres', done: 'Parties terminées' };

/** « 2 j 3 h », « 23 h 10 min », « 14 min »: arrondi vers le bas, jamais négatif. */
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return 'moins d’une minute';
}

/** Phrase d'état d'une partie, déduite des seuls champs calculés par le serveur. */
export function describeGame(g: GameView): string {
  switch (g.status) {
    case 'cancelled':
      return 'Défi annulé';
    case 'finished':
      return 'Terminée';
    case 'abandoned':
      if (g.ended_reason === 'expired') return 'Délai dépassé: partie abandonnée';
      return g.forfeit_by_me ? 'Abandonnée par toi (forfait)' : 'Forfait de l’adversaire';
    case 'searching':
      return g.can_play ? 'En attente d’un adversaire: tu peux déjà commencer' : 'En attente d’un adversaire';
  }
  if (g.mode === 'duel') return g.my_status === 'done' ? 'Tu as fini: l’adversaire dessine encore' : 'À toi de dessiner';
  if (g.mode === 'battle') return g.turn_is_mine ? 'À toi de jouer' : 'Tour de l’adversaire';
  if (g.reservation_until) return 'Case réservée pour toi';
  return g.can_play ? 'Case disponible' : 'En attente du prochain relais';
}

/** Lien à partager pour inviter quelqu'un dans un défi. */
export function inviteLink(token: string, base: string = `${location.origin}${location.pathname}`): string {
  return `${base}#/lab/survivor/invite/${token}`;
}

/** Accepte un jeton nu ou un lien complet collé par le joueur. */
export function tokenFrom(input: string): string | null {
  const m = input.trim().match(/([0-9a-f]{64})\s*$/i);
  return m ? m[1].toLowerCase() : null;
}
