import { HEIGHT, WIDTH } from '../palette';
import { MIMO_INK } from '../mimo/mimo';
import { drawShapes } from '../mimo/raster';
import type { Shape } from '../mimo/geometry';
import { CAP, LEADING, SPACE, STROKE, TRACKING, glyphOf, toFontText } from './font';

/** Texte libre: écrit en noir directement sur l'image, sans bulle ni cadre. */
export const TEXT_MAX_CHARS = 100;
export const TEXT_MIN = 10;
export const TEXT_MAX = 96;
export const TEXT_DEFAULT = 26;
/** Marge minimale entre le texte et le bord de la toile (pixels). */
const MARGIN = 6;

export interface TextState {
  value: string;
  /** Centre du texte, en pixels de la toile. */
  cx: number;
  cy: number;
  /** Hauteur d'une lettre capitale, en pixels. */
  size: number;
}

export interface TextRect {
  left: number;
  top: number;
  w: number;
  h: number;
}

interface Layout {
  shapes: Shape[];
  /** Encombrement réel du dessin, en unités de la police (traits compris). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const advance = (ch: string) => (ch === ' ' ? SPACE : (glyphOf(ch)?.w ?? 0) + TRACKING);

/** Coupe en lignes: retours à la ligne saisis, puis mots, et au besoin lettre par lettre pour un mot plus long que la toile. */
export function wrapText(text: string, maxUnits: number): string[] {
  const lines: string[] = [];
  for (const para of toFontText(text).split('\n')) {
    let cur = '';
    let width = 0;
    const push = () => {
      lines.push(cur.trimEnd());
      cur = '';
      width = 0;
    };
    for (const word of para.split(/(?<= )/)) {
      const w = [...word].reduce((n, ch) => n + advance(ch), 0);
      if (width > 0 && width + w - (word.endsWith(' ') ? SPACE : 0) > maxUnits) push();
      if (w > maxUnits) {
        for (const ch of word) {
          if (width > 0 && width + advance(ch) - TRACKING > maxUnits) push();
          cur += ch;
          width += advance(ch);
        }
      } else {
        cur += word;
        width += w;
      }
    }
    push();
  }
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const layouts = new Map<string, Layout>();

function layoutText(value: string, size: number): Layout {
  const key = `${size}|${value}`;
  const hit = layouts.get(key);
  if (hit) return hit;
  const scale = size / CAP;
  const lines = wrapText(value, (WIDTH - 2 * MARGIN) / scale);
  const shapes: Shape[] = [];
  const widths = lines.map((l) => [...l].reduce((n, ch) => n + advance(ch), 0) - TRACKING);
  const block = Math.max(0, ...widths);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  lines.forEach((l, row) => {
    let x = (block - widths[row]) / 2; // lignes centrées
    const y = row * LEADING;
    for (const ch of l) {
      const g = glyphOf(ch);
      if (g) {
        for (const s of g.shapes) {
          const pts = s.pts.map((v, i) => (i % 2 ? v + y : v + x));
          shapes.push({ ...s, pts });
          for (let i = 0; i < pts.length; i += 2) {
            x0 = Math.min(x0, pts[i] - STROKE / 2);
            x1 = Math.max(x1, pts[i] + STROKE / 2);
            y0 = Math.min(y0, pts[i + 1] - STROKE / 2);
            y1 = Math.max(y1, pts[i + 1] + STROKE / 2);
          }
        }
      }
      x += advance(ch);
    }
  });
  const out: Layout = shapes.length ? { shapes, x0, y0, x1, y1 } : { shapes, x0: 0, y0: 0, x1: 0, y1: 0 };
  layouts.set(key, out);
  if (layouts.size > 40) layouts.delete(layouts.keys().next().value!);
  return out;
}

/** Dimensions du texte à cette taille (sans le tracer): très rapide, utilisée pendant un redimensionnement. */
export function textDims(value: string, size: number): { w: number; h: number } {
  const l = layoutText(value, size);
  if (!l.shapes.length) return { w: 0, h: 0 };
  const scale = size / CAP;
  return { w: Math.ceil((l.x1 - l.x0) * scale), h: Math.ceil((l.y1 - l.y0) * scale) };
}

export interface TextMask {
  w: number;
  h: number;
  mask: Uint8Array;
}

const masks = new Map<string, TextMask>();

/** Pixels noirs du texte à cette taille (et sa largeur/hauteur). Texte vide: 0 × 0. */
export function rasterText(value: string, size: number): TextMask {
  const key = `${size}|${value}`;
  const hit = masks.get(key);
  if (hit) return hit;
  const l = layoutText(value, size);
  const scale = size / CAP;
  const { w, h } = textDims(value, size);
  let out: TextMask;
  if (!l.shapes.length || w < 1 || h < 1) out = { w: 0, h: 0, mask: new Uint8Array(0) };
  else {
    const moved = l.shapes.map((s) => ({ ...s, pts: s.pts.map((v, i) => (i % 2 ? v - l.y0 : v - l.x0)) }));
    out = { w, h, mask: drawShapes(moved, w, h, scale, scale, Math.max(2, STROKE * scale)) };
  }
  masks.set(key, out);
  if (masks.size > 24) masks.delete(masks.keys().next().value!);
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Taille réellement utilisée: la demandée, réduite au besoin pour que le texte tienne dans la toile. */
export const textSizeOf = (t: TextState) => fitSize(t.value, t.size);

/** Rectangle occupé par le texte; vide tant que rien n'est écrit. */
export function textRect(t: TextState): TextRect {
  const { w, h } = textDims(t.value, textSizeOf(t));
  return { left: Math.round(t.cx - w / 2), top: Math.round(t.cy - h / 2), w, h };
}

/** Plus grande taille ≤ `size` pour laquelle tout le texte tient dans la toile. */
export function fitSize(value: string, size: number): number {
  let s = clamp(Math.round(size), TEXT_MIN, TEXT_MAX);
  while (s > TEXT_MIN) {
    const { w, h } = textDims(value, s);
    if (w <= WIDTH - 2 * MARGIN && h <= HEIGHT - 2 * MARGIN) break;
    s--;
  }
  return s;
}

/** Garde le texte entier dans la toile: jamais coupé par un bord. */
export function clampTextCenter(value: string, size: number, x: number, y: number): { cx: number; cy: number } {
  const { w, h } = textDims(value, size);
  return {
    cx: clamp(x, Math.min(w / 2, WIDTH / 2), Math.max(WIDTH - w / 2, WIDTH / 2)),
    cy: clamp(y, Math.min(h / 2, HEIGHT / 2), Math.max(HEIGHT - h / 2, HEIGHT / 2)),
  };
}

/** Dépose le texte (noir) sur une copie des pixels. Même chemin pour l'aperçu et le placement. */
export function drawText(pixels: Uint8Array, t: TextState): void {
  const { w, h, mask } = rasterText(t.value, textSizeOf(t));
  if (!w) return;
  const r = textRect(t);
  for (let y = 0; y < h; y++) {
    const ty = r.top + y;
    if (ty < 0 || ty >= HEIGHT) continue;
    for (let x = 0; x < w; x++) {
      const tx = r.left + x;
      if (tx < 0 || tx >= WIDTH || !mask[y * w + x]) continue;
      pixels[ty * WIDTH + tx] = MIMO_INK;
    }
  }
}

/** Nettoie une saisie: espaces superposés conservés, longueur limitée. */
export function limitText(value: string): string {
  return [...value.replace(/\r\n?/g, '\n')].slice(0, TEXT_MAX_CHARS).join('');
}
