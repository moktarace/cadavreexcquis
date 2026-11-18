import { describe, expect, it } from 'vitest';
import {
  clearMask,
  extract,
  fill,
  floodRegion,
  lassoMask,
  maskBounds,
  pasteContent,
  patternAt,
  rectMask,
  remap,
  shiftMask,
  stamp,
  strokeLine,
  type Brush,
} from './raster';
import { HEIGHT, WIDTH } from './palette';

const blank = () => new Uint8Array(WIDTH * HEIGHT);
const px = (a: Uint8Array, x: number, y: number) => a[y * WIDTH + x];
const count = (a: Uint8Array, v = 1) => a.reduce((n, p) => n + (p === v ? 1 : 0), 0);
const brush = (size: number, shape: Brush['shape'] = 'round'): Brush => ({ size, shape, texture: 'solid' });

describe('pinceau', () => {
  it('dessine un pixel net avec la taille 1', () => {
    const a = blank();
    stamp(a, 10, 10, brush(1), 1);
    expect(count(a)).toBe(1);
    expect(px(a, 10, 10)).toBe(1);
  });

  it('produit des formes rondes et carrées distinctes', () => {
    const r = blank();
    const s = blank();
    stamp(r, 50, 50, brush(5, 'round'), 1);
    stamp(s, 50, 50, brush(5, 'square'), 1);
    expect(count(s)).toBe(25);
    expect(count(r)).toBeLessThan(25);
    expect(count(r)).toBeGreaterThan(15);
  });

  it('ne dessine jamais hors de la grille 320×240', () => {
    const a = blank();
    stamp(a, -3, -3, brush(8, 'square'), 1);
    stamp(a, WIDTH + 2, HEIGHT + 2, brush(8, 'square'), 1);
    expect(a.length).toBe(WIDTH * HEIGHT);
    expect(count(a)).toBeGreaterThan(0);
  });

  it('efface avec la valeur 0 quelle que soit la texture', () => {
    const a = blank().fill(1);
    stamp(a, 20, 20, { size: 4, shape: 'square', texture: 'checker' }, 0);
    expect(count(a, 0)).toBe(16);
  });

  it('applique les textures avec des motifs ancrés au papier', () => {
    const a = blank();
    stamp(a, 20, 20, { size: 8, shape: 'square', texture: 'checker' }, 1);
    expect(count(a)).toBe(32);
    expect(patternAt('checker', 0, 0)).toBe(true);
    expect(patternAt('checker', 1, 0)).toBe(false);
    expect(patternAt('dots', 2, 2)).toBe(true);
    expect(patternAt('dots', 1, 2)).toBe(false);
  });

  it('relie deux points par un trait continu sans trou', () => {
    const a = blank();
    strokeLine(a, { x: 5, y: 5, pressure: 1 }, { x: 60, y: 40, pressure: 1 }, brush(1), 1);
    // Bresenham: autant de pixels que le plus grand écart + 1
    expect(count(a)).toBe(56);
    expect(px(a, 5, 5)).toBe(1);
    expect(px(a, 60, 40)).toBe(1);
  });

  it('module la taille avec la pression', () => {
    const light = blank();
    const hard = blank();
    strokeLine(light, { x: 20, y: 20, pressure: 0.1 }, { x: 60, y: 20, pressure: 0.1 }, brush(12), 1);
    strokeLine(hard, { x: 20, y: 20, pressure: 1 }, { x: 60, y: 20, pressure: 1 }, brush(12), 1);
    expect(count(light)).toBeLessThan(count(hard));
  });
});

describe('remplissage', () => {
  it('remplit une zone fermée sans déborder', () => {
    const a = blank();
    for (let i = 10; i <= 30; i++) {
      stamp(a, i, 10, brush(1), 1);
      stamp(a, i, 30, brush(1), 1);
      stamp(a, 10, i, brush(1), 1);
      stamp(a, 30, i, brush(1), 1);
    }
    expect(fill(a, 20, 20, 2, 'solid')).toBe(true);
    expect(px(a, 20, 20)).toBe(2);
    expect(px(a, 11, 11)).toBe(2);
    expect(px(a, 5, 5)).toBe(0);
    expect(count(a, 2)).toBe(19 * 19);
  });

  it('ne fait rien quand la couleur est déjà celle de la zone', () => {
    const a = blank().fill(1);
    expect(fill(a, 5, 5, 1, 'solid')).toBe(false);
  });

  it('remplit avec un motif sans toucher les pixels hors motif', () => {
    const a = blank();
    fill(a, 0, 0, 1, 'checker');
    expect(count(a)).toBe((WIDTH * HEIGHT) / 2);
  });

  it('traverse correctement une grande zone (pas de dépassement de pile)', () => {
    const a = blank();
    expect(count(floodRegion(a, 0, 0), 1)).toBe(WIDTH * HEIGHT);
  });

  it('refuse un point de départ hors de la grille', () => {
    expect(count(floodRegion(blank(), -1, 5), 1)).toBe(0);
  });
});

describe('sélection', () => {
  it('construit un rectangle inclusif', () => {
    const m = rectMask(10, 10, 14, 12);
    expect(count(m)).toBe(15);
    expect(maskBounds(m)).toEqual({ x: 10, y: 10, w: 5, h: 3 });
  });

  it('construit une sélection libre fermée', () => {
    const m = lassoMask([
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 30 },
      { x: 10, y: 30 },
    ]);
    expect(count(m)).toBe(20 * 20);
    expect(lassoMask([{ x: 1, y: 1 }, { x: 5, y: 5 }]).some(Boolean)).toBe(false);
  });

  it('découpe, déplace et colle sans perte', () => {
    const a = blank();
    a[20 * WIDTH + 20] = 1;
    a[20 * WIDTH + 21] = 2;
    const mask = rectMask(19, 19, 22, 21);
    const c = extract(a, mask)!;
    clearMask(a, mask);
    expect(count(a, 1) + count(a, 2)).toBe(0);
    pasteContent(a, c, 50, 10);
    expect(px(a, 70, 30)).toBe(1);
    expect(px(a, 71, 30)).toBe(2);
  });

  it('ne recouvre pas le dessous avec des pixels transparents', () => {
    const a = blank();
    a[5 * WIDTH + 5] = 2;
    const src = blank();
    src[0] = 1;
    const c = extract(src, rectMask(0, 0, 1, 0))!;
    pasteContent(a, { ...c, x: 5, y: 5 }, 0, 0);
    expect(px(a, 5, 5)).toBe(1);
    expect(px(a, 6, 5)).toBe(0);
  });

  it('décale un masque en restant dans la grille', () => {
    const m = shiftMask(rectMask(0, 0, 9, 9), 5, 5);
    expect(maskBounds(m)).toEqual({ x: 5, y: 5, w: 10, h: 10 });
    expect(count(shiftMask(rectMask(0, 0, 9, 9), -5, 0))).toBe(5 * 10);
  });

  it('change de couleur dans une sélection', () => {
    const a = blank().fill(1);
    remap(a, rectMask(0, 0, 9, 9), 1, 2);
    expect(count(a, 2)).toBe(100);
    expect(count(a, 1)).toBe(WIDTH * HEIGHT - 100);
  });
});
