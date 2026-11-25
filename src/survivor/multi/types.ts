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
  ended_reason: 'completed' | 'forfeit' | 'expired' | 'cancelled' | 'defeat' | null;
  /** Issue de la partie vue par le joueur (calculée par le serveur). */
  result: 'victory' | 'defeat' | 'win' | 'loss' | 'draw' | 'completed' | 'expired' | 'cancelled' | null;
  /** Ma réserve d'encre (commune en Relay) et sa capacité, quand la partie a commencé. */
  reserve: number | null;
  capacity: number | null;
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

export type Outcome = 'created' | 'joined' | 'searching' | 'reserved' | 'extended' | 'released' | 'cancelled' | 'abandoned' | 'submitted' | 'duplicate' | 'picked' | 'joker' | 'emergency' | 'upgraded' | 'turn_passed' | 'defeat';

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

export type Level = 'easy' | 'medium' | 'hard';
export type RunStep = 'choosing' | 'upgrade' | 'demands' | 'waiting' | 'finished';

export interface MpProposal {
  id: string;
  level: Level;
  /** Encre gagnée en terminant la case, bonus des améliorations compris (calculée par le serveur). */
  reward: number;
}

/** Ma réserve d'encre et ma progression (la run est commune en Relay). */
export interface MpRun {
  step: RunStep;
  /** Position de la prochaine case que je dépose. */
  position: number;
  reserve: number;
  capacity: number;
  upgrades: Record<string, number>;
  jokers: number;
  emergency: number;
  joker_uses: number;
  emergency_uses: number;
  total_spent: number;
  cases_done: number;
  proposals: MpProposal[];
  pick: string | null;
  offer: string[];
  upgrade_until: string | null;
  outcome: 'victory' | 'defeat' | null;
  free_mimos: number;
}

export interface MpRunSummary {
  nickname: string | null;
  is_me: boolean;
  shared: boolean;
  step: RunStep | null;
  reserve: number;
  capacity: number;
  cases_done: number;
  total_spent: number;
  upgrades: Record<string, number> | null;
  outcome: 'victory' | 'defeat' | null;
}

export interface MpCase {
  position: number;
  author_id: string;
  nickname: string;
  constraint_id: string;
  image_path: string;
  ink_spent: number;
  reward: number;
  /** Duel: propriétaire de la BD; nul quand la BD est commune. */
  bd_owner: string | null;
  mine: boolean;
}

/** Tout ce que l'interface sait d'une partie multijoueur (`survivor_state`): jamais de calcul de règles côté client. */
export interface MpState {
  game: GameView;
  /** Seed en texte: aucune perte de précision entre PostgreSQL et JavaScript. */
  seed: string;
  /** C'est à moi d'agir à l'étape en cours. */
  acting: boolean;
  cases: MpCase[];
  runs: MpRunSummary[];
  demand_options: Record<Level, string[]> | null;
  upgrade_wait_seconds: number | null;
  run: MpRun | null;
}

export interface MpResult {
  outcome: Outcome;
  game: GameView;
  state: MpState;
}

/** Ce que l'interface envoie pour déposer une case terminée; le serveur calcule récompense, améliorations et transitions. */
export interface SubmitCaseInput {
  gameId: string;
  position: number;
  /** Identifiant de cette tentative: le même après un échec réseau, un nouveau si le dessin a changé. */
  submissionId: string;
  constraintId: string;
  imagePath: string;
  /** Encre dépensée selon l'éditeur local (non vérifiable par le serveur, seulement bornée par la réserve). */
  inkSpent: number;
}

/** Chemin de stockage d'une case: <joueur>/<partie>/<soumission>.png (même format que la politique SQL). */
export const casePath = (userId: string, gameId: string, submissionId: string) => `${userId}/${gameId}/${submissionId}.png`;

export const MODE_LABELS: Record<MultiMode, string> = { relay: 'Relay', duel: 'Duel', battle: 'Battle' };

export const MODE_BLURBS: Record<MultiMode, string> = {
  relay: 'Une BD commune, passée de joueur en joueur.',
  duel: 'Deux BD identiques, dessinées chacune de son côté.',
  battle: 'Une BD à deux, dessinée à tour de rôle.',
};

export const RESULT_LABELS: Record<string, string> = {
  victory: 'Victoire collective: la BD est terminée',
  defeat: 'Défaite: panne d’encre',
  win: 'Victoire: ton adversaire est tombé en panne d’encre',
  loss: 'Défaite: panne d’encre',
  draw: 'Égalité provisoire: les deux joueurs ont survécu',
  completed: 'Terminée',
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
      return RESULT_LABELS[g.result ?? 'completed'] ?? 'Terminée';
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
