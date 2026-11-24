import themeBank from '../../supabase/themes.json';
import { SURVIVOR } from './config';
import { PHASE_LABELS, constraintById, phaseOf, pickConstraint } from './constraints';
import { inkRulesFor } from './rules';
import { modifiersOf, offerUpgrades, upgradeById } from './upgrades';

export type RunPhase = 'drawing' | 'validating' | 'upgrade' | 'finished';

/** Tout ce qu'il faut pour reprendre une partie (les cases terminées sont conservées à part, en pixels). */
export interface RunState {
  version: 1;
  theme: string;
  /** Case en cours, de 1 à `totalCases`. */
  caseNo: number;
  /** Encre disponible au début de la case en cours. */
  reserve: number;
  upgrades: Record<string, number>;
  /** Contrainte de chaque case, la case en cours comprise. */
  constraintIds: string[];
  /** Contrainte respectée ou non, pour chaque case terminée. */
  results: boolean[];
  /** Encre dépensée sur chaque case terminée. */
  spentPerCase: number[];
  jokers: number;
  emergency: number;
  phase: RunPhase;
  offer: string[];
  outcome: 'victory' | 'defeat' | null;
  totalSpent: number;
}

const themes = (themeBank as { themes: { text: string }[] }).themes.map((t) => t.text);
const nonWhite = (pixels: Uint8Array) => pixels.reduce((n, v) => n + (v ? 1 : 0), 0);

/** Une partie de Survivor: logique pure, sans interface; l'éditeur ne lui prête que ses pixels et l'encre dépensée. */
export class SurvivorGame {
  /** Pixels des cases terminées, dans l'ordre. */
  cases: Uint8Array[] = [];

  constructor(
    public state: RunState,
    private readonly rng: () => number = Math.random,
  ) {}

  static start(rng: () => number = Math.random): SurvivorGame {
    const first = pickConstraint([], rng);
    return new SurvivorGame(
      {
        version: 1,
        theme: themes[Math.min(themes.length - 1, Math.floor(rng() * themes.length))],
        caseNo: 1,
        reserve: SURVIVOR.ink.start,
        upgrades: {},
        constraintIds: [first.id],
        results: [],
        spentPerCase: [],
        jokers: 0,
        emergency: 0,
        phase: 'drawing',
        offer: [],
        outcome: null,
        totalSpent: 0,
      },
      rng,
    );
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

  get constraint() {
    return constraintById(this.state.constraintIds[this.state.caseNo - 1])!;
  }

  get phaseLabel() {
    return PHASE_LABELS[phaseOf(this.state.caseNo, SURVIVOR.totalCases)];
  }

  get finishedCases() {
    return this.state.results.length;
  }

  get respectedCount() {
    return this.state.results.filter(Boolean).length;
  }

  /** Une case se termine dès qu'elle contient assez de dessin. */
  isTerminable(pixels: Uint8Array): boolean {
    return nonWhite(pixels) >= SURVIVOR.minCasePixels;
  }

  /** Valide la case en cours: ses pixels et l'encre qu'elle a coûté. Faux si elle est trop vide. */
  finishCase(pixels: Uint8Array, spent: number): boolean {
    if (this.state.phase !== 'drawing' || !this.isTerminable(pixels)) return false;
    this.cases.push(pixels.slice());
    this.state.spentPerCase.push(spent);
    this.state.totalSpent += spent;
    this.state.reserve = Math.max(0, this.state.reserve - spent);
    this.state.phase = 'validating';
    return true;
  }

  /** Auto-évaluation de la contrainte: récompense en encre, puis amélioration, case suivante ou victoire. */
  validate(respected: boolean) {
    const s = this.state;
    if (s.phase !== 'validating') return;
    const m = this.modifiers;
    const reward = (respected ? SURVIVOR.rewards.respected + m.reward : SURVIVOR.rewards.notRespected) + m.regen;
    s.reserve = Math.min(m.capacity, s.reserve + reward);
    s.results.push(respected);
    if (s.caseNo >= SURVIVOR.totalCases) {
      s.phase = 'finished';
      s.outcome = 'victory';
    } else if (s.caseNo % SURVIVOR.upgradeEvery === 0) {
      s.phase = 'upgrade';
      s.offer = offerUpgrades(s.upgrades, this.rng);
    } else this.nextCase();
  }

  /** Récompense qu'obtiendrait la validation, pour l'afficher sur les boutons. */
  rewardFor(respected: boolean): number {
    const m = this.modifiers;
    return (respected ? SURVIVOR.rewards.respected + m.reward : SURVIVOR.rewards.notRespected) + m.regen;
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
    s.constraintIds.push(pickConstraint(s.constraintIds, this.rng).id);
    s.phase = 'drawing';
  }

  /** Joker: remplace la contrainte de la case en cours par une autre de la même étape. */
  replaceConstraint(): boolean {
    const s = this.state;
    if (s.phase !== 'drawing' || s.jokers <= 0) return false;
    s.jokers--;
    s.constraintIds[s.caseNo - 1] = pickConstraint(s.constraintIds, this.rng, this.constraint.id).id;
    return true;
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
    return s.phase === 'drawing' && inkLeft < SURVIVOR.ink.minPlayable && !freeMimoLeft && s.emergency <= 0 && !this.isTerminable(pixels);
  }

  lose() {
    this.state.phase = 'finished';
    this.state.outcome = 'defeat';
  }
}
