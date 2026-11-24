import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEIGHT, WIDTH } from '../editor/palette';
import { EditorSession } from '../editor/session';
import { SURVIVOR } from './config';
import { CONSTRAINTS, constraintById, diceOf, phaseOf, pickConstraint } from './constraints';
import { SurvivorGame } from './game';
import { inkRulesFor } from './rules';
import { clearRun, decodeCase, encodeCase, loadRun, saveRun } from './storage';
import { UPGRADES, modifiersOf, offerUpgrades } from './upgrades';

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
    expect(s.project.pixels).toEqual(before);
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

describe('consignes de l’éditeur (deux dés)', () => {
  it('la table compte les 36 résultats des deux dés, sans doublon', () => {
    const ids = CONSTRAINTS.map((c) => c.id).sort();
    expect(ids).toEqual(Array.from({ length: 36 }, (_, i) => `${Math.floor(i / 6) + 1}${(i % 6) + 1}`).sort());
    expect(new Set(CONSTRAINTS.map((c) => c.text)).size).toBe(36);
    expect(constraintById('31')?.text).toBe('Un personnage se transforme.');
    expect(diceOf('31')).toBe('\u2682\u2680');
  });

  it('les quatre étapes d’une partie de 16 cases restent égales', () => {
    const phases = Array.from({ length: 16 }, (_, i) => phaseOf(i + 1, 16));
    expect(phases.slice(0, 4)).toEqual(['intro', 'intro', 'intro', 'intro']);
    expect(phases.slice(4, 8)).toEqual(['complication', 'complication', 'complication', 'complication']);
    expect(phases.slice(8, 12)).toEqual(['escalade', 'escalade', 'escalade', 'escalade']);
    expect(phases.slice(12)).toEqual(['denouement', 'denouement', 'denouement', 'denouement']);
  });

  it('ne tire pas deux fois la même consigne, ni celle qu’on remplace', () => {
    const rng = seeded(3);
    const used: string[] = [];
    for (let i = 0; i < 16; i++) used.push(pickConstraint(used, rng).id);
    expect(new Set(used).size).toBe(16);
    expect(pickConstraint(used, rng, used[0]).id).not.toBe(used[0]);
  });
});

/** Joue une case: dessine assez, la termine, répond à la contrainte. */
function playCase(game: SurvivorGame, respected: boolean, spent = 6) {
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  pixels.fill(1, 0, 400);
  expect(game.finishCase(pixels, spent)).toBe(true);
  game.validate(respected);
}

describe('déroulement de la partie', () => {
  it('démarre avec un thème, une consigne et toute la réserve', () => {
    const g = SurvivorGame.start(seeded(5));
    expect(g.state.theme.length).toBeGreaterThan(2);
        expect(g.state).toMatchObject({ caseNo: 1, reserve: SURVIVOR.ink.start, phase: 'drawing', outcome: null });
  });

  it('refuse de terminer une case encore vide', () => {
    const g = SurvivorGame.start(seeded(5));
    expect(g.finishCase(new Uint8Array(WIDTH * HEIGHT), 0)).toBe(false);
    expect(g.state.phase).toBe('drawing');
  });

  it('récompense une contrainte respectée (+20) ou non (+5), plafonnée par la capacité', () => {
    const yes = SurvivorGame.start(seeded(1));
    playCase(yes, true, 30);
    expect(yes.state.reserve).toBe(70 + 20);
    const no = SurvivorGame.start(seeded(1));
    playCase(no, false, 30);
    expect(no.state.reserve).toBe(70 + 5);
    const full = SurvivorGame.start(seeded(1));
    playCase(full, true, 0);
    expect(full.state.reserve).toBe(SURVIVOR.ink.capacity);
    expect(yes.state.results).toEqual([true]);
    expect(yes.state.totalSpent).toBe(30);
  });

  it('propose une amélioration toutes les deux cases, à choisir parmi trois', () => {
    const g = SurvivorGame.start(seeded(9));
    playCase(g, true);
    expect(g.state.phase).toBe('drawing');
    expect(g.state.caseNo).toBe(2);
    playCase(g, true);
    expect(g.state.phase).toBe('upgrade');
    expect(g.state.offer).toHaveLength(3);
    expect(g.chooseUpgrade('absent')).toBe(false);
    const pick = g.state.offer[0];
    expect(g.chooseUpgrade(pick)).toBe(true);
    expect(g.state.upgrades[pick]).toBe(1);
    expect(g.state).toMatchObject({ phase: 'drawing', caseNo: 3, offer: [] });
  });

  it('applique les effets des améliorations: Encrier, Régénération, Narrateur, Joker, Dernier souffle', () => {
    const g = SurvivorGame.start(seeded(2));
    g.state.upgrades = { encrier: 1, regeneration: 1, narrateur: 1, joker: 1, souffle: 1 };
    g.state.jokers = 2;
    g.state.emergency = 1;
    expect(g.capacity).toBe(125);
    g.state.reserve = 50;
    playCase(g, true, 10);
    expect(g.state.reserve).toBe(40 + 20 + 5 + 4);
    expect(g.rewardFor(false)).toBe(5 + 4);
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

  it('Joker relance les dés, un nombre limité de fois', () => {
    const g = SurvivorGame.start(seeded(4));
    expect(g.replaceConstraint()).toBe(false);
    g.state.jokers = 2;
    const before = g.constraint.id;
    expect(g.replaceConstraint()).toBe(true);
    expect(g.constraint.id).not.toBe(before);
        expect(g.state.jokers).toBe(1);
    g.replaceConstraint();
    expect(g.replaceConstraint()).toBe(false);
  });

  it('Dernier souffle ajoute la réserve d’urgence une seule fois', () => {
    const g = SurvivorGame.start(seeded(4));
    expect(g.useEmergency()).toBe(false);
    g.state.emergency = 1;
    g.state.reserve = 0;
    expect(g.useEmergency()).toBe(true);
    expect(g.state.reserve).toBe(SURVIVOR.upgrades.dernierSouffle);
    expect(g.useEmergency()).toBe(false);
  });

  it('victoire à la seizième case, avec le bilan de la partie', () => {
    const g = SurvivorGame.start(seeded(11));
    for (let i = 1; i <= SURVIVOR.totalCases; i++) {
      expect(g.state.outcome).toBeNull();
      playCase(g, i % 2 === 0, 5);
      if (g.state.phase === 'upgrade') g.chooseUpgrade(g.state.offer[0]);
    }
    expect(g.state.phase).toBe('finished');
    expect(g.state.outcome).toBe('victory');
    expect(g.finishedCases).toBe(16);
    expect(g.respectedCount).toBe(8);
    expect(g.cases).toHaveLength(16);
    expect(g.state.totalSpent).toBe(80);
    expect(Object.keys(g.state.upgrades).length).toBeGreaterThan(0);
    expect(new Set(g.state.constraintIds).size).toBe(16);
  });

  it('défaite: plus d’encre, plus de Mimo gratuit ni de secours, et une case trop vide pour être terminée', () => {
    const g = SurvivorGame.start(seeded(6));
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
    const s = new EditorSession();
    s.ink = g.rules;
    s.inkBudget = g.state.reserve;
    s.update({ pen: { size: 6, shape: 'round', texture: 'solid' } });
    line(s, [10, 100], [300, 100]);
    const spent = s.project.ink!.spent;
    expect(g.finishCase(s.project.pixels, spent)).toBe(true);
    g.validate(false);
    expect(g.state.reserve).toBeCloseTo(100 - spent + 5, 6);
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
      playCase(g, true, 12);
      playCase(g, false, 7);
      expect(saveRun(g)).toBe(true);
      const back = loadRun()!;
      expect(back.state.caseNo).toBe(g.state.caseNo);
      expect(back.state.reserve).toBeCloseTo(g.state.reserve, 6);
      expect(back.state.phase).toBe('upgrade');
      expect(back.state.upgrades).toEqual(g.state.upgrades);
      expect(back.cases).toEqual(g.cases);
      expect(store.get('cl.survivor.v1')).not.toMatch(/pixels/);
      clearRun();
      expect(loadRun()).toBeNull();
    });

    it('ignore une sauvegarde illisible', () => {
      store.set('cl.survivor.v1', '{pas du json');
      expect(loadRun()).toBeNull();
    });
  });
});
