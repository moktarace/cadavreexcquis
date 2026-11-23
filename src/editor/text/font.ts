import { path, type Shape } from '../mimo/geometry';

/**
 * Police unique du jeu, dessinée au trait: lettres rondes et épaisses (capitale haute de 100, trait 15), sans dépendance ni fichier.
 * Le rendu est calculé pixel par pixel comme celui des Mimo: identique sur tous les appareils, jamais flou.
 * Majuscules, minuscules, accents français, chiffres et ponctuation.
 */
export const CAP = 100;
/** Épaisseur du trait en unités de la police. */
export const STROKE = 15;
/** Espace entre deux lettres et largeur d'une espace. */
export const TRACKING = 10;
export const SPACE = 40;
/** Interligne entre deux lignes de texte. */
export const LEADING = 150;

export interface Glyph {
  /** Largeur de la boîte de la lettre (marges de trait comprises). */
  w: number;
  shapes: Shape[];
}

const RAW: Record<string, [number, string]> = {
  A: [72, 'M 8 92 L 36 8 L 64 92 M 19 64 L 53 64'],
  B: [64, 'M 8 8 L 8 92 M 8 8 L 34 8 C 56 8 56 50 34 50 L 8 50 M 34 50 C 62 50 62 92 34 92 L 8 92'],
  C: [64, 'M 56 24 C 50 10 38 8 30 10 C 14 14 8 32 8 50 C 8 68 14 86 30 90 C 38 92 50 90 56 76'],
  D: [66, 'M 8 8 L 8 92 L 26 92 C 62 92 62 8 26 8 L 8 8'],
  E: [56, 'M 50 8 L 8 8 L 8 92 L 50 92 M 8 50 L 42 50'],
  F: [54, 'M 48 8 L 8 8 L 8 92 M 8 48 L 40 48'],
  G: [68, 'M 58 24 C 52 10 40 8 32 10 C 14 14 8 32 8 50 C 8 68 14 86 32 90 C 48 94 60 86 60 66 L 60 52 L 38 52'],
  H: [68, 'M 8 8 L 8 92 M 60 8 L 60 92 M 8 50 L 60 50'],
  I: [30, 'M 15 8 L 15 92'],
  J: [48, 'M 40 8 L 40 68 C 40 88 30 94 20 92 C 14 90 8 86 8 78'],
  K: [64, 'M 8 8 L 8 92 M 56 8 L 10 54 M 28 38 L 58 92'],
  L: [50, 'M 8 8 L 8 92 L 44 92'],
  M: [84, 'M 8 92 L 8 8 L 42 62 L 76 8 L 76 92'],
  N: [68, 'M 8 92 L 8 8 L 60 92 L 60 8'],
  O: [70, 'M 35 8 C 10 8 8 30 8 50 C 8 70 10 92 35 92 C 60 92 62 70 62 50 C 62 30 60 8 35 8 Z'],
  P: [60, 'M 8 92 L 8 8 L 32 8 C 56 8 56 54 32 54 L 8 54'],
  Q: [72, 'M 35 8 C 10 8 8 30 8 50 C 8 70 10 92 35 92 C 60 92 62 70 62 50 C 62 30 60 8 35 8 Z M 40 70 L 62 98'],
  R: [64, 'M 8 92 L 8 8 L 32 8 C 56 8 56 52 32 52 L 8 52 M 32 52 L 58 92'],
  S: [60, 'M 52 22 C 46 8 20 6 14 24 C 8 42 28 46 36 50 C 52 56 56 76 46 86 C 36 96 14 92 8 76'],
  T: [60, 'M 8 8 L 52 8 M 30 8 L 30 92'],
  U: [66, 'M 8 8 L 8 62 C 8 94 58 94 58 62 L 58 8'],
  V: [70, 'M 8 8 L 35 92 L 62 8'],
  W: [96, 'M 8 8 L 26 92 L 48 28 L 70 92 L 88 8'],
  X: [66, 'M 8 8 L 58 92 M 58 8 L 8 92'],
  Y: [66, 'M 8 8 L 33 50 L 58 8 M 33 50 L 33 92'],
  Z: [60, 'M 8 8 L 52 8 L 8 92 L 52 92'],
  a: [56, 'M 48 64 C 48 38 8 38 8 65 C 8 92 48 92 48 64 Z M 48 38 L 48 92'],
  b: [56, 'M 8 8 L 8 92 M 8 64 C 8 38 48 38 48 65 C 48 92 8 92 8 64 Z'],
  c: [50, 'M 44 48 C 36 38 8 38 8 65 C 8 92 36 92 44 82'],
  d: [56, 'M 48 8 L 48 92 M 48 64 C 48 38 8 38 8 65 C 8 92 48 92 48 64 Z'],
  e: [54, 'M 8 62 L 46 62 C 46 36 8 36 8 64 C 8 92 36 94 46 80'],
  f: [44, 'M 40 14 C 24 6 18 18 18 32 L 18 92 M 8 42 L 38 42'],
  g: [56, 'M 48 64 C 48 38 8 38 8 65 C 8 92 48 92 48 64 Z M 48 38 L 48 100 C 48 120 14 118 8 104'],
  h: [54, 'M 8 8 L 8 92 M 8 60 C 8 34 46 34 46 60 L 46 92'],
  i: [26, 'M 13 40 L 13 92 M 13 12 L 13 12'],
  ı: [26, 'M 13 40 L 13 92'],
  j: [34, 'M 22 40 L 22 100 C 22 118 10 116 6 108 M 22 12 L 22 12'],
  k: [52, 'M 8 8 L 8 92 M 44 38 L 10 68 M 22 58 L 46 92'],
  l: [38, 'M 12 8 L 12 78 C 12 92 22 94 30 88'],
  m: [84, 'M 8 38 L 8 92 M 8 60 C 8 34 40 34 40 60 L 40 92 M 40 60 C 40 34 76 34 76 60 L 76 92'],
  n: [54, 'M 8 38 L 8 92 M 8 60 C 8 34 46 34 46 60 L 46 92'],
  o: [56, 'M 28 38 C 6 38 6 92 28 92 C 50 92 50 38 28 38 Z'],
  p: [56, 'M 8 38 L 8 116 M 8 64 C 8 38 48 38 48 65 C 48 92 8 92 8 64 Z'],
  q: [56, 'M 48 38 L 48 116 M 48 64 C 48 38 8 38 8 65 C 8 92 48 92 48 64 Z'],
  r: [40, 'M 8 38 L 8 92 M 8 62 C 10 40 28 34 38 40'],
  s: [46, 'M 40 46 C 34 36 10 36 10 52 C 10 66 40 62 40 78 C 40 94 12 94 6 82'],
  t: [40, 'M 18 18 L 18 82 C 18 94 30 94 36 90 M 8 42 L 34 42'],
  u: [54, 'M 8 38 L 8 68 C 8 96 46 96 46 68 M 46 38 L 46 92'],
  v: [56, 'M 8 38 L 28 92 L 48 38'],
  w: [80, 'M 8 38 L 22 92 L 40 52 L 58 92 L 72 38'],
  x: [52, 'M 8 38 L 44 92 M 44 38 L 8 92'],
  y: [54, 'M 8 38 L 28 88 M 48 38 L 22 108 C 18 116 10 116 6 112'],
  z: [48, 'M 8 38 L 40 38 L 8 92 L 40 92'],
  '0': [62, 'M 31 8 C 8 8 8 30 8 50 C 8 70 8 92 31 92 C 54 92 54 70 54 50 C 54 30 54 8 31 8 Z'],
  '1': [44, 'M 8 26 L 28 8 L 28 92'],
  '2': [60, 'M 10 24 C 14 6 46 6 50 28 C 52 44 36 56 8 92 L 52 92'],
  '3': [60, 'M 10 14 C 30 2 52 10 48 30 C 46 46 30 48 22 48 C 34 48 54 52 52 72 C 50 94 20 98 8 80'],
  '4': [62, 'M 44 92 L 44 8 L 8 66 L 56 66'],
  '5': [62, 'M 52 8 L 14 8 L 10 46 C 30 38 52 46 52 68 C 52 92 22 98 8 82'],
  '6': [62, 'M 50 14 C 38 4 10 8 8 50 C 6 94 54 94 54 66 C 54 42 20 40 8 58'],
  '7': [60, 'M 8 8 L 54 8 L 24 92'],
  '8': [60, 'M 30 48 C 8 44 10 8 30 8 C 52 8 52 44 30 48 C 6 52 6 92 30 92 C 56 92 56 52 30 48'],
  '9': [62, 'M 12 86 C 24 96 52 92 54 50 C 56 6 8 6 8 34 C 8 58 42 60 54 42'],
  '.': [28, 'M 14 90 L 14 90'],
  ',': [28, 'M 16 88 L 10 106'],
  '!': [28, 'M 14 8 L 14 62 M 14 90 L 14 90'],
  '?': [56, 'M 8 26 C 10 6 48 6 48 28 C 48 46 28 46 28 62 M 28 90 L 28 90'],
  ':': [28, 'M 14 38 L 14 38 M 14 90 L 14 90'],
  ';': [28, 'M 14 38 L 14 38 M 16 84 L 10 104'],
  "'": [26, 'M 13 8 L 11 30'],
  '"': [44, 'M 13 8 L 11 30 M 31 8 L 29 30'],
  '-': [44, 'M 8 54 L 36 54'],
  '_': [56, 'M 8 98 L 48 98'],
  '(': [36, 'M 28 6 C 10 24 10 76 28 96'],
  ')': [36, 'M 8 6 C 26 24 26 76 8 96'],
  '/': [48, 'M 40 6 L 8 94'],
  '+': [56, 'M 28 26 L 28 78 M 6 52 L 50 52'],
  '=': [56, 'M 8 38 L 48 38 M 8 66 L 48 66'],
  '%': [76, 'M 62 8 L 14 92 M 18 12 L 18 12 M 58 88 L 58 88'],
  '&': [70, 'M 62 92 L 24 38 C 14 22 24 8 36 10 C 50 12 50 30 34 44 C 14 60 12 92 38 92 C 52 92 58 76 60 62'],
  '*': [48, 'M 24 14 L 24 54 M 6 24 L 42 44 M 42 24 L 6 44'],
  '#': [66, 'M 24 14 L 18 90 M 48 14 L 42 90 M 8 38 L 58 38 M 6 66 L 56 66'],
  '<': [48, 'M 40 18 L 10 52 L 40 86'],
  '>': [48, 'M 8 18 L 38 52 L 8 86'],
  '«': [60, 'M 28 22 L 8 52 L 28 82 M 52 22 L 32 52 L 52 82'],
  '»': [60, 'M 8 22 L 28 52 L 8 82 M 32 22 L 52 52 L 32 82'],
  '…': [72, 'M 12 90 L 12 90 M 36 90 L 36 90 M 60 90 L 60 90'],
};

/** Ajouts sur une capitale: marque au-dessus (position relative au centre) ou cédille dessous. */
const ACCENTS: Record<string, (c: number, dy: number) => string> = {
  grave: (c, d) => `M ${c - 10} ${-30 + d} L ${c + 6} ${-14 + d}`,
  acute: (c, d) => `M ${c - 6} ${-14 + d} L ${c + 10} ${-30 + d}`,
  circ: (c, d) => `M ${c - 14} ${-14 + d} L ${c} ${-30 + d} L ${c + 14} ${-14 + d}`,
  tre: (c, d) => `M ${c - 11} ${-22 + d} L ${c - 11} ${-22 + d} M ${c + 11} ${-22 + d} L ${c + 11} ${-22 + d}`,
  cedil: (c) => `M ${c} 98 C ${c + 12} 98 ${c + 12} 114 ${c - 6} 114`,
};

/** Les marques des minuscules descendent jusqu'au-dessus de la hauteur d'x. */
const LOWER_DY = 26;

const ACCENTED: Record<string, [string, keyof typeof ACCENTS, number?]> = {
  À: ['A', 'grave'], Â: ['A', 'circ'], Ä: ['A', 'tre'], Ç: ['C', 'cedil'],
  É: ['E', 'acute'], È: ['E', 'grave'], Ê: ['E', 'circ'], Ë: ['E', 'tre'],
  Î: ['I', 'circ'], Ï: ['I', 'tre'], Ô: ['O', 'circ'], Ö: ['O', 'tre'],
  Ù: ['U', 'grave'], Û: ['U', 'circ'], Ü: ['U', 'tre'], Ÿ: ['Y', 'tre'],
  à: ['a', 'grave', LOWER_DY], â: ['a', 'circ', LOWER_DY], ä: ['a', 'tre', LOWER_DY], ç: ['c', 'cedil'],
  é: ['e', 'acute', LOWER_DY], è: ['e', 'grave', LOWER_DY], ê: ['e', 'circ', LOWER_DY], ë: ['e', 'tre', LOWER_DY],
  î: ['ı', 'circ', LOWER_DY], ï: ['ı', 'tre', LOWER_DY], ô: ['o', 'circ', LOWER_DY], ö: ['o', 'tre', LOWER_DY],
  ù: ['u', 'grave', LOWER_DY], û: ['u', 'circ', LOWER_DY], ü: ['u', 'tre', LOWER_DY], ÿ: ['y', 'tre', LOWER_DY],
};

const cache = new Map<string, Glyph | null>();

/** Caractère à dessiner pour un caractère saisi: apostrophes et tirets unifiés. */
export function normalizeChar(ch: string): string {
  if (ch === '’' || ch === '‘' || ch === '´') return "'";
  if (ch === '“' || ch === '”') return '"';
  if (ch === '–' || ch === '—') return '-';
  return ch;
}

/** Remplace les ligatures par deux lettres et supprime ce que la police ne sait pas écrire. */
export function toFontText(text: string): string {
  let out = '';
  for (const raw of text.normalize('NFC')) {
    const ch = normalizeChar(raw);
    if (ch === 'Œ') out += 'OE';
    else if (ch === 'Æ') out += 'AE';
    else if (ch === 'æ') out += 'ae';
    else if (ch === 'ß') out += 'ss';
    else if (ch === 'ʼ') out += "'";
    else if (ch === '\n' || ch === ' ' || hasGlyph(ch)) out += ch;
    else if (ch === '\t') out += ' ';
  }
  return out;
}

export function hasGlyph(ch: string): boolean {
  return ch in RAW || ch in ACCENTED || ch === 'œ';
}

export function glyphOf(ch: string): Glyph | null {
  if (cache.has(ch)) return cache.get(ch)!;
  let g: Glyph | null = null;
  const raw = RAW[ch];
  if (raw) g = { w: raw[0], shapes: path(raw[1]) };
  else if (ACCENTED[ch]) {
    const [base, accent, dy = 0] = ACCENTED[ch];
    const b = RAW[base];
    // Marque centrée sur la lettre; deux points = deux traits nuls (points ronds).
    g = { w: b[0], shapes: [...path(b[1]), ...path(ACCENTS[accent](b[0] / 2, dy))] };
  } else if (ch === 'œ') {
    // o et e collés: le bord droit de l'un est le bord gauche de l'autre.
    const [ow, od] = RAW.o;
    const [ew, ed] = RAW.e;
    const shift = ow - 14;
    g = { w: shift + ew, shapes: [...path(od), ...path(ed).map((s) => ({ ...s, pts: s.pts.map((v, i) => (i % 2 ? v : v + shift)) }))] };
  }
  cache.set(ch, g);
  return g;
}
