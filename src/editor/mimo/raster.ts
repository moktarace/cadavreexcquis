import { mimoShapes, type MimoSpec } from './art';
import { BOX, type Shape } from './geometry';

export interface MimoMask {
  w: number;
  h: number;
  /** 1 = trait noir, 0 = transparent. */
  mask: Uint8Array;
}

/** Épaisseur de base d'un trait, en pixels: jamais sous 2 pour rester net à petite taille. */
export function strokeWidth(w: number, h: number): number {
  return Math.max(2, 0.034 * Math.sqrt(w * h));
}

function strokeSegment(m: Uint8Array, w: number, h: number, ax: number, ay: number, bx: number, by: number, r: number) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - ax;
      const py = y + 0.5 - ay;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const ex = px - t * dx;
      const ey = py - t * dy;
      if (ex * ex + ey * ey <= r2) m[y * w + x] = 1;
    }
  }
}

function fillPolygon(m: Uint8Array, w: number, h: number, pts: number[], value: number) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < pts.length; i += 2) {
    minY = Math.min(minY, pts[i]);
    maxY = Math.max(maxY, pts[i]);
  }
  const xs: number[] = [];
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(h - 1, Math.ceil(maxY)); y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
      const yi = pts[i + 1];
      const yj = pts[j + 1];
      if (yi > cy !== yj > cy) xs.push(pts[i] + ((cy - yi) / (yj - yi)) * (pts[j] - pts[i]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x++) m[y * w + x] = value;
    }
  }
}

/** Trace des formes (unités du dessin) dans un masque w × h: sx, sy = pixels par unité, base = épaisseur de base en pixels. */
export function drawShapes(shapes: readonly Shape[], w: number, h: number, sx: number, sy: number, base: number): Uint8Array {
  const m = new Uint8Array(w * h);
  const scaled = (pts: number[]) => pts.map((v, i) => (i % 2 ? v * sy : v * sx));
  for (const s of shapes) {
    if (s.k === 'line') {
      const r = Math.max(1.6, base * (s.w ?? 1)) / 2;
      const p = scaled(s.pts);
      const n = s.closed ? p.length : p.length - 2;
      for (let i = 0; i < n; i += 2) {
        const j = (i + 2) % p.length;
        strokeSegment(m, w, h, p[i], p[i + 1], p[j], p[j + 1], r);
      }
    } else if (s.k === 'fill') fillPolygon(m, w, h, scaled(s.pts), 1);
  }
  for (const s of shapes) if (s.k === 'hole' && Math.min(w, h) >= (s.min ?? 0)) fillPolygon(m, w, h, scaled(s.pts), 0);
  return m;
}

const cache = new Map<string, MimoMask>();

/** Rasterise un Mimo à une taille précise (w × h pixels), sans lissage: pixels noirs ou transparents. */
export function rasterMimo(spec: MimoSpec, w: number, h: number): MimoMask {
  const key = `${spec.design}.${spec.emotion}.${spec.pose}@${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = { w, h, mask: drawShapes(mimoShapes(spec), w, h, w / BOX, h / BOX, strokeWidth(w, h)) };
  cache.set(key, out);
  if (cache.size > 24) cache.delete(cache.keys().next().value!);
  return out;
}
