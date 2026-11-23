/**
 * Géométrie vectorielle des Mimo: tout est décrit dans une boîte de 100 × 100, au trait noir uniquement.
 * Aucun rendu ici (voir raster.ts): des formes simples, déterministes, sans dépendance.
 */

export type Shape =
  /** Trait à bouts ronds; `w` = multiple de l'épaisseur de base. */
  | { k: 'line'; pts: number[]; closed?: boolean; w?: number }
  /** Aplat noir (pupilles, nez): jamais une couleur. */
  | { k: 'fill'; pts: number[] }
  /** Évidement (reflet dans l'œil), dessiné en dernier; ignoré sous `min` pixels de haut. */
  | { k: 'hole'; pts: number[]; min?: number };

export const BOX = 100;

/** Découpe de chemins façon SVG (M L C Q Z, coordonnées absolues). */
export function path(d: string, w?: number): Shape[] {
  const tokens = d.match(/[MLCQZ]|-?\d*\.?\d+/g) ?? [];
  const out: Shape[] = [];
  let pts: number[] = [];
  let i = 0;
  let x = 0;
  let y = 0;
  const num = () => Number(tokens[i++]);
  const flush = (closed: boolean) => {
    if (pts.length >= 4) out.push({ k: 'line', pts, closed, w });
    pts = [];
  };
  let cmd = '';
  while (i < tokens.length) {
    if (/[MLCQZ]/.test(tokens[i])) cmd = tokens[i++];
    switch (cmd) {
      case 'M':
        flush(false);
        x = num();
        y = num();
        pts = [x, y];
        break;
      case 'L':
        x = num();
        y = num();
        pts.push(x, y);
        break;
      case 'Q': {
        const cx = num();
        const cy = num();
        const ex = num();
        const ey = num();
        for (let s = 1; s <= 8; s++) {
          const t = s / 8;
          const u = 1 - t;
          pts.push(u * u * x + 2 * u * t * cx + t * t * ex, u * u * y + 2 * u * t * cy + t * t * ey);
        }
        x = ex;
        y = ey;
        break;
      }
      case 'C': {
        const x1 = num();
        const y1 = num();
        const x2 = num();
        const y2 = num();
        const ex = num();
        const ey = num();
        for (let s = 1; s <= 14; s++) {
          const t = s / 14;
          const u = 1 - t;
          pts.push(
            u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex,
            u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey,
          );
        }
        x = ex;
        y = ey;
        break;
      }
      case 'Z':
        flush(true);
        cmd = '';
        break;
      default:
        i++;
    }
  }
  flush(false);
  return out;
}

/** Polyligne d'une ellipse (angles en degrés, 0 = droite, sens horaire à l'écran). */
export function ellipse(cx: number, cy: number, rx: number, ry: number, a0 = 0, a1 = 360, n = 32): number[] {
  const pts: number[] = [];
  const steps = Math.max(4, Math.round((n * Math.abs(a1 - a0)) / 360));
  for (let s = 0; s <= steps; s++) {
    const a = ((a0 + ((a1 - a0) * s) / steps) * Math.PI) / 180;
    pts.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  }
  return pts;
}

/** Super-ellipse: n = 2 donne une ellipse, plus grand un « mochi » aux flancs pleins. */
export function blob(cx: number, cy: number, rx: number, ry: number, n = 2.3, steps = 64): number[] {
  const pts: number[] = [];
  for (let s = 0; s < steps; s++) {
    const a = (s / steps) * Math.PI * 2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    pts.push(cx + rx * Math.sign(c) * Math.abs(c) ** (2 / n), cy + ry * Math.sign(sn) * Math.abs(sn) ** (2 / n));
  }
  return pts;
}

export const line = (pts: number[], w?: number, closed = false): Shape => ({ k: 'line', pts, closed, w });
export const fill = (pts: number[]): Shape => ({ k: 'fill', pts });
export const dot = (x: number, y: number, r: number): Shape => fill(ellipse(x, y, r, r, 0, 360, 20));

export function mirrorPts(pts: number[]): number[] {
  const out = pts.slice();
  for (let i = 0; i < out.length; i += 2) out[i] = BOX - out[i];
  return out;
}

export function mirror(shapes: Shape[]): Shape[] {
  return shapes.map((s) => ({ ...s, pts: mirrorPts(s.pts) }));
}

export function transform(shapes: Shape[], fn: (x: number, y: number) => [number, number]): Shape[] {
  return shapes.map((s) => {
    const pts = s.pts.slice();
    for (let i = 0; i < pts.length; i += 2) [pts[i], pts[i + 1]] = fn(pts[i], pts[i + 1]);
    return { ...s, pts };
  });
}

export function rotate(shapes: Shape[], deg: number, cx: number, cy: number): Shape[] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return transform(shapes, (x, y) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
}

function inside(poly: number[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i];
    const yi = poly[i + 1];
    const xj = poly[j];
    const yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Ne garde que les morceaux d'un trait situés hors d'un polygone (oreilles qui sortent de la tête, sans transparence). */
export function outside(shape: Shape, poly: number[], w?: number): Shape[] {
  if (shape.k !== 'line') return [shape];
  const out: Shape[] = [];
  let run: number[] = [];
  const pts = shape.closed ? [...shape.pts, shape.pts[0], shape.pts[1]] : shape.pts;
  for (let i = 0; i < pts.length; i += 2) {
    if (inside(poly, pts[i], pts[i + 1])) {
      if (run.length >= 4) out.push(line(run, w ?? shape.w));
      run = [];
    } else run.push(pts[i], pts[i + 1]);
  }
  if (run.length >= 4) out.push(line(run, w ?? shape.w));
  return out;
}
