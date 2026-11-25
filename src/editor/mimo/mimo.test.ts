import { describe, expect, it } from 'vitest';
import { PALETTE, HEIGHT, WIDTH } from '../palette';
import { EditorSession } from '../session';
import { MIMO_DESIGNS, MIMO_EMOTIONS, MIMO_POSES, mimoShapes, type MimoSpec } from './art';
import { ObjectGesture, TAP_MAX_MS, TAP_SLOP, mimoPlaceable } from './gesture';
import { FX_DURATION, MIMO_INK, MIMO_MAX, MIMO_MIN, fxScale, mimoRect } from './mimo';
import { rasterMimo } from './raster';
import { samePixels } from '../../testing/pixels';

const black = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);
const all: MimoSpec[] = [];
for (let design = 0; design < MIMO_DESIGNS; design++) for (let emotion = 0; emotion < MIMO_EMOTIONS; emotion++) for (let pose = 0; pose < MIMO_POSES; pose++) all.push({ design, emotion, pose });

const diff = (a: Uint8Array, b: Uint8Array) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

describe('dessin des Mimo', () => {
  it('propose 6 styles, 6 émotions et 6 poses, toutes combinables', () => {
    expect(all).toHaveLength(216);
    for (const spec of all) {
      const { mask } = rasterMimo(spec, 120, 120);
      const n = black(mask);
      expect(n, JSON.stringify(spec)).toBeGreaterThan(450);
      expect(n, JSON.stringify(spec)).toBeLessThan(5200);
    }
  });

  it('reste dans sa boîte, sans toucher les bords (aucun trait rogné)', () => {
    for (const spec of all) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const shape of mimoShapes(spec)) {
        for (const v of shape.pts) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      expect(lo, JSON.stringify(spec)).toBeGreaterThan(1.7);
      expect(hi, JSON.stringify(spec)).toBeLessThan(98.3);
    }
  });

  it('est déterministe', () => {
    const spec = { design: 3, emotion: 4, pose: 2 };
    expect(mimoShapes(spec)).toBe(mimoShapes(spec));
    const a = rasterMimo(spec, 97, 97).mask;
    const b = rasterMimo({ ...spec }, 97, 97).mask;
    expect(diff(a, b)).toBe(0);
  });

  it('distingue nettement les styles, les émotions et les poses', () => {
    const base = { design: 0, emotion: 0, pose: 0 };
    const ref = rasterMimo(base, 100, 100).mask;
    for (let i = 1; i < 6; i++) {
      expect(diff(ref, rasterMimo({ ...base, design: i }, 100, 100).mask), `style ${i}`).toBeGreaterThan(250);
      expect(diff(ref, rasterMimo({ ...base, emotion: i }, 100, 100).mask), `émotion ${i}`).toBeGreaterThan(150);
      expect(diff(ref, rasterMimo({ ...base, pose: i }, 100, 100).mask), `pose ${i}`).toBeGreaterThan(150);
    }
  });

  it('reste lisible quand on le réduit', () => {
    for (const size of [MIMO_MIN, 80]) {
      const { mask } = rasterMimo({ design: 1, emotion: 2, pose: 5 }, size, size);
      expect(black(mask)).toBeGreaterThan(size * 4);
    }
  });

  it('n’utilise que du noir: le noir de la palette', () => {
    expect(PALETTE[MIMO_INK].id).toBe('black');
  });
});

describe('placement dans l’éditeur', () => {
  const placed = (s: EditorSession) => s.project.pixels.reduce((n, v) => n + (v === MIMO_INK ? 1 : 0), 0);

  it('ajoute un Mimo au centre, sans toucher au dessin avant « Placer »', () => {
    const s = new EditorSession();
    expect(s.beginMimo()).toBe(true);
    expect(s.mimo).toMatchObject({ cx: WIDTH / 2, cy: HEIGHT / 2 });
    expect(placed(s)).toBe(0);
    expect(s.current().pixels.some(Boolean)).toBe(true); // aperçu
    expect(s.canUndo).toBe(true);
  });

  it('cycle les 6 poses, émotions et styles et revient au début', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    s.beginMimo();
    for (const [axis, count] of [['pose', MIMO_POSES], ['emotion', MIMO_EMOTIONS], ['design', MIMO_DESIGNS]] as const) {
      const seen = new Set<number>([s.mimo!.spec[axis]]);
      for (let i = 0; i < count; i++) {
        s.mimoStep(axis);
        seen.add(s.mimo!.spec[axis]);
      }
      expect(seen.size).toBe(count);
      expect(s.mimo!.spec[axis]).toBe(0);
    }
    s.mimoStep('pose', -1);
    expect(s.mimo!.spec.pose).toBe(MIMO_POSES - 1);
  });

  it('se déplace et se redimensionne dans des bornes raisonnables, sans déformation', () => {
    const s = new EditorSession();
    s.beginMimo();
    s.mimoMoveTo(-50, 999);
    expect(s.mimo).toMatchObject({ cx: 0, cy: HEIGHT });
    s.mimoResize(5);
    expect(s.mimo!.size).toBe(MIMO_MIN);
    s.mimoResize(9999);
    expect(s.mimo!.size).toBe(MIMO_MAX);
    s.mimoResize(150);
    const r = mimoRect(s.mimo!);
    expect(r.w).toBe(r.h);
  });

  it('s’annule avant placement sans toucher au reste du dessin', () => {
    const s = new EditorSession();
    s.pointerDown(10, 10);
    s.pointerMove(60, 10);
    s.pointerUp();
    const before = s.project.pixels.slice();
    s.beginMimo();
    s.cancelMimo();
    expect(s.mimo).toBeNull();
    samePixels(s.project.pixels, before);
    s.beginMimo();
    s.undo(); // « annuler » abandonne d’abord le Mimo en cours
    expect(s.mimo).toBeNull();
    samePixels(s.project.pixels, before);
  });

  it('fusionne le Mimo en noir sur le dessin existant, identique à l’aperçu', () => {
    const s = new EditorSession();
    s.update({ color: 2 });
    s.pointerDown(5, 5);
    s.pointerMove(300, 5);
    s.pointerUp();
    s.beginMimo();
    s.mimoMoveTo(100, 120);
    s.mimoResize(140);
    const preview = s.current().pixels.slice();
    expect(s.placeMimo()).toBe(true);
    expect(s.mimo).toBeNull();
    samePixels(s.project.pixels, preview);
    expect(placed(s)).toBeGreaterThan(300);
    expect(s.project.pixels[5 * WIDTH + 150]).toBe(2); // le trait rouge est resté
  });

  /** Place un Mimo aux réglages donnés. */
  function addMimo(s: EditorSession, at: { x: number; y: number; size: number; pose: number; emotion: number; design: number }) {
    expect(s.beginMimo()).toBe(true);
    s.mimoMoveTo(at.x, at.y);
    s.mimoResize(at.size);
    for (const axis of ['pose', 'emotion', 'design'] as const) for (let i = 0; i < at[axis]; i++) s.mimoStep(axis);
    expect(s.placeMimo()).toBe(true);
  }

  const scene = [
    { x: 50, y: 150, size: 120, pose: 0, emotion: 0, design: 0 },
    { x: 140, y: 120, size: 90, pose: 2, emotion: 3, design: 1 },
    { x: 230, y: 160, size: 150, pose: 5, emotion: 2, design: 4 },
    { x: 290, y: 90, size: 70, pose: 3, emotion: 5, design: 3 },
    { x: 100, y: 60, size: 100, pose: 1, emotion: 4, design: 5 },
  ];

  it('permet de placer autant de Mimo que l’on veut dans une même case', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    let last = 0;
    for (const m of scene) {
      addMimo(s, m);
      const n = placed(s);
      expect(n).toBeGreaterThan(last);
      last = n;
    }
    for (let i = 0; i < 10; i++) addMimo(s, { x: 20 + i * 30, y: 120, size: 60, pose: i % 6, emotion: i % 6, design: i % 6 });
    expect(s.beginMimo()).toBe(true);
    expect(s.mimo).not.toBeNull();
  });

  it('chaque Mimo se règle indépendamment avant son placement, sans toucher aux précédents', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    addMimo(s, scene[0]);
    const first = s.project.pixels.slice();
    s.beginMimo();
    expect(s.mimo!.spec).toEqual({ design: 0, emotion: 0, pose: 0 }); // chaque nouveau Mimo repart de zéro
    s.mimoStep('design', 1);
    s.mimoStep('emotion', -1);
    s.mimoMoveTo(250, 100);
    s.mimoResize(80);
    samePixels(s.project.pixels, first);
    s.cancelMimo();
    samePixels(s.project.pixels, first);
  });

  it('autorise le dessin libre entre deux placements, et le Mimo suivant se pose par-dessus', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    s.update({ color: 3 });
    addMimo(s, scene[0]);
    s.pointerDown(3, 3);
    s.pointerMove(300, 3);
    s.pointerUp();
    expect(s.project.pixels[3 * WIDTH + 150]).toBe(3);
    addMimo(s, scene[1]);
    expect(s.project.pixels[3 * WIDTH + 150]).toBe(3);
    s.pointerDown(3, 230);
    s.pointerMove(300, 230);
    s.pointerUp();
    expect(s.project.pixels[230 * WIDTH + 150]).toBe(3);
  });

  it('annule et rétablit plusieurs placements successifs, un par un', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    const states = [s.project.pixels.slice()];
    for (const m of scene) {
      addMimo(s, m);
      states.push(s.project.pixels.slice());
      s.pointerDown(m.x, 5);
      s.pointerMove(m.x + 15, 5);
      s.pointerUp();
      states.push(s.project.pixels.slice());
    }
    for (let i = states.length - 2; i >= 0; i--) {
      s.undo();
      samePixels(s.project.pixels, states[i]);
    }
    expect(s.canUndo).toBe(false);
    for (let i = 1; i < states.length; i++) {
      s.redo();
      samePixels(s.project.pixels, states[i]);
    }
    expect(s.canRedo).toBe(false);
  });

  it('un nouveau placement efface l’historique à rétablir, comme un trait', () => {
    const s = new EditorSession();
    addMimo(s, scene[0]);
    s.undo();
    expect(s.canRedo).toBe(true);
    addMimo(s, scene[1]);
    expect(s.canRedo).toBe(false);
  });

  it('reste fluide avec de nombreux personnages', () => {
    const s = new EditorSession();
    s.reducedMotion = true;
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      addMimo(s, { x: (i * 37) % 320, y: 80 + ((i * 53) % 120), size: 60 + ((i * 29) % 160), pose: i % 6, emotion: (i * 5) % 6, design: (i * 7) % 6 });
    }
    expect(performance.now() - t0).toBeLessThan(2500);
    // aperçu d'un Mimo de plus au-dessus de la scène: une image
    s.beginMimo();
    const t1 = performance.now();
    for (let i = 0; i < 30; i++) {
      s.mimoMoveTo(100 + i * 3, 120);
      s.mimoResize(80 + i * 4);
      s.current();
    }
    expect((performance.now() - t1) / 30).toBeLessThan(16);
  });

  it('ne laisse rien dessiner ni changer d’outil pendant le placement', () => {
    const s = new EditorSession();
    s.beginMimo();
    const before = s.current().pixels.slice();
    s.pointerDown(20, 20);
    s.pointerMove(80, 20);
    s.pointerUp();
    s.setTool('eraser');
    expect(s.tool).toBe('pen');
    expect(s.beginStamp('x')).toBe(false);
    samePixels(s.current().pixels, before);
    s.placeMimo();
    expect(s.project.pixels[20 * WIDTH + 5]).toBe(0);
  });

  it('fonctionne aussi sur un dessin ancien et après un déplacement de sélection', () => {
    const s = new EditorSession({ pixels: new Uint8Array(WIDTH * HEIGHT) });
    s.beginMimo();
    s.placeMimo();
    s.selectAll();
    s.setTool('move');
    s.pointerDown(10, 10);
    s.pointerMove(30, 10);
    s.pointerUp();
    s.commitFloating();
    expect(s.beginMimo()).toBe(true);
  });

  it('place au rendu final, sans la déformation d’animation', () => {
    const s = new EditorSession();
    s.beginMimo();
    s.mimoStep('pose', 1, 0);
    expect(s.mimo!.fx).not.toBeNull();
    expect(s.mimoFrame(40)).toBe(true);
    s.placeMimo();
    const direct = new EditorSession();
    direct.reducedMotion = true;
    direct.beginMimo();
    direct.mimoStep('pose');
    direct.placeMimo();
    samePixels(s.project.pixels, direct.project.pixels);
  });

  it('anime très brièvement, et pas du tout si le système demande moins d’animations', () => {
    const s = new EditorSession();
    s.beginMimo();
    s.mimoStep('emotion', 1, 1000);
    expect(s.mimoFrame(1000 + FX_DURATION.emotion / 2)).toBe(true);
    expect(s.mimoFrame(1000 + FX_DURATION.emotion + 1)).toBe(false);
    expect(s.mimo!.fx).toBeNull();
    for (const kind of ['pose', 'emotion', 'design'] as const) {
      expect(FX_DURATION[kind]).toBeLessThanOrEqual(250);
      expect(fxScale({ kind, t0: 0, t: 1 })).toEqual({ sx: 1, sy: 1 });
    }
    const quiet = new EditorSession();
    quiet.reducedMotion = true;
    quiet.beginMimo();
    quiet.mimoStep('design');
    expect(quiet.mimo!.fx).toBeNull();
  });

  it('les pieds restent posés pendant un rebond', () => {
    const s = new EditorSession();
    s.beginMimo();
    const rest = mimoRect({ ...s.mimo!, fx: null });
    for (const t of [0, 0.2, 0.5]) {
      const r = mimoRect({ ...s.mimo!, fx: { kind: 'pose', t0: 0, t } });
      expect(Math.abs(r.top + r.h - (rest.top + rest.h))).toBeLessThanOrEqual(1);
    }
  });
});

describe('gestes', () => {
  function setup(size = 120) {
    const s = new EditorSession();
    s.reducedMotion = true;
    s.beginMimo();
    s.mimoResize(size);
    // 1 pixel de toile = 1 pixel d'écran
    const g = new ObjectGesture(mimoPlaceable(s), (x, y) => ({ x, y }));
    return { s, g };
  }
  const center = { x: WIDTH / 2, y: HEIGHT / 2 };

  it('un tap sur le Mimo change la pose, sans le déplacer', () => {
    const { s, g } = setup();
    g.down(1, center.x + 5, center.y, 0);
    g.up(1, 120);
    expect(s.mimo!.spec.pose).toBe(1);
    expect(s.mimo).toMatchObject({ cx: center.x, cy: center.y });
  });

  it('un tout petit tremblement pendant le tap ne le déplace pas', () => {
    const { s, g } = setup();
    g.down(1, center.x, center.y, 0);
    g.move(1, center.x + TAP_SLOP - 1, center.y + 2);
    g.up(1, 100);
    expect(s.mimo!.spec.pose).toBe(1);
    expect(s.mimo!.cx).toBe(center.x);
  });

  it('un glissement déplace le Mimo sans changer de pose, d’émotion ni de style', () => {
    const { s, g } = setup();
    g.down(1, center.x, center.y, 0);
    for (let i = 1; i <= 20; i++) g.move(1, center.x + i * 3, center.y - i * 2);
    g.up(1, 300);
    expect(s.mimo!.spec).toEqual({ design: 0, emotion: 0, pose: 0 });
    expect(s.mimo!.cx).toBeGreaterThan(center.x + 40);
    expect(s.mimo!.cy).toBeLessThan(center.y - 30);
  });

  it('suit le doigt sans saut au moment où le glissement est reconnu', () => {
    const { s, g } = setup();
    g.down(1, center.x + 20, center.y + 10, 0);
    g.move(1, center.x + 20 + TAP_SLOP + 1, center.y + 10);
    expect(Math.abs(s.mimo!.cx - center.x)).toBeLessThan(2);
    g.move(1, center.x + 50, center.y + 10);
    expect(s.mimo!.cx).toBeCloseTo(center.x + 21, 0);
  });

  it('un appui long ou posé puis relevé trop tard ne change pas de pose', () => {
    const { s, g } = setup();
    g.down(1, center.x, center.y, 0);
    g.up(1, TAP_MAX_MS + 100);
    expect(s.mimo!.spec.pose).toBe(0);
  });

  it('un doigt hors du Mimo ne fait rien (et ne dessine pas)', () => {
    const { s, g } = setup(80);
    g.down(1, 10, 10, 0);
    g.move(1, 200, 100);
    g.up(1, 50);
    expect(g.state).toBe('none');
    expect(s.mimo).toMatchObject({ cx: center.x, cy: center.y });
    expect(s.mimo!.spec.pose).toBe(0);
    expect(s.current().pixels[10 * WIDTH + 100]).toBe(0);
  });

  it('un petit Mimo reste facile à attraper', () => {
    const { s, g } = setup(MIMO_MIN);
    g.down(1, center.x + 28, center.y + 28, 0);
    g.up(1, 80);
    expect(s.mimo!.spec.pose).toBe(1);
  });

  it('le pincement agrandit en proportion, sans déplacer ni changer de pose', () => {
    const { s, g } = setup(100);
    g.down(1, center.x - 20, center.y, 0);
    g.down(2, center.x + 20, center.y, 5);
    for (let i = 1; i <= 10; i++) {
      g.move(1, center.x - 20 - i * 3, center.y + 1);
      g.move(2, center.x + 20 + i * 3, center.y - 1);
    }
    expect(s.mimo!.size).toBeGreaterThan(150);
    expect(s.mimo).toMatchObject({ cx: center.x, cy: center.y });
    g.up(2, 400);
    g.up(1, 410);
    expect(s.mimo!.spec.pose).toBe(0);
    expect(g.active).toBe(false);
  });

  it('un pincement borne la taille', () => {
    const { s, g } = setup(100);
    g.down(1, 100, 100, 0);
    g.down(2, 200, 100, 0);
    g.move(2, 100.5, 100);
    expect(s.mimo!.size).toBe(MIMO_MIN);
    g.move(2, 1000, 100);
    expect(s.mimo!.size).toBe(MIMO_MAX);
  });

  it('le doigt qui reste après un pincement ne déplace rien et ne change pas la pose', () => {
    const { s, g } = setup(100);
    g.down(1, center.x - 10, center.y, 0);
    g.down(2, center.x + 10, center.y, 0);
    g.up(2, 100);
    g.move(1, center.x + 80, center.y + 40);
    g.up(1, 150);
    expect(s.mimo).toMatchObject({ cx: center.x, cy: center.y });
    expect(s.mimo!.spec.pose).toBe(0);
  });

  it('une interruption (cancel, rotation) ne valide aucun tap', () => {
    const { s, g } = setup();
    g.down(1, center.x, center.y, 0);
    g.up(1, 50, true);
    expect(s.mimo!.spec.pose).toBe(0);
    g.down(2, center.x, center.y, 0);
    g.reset();
    expect(g.active).toBe(false);
    g.up(2, 20);
    expect(s.mimo!.spec.pose).toBe(0);
  });
});
