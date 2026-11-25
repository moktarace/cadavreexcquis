import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEIGHT, WIDTH } from '../editor/palette';
import { EditorSession } from '../editor/session';
import { SURVIVOR } from './config';
import { CONSTRAINTS, LEVELS, constraintById, diceOf, drawProposals, isEligible, phaseOf, type Level } from './constraints';
import { SurvivorGame, type RunStateV1 } from './game';
import { inkRulesFor } from './rules';
import { clearRun, decodeCase, encodeCase, loadRun, saveRun } from './storage';
import { UPGRADES, modifiersOf, offerUpgrades } from './upgrades';
import { samePixels } from '../testing/pixels';

/** Générateur déterministe pour les tests. */
function seeded(seed = 1) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 2 ** 32;
  };
}

const newSession = (owned: Record<string, number> = {}, budget: number = SURVIVOR.ink.start) => {
  const s = new EditorSession();
  s.reducedMotion = true;
  s.ink = inkRulesFor(modifiersOf(owned));
  s.inkBudget = budget;
  return s;
};
const line = (s: EditorSession, from: [number, number], to: [number, number]) => {
  s.pointerDown(from[0], from[1]);
  s.pointerMove(to[0], to[1]);
  s.pointerUp();
};

describe('consommation d’encre', () => {
  it('un trait coûte selon sa longueur et son épaisseur, en temps réel', () => {
    const s = newSession();
    s.update({ pen: { size: 3, shape: 'round', texture: 'solid' } });
    s.pointerDown(10, 10);
    const start = s.inkLeft;
    expect(start).toBeLessThan(100);
    s.pointerMove(110, 10);
    expect(s.inkLeft).toBeCloseTo(100 - 100 * 3 * SURVIVOR.costs.strokePerPixel - 3 * SURVIVOR.costs.strokePerPixel, 3);
    s.pointerUp();
    expect(s.inkLeft).toBeCloseTo(100 - 303 * SURVIVOR.costs.strokePerPixel, 3);

    const thick = newSession();
    thick.update({ pen: { size: 12, shape: 'round', texture: 'solid' } });
    line(thick, [10, 10], [110, 10]);
    expect(100 - thick.inkLeft).toBeGreaterThan((100 - s.inkLeft) * 3.5);
  });

  it('une texture qui noircit moins coûte moins', () => {
    const solid = newSession();
    const dots = newSession();
    dots.update({ pen: { size: 8, shape: 'round', texture: 'dots' } });
    solid.update({ pen: { size: 8, shape: 'round', texture: 'solid' } });
    line(solid, [10, 10], [200, 10]);
    line(dots, [10, 10], [200, 10]);
    expect(100 - dots.inkLeft).toBeLessThan((100 - solid.inkLeft) / 2);
  });

  it('le trait s’arrête net quand la réserve est vide, et le crayon ne trace plus', () => {
    const s = newSession({}, 2);
    s.update({ pen: { size: 4, shape: 'round', texture: 'solid' } });
    s.pointerDown(10, 100);
    s.pointerMove(300, 100);
    expect(s.inkLeft).toBeCloseTo(0, 6);
    s.pointerMove(310, 100);
    s.pointerUp();
    const drawn = s.project.pixels.reduce((n, v) => n + (v ? 1 : 0), 0);
    expect(drawn).toBeGreaterThan(20);
    expect(s.project.pixels[100 * WIDTH + 290]).toBe(0); // le trait n'est pas allé au bout
    const before = s.project.pixels.slice();
    line(s, [10, 20], [200, 20]);
    samePixels(s.project.pixels, before);
    expect(s.inkLeft).toBeCloseTo(0, 6);
  });

  it('annuler un trait rend son coût, rétablir le dépense à nouveau', () => {
    const s = newSession();
    line(s, [10, 10], [200, 10]);
    const spent = 100 - s.inkLeft;
    expect(spent).toBeGreaterThan(5);
    s.undo();
    expect(s.inkLeft).toBeCloseTo(100, 6);
    s.redo();
    expect(100 - s.inkLeft).toBeCloseTo(spent, 6);
  });

  it('abandonner un trait en cours (pointercancel) ne coûte rien', () => {
    const s = newSession();
    s.pointerDown(10, 10);
    s.pointerMove(200, 10);
    expect(s.inkLeft).toBeLessThan(100);
    s.pointerCancel();
    expect(s.inkLeft).toBe(100);
  });

  it('la gomme est gratuite et ne rend rien par défaut', () => {
    const s = newSession();
    line(s, [10, 10], [200, 10]);
    const left = s.inkLeft;
    s.setTool('eraser');
    s.update({ eraserSize: 16 });
    line(s, [10, 10], [200, 10]);
    expect(s.project.pixels[10 * WIDTH + 100]).toBe(0);
    expect(s.inkLeft).toBeCloseTo(left, 6);
  });

  it('avec Recyclage, la gomme rend une part de l’encre et un nouvel appui sur annuler la reprend', () => {
    const s = newSession({ recyclage: 2 });
    s.update({ pen: { size: 6, shape: 'round', texture: 'solid' } });
    line(s, [10, 10], [200, 10]);
    const afterDraw = s.inkLeft;
    s.setTool('eraser');
    s.update({ eraserSize: 20 });
    line(s, [0, 10], [210, 10]);
    expect(s.inkLeft).toBeGreaterThan(afterDraw + 1);
    expect(s.inkLeft).toBeLessThan(100);
    const refunded = s.inkLeft;
    s.undo();
    expect(s.inkLeft).toBeCloseTo(afterDraw, 6);
    s.redo();
    expect(s.inkLeft).toBeCloseTo(refunded, 6);
  });

  it('le remboursement ne dépasse jamais l’encre dépensée', () => {
    const s = newSession({ recyclage: 4 }, 100);
    s.update({ pen: { size: 3, shape: 'round', texture: 'solid' } });
    line(s, [10, 10], [60, 10]);
    s.setTool('eraser');
    s.update({ eraserSize: 32 });
    line(s, [0, 10], [320, 10]);
    expect(s.inkLeft).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('Mimo, texte, décor et tampon ont un coût fixe, dépensé au placement', () => {
    const s = newSession();
    s.beginMimo();
    expect(s.pendingCost).toBe(SURVIVOR.costs.mimo);
    expect(s.inkLeft).toBe(100);
    s.placeMimo();
    expect(s.inkLeft).toBe(100 - SURVIVOR.costs.mimo);
    s.beginText();
    s.textSet('Oups');
    s.placeText();
    expect(s.inkLeft).toBeCloseTo(100 - SURVIVOR.costs.mimo - SURVIVOR.costs.text, 6);
    s.beginDecor();
    s.placeDecor();
    expect(s.inkLeft).toBeCloseTo(100 - SURVIVOR.costs.mimo - SURVIVOR.costs.text - SURVIVOR.costs.decor, 6);
    while (s.canUndo) s.undo();
    expect(s.inkLeft).toBe(100);
  });

  it('abandonner un Mimo, un texte ou un décor en cours ne coûte rien', () => {
    const s = newSession();
    s.beginMimo();
    s.cancelMimo();
    s.beginText();
    s.textSet('x');
    s.cancelText();
    s.beginDecor();
    s.cancelDecor();
    expect(s.inkLeft).toBe(100);
  });

  it('sans assez d’encre, les actions payantes sont indisponibles', () => {
    const s = newSession({}, 6);
    expect(s.canAfford('mimo')).toBe(false);
    expect(s.canAfford('text')).toBe(true);
    expect(s.canAfford('decor')).toBe(false);
    s.beginMimo();
    expect(s.canPlacePending).toBe(false);
    expect(s.placeMimo()).toBe(false);
    expect(s.mimo).not.toBeNull();
    s.cancelMimo();
    expect(s.inkLeft).toBe(6);
  });

  it('le pot de peinture coûte selon la surface, et un trop grand remplissage est refusé', () => {
    const s = newSession();
    s.setTool('fill');
    s.update({ color: 2 });
    s.pointerDown(10, 10);
    s.pointerUp();
    expect(100 - s.inkLeft).toBeCloseTo(Math.min(SURVIVOR.costs.fillMax, SURVIVOR.costs.fillBase + WIDTH * HEIGHT * SURVIVOR.costs.fillPerPixel), 3);
    const poor = newSession({}, 5);
    poor.setTool('fill');
    poor.pointerDown(10, 10);
    poor.pointerUp();
    expect(poor.project.pixels.some(Boolean)).toBe(false);
    expect(poor.inkLeft).toBe(5);
  });

  it('le jeu classique n’est pas touché: tout est gratuit', () => {
    const s = new EditorSession();
    expect(s.inkLeft).toBe(Infinity);
    expect(s.canAfford('mimo')).toBe(true);
    line(s, [10, 10], [300, 10]);
    s.beginMimo();
    expect(s.placeMimo()).toBe(true);
    expect(s.project.ink).toBeUndefined();
  });
});

describe('améliorations', () => {
  it('proposent trois choix différents parmi celles encore disponibles', () => {
    const rng = seeded(7);
    for (let i = 0; i < 50; i++) {
      const offer = offerUpgrades({}, rng);
      expect(offer).toHaveLength(3);
      expect(new Set(offer).size).toBe(3);
    }
    const all = new Set<string>();
    for (let i = 0; i < 200; i++) offerUpgrades({}, rng).forEach((id) => all.add(id));
    expect(all.size).toBe(UPGRADES.length);
    const maxed = Object.fromEntries(UPGRADES.filter((u) => u.id !== 'joker').map((u) => [u.id, u.max]));
    expect(offerUpgrades(maxed, rng)).toEqual(['joker']);
  });

  it('s’additionnent, avec des planchers', () => {
    expect(modifiersOf({ encrier: 2 }).capacity).toBe(SURVIVOR.ink.capacity + 2 * SURVIVOR.upgrades.encrier);
    expect(modifiersOf({ plume: 1 }).stroke).toBeCloseTo(0.85, 6);
    expect(modifiersOf({ plume: 99 }).stroke).toBe(SURVIVOR.upgrades.plumeFloor);
    expect(modifiersOf({ architecte: 99 }).decor).toBe(SURVIVOR.upgrades.discountFloor);
    expect(modifiersOf({ ecrivain: 2 }).text).toBeCloseTo(0.5, 6);
    expect(modifiersOf({ recyclage: 99 }).eraseRefund).toBe(SURVIVOR.upgrades.recyclageMax);
    expect(modifiersOf({ regeneration: 3 }).regen).toBe(12);
    expect(modifiersOf({ narrateur: 2 }).reward).toBe(10);
    expect(modifiersOf({ ami: 2 }).freeMimos).toBe(2);
  });

  it('Plume légère réduit le coût des traits, Écrivain celui du texte, Architecte celui des décors', () => {
    const plain = newSession();
    const plume = newSession({ plume: 2 });
    line(plain, [10, 10], [200, 10]);
    line(plume, [10, 10], [200, 10]);
    expect(100 - plume.inkLeft).toBeCloseTo((100 - plain.inkLeft) * 0.7, 3);
    expect(inkRulesFor(modifiersOf({ ecrivain: 1 })).text()).toBeCloseTo(SURVIVOR.costs.text * 0.75, 6);
    expect(inkRulesFor(modifiersOf({ architecte: 1 })).decor()).toBeCloseTo(SURVIVOR.costs.decor * 0.75, 6);
  });

  it('Ami imaginaire offre le premier Mimo de chaque case, et annuler le rend à nouveau gratuit', () => {
    const s = newSession({ ami: 1 });
    expect(s.freeMimoLeft).toBe(true);
    s.beginMimo();
    expect(s.pendingCost).toBe(0);
    s.placeMimo();
    expect(s.inkLeft).toBe(100);
    expect(s.freeMimoLeft).toBe(false);
    s.beginMimo();
    s.mimoMoveTo(50, 50);
    expect(s.pendingCost).toBe(SURVIVOR.costs.mimo);
    s.placeMimo();
    expect(s.inkLeft).toBe(100 - SURVIVOR.costs.mimo);
    s.undo();
    s.undo();
    expect(s.freeMimoLeft).toBe(true);
    const two = newSession({ ami: 2 });
    two.beginMimo();
    two.placeMimo();
    two.beginMimo();
    two.placeMimo();
    expect(two.inkLeft).toBe(100);
  });

  it('une synergie: Plume légère + Recyclage rend le dessin presque gratuit à refaire', () => {
    const s = newSession({ plume: 3, recyclage: 4 });
    s.update({ pen: { size: 6, shape: 'round', texture: 'solid' } });
    line(s, [10, 50], [250, 50]);
    const spent = 100 - s.inkLeft;
    s.setTool('eraser');
    s.update({ eraserSize: 32 });
    line(s, [0, 50], [260, 50]);
    expect(100 - s.inkLeft).toBeLessThan(spent * 0.35);
  });
});

const TOTAL = SURVIVOR.totalCases;
const ids = (level: Level) => CONSTRAINTS.filter((c) => c.level === level).map((c) => c.id).sort();

describe('banque de demandes', () => {
  it('la table compte les 36 résultats des deux dés, sans doublon', () => {
    const all = CONSTRAINTS.map((c) => c.id).sort();
    expect(all).toEqual(Array.from({ length: 36 }, (_, i) => `${Math.floor(i / 6) + 1}${(i % 6) + 1}`).sort());
    expect(new Set(CONSTRAINTS.map((c) => c.text)).size).toBe(36);
    expect(constraintById('31')?.text).toBe('Un personnage se transforme.');
    expect(diceOf('31')).toBe('\u2682\u2680');
  });

  it('douze demandes par difficulté, selon le classement prévu', () => {
    expect(ids('easy')).toEqual(['16', '21', '24', '25', '32', '34', '42', '44', '52', '54', '55', '63']);
    expect(ids('medium')).toEqual(['12', '13', '22', '26', '31', '35', '36', '41', '43', '45', '64', '65']);
    expect(ids('hard')).toEqual(['11', '14', '15', '23', '33', '46', '51', '53', '56', '61', '62', '66']);
  });

  it('récompenses: 10, 20 et 35 d’encre', () => {
    expect(SURVIVOR.rewards).toEqual({ easy: 10, medium: 20, hard: 35 });
  });

  it('les quatre étapes d’une partie de 16 cases restent égales', () => {
    const phases = Array.from({ length: 16 }, (_, i) => phaseOf(i + 1, 16));
    expect(phases.slice(0, 4)).toEqual(['intro', 'intro', 'intro', 'intro']);
    expect(phases.slice(4, 8)).toEqual(['complication', 'complication', 'complication', 'complication']);
    expect(phases.slice(8, 12)).toEqual(['escalade', 'escalade', 'escalade', 'escalade']);
    expect(phases.slice(12)).toEqual(['denouement', 'denouement', 'denouement', 'denouement']);
  });

  it('chaque difficulté garde assez de demandes éligibles à chaque case', () => {
    for (let n = 1; n <= TOTAL; n++) for (const l of LEVELS) expect(CONSTRAINTS.filter((c) => c.level === l && isEligible(c, n, TOTAL)).length).toBeGreaterThanOrEqual(5);
  });
});

describe('tirage des trois demandes', () => {
  it('propose une demande facile, une intermédiaire et une difficile, toutes éligibles', () => {
    const rng = seeded(21);
    for (let n = 1; n <= TOTAL; n++) {
      for (let i = 0; i < 20; i++) {
        const picks = drawProposals(n, TOTAL, [], rng).map((id) => constraintById(id)!);
        expect(picks.map((c) => c.level)).toEqual(['easy', 'medium', 'hard']);
        expect(new Set(picks.map((c) => c.id)).size).toBe(3);
        expect(picks.every((c) => isEligible(c, n, TOTAL))).toBe(true);
      }
    }
  });

  it('respecte l’éligibilité narrative', () => {
    const seen = (n: number) => {
      const out = new Set<string>();
      const rng = seeded(n);
      for (let i = 0; i < 300; i++) drawProposals(n, TOTAL, [], rng).forEach((id) => out.add(id));
      return out;
    };
    expect(seen(1).has('12')).toBe(false); // pas de retour d'un ancien personnage à la première case
    expect(seen(2).has('12')).toBe(true);
    for (const n of [1, 2, 3, 4]) expect(seen(n).has('66')).toBe(false); // pas de trahison au début
    expect(seen(6).has('66')).toBe(true);
    for (const n of [13, 14, 15, 16]) for (const id of ['53', '51', '62', '33']) expect(seen(n).has(id)).toBe(false); // rien qui annonce ou ouvre une suite
    expect(seen(16).has('15')).toBe(false);
  });

  it('ne repropose jamais une demande déjà choisie tant qu’il en reste d’inédites', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rng = seeded(seed);
      const chosen: string[] = [];
      for (let n = 1; n <= TOTAL; n++) chosen.push(drawProposals(n, TOTAL, chosen, rng)[n % 3]);
      expect(new Set(chosen).size).toBe(TOTAL);
    }
  });

  it('les demandes proposées mais non choisies peuvent revenir', () => {
    const rng = seeded(2);
    const shown = drawProposals(1, TOTAL, [], rng);
    const again = new Set<string>();
    for (let i = 0; i < 200; i++) drawProposals(2, TOTAL, [], rng).forEach((id) => again.add(id));
    expect(shown.some((id) => again.has(id))).toBe(true);
  });

  it('en dernier recours, répète une demande en gardant trois propositions distinctes', () => {
    const rng = seeded(5);
    const chosen = CONSTRAINTS.map((c) => c.id);
    const picks = drawProposals(8, TOTAL, chosen, rng);
    expect(new Set(picks).size).toBe(3);
    expect(picks.map((id) => constraintById(id)!.level)).toEqual(['easy', 'medium', 'hard']);
    const almost = CONSTRAINTS.filter((c) => c.level === 'easy' && c.id !== '32').map((c) => c.id);
    expect(drawProposals(8, TOTAL, almost, rng)[0]).toBe('32');
  });

  it('un Joker évite les demandes qui viennent d’être montrées', () => {
    const rng = seeded(9);
    for (let i = 0; i < 50; i++) {
      const first = drawProposals(5, TOTAL, [], rng);
      const next = drawProposals(5, TOTAL, [], rng, first);
      expect(next.some((id, k) => id === first[k])).toBe(false);
    }
  });
});

const pixelsOf = () => {
  const p = new Uint8Array(WIDTH * HEIGHT);
  p.fill(1, 0, 400);
  return p;
};

/** Choisit la demande de la difficulté voulue, puis termine la case. */
function playCase(game: SurvivorGame, spent = 6, level: Level = 'easy') {
  expect(game.choose(game.state.proposals[LEVELS.indexOf(level)])).toBe(true);
  const gain = game.finishCase(pixelsOf(), spent);
  expect(gain).not.toBeNull();
  return gain!;
}

describe('déroulement de la partie', () => {
  it('démarre par le choix de trois demandes, avec un thème et toute la réserve', () => {
    const g = SurvivorGame.start(seeded(5));
    expect(g.state.theme.length).toBeGreaterThan(2);
    expect(g.state).toMatchObject({ caseNo: 1, reserve: SURVIVOR.ink.start, phase: 'choosing', outcome: null, constraintIds: [] });
    expect(g.state.proposals).toHaveLength(3);
    expect(g.constraint).toBeUndefined();
  });

  it('impossible de commencer ou de terminer une case sans demande choisie', () => {
    const g = SurvivorGame.start(seeded(5));
    expect(g.finishCase(pixelsOf(), 0)).toBeNull();
    expect(g.state.phase).toBe('choosing');
    expect(g.choose('absent')).toBe(false);
    expect(g.isStuck(0, false, new Uint8Array(WIDTH * HEIGHT))).toBe(false);
  });

  it('choisir une demande ouvre la case et la fige', () => {
    const g = SurvivorGame.start(seeded(5));
    const [easy, medium] = g.state.proposals;
    expect(g.choose(medium)).toBe(true);
    expect(g.state).toMatchObject({ phase: 'drawing', proposals: [], constraintIds: [medium] });
    expect(g.constraint?.id).toBe(medium);
    expect(g.choose(easy)).toBe(false);
    expect(g.rerollProposals()).toBe(false);
  });

  it('refuse de terminer une case encore vide', () => {
    const g = SurvivorGame.start(seeded(5));
    g.choose(g.state.proposals[0]);
    expect(g.finishCase(new Uint8Array(WIDTH * HEIGHT), 0)).toBeNull();
    expect(g.state.phase).toBe('drawing');
  });

  it('verse automatiquement la récompense de la demande choisie en terminant la case', () => {
    for (const [level, reward] of [['easy', 10], ['medium', 20], ['hard', 35]] as const) {
      const g = SurvivorGame.start(seeded(1));
      const gain = playCase(g, 50, level);
      expect(gain).toEqual({ reward, gained: reward });
      expect(g.state.reserve).toBe(50 + reward);
      expect(g.state.totalSpent).toBe(50);
      expect(g.state.spentPerCase).toEqual([50]);
    }
  });

  it('ne verse la récompense qu’une fois par case', () => {
    const g = SurvivorGame.start(seeded(1));
    playCase(g, 50, 'hard');
    const reserve = g.state.reserve;
    expect(g.finishCase(pixelsOf(), 0)).toBeNull();
    expect(g.finishCase(pixelsOf(), 0)).toBeNull();
    expect(g.state.reserve).toBe(reserve);
    expect(g.cases).toHaveLength(1);
  });

  it('plafonne la réserve à la capacité', () => {
    const g = SurvivorGame.start(seeded(1));
    const gain = playCase(g, 20, 'hard');
    expect(g.state.reserve).toBe(SURVIVOR.ink.capacity);
    expect(gain).toEqual({ reward: 35, gained: 20 });
    const full = SurvivorGame.start(seeded(1));
    expect(playCase(full, 0, 'easy').gained).toBe(0);
    expect(full.state.reserve).toBe(100);
  });

  it('enchaîne les cases par un nouveau choix, avec une amélioration toutes les deux cases', () => {
    const g = SurvivorGame.start(seeded(9));
    playCase(g);
    expect(g.state).toMatchObject({ phase: 'choosing', caseNo: 2 });
    expect(g.state.proposals).toHaveLength(3);
    playCase(g);
    expect(g.state.phase).toBe('upgrade');
    expect(g.state.offer).toHaveLength(3);
    expect(g.chooseUpgrade('absent')).toBe(false);
    const pick = g.state.offer[0];
    expect(g.chooseUpgrade(pick)).toBe(true);
    expect(g.state.upgrades[pick]).toBe(1);
    expect(g.state).toMatchObject({ phase: 'choosing', caseNo: 3, offer: [] });
    expect(g.state.proposals).toHaveLength(3);
  });

  it('Narrateur ajoute +5 d’encre par exemplaire à la demande choisie', () => {
    const g = SurvivorGame.start(seeded(2));
    g.state.upgrades = { narrateur: 2 };
    const medium = g.state.proposals[1];
    expect(g.rewardOf(medium)).toBe(30);
    g.state.reserve = 40;
    g.choose(medium);
    expect(g.finishCase(pixelsOf(), 10)?.reward).toBe(30);
    expect(g.state.reserve).toBe(30 + 30);
  });

  it('applique aussi Encrier et Régénération, sans dépasser la capacité', () => {
    const g = SurvivorGame.start(seeded(2));
    g.state.upgrades = { encrier: 1, regeneration: 1 };
    expect(g.capacity).toBe(125);
    g.state.reserve = 50;
    expect(playCase(g, 10, 'medium').reward).toBe(20 + 4);
    expect(g.state.reserve).toBe(40 + 24);
    const near = SurvivorGame.start(seeded(2));
    near.state.upgrades = { encrier: 1 };
    near.state.reserve = 120;
    playCase(near, 0, 'hard');
    expect(near.state.reserve).toBe(125);
  });

  it('Encrier ajoute sa capacité et l’encre qui va avec', () => {
    const g = SurvivorGame.start(seeded(2));
    g.state.phase = 'upgrade';
    g.state.offer = ['encrier'];
    g.state.reserve = 60;
    g.chooseUpgrade('encrier');
    expect(g.capacity).toBe(125);
    expect(g.state.reserve).toBe(85);
  });

  it('Joker renouvelle les trois demandes avant de dessiner, un nombre limité de fois', () => {
    const g = SurvivorGame.start(seeded(4));
    expect(g.rerollProposals()).toBe(false);
    g.state.jokers = 2;
    const before = [...g.state.proposals];
    expect(g.rerollProposals()).toBe(true);
    expect(g.state.proposals).toHaveLength(3);
    expect(g.state.proposals.some((id, k) => id === before[k])).toBe(false);
    expect(g.state.jokers).toBe(1);
    expect(g.state.reserve).toBe(SURVIVOR.ink.start);
    g.rerollProposals();
    expect(g.rerollProposals()).toBe(false);
    expect(g.state.jokers).toBe(0);
  });

  it('Joker n’agit plus une fois la case commencée', () => {
    const g = SurvivorGame.start(seeded(4));
    g.state.jokers = 2;
    g.choose(g.state.proposals[0]);
    const chosen = [...g.state.constraintIds];
    expect(g.rerollProposals()).toBe(false);
    expect(g.state.jokers).toBe(2);
    expect(g.state.constraintIds).toEqual(chosen);
  });

  it('le choix d’amélioration Joker accorde ses charges', () => {
    const g = SurvivorGame.start(seeded(4));
    g.state.phase = 'upgrade';
    g.state.offer = ['joker'];
    g.chooseUpgrade('joker');
    expect(g.state.jokers).toBe(SURVIVOR.upgrades.jokerCharges);
  });

  it('Dernier souffle ajoute la réserve d’urgence une seule fois', () => {
    const g = SurvivorGame.start(seeded(4));
    g.choose(g.state.proposals[0]);
    expect(g.useEmergency()).toBe(false);
    g.state.emergency = 1;
    g.state.reserve = 0;
    expect(g.useEmergency()).toBe(true);
    expect(g.state.reserve).toBe(SURVIVOR.upgrades.dernierSouffle);
    expect(g.useEmergency()).toBe(false);
  });

  it('victoire à la seizième case, avec le bilan de la partie', () => {
    const g = SurvivorGame.start(seeded(11));
    for (let i = 1; i <= TOTAL; i++) {
      expect(g.state.outcome).toBeNull();
      playCase(g, 5, LEVELS[i % 3]);
      if (g.state.phase === 'upgrade') g.chooseUpgrade(g.state.offer[0]);
    }
    expect(g.state).toMatchObject({ phase: 'finished', outcome: 'victory' });
    expect(g.finishedCases).toBe(16);
    expect(g.cases).toHaveLength(16);
    expect(g.state.totalSpent).toBe(80);
    expect(Object.keys(g.state.upgrades).length).toBeGreaterThan(0);
    expect(new Set(g.state.constraintIds).size).toBe(16);
    expect(Object.values(g.chosenByLevel).reduce((a, b) => a + b, 0)).toBe(16);
    expect(g.chosenByLevel).toEqual({ easy: 5, medium: 6, hard: 5 });
  });

  it('défaite: plus d’encre, plus de Mimo gratuit ni de secours, et une case trop vide pour être terminée', () => {
    const g = SurvivorGame.start(seeded(6));
    g.choose(g.state.proposals[0]);
    const blank = new Uint8Array(WIDTH * HEIGHT);
    expect(g.isStuck(0, false, blank)).toBe(true);
    expect(g.isStuck(30, false, blank)).toBe(false); // il reste de l'encre
    expect(g.isStuck(0, true, blank)).toBe(false); // un Mimo gratuit permet de continuer
    g.state.emergency = 1;
    expect(g.isStuck(0, false, blank)).toBe(false); // le dernier souffle sauve
    g.state.emergency = 0;
    const drawn = new Uint8Array(WIDTH * HEIGHT);
    drawn.fill(1, 0, 500);
    expect(g.isStuck(0, false, drawn)).toBe(false); // la case peut être terminée
    g.lose();
    expect(g.state).toMatchObject({ phase: 'finished', outcome: 'defeat' });
  });

  it('détecte la défaite avec le vrai éditeur: tout dépenser puis tout effacer', () => {
    const g = SurvivorGame.start(seeded(6));
    g.state.reserve = 3;
    g.choose(g.state.proposals[0]);
    const s = new EditorSession();
    s.ink = g.rules;
    s.inkBudget = g.state.reserve;
    s.update({ pen: { size: 6, shape: 'round', texture: 'solid' } });
    line(s, [10, 100], [300, 100]);
    expect(s.inkLeft).toBeCloseTo(0, 6);
    expect(g.isStuck(s.inkLeft, s.freeMimoLeft, s.project.pixels)).toBe(false); // le dessin permet de terminer
    s.setTool('eraser');
    s.update({ eraserSize: 32 });
    line(s, [0, 100], [320, 100]);
    expect(g.isStuck(s.inkLeft, s.freeMimoLeft, s.project.pixels)).toBe(true);
  });

  it('le coût dépensé sur une case sort de la réserve avant la récompense', () => {
    const g = SurvivorGame.start(seeded(1));
    g.choose(g.state.proposals[0]);
    const s = new EditorSession();
    s.ink = g.rules;
    s.inkBudget = g.state.reserve;
    s.update({ pen: { size: 6, shape: 'round', texture: 'solid' } });
    line(s, [10, 100], [300, 100]);
    const spent = s.project.ink!.spent;
    expect(g.finishCase(s.project.pixels, spent)).not.toBeNull();
    expect(g.state.reserve).toBeCloseTo(100 - spent + 10, 6);
  });
});

describe('stockage local', () => {
  it('encode une case en quelques ko et la restitue à l’identique', () => {
    const px = new Uint8Array(WIDTH * HEIGHT);
    px.fill(1, 1000, 1700);
    px.fill(3, 40000, 40500);
    px[77] = 5;
    const text = encodeCase(px);
    expect(text.length).toBeLessThan(4000);
    expect(decodeCase(text, px.length)).toEqual(px);
    const noisy = new Uint8Array(WIDTH * HEIGHT).map((_, i) => (i * 7) % 6);
    expect(decodeCase(encodeCase(noisy), noisy.length)).toEqual(noisy);
  });

  describe('sauvegarde de la partie', () => {
    const store = new Map<string, string>();
    beforeEach(() => {
      store.clear();
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('conserve les cases terminées et la progression, puis efface', () => {
      const g = SurvivorGame.start(seeded(8));
      playCase(g, 12);
      playCase(g, 7, 'hard');
      expect(saveRun(g)).toBe(true);
      const back = loadRun()!;
      expect(back.state).toEqual(g.state);
      expect(back.state.phase).toBe('upgrade');
      expect(back.cases).toEqual(g.cases);
      expect(store.get('cl.survivor.v1')).not.toMatch(/pixels/);
      clearRun();
      expect(loadRun()).toBeNull();
    });

    it('reprend le choix en cours: recharger ne renouvelle pas gratuitement les demandes', () => {
      const g = SurvivorGame.start(seeded(8));
      g.state.jokers = 1;
      saveRun(g);
      expect(loadRun()!.state.proposals).toEqual(g.state.proposals);
      g.rerollProposals();
      saveRun(g);
      const back = loadRun()!;
      expect(back.state.proposals).toEqual(g.state.proposals);
      expect(back.state.jokers).toBe(0);
      expect(back.rerollProposals()).toBe(false);
    });

    it('reprend la demande choisie, sans brouillon du dessin', () => {
      const g = SurvivorGame.start(seeded(8));
      g.choose(g.state.proposals[2]);
      saveRun(g);
      const back = loadRun()!;
      expect(back.state.phase).toBe('drawing');
      expect(back.constraint?.id).toBe(g.constraint?.id);
      expect(back.state.proposals).toEqual([]);
    });

    it('la reprise relit toujours la dernière sauvegarde', () => {
      const g = SurvivorGame.start(seeded(8));
      saveRun(g);
      const first = loadRun()!;
      playCase(g, 9);
      saveRun(g);
      expect(first.state.caseNo).toBe(1);
      expect(loadRun()!.state.caseNo).toBe(2);
    });

    it('ignore une sauvegarde illisible ou d’une version inconnue', () => {
      store.set('cl.survivor.v1', '{pas du json');
      expect(loadRun()).toBeNull();
      store.set('cl.survivor.v1', JSON.stringify({ state: { version: 9 }, cases: [] }));
      expect(loadRun()).toBeNull();
    });

    describe('anciennes sauvegardes', () => {
      const v1 = (over: Partial<RunStateV1>): RunStateV1 => ({
        version: 1,
        theme: 'Fausse alerte',
        caseNo: 1,
        reserve: 80,
        upgrades: { plume: 1 },
        constraintIds: ['45'],
        results: [],
        spentPerCase: [],
        jokers: 1,
        emergency: 0,
        phase: 'drawing',
        offer: [],
        outcome: null,
        totalSpent: 0,
        ...over,
      });
      const write = (state: RunStateV1, n: number) => store.set('cl.survivor.v1', JSON.stringify({ state, cases: Array.from({ length: n }, () => encodeCase(pixelsOf())) }));

      it('une case en cours repart sur trois demandes, cases terminées conservées', () => {
        write(v1({ caseNo: 3, constraintIds: ['12', '31', '45'], results: [true, false], spentPerCase: [10, 20], totalSpent: 30 }), 2);
        const g = loadRun()!;
        expect(g.state).toMatchObject({ version: 2, phase: 'choosing', caseNo: 3, reserve: 80, constraintIds: ['12', '31'], totalSpent: 30, jokers: 1 });
        expect(g.state.proposals).toHaveLength(3);
        expect(g.cases).toHaveLength(2);
        expect(JSON.parse(store.get('cl.survivor.v1')!).state.version).toBe(2);
        expect(loadRun()!.state.proposals).toEqual(g.state.proposals);
      });

      it('une case terminée mais pas encore validée touche la récompense de sa demande', () => {
        write(v1({ phase: 'validating', reserve: 60, results: [], spentPerCase: [20], totalSpent: 20 }), 1);
        const g = loadRun()!;
        expect(g.state).toMatchObject({ phase: 'choosing', caseNo: 2, constraintIds: ['45'] });
        expect(g.state.reserve).toBe(60 + 20);
        expect(g.cases).toHaveLength(1);
      });

      it('une ancienne demande disparue vaut la récompense facile; la validation de la case 2 mène à l’amélioration', () => {
        write(v1({ phase: 'validating', caseNo: 2, reserve: 40, constraintIds: ['12', 'intro-3'], results: [true], spentPerCase: [5, 10], totalSpent: 15 }), 2);
        const g = loadRun()!;
        expect(g.state.phase).toBe('upgrade');
        expect(g.state.offer).toHaveLength(3);
        expect(g.state.reserve).toBe(40 + 10);
      });

      it('garde un choix d’amélioration et une partie terminée', () => {
        write(v1({ phase: 'upgrade', caseNo: 2, constraintIds: ['12', '31'], results: [true, true], spentPerCase: [5, 5], offer: ['joker', 'plume'] }), 2);
        const up = loadRun()!;
        expect(up.state).toMatchObject({ phase: 'upgrade', caseNo: 2, offer: ['joker', 'plume'] });
        write(v1({ phase: 'finished', outcome: 'defeat', caseNo: 2, constraintIds: ['12', '31'], results: [true, true], spentPerCase: [5, 5] }), 2);
        expect(loadRun()!.state).toMatchObject({ phase: 'finished', outcome: 'defeat' });
      });
    });
  });
});
