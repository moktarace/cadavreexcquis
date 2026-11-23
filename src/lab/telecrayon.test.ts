import { describe, expect, it } from 'vitest';
import { EditorSession } from '../editor/session';
import { HEIGHT, WIDTH } from '../editor/palette';
import { PROFILES, PadGesture, Telecrayon, gainAt, type PenTarget, type StrokeOutcome } from './telecrayon';

type Call = ['down' | 'move', number, number] | ['up'] | ['cancel'];

function fakeTarget() {
  const calls: Call[] = [];
  const target: PenTarget = {
    pointerDown: (x, y) => calls.push(['down', x, y]),
    pointerMove: (x, y) => calls.push(['move', x, y]),
    pointerUp: () => calls.push(['up']),
    pointerCancel: () => calls.push(['cancel']),
  };
  return { calls, target };
}

const setup = (target: PenTarget, profile = PROFILES.precise) => {
  const outcomes: StrokeOutcome[] = [];
  const pen = new Telecrayon(target, { ...profile }, (o) => outcomes.push(o));
  return { pen, outcomes };
};

/** Glisse un pouce par petits pas réguliers (10 px CSS / 16 ms ≈ lent). */
function drag(pen: Telecrayon, id: number, x0: number, y0: number, dx: number, dy: number, steps = 10, t0 = 0) {
  pen.padDown(id, x0, y0, t0);
  for (let i = 1; i <= steps; i++) pen.padMove(id, x0 + (dx * i) / steps, y0 + (dy * i) / steps, t0 + i * 16);
  pen.padUp(id);
}

describe('gain et accélération', () => {
  it('est précis à vitesse lente et croît sans saut avec la vitesse', () => {
    const s = PROFILES.precise;
    expect(gainAt(0, s)).toBeCloseTo(s.gain, 5);
    expect(gainAt(0.05, s)).toBeLessThan(s.gain * 1.01);
    expect(gainAt(s.fullSpeed * 3, s)).toBeCloseTo(s.gain * s.accel, 5);
    let prev = gainAt(0, s);
    for (let v = 0; v <= 3; v += 0.1) {
      const g = gainAt(v, s);
      expect(g).toBeGreaterThanOrEqual(prev);
      expect(g - prev).toBeLessThan(s.gain * 0.25);
      prev = g;
    }
  });

  it('le profil Rapide va plus loin que le profil Précis pour le même geste', () => {
    const a = new PadGesture(0, 0, 0, () => PROFILES.precise);
    const b = new PadGesture(0, 0, 0, () => PROFILES.fast);
    const ma = a.move(40, 0, 100)!;
    const mb = b.move(40, 0, 100)!;
    expect(mb.dx).toBeGreaterThan(ma.dx * 2);
  });
});

describe('pavé tactile relatif', () => {
  it('le curseur démarre au centre et bouge proportionnellement au glissement', () => {
    const { target } = fakeTarget();
    const { pen } = setup(target);
    const start = { ...pen.cursor };
    drag(pen, 1, 50, 50, 60, 0);
    expect(pen.cursor.x).toBeGreaterThan(start.x + 10);
    expect(pen.cursor.y).toBe(start.y);
  });

  it('poser le pouce ailleurs ne fait pas sauter le curseur, relever non plus', () => {
    const { target } = fakeTarget();
    const { pen } = setup(target);
    pen.padDown(1, 10, 10, 0);
    pen.padUp(1);
    const a = { ...pen.cursor };
    pen.padDown(2, 120, 90, 100);
    expect(pen.cursor).toEqual(a);
    pen.padUp(2);
    expect(pen.cursor).toEqual(a);
  });

  it('ignore le tremblement de la pose et du relevé', () => {
    const { target } = fakeTarget();
    const { pen } = setup(target);
    const a = { ...pen.cursor };
    pen.padDown(1, 50, 50, 0);
    pen.padMove(1, 50.6, 50.4, 16);
    pen.padMove(1, 50.2, 50.9, 32);
    pen.padUp(1);
    expect(pen.cursor).toEqual(a);
  });

  it('les glissements lents successifs permettent de traverser la toile', () => {
    const { target } = fakeTarget();
    const { pen } = setup(target, PROFILES.precise);
    for (let i = 0; i < 12; i++) drag(pen, i + 1, 0, 0, 120, 0, 30, i * 1000);
    expect(pen.cursor.x).toBe(WIDTH - 1);
  });

  it('garde le curseur dans la toile', () => {
    const { target } = fakeTarget();
    const { pen } = setup(target, PROFILES.fast);
    drag(pen, 1, 0, 0, -2000, -2000, 10);
    expect(pen.cursor).toEqual({ x: 0, y: 0 });
    drag(pen, 2, 0, 0, 5000, 5000, 10, 1000);
    expect(pen.cursor).toEqual({ x: WIDTH - 1, y: HEIGHT - 1 });
  });

  it('ne reçoit que les événements de son propre pointeur', () => {
    const { target } = fakeTarget();
    const { pen } = setup(target);
    pen.padDown(1, 0, 0, 0);
    const a = { ...pen.cursor };
    pen.padMove(9, 100, 100, 50);
    expect(pen.cursor).toEqual(a);
  });
});

describe('bouton TRACER', () => {
  it('un appui bref sans déplacement pose un point à la position du curseur', () => {
    const { target, calls } = fakeTarget();
    const { pen, outcomes } = setup(target);
    pen.traceDown(7);
    pen.traceUp(7);
    expect(calls).toEqual([['down', 160, 120], ['up']]);
    expect(outcomes).toEqual(['committed']);
  });

  it('déplacer le pouce gauche pendant le maintien trace, puis relâcher valide', () => {
    const { target, calls } = fakeTarget();
    const { pen } = setup(target);
    pen.traceDown(7);
    drag(pen, 1, 20, 20, 80, 0);
    pen.traceUp(7);
    expect(calls[0]).toEqual(['down', 160, 120]);
    expect(calls.filter((c) => c[0] === 'move').length).toBeGreaterThan(3);
    expect(calls[calls.length - 1]).toEqual(['up']);
  });

  it('sans TRACER le curseur bouge sans dessiner', () => {
    const { target, calls } = fakeTarget();
    const { pen } = setup(target);
    drag(pen, 1, 0, 0, 100, 40);
    expect(calls).toEqual([]);
  });

  it('relever puis reposer le pouce gauche ne crée aucun segment parasite', () => {
    const { target, calls } = fakeTarget();
    const { pen } = setup(target);
    pen.traceDown(7);
    drag(pen, 1, 0, 0, 40, 0);
    const before = calls.length;
    pen.padDown(2, 200, 150, 5000);
    pen.padMove(2, 200.3, 150.2, 5016);
    pen.padUp(2);
    expect(calls.length).toBe(before);
    expect(pen.penDown).toBe(true);
  });

  it('le trait continue pendant plusieurs glissements successifs', () => {
    const { target, calls } = fakeTarget();
    const { pen } = setup(target);
    pen.traceDown(7);
    drag(pen, 1, 0, 0, 60, 0, 10, 0);
    const n1 = calls.length;
    drag(pen, 2, 0, 0, 60, 0, 10, 2000);
    expect(calls.length).toBeGreaterThan(n1);
    expect(calls.filter((c) => c[0] === 'down')).toHaveLength(1);
    pen.traceUp(7);
    expect(calls.filter((c) => c[0] === 'up')).toHaveLength(1);
  });

  it('relâcher TRACER avant le pouce gauche valide le trait sans en tracer d’autre', () => {
    const { target, calls } = fakeTarget();
    const { pen, outcomes } = setup(target);
    pen.padDown(1, 0, 0, 0);
    pen.traceDown(7);
    pen.padMove(1, 40, 0, 100);
    pen.traceUp(7);
    const n = calls.length;
    pen.padMove(1, 90, 0, 200);
    pen.padUp(1);
    expect(calls.length).toBe(n);
    expect(outcomes).toEqual(['committed']);
  });

  it('deux gestes rapides successifs donnent deux traits', () => {
    const { target, calls } = fakeTarget();
    const { pen, outcomes } = setup(target);
    pen.traceDown(1);
    pen.traceUp(1);
    pen.traceDown(2);
    pen.traceUp(2);
    expect(calls.filter((c) => c[0] === 'down')).toHaveLength(2);
    expect(outcomes).toEqual(['committed', 'committed']);
  });

  it('ignore un second doigt sur TRACER tant que le premier est posé', () => {
    const { target, calls } = fakeTarget();
    const { pen } = setup(target);
    pen.traceDown(1);
    pen.traceDown(2);
    pen.traceUp(2);
    expect(calls).toEqual([['down', 160, 120]]);
    expect(pen.penDown).toBe(true);
  });

  it('la perte du pouce gauche n’interrompt pas le trait', () => {
    const { target, calls } = fakeTarget();
    const { pen } = setup(target);
    pen.padDown(1, 0, 0, 0);
    pen.traceDown(7);
    pen.padUp(1);
    expect(calls).toEqual([['down', 160, 120]]);
  });
});

describe('annulation et interruptions', () => {
  it('relâcher dans la zone d’annulation abandonne le trait', () => {
    const { target, calls } = fakeTarget();
    const { pen, outcomes } = setup(target);
    pen.traceDown(7);
    pen.setCancelArmed(7, true);
    expect(pen.cancelArmed).toBe(true);
    pen.traceUp(7);
    expect(calls).toEqual([['down', 160, 120], ['cancel']]);
    expect(outcomes).toEqual(['cancelled']);
    expect(pen.cancelArmed).toBe(false);
  });

  it('revenir sur le bouton désarme l’annulation', () => {
    const { target, calls } = fakeTarget();
    const { pen } = setup(target);
    pen.traceDown(7);
    pen.setCancelArmed(7, true);
    pen.setCancelArmed(7, false);
    pen.traceUp(7);
    expect(calls[calls.length - 1]).toEqual(['up']);
  });

  it('pointercancel, perte de focus ou orientation n’en valident jamais un', () => {
    for (const interrupt of [(p: Telecrayon) => p.traceAbort(7), (p: Telecrayon) => p.interrupt()]) {
      const { target, calls } = fakeTarget();
      const { pen, outcomes } = setup(target);
      pen.padDown(1, 0, 0, 0);
      pen.traceDown(7);
      interrupt(pen);
      expect(calls).toEqual([['down', 160, 120], ['cancel']]);
      expect(outcomes).toEqual(['cancelled']);
      expect(pen.penDown).toBe(false);
      pen.traceUp(7);
      expect(calls).toHaveLength(2);
    }
  });

  it('l’interruption globale lâche aussi le pavé', () => {
    const { target } = fakeTarget();
    const { pen } = setup(target);
    pen.padDown(1, 0, 0, 0);
    pen.traceDown(7);
    pen.interrupt();
    expect(pen.padActive).toBe(false);
  });

  it('une interruption sans trait en cours n’appelle rien', () => {
    const { target, calls } = fakeTarget();
    const { pen } = setup(target);
    pen.padDown(1, 0, 0, 0);
    pen.interrupt();
    expect(calls).toEqual([]);
    expect(pen.padActive).toBe(false);
  });
});

describe('avec le moteur de dessin existant', () => {
  const sum = (s: EditorSession) => s.project.pixels.reduce((a, b) => a + (b ? 1 : 0), 0);

  it('un trait validé s’annule et se rétablit; un trait annulé ne laisse rien', () => {
    const session = new EditorSession();
    const { pen } = setup(session);
    pen.traceDown(7);
    drag(pen, 1, 0, 0, 80, 20);
    expect(sum(session)).toBe(0); // trait provisoire: pas encore dans le dessin
    expect(sum({ project: session.current() } as EditorSession)).toBeGreaterThan(0);
    pen.traceUp(7);
    const drawn = sum(session);
    expect(drawn).toBeGreaterThan(10);

    session.undo();
    expect(sum(session)).toBe(0);
    session.redo();
    expect(sum(session)).toBe(drawn);

    pen.traceDown(8);
    drag(pen, 2, 0, 0, 80, 20, 10, 9000);
    pen.setCancelArmed(8, true);
    pen.traceUp(8);
    expect(sum(session)).toBe(drawn);
    expect(session.current()).toBe(session.project);
  });

  it('un appui bref laisse un point à la position du curseur', () => {
    const session = new EditorSession();
    const { pen } = setup(session);
    pen.traceDown(7);
    pen.traceUp(7);
    expect(session.project.pixels[120 * WIDTH + 160]).toBe(session.color);
    expect(sum(session)).toBeGreaterThan(0);
  });
});
