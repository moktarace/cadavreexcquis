import { HEIGHT, WIDTH } from '../palette';
import type { MimoSpec } from './art';
import { rasterMimo } from './raster';

export type MimoAxis = 'pose' | 'emotion' | 'design';

export const MIMO_MIN = 60;
export const MIMO_MAX = 220;
export const MIMO_DEFAULT = 120;

/** Indice de palette du noir: un Mimo est toujours noir, quelle que soit la couleur choisie. */
export const MIMO_INK = 1;

/** Animations très courtes (millisecondes) par type de changement. */
export const FX_DURATION: Record<MimoAxis, number> = { pose: 240, emotion: 150, design: 190 };

export interface MimoFx {
  kind: MimoAxis;
  /** Début, en millisecondes (horloge de la page). */
  t0: number;
  /** Avancement 0 → 1, mis à jour image par image. */
  t: number;
}

export interface MimoState {
  spec: MimoSpec;
  /** Centre de la boîte du Mimo, en pixels de la toile. */
  cx: number;
  cy: number;
  /** Côté de la boîte carrée, en pixels de la toile. */
  size: number;
  fx: MimoFx | null;
}

export interface MimoRect {
  left: number;
  top: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clampSize = (size: number) => clamp(size, MIMO_MIN, MIMO_MAX);
export const clampCenter = (x: number, y: number) => ({ cx: clamp(x, 0, WIDTH), cy: clamp(y, 0, HEIGHT) });

/** Déformation élastique d'une animation: rebond de la pose, ondulation du visage, petit saut du style. */
export function fxScale(fx: MimoFx | null): { sx: number; sy: number } {
  if (!fx) return { sx: 1, sy: 1 };
  const k = (1 - fx.t) ** 2;
  switch (fx.kind) {
    case 'pose': {
      const o = Math.cos(fx.t * Math.PI * 3);
      return { sx: 1 - 0.07 * k * o, sy: 1 + 0.12 * k * o };
    }
    case 'emotion':
      return { sx: 1 + 0.09 * k * Math.cos(fx.t * Math.PI * 2.5), sy: 1 - 0.03 * k };
    case 'design': {
      const pop = 0.14 * k * Math.cos(fx.t * Math.PI * 2);
      return { sx: 1 + pop, sy: 1 + pop };
    }
  }
}

/** Rectangle occupé par le Mimo; pendant une animation les pieds restent posés au même endroit. */
export function mimoRect(m: MimoState): MimoRect {
  const side = Math.round(m.size);
  const { sx, sy } = fxScale(m.fx);
  const w = Math.max(8, Math.round(side * sx));
  const h = Math.max(8, Math.round(side * sy));
  return { left: Math.round(m.cx - w / 2), top: Math.round(m.cy + side / 2 - h), w, h };
}

/** Dépose le Mimo (noir, fond transparent) sur une copie des pixels. Même chemin pour l'aperçu et le placement. */
export function drawMimo(pixels: Uint8Array, m: MimoState, animated: boolean): void {
  const r = mimoRect(animated ? m : { ...m, fx: null });
  const { mask } = rasterMimo(m.spec, r.w, r.h);
  for (let y = 0; y < r.h; y++) {
    const ty = r.top + y;
    if (ty < 0 || ty >= HEIGHT) continue;
    for (let x = 0; x < r.w; x++) {
      const tx = r.left + x;
      if (tx < 0 || tx >= WIDTH || !mask[y * r.w + x]) continue;
      pixels[ty * WIDTH + tx] = MIMO_INK;
    }
  }
}
