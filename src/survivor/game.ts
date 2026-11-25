import themeBank from '../../supabase/themes.json';
import { SURVIVOR } from './config';
import { LEVELS, PHASE_LABELS, constraintById, drawProposals, phaseOf, type Level } from './constraints';
import { inkRulesFor } from './rules';
import { modifiersOf, offerUpgrades, upgradeById } from './upgrades';

/** Consommables payants (catalogue, prix et effets: serveur, voir 0016). */
export type ShopItem = 'refill' | 'constraint_reroll' | 'upgrade_reroll' | 'emergency_refill';

/** Achats d'une partie Solo: reçus déjà appliqués (jamais deux fois), consommables utilisés, achat en cours d'envoi. */
export interface ShopState {
  applied: string[];
  bought: ShopItem[];
  pending: { id: string; item: ShopItem } | null;
}

/** Reçu délivré par le serveur: seul `effect` (jamais un prix ni un montant choisi ici) pilote l'effet local. */
export interface PurchaseReceipt {
  purchase: string;
  item: ShopItem;
  effect: number | null;
}

export type RunPhase = 'choosing' | 'drawing' | 'upgrade' | 'finished';

/** Tout ce qu'il faut pour reprendre une partie (les cases terminées sont conservées à part, en pixels). */
export interface RunState {
  version: 2;
  theme: string;
  /** Case en cours, de 1 à `totalCases`. */
  caseNo: number;
  /** Encre disponible au début de la case en cours. */
  reserve: number;
  upgrades: Record<string, number>;
  /** Les trois demandes offertes pour la case en cours; vides une fois l'une d'elles choisie. */
  proposals: string[];
  /** Demande choisie pour chaque case, la case en cours comprise une fois choisie. */
  constraintIds: string[];
  /** Encre dépensée sur chaque case terminée. */
  spentPerCase: number[];
  jokers: number;
  emergency: number;
  phase: RunPhase;
  offer: string[];
  outcome: 'victory' | 'defeat' | null;
  totalSpent: number;
  /** Identifiant stable de la partie Solo (limites d'achat côté serveur); ajouté aux anciennes sauvegardes au chargement. */
  gameId?: string;
  shop?: ShopState;
}

/** Ancien format (contrainte imposée puis auto-validée), lu seulement pour reprendre une partie existante. */
export interface RunStateV1 {
  version: 1;
  theme: string;
  caseNo: number;
  reserve: number;
  upgrades: Record<string, number>;
  constraintIds: string[];
  results: boolean[];
  spentPerCase: number[];
  jokers: number;
  emergency: number;
  phase: 'drawing' | 'validating' | 'upgrade' | 'finished';
  offer: string[];
  outcome: 'victory' | 'defeat' | null;
  totalSpent: number;
}

/** Ce que rapporte une case terminée: la récompense annoncée et l'encre réellement ajoutée (la réserve est plafonnée). */
export interface CaseGain {
  reward: number;
  gained: number;
}

const themes = (themeBank as { themes: { text: string }[] }).themes.map((t) => t.text);
export const nonWhite = (pixels: Uint8Array) => pixels.reduce((n, v) => n + (v ? 1 : 0), 0);

/** Panne d'encre: plus de quoi tracer, aucun Mimo gratuit, aucun secours, et une case encore trop vide pour être terminée. */
export const stuckNow = (o: { inkLeft: number; freeMimoLeft: boolean; emergency: number; terminable: boolean }) =>
  o.inkLeft < SURVIVOR.ink.minPlayable && !o.freeMimoLeft && o.emergency <= 0 && !o.terminable;

/** Une partie de Survivor: logique pure, sans interface; l'éditeur ne lui prête que ses pixels et l'encre dépensée. */
export class SurvivorGame {
  /** Pixels des cases terminées, dans l'ordre. */
  cases: Uint8Array[] = [];

  constructor(
    public state: RunState,
    private readonly rng: () => number = Math.random,
  ) {}

  static start(rng: () => number = Math.random): SurvivorGame {
    return new SurvivorGame(
      {
        version: 2,
        theme: themes[Math.min(themes.length - 1, Math.floor(rng() * themes.length))],
        caseNo: 1,
        reserve: SURVIVOR.ink.start,
        upgrades: {},
        proposals: drawProposals(1, SURVIVOR.totalCases, [], rng),
        constraintIds: [],
        spentPerCase: [],
        jokers: 0,
        emergency: 0,
        phase: 'choosing',
        offer: [],
        outcome: null,
        totalSpent: 0,
        gameId: crypto.randomUUID(),
        shop: { applied: [], bought: [], pending: null },
      },
      rng,
    );
  }

  /**
   * Reprend une partie de l'ancien format en gardant ses cases. Une case encore en dessin repart sur trois demandes à choisir;
   * une case terminée mais pas encore validée touche la récompense de sa demande (facile si elle n'existe plus).
   */
  static fromV1(old: RunStateV1, rng: () => number = Math.random): SurvivorGame {
    const { results: _results, phase, ...rest } = old;
    const finished = old.spentPerCase.length;
    const game = new SurvivorGame(
      { ...rest, version: 2, proposals: [], constraintIds: old.constraintIds.slice(0, finished), phase: phase === 'validating' ? 'drawing' : phase === 'drawing' ? 'choosing' : phase },
      rng,
    );
    const s = game.state;
    if (phase === 'drawing') s.proposals = drawProposals(s.caseNo, SURVIVOR.totalCases, s.constraintIds, rng);
    if (phase === 'validating') game.award(old.constraintIds[finished - 1]);
    return game;
  }

  get modifiers() {
    return modifiersOf(this.state.upgrades);
  }

  get rules() {
    return inkRulesFor(this.modifiers);
  }

  get capacity() {
    return this.modifiers.capacity;
  }

  /** Demande choisie pour la case en cours (absente tant qu'on est en train de choisir). */
  get constraint() {
    return this.state.phase === 'drawing' ? constraintById(this.state.constraintIds[this.state.caseNo - 1]) : undefined;
  }

  get phaseLabel() {
    return PHASE_LABELS[phaseOf(this.state.caseNo, SURVIVOR.totalCases)];
  }

  get finishedCases() {
    return this.state.spentPerCase.length;
  }

  /** Nombre de demandes choisies par difficulté. */
  get chosenByLevel(): Record<Level, number> {
    const out: Record<Level, number> = { easy: 0, medium: 0, hard: 0 };
    for (const id of this.state.constraintIds) {
      const c = constraintById(id);
      if (c) out[c.level]++;
    }
    return out;
  }

  /** Encre rapportée par une demande, bonus des améliorations compris (régénération en plus, voir `finishCase`). */
  rewardOf(id: string): number {
    const level = constraintById(id)?.level ?? LEVELS[0];
    return SURVIVOR.rewards[level] + this.modifiers.reward;
  }

  get gameId(): string {
    return (this.state.gameId ??= crypto.randomUUID());
  }

  get shop(): ShopState {
    return (this.state.shop ??= { applied: [], bought: [], pending: null });
  }

  /** Le consommable a-t-il un sens maintenant? (indicatif: le serveur ne voit pas la partie Solo) */
  canUse(item: ShopItem, minMissing = 20): boolean {
    const s = this.state;
    if (this.shop.bought.includes(item)) return false;
    if (item === 'refill') return s.phase === 'choosing' && this.capacity - s.reserve >= minMissing;
    if (item === 'constraint_reroll') return s.phase === 'choosing';
    if (item === 'upgrade_reroll') return s.phase === 'upgrade' && offerUpgrades(s.upgrades, this.rng, SURVIVOR.offerSize, s.offer).length === SURVIVOR.offerSize;
    return s.phase === 'drawing' && s.emergency === 0;
  }

  beginPurchase(id: string, item: ShopItem) {
    this.shop.pending = { id, item };
  }

  clearPending() {
    this.shop.pending = null;
  }

  /**
   * Applique un achat confirmé par le serveur, au plus une fois par reçu (rechargement, relance, récupération).
   * Les anciens tirages ne bougent pas; un Joker payant ne consomme aucune charge acquise.
   */
  applyPurchase(r: PurchaseReceipt): boolean {
    const s = this.state;
    const shop = this.shop;
    if (shop.applied.includes(r.purchase)) {
      if (shop.pending?.id === r.purchase) shop.pending = null;
      return false;
    }
    if (r.item === 'refill') s.reserve = Math.min(this.capacity, s.reserve + (r.effect ?? 0));
    else if (r.item === 'emergency_refill') s.reserve += r.effect ?? 0;
    else if (r.item === 'constraint_reroll' && s.phase === 'choosing') {
      s.proposals = drawProposals(s.caseNo, SURVIVOR.totalCases, s.constraintIds, this.rng, s.proposals);
    } else if (r.item === 'upgrade_reroll' && s.phase === 'upgrade') {
      const next = offerUpgrades(s.upgrades, this.rng, SURVIVOR.offerSize, s.offer);
      if (next.length === SURVIVOR.offerSize) s.offer = next;
    }
    shop.applied.push(r.purchase);
    shop.bought.push(r.item);
    if (shop.pending?.id === r.purchase) shop.pending = null;
    return true;
  }

  /** Une case se termine dès qu'elle contient assez de dessin. */
  isTerminable(pixels: Uint8Array): boolean {
    return nonWhite(pixels) >= SURVIVOR.minCasePixels;
  }

  /** Choisit l'une des trois demandes et ouvre la case. */
  choose(id: string): boolean {
    const s = this.state;
    if (s.phase !== 'choosing' || !s.proposals.includes(id)) return false;
    s.constraintIds.push(id);
    s.proposals = [];
    s.phase = 'drawing';
    return true;
  }

  /** Joker: tire trois nouvelles demandes, avant de commencer à dessiner. */
  rerollProposals(): boolean {
    const s = this.state;
    if (s.phase !== 'choosing' || s.jokers <= 0) return false;
    s.jokers--;
    s.proposals = drawProposals(s.caseNo, SURVIVOR.totalCases, s.constraintIds, this.rng, s.proposals);
    return true;
  }

  /** Termine la case en cours: ses pixels et l'encre qu'elle a coûté. La récompense est versée ici, une seule fois. Nul si la case est trop vide. */
  finishCase(pixels: Uint8Array, spent: number): CaseGain | null {
    const s = this.state;
    if (s.phase !== 'drawing' || !this.isTerminable(pixels)) return null;
    this.cases.push(pixels.slice());
    s.spentPerCase.push(spent);
    s.totalSpent += spent;
    s.reserve = Math.max(0, s.reserve - spent);
    return this.award(s.constraintIds[s.caseNo - 1]);
  }

  /** Verse la récompense de la demande, puis enchaîne: amélioration, case suivante ou victoire. */
  private award(constraintId: string): CaseGain {
    const s = this.state;
    const m = this.modifiers;
    const reward = this.rewardOf(constraintId) + m.regen;
    const before = s.reserve;
    s.reserve = Math.min(m.capacity, before + reward);
    if (s.caseNo >= SURVIVOR.totalCases) {
      s.phase = 'finished';
      s.outcome = 'victory';
    } else if (s.caseNo % SURVIVOR.upgradeEvery === 0) {
      s.phase = 'upgrade';
      s.offer = offerUpgrades(s.upgrades, this.rng);
    } else this.nextCase();
    return { reward, gained: s.reserve - before };
  }

  chooseUpgrade(id: string): boolean {
    const s = this.state;
    const def = upgradeById(id);
    if (s.phase !== 'upgrade' || !def || !s.offer.includes(id)) return false;
    s.upgrades[id] = (s.upgrades[id] ?? 0) + 1;
    const a = SURVIVOR.upgrades;
    if (id === 'encrier') s.reserve = Math.min(this.capacity, s.reserve + a.encrier);
    if (id === 'joker') s.jokers += a.jokerCharges;
    if (id === 'souffle') s.emergency += 1;
    s.offer = [];
    this.nextCase();
    return true;
  }

  private nextCase() {
    const s = this.state;
    s.caseNo++;
    s.proposals = drawProposals(s.caseNo, SURVIVOR.totalCases, s.constraintIds, this.rng);
    s.phase = 'choosing';
  }

  /** Dernier souffle: ajoute la réserve d'urgence (une seule fois par exemplaire). */
  useEmergency(): boolean {
    const s = this.state;
    if (s.phase !== 'drawing' || s.emergency <= 0) return false;
    s.emergency--;
    s.reserve += SURVIVOR.upgrades.dernierSouffle;
    return true;
  }

  /**
   * Défaite: plus d'encre pour tracer, aucun Mimo gratuit, aucune réserve d'urgence, et une case encore trop vide pour être terminée.
   * `inkLeft` et `freeMimoLeft` viennent de l'éditeur, `pixels` du dessin en cours.
   */
  isStuck(inkLeft: number, freeMimoLeft: boolean, pixels: Uint8Array): boolean {
    const s = this.state;
    return s.phase === 'drawing' && stuckNow({ inkLeft, freeMimoLeft, emergency: s.emergency, terminable: this.isTerminable(pixels) });
  }

  lose() {
    this.state.phase = 'finished';
    this.state.outcome = 'defeat';
  }
}
