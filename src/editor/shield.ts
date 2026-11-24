/**
 * Zones protégées: là où un Mimo ou un texte a été placé, un décor ajouté ensuite ne trace rien (il passe derrière).
 * Ce n'est pas un calque: un simple masque qui suit l'historique, jamais affiché ni publié.
 */
import { HEIGHT, PIXELS, WIDTH } from './palette';

/** Remplit l'intérieur des contours fermés: le Mimo « plein » protège aussi son visage et son corps. */
function silhouette(mask: Uint8Array, w: number, h: number): Uint8Array {
  const gw = w + 2;
  const gh = h + 2;
  const solid = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) solid[(y + 1) * gw + x + 1] = 1;
  const outside = new Uint8Array(gw * gh);
  const stack = [0];
  outside[0] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % gw;
    const y = (i / gw) | 0;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const j = ny * gw + nx;
      if (!solid[j] && !outside[j]) {
        outside[j] = 1;
        stack.push(j);
      }
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = outside[(y + 1) * gw + x + 1] ? 0 : 1;
  return out;
}

/** Épaissit une zone de r pixels dans toutes les directions (fenêtre carrée, deux passes). */
function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    const row = y * w;
    // distance au dernier pixel plein à gauche, puis à droite
    for (let x = 0; x < w; x++) {
      if (m[row + x]) last = x;
      if (x - last <= r) a[row + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (m[row + x]) last = x;
      if (last - x <= r) a[row + x] = 1;
    }
  }
  const b = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (a[y * w + x]) last = y;
      if (y - last <= r) b[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (a[y * w + x]) last = y;
      if (last - y <= r) b[y * w + x] = 1;
    }
  }
  return b;
}

/** Nouvelle zone protégée = l'ancienne + l'objet (rempli ou non) épaissi de `radius` pixels. */
export function protect(
  shield: Uint8Array | undefined,
  mask: Uint8Array,
  w: number,
  h: number,
  left: number,
  top: number,
  radius: number,
  fillInside: boolean,
): Uint8Array {
  const out = shield ? shield.slice() : new Uint8Array(PIXELS);
  const pad = radius + 1;
  const gw = w + 2 * pad;
  const gh = h + 2 * pad;
  const base = fillInside ? silhouette(mask, w, h) : mask;
  const grid = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (base[y * w + x]) grid[(y + pad) * gw + x + pad] = 1;
  const grown = dilate(grid, gw, gh, radius);
  for (let y = 0; y < gh; y++) {
    const ty = top - pad + y;
    if (ty < 0 || ty >= HEIGHT) continue;
    for (let x = 0; x < gw; x++) {
      const tx = left - pad + x;
      if (tx >= 0 && tx < WIDTH && grown[y * gw + x]) out[ty * WIDTH + tx] = 1;
    }
  }
  return out;
}
