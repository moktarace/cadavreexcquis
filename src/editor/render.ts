import { PALETTE, PIXELS } from './palette';

/** Indices de palette → RGBA opaque. Résolution réelle 320×240, jamais agrandie. */
export function indexedToRgba(indexed: Uint8Array, target?: Uint8ClampedArray): Uint8ClampedArray {
  const rgba = target ?? new Uint8ClampedArray(PIXELS * 4);
  for (let i = 0; i < PIXELS; i++) {
    const [r, g, b] = PALETTE[indexed[i]].rgb;
    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  }
  return rgba;
}
