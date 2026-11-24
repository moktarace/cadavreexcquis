import { HEIGHT, WIDTH } from '../palette';
import { MIMO_INK } from '../mimo/mimo';
import { drawShapes } from '../mimo/raster';
import { DECOR_COUNT, DECOR_H, DECOR_PLACES, DECOR_STROKE, DECOR_W, type DecorElement } from './art';

/** Largeur du décor en pixels de la toile (la hauteur suit, 4:3). */
export const DECOR_MIN = 90;
export const DECOR_MAX = 560;
export const DECOR_DEFAULT = 300;
/** Rayon de tolérance (pixels de la toile) autour d'un élément pour le retirer d'un toucher. */
export const PICK_REACH = 20;
export const DECOR_FX_MS = 170;

export interface DecorFx {
  t0: number;
  t: number;
}

export interface DecorState {
  place: number;
  /** Centre du décor, en pixels de la toile. */
  cx: number;
  cy: number;
  width: number;
  /** Éléments retirés (le dernier est le premier à revenir). */
  removed: string[];
  /** Mode « Gommer »: un toucher retire un élément au lieu de déplacer le décor. */
  erasing: boolean;
  fx: DecorFx | null;
}

export interface DecorRect {
  left: number;
  top: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clampDecorSize = (w: number) => clamp(w, DECOR_MIN, DECOR_MAX);
export const clampDecorCenter = (x: number, y: number) => ({ cx: clamp(x, 0, WIDTH), cy: clamp(y, 0, HEIGHT) });

/** Lieu suivant, tiré au hasard mais jamais le même que le précédent (sauf s'il n'y en a qu'un). */
export function nextPlace(previous: number | null, rng: () => number = Math.random, count = DECOR_COUNT): number {
  if (count <= 1) return 0;
  if (previous === null) return Math.min(count - 1, Math.floor(rng() * count));
  const k = Math.min(count - 2, Math.floor(rng() * (count - 1)));
  return k >= previous ? k + 1 : k;
}

/** Petit gonflement au changement de lieu (le « Change ! » de l'arbitre). */
export function decorPop(fx: DecorFx | null): number {
  return fx ? 1 + 0.07 * (1 - fx.t) ** 2 * Math.cos(fx.t * Math.PI) : 1;
}

export function decorRect(d: DecorState, animated = true): DecorRect {
  const w = Math.max(8, Math.round(d.width * (animated ? decorPop(d.fx) : 1)));
  const h = Math.round((w * DECOR_H) / DECOR_W);
  return { left: Math.round(d.cx - w / 2), top: Math.round(d.cy - h / 2), w, h };
}

const masks = new Map<string, Uint8Array>();

/** Pixels noirs du décor à cette taille, sans les éléments retirés. */
export function rasterDecor(place: number, removed: readonly string[], w: number, h: number): Uint8Array {
  const key = `${place}|${[...removed].sort().join(',')}|${w}x${h}`;
  const hit = masks.get(key);
  if (hit) return hit;
  const sx = w / DECOR_W;
  const shapes = DECOR_PLACES[place].elements.filter((e) => !removed.includes(e.id)).flatMap((e) => e.shapes);
  const out = drawShapes(shapes, w, h, sx, h / DECOR_H, Math.max(2, DECOR_STROKE * sx));
  masks.set(key, out);
  if (masks.size > 16) masks.delete(masks.keys().next().value!);
  return out;
}

/**
 * Dépose le décor DERRIÈRE le dessin: seuls les pixels blancs et non protégés reçoivent un trait noir.
 * Un pixel déjà dessiné (couleur, trait noir, Mimo, texte) n'est jamais modifié.
 */
export function drawDecor(pixels: Uint8Array, shield: Uint8Array | undefined, d: DecorState, animated: boolean): void {
  const r = decorRect(d, animated);
  const mask = rasterDecor(d.place, d.removed, r.w, r.h);
  for (let y = 0; y < r.h; y++) {
    const ty = r.top + y;
    if (ty < 0 || ty >= HEIGHT) continue;
    for (let x = 0; x < r.w; x++) {
      const tx = r.left + x;
      if (tx < 0 || tx >= WIDTH || !mask[y * r.w + x]) continue;
      const i = ty * WIDTH + tx;
      if (pixels[i] === 0 && !(shield && shield[i])) pixels[i] = MIMO_INK;
    }
  }
}

export interface PlacedElement {
  id: string;
  name: string;
  /** Zone de sélection en pixels de la toile. */
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Éléments encore visibles, avec leur zone en pixels de la toile. */
export function visibleElements(d: DecorState): PlacedElement[] {
  const r = decorRect(d, false);
  const sx = r.w / DECOR_W;
  return DECOR_PLACES[d.place].elements
    .filter((e) => !d.removed.includes(e.id))
    .map((e: DecorElement) => ({ id: e.id, name: e.name, left: r.left + e.x0 * sx, top: r.top + e.y0 * sx, right: r.left + e.x1 * sx, bottom: r.top + e.y1 * sx }));
}

/** Élément touché en (x, y): sa zone contient le point, sinon le plus proche dans la tolérance; null sur le vide. */
export function pickElement(d: DecorState, x: number, y: number, reach = PICK_REACH): string | null {
  let best: { id: string; dist: number; area: number } | null = null;
  for (const e of visibleElements(d)) {
    const dx = Math.max(e.left - x, 0, x - e.right);
    const dy = Math.max(e.top - y, 0, y - e.bottom);
    const dist = Math.hypot(dx, dy);
    if (dist > reach) continue;
    const area = (e.right - e.left) * (e.bottom - e.top);
    if (!best || dist < best.dist || (dist === best.dist && area < best.area)) best = { id: e.id, dist, area };
  }
  return best?.id ?? null;
}
