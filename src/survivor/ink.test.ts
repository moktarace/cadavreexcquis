import { describe, expect, it } from 'vitest';
import { EditorSession } from '../editor/session';
import { SURVIVOR } from './config';
import { SurvivorGame, drawnPixels, inkOutMessage, inkOutState, nonWhite, stuckNow, type InkOutInput } from './game';
import { inkRulesFor } from './rules';
import { modifiersOf } from './upgrades';

function seeded(seed = 1) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 2 ** 32;
  };
}
const base: InkOutInput = { inkLeft: 0, freeMimoLeft: false, emergency: 0, terminable: false };

describe('panne d’encre: trois situations', () => {
  it('A: plus d’encre mais case validable → on peut terminer, même avec des secours', () => {
    for (const aids of [{}, { emergency: 1 }, { freeMimoLeft: true }]) {
      const o = { ...base, ...aids, terminable: true };
      expect(inkOutState(o)).toBe('validable');
      expect(stuckNow(o)).toBe(false);
    }
    expect(inkOutMessage('validable', { freeMimoLeft: false, emergency: 0 })).toBe('Plus d’encre ! Tu peux encore terminer cette case pour en récupérer.');
  });

  it('B: case trop vide mais un secours gratuit existe → ni défaite ni message trompeur', () => {
    expect(inkOutState({ ...base, emergency: 1 })).toBe('rescue');
    expect(inkOutState({ ...base, freeMimoLeft: true })).toBe('rescue');
    expect(stuckNow({ ...base, emergency: 1 })).toBe(false);
    expect(inkOutMessage('rescue', { freeMimoLeft: true, emergency: 1 })).toBe(`Plus d’encre pour tracer. Il te reste un Mimo gratuit et ton Dernier souffle (+${SURVIVOR.upgrades.dernierSouffle}).`);
    expect(inkOutMessage('rescue', { freeMimoLeft: false, emergency: 2 })).toMatch(/Dernier souffle/);
    expect(inkOutMessage('rescue', { freeMimoLeft: true, emergency: 0 })).toMatch(/Mimo gratuit/);
  });

  it('C: case non validable et aucun secours → condition de défaite existante', () => {
    expect(inkOutState(base)).toBe('lost');
    expect(stuckNow(base)).toBe(true);
    expect(inkOutMessage('lost', { freeMimoLeft: false, emergency: 0 })).toMatch(/la BD s’arrête/);
  });

  it('avec de l’encre il n’y a rien à dire; les seuils du jeu ne bougent pas', () => {
    expect(inkOutState({ ...base, inkLeft: SURVIVOR.ink.minPlayable })).toBe('ok');
    expect(inkOutMessage('ok', { freeMimoLeft: false, emergency: 0 })).toBeNull();
    expect(inkOutState({ ...base, inkLeft: SURVIVOR.ink.minPlayable - 0.01, terminable: true })).toBe('validable');
  });

  it('le moteur laisse terminer une case validable avec une réserve à zéro et verse la récompense', () => {
    const g = SurvivorGame.start(seeded(5));
    g.choose(g.state.proposals[0]);
    g.state.reserve = 3;
    const px = new Uint8Array(320 * 240).fill(1, 0, SURVIVOR.minCasePixels + 5);
    expect(g.isStuck(0, false, px)).toBe(false);
    const gain = g.finishCase(px, 3)!;
    expect(gain.reward).toBeGreaterThan(0);
    expect(g.state.reserve).toBe(gain.gained);
    expect(g.state.phase).not.toBe('finished');
  });
});

describe('bilan d’encre d’une défaite', () => {
  const play = () => {
    const g = SurvivorGame.start(seeded(5));
    const full = new Uint8Array(320 * 240).fill(1, 0, SURVIVOR.minCasePixels + 5);
    g.choose(g.state.proposals[0]);
    g.finishCase(full, SURVIVOR.ink.start); // case 1: toute la réserve
    return { g, full };
  };

  it('compte l’encre consommée sur la case perdue, une seule fois', () => {
    const { g } = play();
    expect(g.state.totalSpent).toBe(SURVIVOR.ink.start);
    g.choose(g.state.proposals[0]);
    const recovered = g.state.reserve;
    g.lose(recovered);
    expect(g.state.totalSpent).toBe(SURVIVOR.ink.start + recovered);
    expect(g.state.lostSpent).toBe(recovered);
    expect(g.state.outcome).toBe('defeat');
    g.lose(999); // une défaite déjà actée ne se recompte pas
    expect(g.state.totalSpent).toBe(SURVIVOR.ink.start + recovered);
  });

  it('ne compte pas ce qui a été annulé (remboursé par l’éditeur)', () => {
    const g = SurvivorGame.start(seeded(5));
    g.choose(g.state.proposals[0]);
    const s = new EditorSession();
    s.reducedMotion = true;
    s.ink = inkRulesFor(modifiersOf({}));
    s.inkBudget = g.state.reserve;
    s.pointerDown(10, 10);
    s.pointerMove(200, 10);
    s.pointerUp();
    const kept = s.inkBudget - s.inkLeft;
    expect(kept).toBeGreaterThan(0);
    s.pointerDown(10, 100);
    s.pointerMove(200, 100);
    s.pointerUp();
    s.undo();
    expect(s.inkBudget - s.inkLeft).toBeCloseTo(kept, 5);
    g.lose(s.inkBudget - Math.max(0, s.inkLeft));
    expect(g.state.totalSpent).toBeCloseTo(kept, 5);
  });

  it('victoire: aucun montant de case perdue; ancienne sauvegarde sans le champ: bilan inchangé', () => {
    const { g } = play();
    expect(g.state.lostSpent).toBeUndefined();
    expect(g.state.totalSpent).toBe(SURVIVOR.ink.start);
  });
});

describe('trait en cours et panne d’encre', () => {
  it('un trait qui épuise l’encre avant d’être relâché compte déjà dans la case: pas de défaite prématurée', () => {
    const g = SurvivorGame.start(seeded(5));
    g.choose(g.state.proposals[0]);
    const s = new EditorSession();
    s.reducedMotion = true;
    s.ink = inkRulesFor(modifiersOf({}));
    s.inkBudget = 1.2;
    s.pointerDown(10, 100);
    s.pointerMove(300, 100); // le pointeur reste posé
    expect(s.stroking).toBe(true);
    expect(s.inkLeft).toBeLessThan(SURVIVOR.ink.minPlayable);
    expect(nonWhite(s.project.pixels)).toBe(0); // rien de validé: ce que voyait l'ancien contrôle
    expect(nonWhite(drawnPixels(s))).toBeGreaterThanOrEqual(SURVIVOR.minCasePixels);
    expect(g.isStuck(s.inkLeft, s.freeMimoLeft, drawnPixels(s))).toBe(false);
    expect(g.isStuck(s.inkLeft, s.freeMimoLeft, s.project.pixels)).toBe(true); // l'ancien calcul aurait perdu la partie
    s.pointerUp();
    expect(s.stroking).toBe(false);
    expect(drawnPixels(s)).toBe(s.project.pixels);
    expect(g.isStuck(s.inkLeft, s.freeMimoLeft, drawnPixels(s))).toBe(false);
  });
});
