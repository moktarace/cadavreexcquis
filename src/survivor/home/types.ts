import type { Hub } from '../arbiter/types';
import { MODE_LABELS, type GameView, type MultiMode, type Rules } from '../multi/types';

/** Événement du flux d'activité (`survivor_activity`, migration 0017): dérivé des tables existantes, donc jamais en double. */
export interface ActivityEvent {
  key: string;
  kind: 'match_found' | 'invite_accepted' | 'turn' | 'game_done' | 'duel_verdict' | 'consent_request' | 'bd_judged' | 'arbitration_done';
  at: string;
  game_id: string | null;
  bd_id: string | null;
  mode: string | null;
  theme: string | null;
  amount: number | null;
  count: number | null;
  ups: number | null;
  result: string | null;
}

export interface Activity {
  /** Repère serveur à renvoyer pour « tout marquer comme lu »: seul ce que le joueur a vu est marqué. */
  now: string;
  read_until: string;
  unread: number;
  events: ActivityEvent[];
  /** Défis et cases en attente de quelqu'un, tels que comptés par le serveur. */
  open: { relay: number; duel: number; battle: number };
}

/** Où mène un événement: la partie, l'espace Arbitre ou le portefeuille. */
export type EventTarget = { to: 'game'; gameId: string } | { to: 'arbiter' } | { to: 'wallet' };

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const label = (mode: string | null) => (mode && mode in MODE_LABELS ? MODE_LABELS[mode as MultiMode] : mode === 'solo' ? 'Solo' : 'BD');

const DONE_TEXT: Record<string, string> = {
  victory: 'Victoire collective: la BD est terminée',
  defeat: 'Défaite: panne d’encre',
  win: 'Victoire',
  loss: 'Défaite',
  draw: 'Égalité',
  completed: 'Partie terminée',
  expired: 'Délai dépassé',
};

const VERDICT_TEXT: Record<string, string> = {
  win: 'tu l’emportes',
  loss: 'ton adversaire l’emporte',
  tie: 'égalité',
};

/** Texte d'un événement: seulement des champs calculés par le serveur. Regroupe déjà arbitrages, upvotes et encre d'une même BD. */
export function describeEvent(e: ActivityEvent): { title: string; detail: string | null; target: EventTarget | null } {
  const theme = e.theme ? `« ${e.theme} »` : null;
  const game: EventTarget | null = e.game_id ? { to: 'game', gameId: e.game_id } : null;
  switch (e.kind) {
    case 'match_found':
      return { title: 'Adversaire trouvé', detail: `${label(e.mode)} ${theme ?? ''}`.trim(), target: game };
    case 'invite_accepted':
      return { title: 'Invitation acceptée', detail: `${label(e.mode)} ${theme ?? ''}`.trim(), target: game };
    case 'turn':
      return { title: 'Nouveau tour disponible', detail: `${label(e.mode)} ${theme ?? ''}`.trim(), target: game };
    case 'game_done':
      return { title: DONE_TEXT[e.result ?? 'completed'] ?? 'Partie terminée', detail: `${label(e.mode)} ${theme ?? ''}`.trim(), target: game };
    case 'duel_verdict':
      return { title: `Résultat narratif du Duel: ${VERDICT_TEXT[e.result ?? 'tie'] ?? 'décidé'}`, detail: theme, target: game };
    case 'consent_request':
      return { title: 'Demande d’arbitrage à accepter ou refuser', detail: `${label(e.mode)} ${theme ?? ''}`.trim(), target: { to: 'arbiter' } };
    case 'bd_judged': {
      const ink = e.amount ? ` : +${e.amount} encre bonus` : '';
      return { title: `Ta BD ${theme ?? ''} a reçu ${plural(e.count ?? 0, 'arbitrage', 'arbitrages')}`.replace('  ', ' '), detail: `${plural(e.ups ?? 0, 'upvote', 'upvotes')}${ink}`, target: { to: 'arbiter' } };
    }
    case 'arbitration_done':
      return { title: `Arbitrage terminé : +${e.amount ?? 0} encre bonus`, detail: theme, target: { to: 'wallet' } };
  }
}

export type MatchKey = 'searching' | 'found' | 'my_turn' | 'their_turn' | 'done';

/** États explicites d'une partie, déduits des seuls champs calculés par le serveur (le client ne recalcule aucun droit). */
export function matchState(g: GameView): { key: MatchKey; label: string } {
  if (g.status === 'cancelled') return { key: 'done', label: 'Défi annulé' };
  if (g.status === 'finished' || g.status === 'abandoned') return { key: 'done', label: 'Partie terminée' };
  if (g.status === 'searching') return { key: 'searching', label: 'Recherche d’un adversaire' };
  if (g.can_play) {
    const fresh = g.mode !== 'relay' && g.cases_done === 0 && g.players.every((p) => p.cases_done === 0);
    if (fresh) return { key: 'found', label: 'Adversaire trouvé: la partie commence' };
    return { key: 'my_turn', label: g.mode === 'relay' && g.reservation_until ? 'Case réservée pour toi' : 'À toi de jouer' };
  }
  if (g.mode === 'battle') return { key: 'their_turn', label: 'Tour de l’adversaire' };
  if (g.mode === 'duel') return { key: 'their_turn', label: g.my_status === 'done' ? 'Tu as fini: l’adversaire dessine encore' : 'En attente' };
  return { key: 'their_turn', label: 'En attente d’un autre dessinateur' };
}

export type PlayTarget =
  | { kind: 'game'; game: GameView }
  | { kind: 'solo' }
  | { kind: 'relay_new' }
  | { kind: 'choose' };

const RANK: Record<MultiMode, number> = { battle: 0, duel: 1, relay: 2 };
/** En dessous d'une heure, un tour proche de son expiration passe avant les priorités par mode. */
const URGENT_SECONDS = 3600;

/**
 * Ce que « Jouer » propose, jamais exécuté sans le geste du joueur:
 * Battle à jouer, Duel à poursuivre, Relay (réservation d'abord), Solo à reprendre, nouvelle case Relay, sinon le choix.
 * Un tour qui expire dans moins d'une heure passe devant (le plus proche d'abord).
 */
export function suggestPlay(games: readonly GameView[] | null, solo: { resumable: boolean }, openRelay: number, exclude?: string): PlayTarget {
  const playable = (games ?? []).filter((g) => g.can_play && (g.status === 'active' || g.status === 'searching') && g.id !== exclude);
  const left = (g: GameView) => g.seconds_left ?? Infinity;
  const urgent = playable.filter((g) => left(g) < URGENT_SECONDS).sort((a, b) => left(a) - left(b))[0];
  if (urgent) return { kind: 'game', game: urgent };
  const best = [...playable].sort((a, b) => RANK[a.mode] - RANK[b.mode] || Number(!!b.reservation_until) - Number(!!a.reservation_until) || left(a) - left(b))[0];
  if (best) return { kind: 'game', game: best };
  if (solo.resumable) return { kind: 'solo' };
  if (openRelay > 0) return { kind: 'relay_new' };
  return { kind: 'choose' };
}

/** Parties « À toi de jouer » par mode, depuis la liste du serveur. */
export function turnsByMode(games: readonly GameView[] | null): Record<MultiMode, number> {
  const out: Record<MultiMode, number> = { relay: 0, duel: 0, battle: 0 };
  for (const g of games ?? []) if (g.can_play && (g.status === 'active' || g.status === 'searching')) out[g.mode]++;
  return out;
}

export interface ActivityLine {
  /** Ce que le joueur peut faire tout de suite. */
  now: string;
  /** Ce qui attend d'autres joueurs, quand le serveur le sait. */
  open: string | null;
}

/** Une ligne par activité, uniquement avec des valeurs du serveur (ou de la sauvegarde pour le Solo). */
export function activityLines(
  games: readonly GameView[] | null,
  activity: Activity | null,
  hub: Hub | null,
  solo: { resumable: boolean; caseNo: number } | null,
  rules: Rules | null,
): Record<'solo' | MultiMode | 'arbiter', ActivityLine> {
  const t = turnsByMode(games);
  const known = games !== null;
  const turns = (n: number, one: string, many: string, none: string) => (!known ? 'Connexion nécessaire' : n === 0 ? none : plural(n, one, many));
  const open = activity?.open;
  return {
    solo: { now: solo?.resumable ? `Partie en cours · case ${solo.caseNo}/${rules?.total_cases ?? 16}` : 'Nouvelle partie', open: 'Sur cet appareil, sans connexion' },
    relay: {
      now: turns(Math.max(t.relay, open?.relay ?? 0), 'case à dessiner', 'cases à dessiner', 'Aucune case disponible'),
      open: null,
    },
    duel: { now: turns(t.duel, 'tour à jouer', 'tours à jouer', 'Aucun tour à jouer'), open: open ? plural(open.duel, 'défi ouvert', 'défis ouverts') : null },
    battle: { now: turns(t.battle, 'tour à jouer', 'tours à jouer', 'Aucun tour à jouer'), open: open ? plural(open.battle, 'défi ouvert', 'défis ouverts') : null },
    arbiter: {
      now: !hub ? 'Connexion nécessaire' : hub.active ? `Arbitrage à reprendre (${hub.active.voted}/${hub.active.total})` : hub.available === 0 ? 'Aucune BD à juger' : plural(hub.available, 'BD à juger', 'BD à juger'),
      open: hub && hub.consents.length > 0 ? plural(hub.consents.length, 'demande à traiter', 'demandes à traiter') : null,
    },
  };
}
