/** Contrat avec les RPC d'arbitrage (supabase/migrations/0015): le serveur attribue, anonymise, récompense. */
export type Vote = 'up' | 'down';

export interface ArbCase {
  /** Identifiant opaque de la case (jamais celui d'un auteur). */
  id: string;
  position: number;
  constraint_id: string;
  image_path: string;
  vote: Vote | null;
}

export interface ArbBd {
  slot: number;
  /** « A » ou « B » pour un Duel (ordre aléatoire), sinon nul. */
  label: 'A' | 'B' | null;
  cases: ArbCase[];
}

export interface Arbitration {
  id: string;
  status: 'assigned' | 'completed' | 'abandoned' | 'flagged' | 'expired';
  theme: string;
  duel: boolean;
  bds: ArbBd[];
  voted: number;
  total: number;
  complete: boolean;
  /** Encre bonus obtenue, connue seulement une fois l'arbitrage validé. */
  reward: number | null;
  up: number;
  down: number;
}

export interface ArbResult {
  outcome: 'assigned' | 'resumed' | 'none' | 'completed' | 'duplicate' | 'closed';
  arbitration: Arbitration | null;
}

export type FlagCategory = 'incomprehensible' | 'inappropriate' | 'other';

export interface NarrativeResult {
  status: 'pending' | 'decided' | 'unavailable';
  result?: 'win' | 'loss' | 'tie';
  my_ups?: number;
  rival_ups?: number;
  arbitrations?: number;
}

export interface HubMine {
  bd_id: string;
  source: 'solo' | 'relay' | 'battle' | 'duel';
  game_id: string | null;
  theme: string;
  status: 'pending' | 'open' | 'declined' | 'hidden';
  created_at: string;
  cases: number;
  arbitrations_done: number;
  arbitrations_max: number;
  /** Votes reçus sur MES cases seulement; jamais l'identité des arbitres. */
  ups: number;
  downs: number;
  ink_earned: number;
  claimed: Record<string, unknown> | null;
  narrative: { status: 'pending' | 'decided' | 'unavailable'; result?: 'win' | 'loss' | 'tie' } | null;
}

export interface Hub {
  balance: number;
  available: number;
  daily_done: number;
  daily_limit: number;
  rules: { min_cases: number; max_arbitrations: number; duel_arbitrations: number; rewards: { vote_given: number; upvote_received: number; complete_bonus: number } };
  active: { id: string; voted: number; total: number } | null;
  consents: { bd_id: string; source: HubMine['source']; theme: string; cases: number }[];
  submittable: { game_id: string; mode: 'relay' | 'duel' | 'battle'; theme: string; cases: number }[];
  mine: HubMine[];
}

export interface Wallet {
  balance: number;
  history: { amount: number; reason: 'arbiter_vote' | 'arbiter_complete' | 'vote_received' | 'purchase'; item: string | null; at: string }[];
}

export const SOURCE_LABELS: Record<HubMine['source'], string> = { solo: 'Solo', relay: 'Relay', battle: 'Battle', duel: 'Duel' };

export const BD_STATUS_LABELS: Record<HubMine['status'], string> = {
  pending: 'En attente de consentement',
  open: 'Ouverte aux arbitres',
  declined: 'Refusée',
  hidden: 'Masquée',
};

export const REASON_LABELS: Record<Wallet['history'][number]['reason'], string> = {
  arbiter_vote: 'Case jugée',
  arbiter_complete: 'Arbitrage complet',
  vote_received: 'Upvote reçu',
  purchase: 'Achat',
};

/** Libellé d'une ligne du portefeuille: « Recharge utilisée », « Joker utilisé », « Upvote reçu »… */
export const ITEM_USED: Record<string, string> = {
  refill: 'Recharge utilisée',
  constraint_reroll: 'Joker utilisé',
  upgrade_reroll: 'Second choix utilisé',
  emergency_refill: 'Dernière chance utilisée',
};

export const historyLabel = (h: Wallet['history'][number]) => (h.reason === 'purchase' ? ITEM_USED[h.item ?? ''] ?? REASON_LABELS.purchase : REASON_LABELS[h.reason]);
export const signed = (n: number) => `${n > 0 ? '+' : '−'}${Math.abs(n)}`;

export const NARRATIVE_LABELS: Record<'win' | 'loss' | 'tie', string> = {
  win: 'Résultat narratif: tu l’emportes',
  loss: 'Résultat narratif: ton adversaire l’emporte',
  tie: 'Résultat narratif: égalité',
};
