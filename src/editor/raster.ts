import { HEIGHT, PIXELS, WIDTH } from './palette';

export type BrushShape = 'round' | 'square';
export type Texture = 'solid' | 'checker' | 'dots' | 'lines' | 'diagonal' | 'sparse';

export const TEXTURES: readonly { id: Texture; label: string }[] = [
  { id: 'solid', label: 'Plein' },
  { id: 'checker', label: 'Damier' },
  { id: 'dots', label: 'Points' },
  { id: 'lines', label: 'Lignes' },
  { id: 'diagonal', label: 'Diagonales' },
  { id: 'sparse', label: 'Grain' },
];

export const PEN_SIZES: readonly number[] = [1, 2, 3, 5, 8, 12];
export const ERASER_SIZES: readonly number[] = [2, 4, 8, 16, 32];

export interface Brush {
  size: number;
  shape: BrushShape;
  texture: Texture;
}

/** Motifs ancrés aux coordonnées absolues: deux traits voisins se raccordent. */
export function patternAt(texture: Texture, x: number, y: number): boolean {
  switch (texture) {
    case 'solid':
      return true;
    case 'checker':
      return ((x + y) & 1) === 0;
    case 'dots':
      return (x & 1) === 0 && (y & 1) === 0;
    case 'lines':
      return (y & 1) === 0;
    case 'diagonal':
      return ((x + y) & 3) === 0;
    case 'sparse':
      // Grain pseudo-aléatoire mais déterministe (hachage entier), environ 1/4 des pixels
      return (Math.imul(x * 73856093 ^ y * 19349663, 2654435761) >>> 30) === 0;
  }
}

/** Dépose une touche de pinceau centrée sur (cx, cy). `value` 0 efface. */
export function stamp(pixels: Uint8Array, cx: number, cy: number, brush: Brush, value: number): boolean {
  const { size, shape, texture } = brush;
  const x0 = cx - Math.floor(size / 2);
  const y0 = cy - Math.floor(size / 2);
  const r = size / 2;
  let changed = false;
  for (let y = Math.max(0, y0); y < Math.min(HEIGHT, y0 + size); y++) {
    for (let x = Math.max(0, x0); x < Math.min(WIDTH, x0 + size); x++) {
      if (shape === 'round') {
        const dx = x + 0.5 - (x0 + r);
        const dy = y + 0.5 - (y0 + r);
        if (dx * dx + dy * dy >= r * r) continue;
      }
      if (value !== 0 && !patternAt(texture, x, y)) continue;
      const i = y * WIDTH + x;
      if (pixels[i] !== value) {
        pixels[i] = value;
        changed = true;
      }
    }
  }
  return changed;
}

/** Trait continu entre deux points; la pression (0–1) module la taille. */
export function strokeLine(
  pixels: Uint8Array,
  from: { x: number; y: number; pressure: number },
  to: { x: number; y: number; pressure: number },
  brush: Brush,
  value: number,
): boolean {
  let x0 = Math.round(from.x);
  let y0 = Math.round(from.y);
  const x1 = Math.round(to.x);
  const y1 = Math.round(to.y);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  const steps = Math.max(dx, -dy, 1);
  let err = dx + dy;
  let changed = false;
  for (let n = 0; ; n++) {
    const t = steps === 0 ? 1 : n / steps;
    const pressure = from.pressure + (to.pressure - from.pressure) * Math.min(1, t);
    const size = Math.max(1, Math.round(brush.size * (0.35 + 0.65 * pressure)));
    if (stamp(pixels, x0, y0, { ...brush, size }, value)) changed = true;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return changed;
}

/** Zone connexe (4 voisins) de pixels de même valeur que (x, y). */
export function floodRegion(pixels: Uint8Array, x: number, y: number): Uint8Array {
  const region = new Uint8Array(PIXELS);
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return region;
  const target = pixels[y * WIDTH + x];
  const stack: number[] = [x, y];
  while (stack.length) {
    const py = stack.pop()!;
    const px = stack.pop()!;
    let lx = px;
    while (lx >= 0 && !region[py * WIDTH + lx] && pixels[py * WIDTH + lx] === target) lx--;
    lx++;
    let rx = lx;
    let upOpen = false;
    let downOpen = false;
    while (rx < WIDTH && !region[py * WIDTH + rx] && pixels[py * WIDTH + rx] === target) {
      region[py * WIDTH + rx] = 1;
      if (py > 0) {
        const open = !region[(py - 1) * WIDTH + rx] && pixels[(py - 1) * WIDTH + rx] === target;
        if (open && !upOpen) stack.push(rx, py - 1);
        upOpen = open;
      }
      if (py < HEIGHT - 1) {
        const open = !region[(py + 1) * WIDTH + rx] && pixels[(py + 1) * WIDTH + rx] === target;
        if (open && !downOpen) stack.push(rx, py + 1);
        downOpen = open;
      }
      rx++;
    }
  }
  return region;
}

/** Remplit la zone sous (x, y); avec un motif, seuls les pixels du motif sont modifiés. */
export function fill(pixels: Uint8Array, x: number, y: number, value: number, texture: Texture): boolean {
  const region = floodRegion(pixels, x, y);
  let changed = false;
  for (let i = 0; i < PIXELS; i++) {
    if (!region[i]) continue;
    if (!patternAt(texture, i % WIDTH, (i / WIDTH) | 0)) continue;
    if (pixels[i] !== value) {
      pixels[i] = value;
      changed = true;
    }
  }
  return changed;
}

// ───────────── Sélections ─────────────

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectMask(ax: number, ay: number, bx: number, by: number): Uint8Array {
  const mask = new Uint8Array(PIXELS);
  const x0 = Math.max(0, Math.min(ax, bx));
  const x1 = Math.min(WIDTH - 1, Math.max(ax, bx));
  const y0 = Math.max(0, Math.min(ay, by));
  const y1 = Math.min(HEIGHT - 1, Math.max(ay, by));
  for (let y = y0; y <= y1; y++) mask.fill(1, y * WIDTH + x0, y * WIDTH + x1 + 1);
  return mask;
}

/** Sélection libre: polygone fermé, règle pair-impair sur les centres de pixels. */
export function lassoMask(points: readonly { x: number; y: number }[]): Uint8Array {
  const mask = new Uint8Array(PIXELS);
  if (points.length < 3) return mask;
  for (let y = 0; y < HEIGHT; y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if ((a.y <= cy && b.y > cy) || (b.y <= cy && a.y > cy)) {
        xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(WIDTH - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let x = from; x <= to; x++) mask[y * WIDTH + x] = 1;
    }
  }
  return mask;
}

export function fullMask(): Uint8Array {
  return new Uint8Array(PIXELS).fill(1);
}

export function maskBounds(mask: Uint8Array): Bounds | null {
  let minX = WIDTH;
  let minY = HEIGHT;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (!mask[y * WIDTH + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export interface Content {
  w: number;
  h: number;
  /** Position d'origine (pour coller au même endroit). */
  x: number;
  y: number;
  pixels: Uint8Array;
  mask: Uint8Array;
}

export function extract(pixels: Uint8Array, mask: Uint8Array): Content | null {
  const b = maskBounds(mask);
  if (!b) return null;
  const out = new Uint8Array(b.w * b.h);
  const m = new Uint8Array(b.w * b.h);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const src = (b.y + y) * WIDTH + b.x + x;
      if (mask[src]) {
        out[y * b.w + x] = pixels[src];
        m[y * b.w + x] = 1;
      }
    }
  }
  return { w: b.w, h: b.h, x: b.x, y: b.y, pixels: out, mask: m };
}

export function clearMask(pixels: Uint8Array, mask: Uint8Array): void {
  for (let i = 0; i < PIXELS; i++) if (mask[i]) pixels[i] = 0;
}

/** Les pixels transparents de la sélection laissent intact ce qui est dessous. */
export function pasteContent(pixels: Uint8Array, c: Content, dx: number, dy: number): void {
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const v = c.pixels[y * c.w + x];
      if (!c.mask[y * c.w + x] || v === 0) continue;
      const tx = c.x + dx + x;
      const ty = c.y + dy + y;
      if (tx >= 0 && ty >= 0 && tx < WIDTH && ty < HEIGHT) pixels[ty * WIDTH + tx] = v;
    }
  }
}

export function shiftMask(mask: Uint8Array, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(PIXELS);
  for (let y = 0; y < HEIGHT; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= HEIGHT) continue;
    for (let x = 0; x < WIDTH; x++) {
      const tx = x + dx;
      if (mask[y * WIDTH + x] && tx >= 0 && tx < WIDTH) out[ty * WIDTH + tx] = 1;
    }
  }
  return out;
}

/** Change `from` en `to` dans la sélection (ou partout si `mask` est nul). */
export function remap(pixels: Uint8Array, mask: Uint8Array | null, from: number, to: number): boolean {
  let changed = false;
  for (let i = 0; i < PIXELS; i++) {
    if (pixels[i] === from && (!mask || mask[i])) {
      pixels[i] = to;
      changed = true;
    }
  }
  return changed;
}
