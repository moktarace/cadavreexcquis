import { BOX, blob, dot, ellipse, fill, line, mirror, mirrorPts, outside, path, rotate, transform, type Shape } from './geometry';

export const MIMO_DESIGNS = 6;
export const MIMO_EMOTIONS = 6;
export const MIMO_POSES = 6;

export const DESIGN_NAMES = ['Pomme', 'Minou', 'Nounours', 'Lapin', 'Mèche', 'Frange'] as const;
export const EMOTION_NAMES = ['Joie', 'Tristesse', 'Colère', 'Surprise', 'Peur', 'Gêne'] as const;
export const POSE_NAMES = ['Debout', 'Bras levés', 'Course', 'Assis', 'Chute', 'Bras croisés'] as const;

export interface MimoSpec {
  design: number;
  emotion: number;
  pose: number;
}

/** Menton de tous les Mimo: le corps part toujours du même endroit, quelle que soit la tête. */
const CHIN = 67;

interface Face {
  /** Abscisse de chaque œil par rapport au centre, hauteur des yeux et de la bouche. */
  ex: number;
  ey: number;
  my: number;
  /** Coin libre en haut à droite pour les petits signes (goutte, étincelle, veine). */
  mark: [number, number];
}

interface Outfit {
  top: number;
  bottom: number;
  /** Ordonnée du bas du torse (la jupe descend plus bas). */
  base: number;
  dress?: boolean;
}

interface Head {
  shapes: Shape[];
  face: Face;
  outfit: Outfit;
  /** Éléments derrière le corps (queue). */
  extra?: Shape[];
}

function headOf(design: number): Head {
  switch (design) {
    case 1: {
      // Minou: tête large, oreilles pointues, moustaches, petit nez
      const head = blob(50, 41, 34, 26, 2.3);
      return {
        shapes: [
          line(head, 1, true),
          ...path('M 21.5 27 C 19 19 18.5 12 20.5 5.5 C 27 8 33 11.5 39.5 16', 1),
          ...path('M 25.2 18.5 C 24.5 14.5 24.6 11.5 25.4 9.5 C 28 11 30.3 12.6 32.5 14.3', 0.7),
          ...mirror(path('M 21.5 27 C 19 19 18.5 12 20.5 5.5 C 27 8 33 11.5 39.5 16', 1)),
          ...mirror(path('M 25.2 18.5 C 24.5 14.5 24.6 11.5 25.4 9.5 C 28 11 30.3 12.6 32.5 14.3', 0.7)),
          ...path('M 18 47 L 7 44.5 M 18.5 52 L 8 54.5', 0.7),
          ...mirror(path('M 18 47 L 7 44.5 M 18.5 52 L 8 54.5', 0.7)),
          fill(ellipse(50, 47.2, 2.6, 1.9)),
        ],
        face: { ex: 16, ey: 42, my: 53.5, mark: [86, 12] },
        outfit: { top: 7.5, bottom: 9.5, base: 82 },
        extra: path('M 58 82 C 80 86 88 72 78 63', 1),
      };
    }
    case 2: {
      // Nounours: tête ronde, petites oreilles rondes, nez
      const head = blob(50, 37, 31, 30, 2.2);
      const ears = [ellipse(24, 11.5, 9.5, 9.5), ellipse(76, 11.5, 9.5, 9.5)];
      const inner = [ellipse(24.5, 12, 4.6, 4.6), ellipse(75.5, 12, 4.6, 4.6)];
      return {
        shapes: [
          line(head, 1, true),
          ...ears.flatMap((e) => outside(line(e, 1, true), head)),
          ...inner.flatMap((e) => outside(line(e, 0.7, true), head)),
          fill(ellipse(50, 46.8, 3.2, 2.3)),
        ],
        face: { ex: 14, ey: 40.5, my: 52.5, mark: [88, 24] },
        outfit: { top: 9, bottom: 12.5, base: 82 },
      };
    }
    case 3: {
      // Lapin: longues oreilles, petite tête ovale
      const head = blob(50, 43, 27.5, 24, 2.2);
      const ear = (dx: number, tilt: number) => {
        const sh = rotate([line(ellipse(50 + dx, 14, 7, 10.5), 1, true)], tilt, 50 + dx, 22)[0];
        const inn = rotate([line(ellipse(50 + dx, 14.5, 3, 7, 90, 270), 0.7)], tilt, 50 + dx, 22)[0];
        return [...outside(sh, head), inn];
      };
      return {
        shapes: [line(head, 1, true), ...ear(-12, -9), ...ear(12, 9), fill(ellipse(50, 49.4, 2.2, 1.6))],
        face: { ex: 12.5, ey: 45, my: 55.5, mark: [86, 22] },
        outfit: { top: 7, bottom: 9.5, base: 81 },
      };
    }
    case 4: {
      // Mèche: tête en œuf, cheveux en pointes façon manga
      const jaw = path('M 22.5 30 C 20.5 44 28 67 50 67 C 72 67 79.5 44 77.5 30', 1);
      const hair = path(
        'M 22.5 30 C 20 20 24 12 29 5 L 34 13 L 40 2 L 46.5 11.5 L 54 2 L 60.5 11.5 L 66 2 L 71 13 C 76 20 80 24 77.5 30 L 71 25 L 64.5 33 L 57.5 25 L 50 33.5 L 42.5 25 L 35.5 33 L 29 25 Z',
        1,
      );
      return {
        shapes: [...jaw, ...hair],
        face: { ex: 13, ey: 44, my: 55, mark: [88, 30] },
        outfit: { top: 8, bottom: 10, base: 82 },
      };
    }
    case 5: {
      // Frange: coupe au carré, mèche sur le front
      const jaw = path('M 25 52 C 26 62 37 67 50 67 C 63 67 74 62 75 52', 1);
      const hair = path(
        'M 25 52 C 15 44 13 20 30 9 C 40 3 60 3 70 9 C 87 20 85 44 75 52 C 77 44 76 36 74 31 C 63 33 56 27 52 18 C 47 28 37 33 26 31 C 24 36 23 44 25 52 Z',
        1,
      );
      return {
        shapes: [...jaw, ...hair],
        face: { ex: 14, ey: 43.5, my: 54, mark: [90, 22] },
        outfit: { top: 7.5, bottom: 14, base: 84, dress: true },
      };
    }
    default: {
      // Pomme: tête ronde, petite pousse sur le dessus
      const head = blob(50, 36.5, 32, 30.5, 2.25);
      return {
        shapes: [line(head, 1, true), ...path('M 50 6.6 C 49 1.8 42.5 2 43.5 5.8', 1), ...path('M 50 6.6 C 52 2.2 58.5 3.2 57.5 6.2', 1)],
        face: { ex: 14.5, ey: 41, my: 52, mark: [88, 16] },
        outfit: { top: 8, bottom: 10.5, base: 82 },
      };
    }
  }
}

const both = (shapes: Shape[]): Shape[] => [...shapes, ...mirror(shapes)];

/** Visage: yeux, sourcils, bouche et petits signes d'une émotion, placés selon la tête. */
function faceOf(emotion: number, f: Face): Shape[] {
  const { ex, ey, my } = f;
  const L = 50 - ex;
  const R = 50 + ex;
  const [mx, mky] = f.mark;
  const oval = (x: number, y: number, rx: number, ry: number) => fill(ellipse(x, y, rx, ry, 0, 360, 24));
  const shine = (x: number, y: number, r = 1.2): Shape => ({ k: 'hole', pts: ellipse(x + 1.2, y - 1.7, r, r, 0, 360, 12), min: 84 });
  const hatch = (x: number, y: number): Shape[] => [
    line([x - 3.5, y + 2, x - 1, y - 2], 0.7),
    line([x - 0.5, y + 2, x + 2, y - 2], 0.7),
    line([x + 2.5, y + 2, x + 5, y - 2], 0.7),
  ];
  const drop = (x: number, y: number, s = 1): Shape[] => path(`M ${x} ${y - 4.2 * s} C ${x - 3 * s} ${y} ${x - 3.4 * s} ${y + 3.6 * s} ${x} ${y + 3.6 * s} C ${x + 3.4 * s} ${y + 3.6 * s} ${x + 3 * s} ${y} ${x} ${y - 4.2 * s} Z`, 0.8);

  switch (emotion) {
    case 1: // tristesse: gros yeux brillants, sourcils tombants, larme, moue
      return [
        oval(L, ey, 3.5, 4.8),
        oval(R, ey, 3.5, 4.8),
        shine(L, ey, 1.5),
        shine(R, ey, 1.5),
        ...path(`M ${L - 6} ${ey - 8} L ${L + 4.5} ${ey - 11.5}`, 1.1),
        ...path(`M ${R + 6} ${ey - 8} L ${R - 4.5} ${ey - 11.5}`, 1.1),
        ...path(`M ${L - 0.5} ${ey + 8} C ${L - 3.4} ${ey + 11} ${L + 2.4} ${ey + 14} ${L - 0.5} ${ey + 8} Z`, 0.8),
        ...path(`M 44.5 ${my + 3.8} Q 50 ${my - 2.6} 55.5 ${my + 3.8}`, 1),
      ];
    case 2: // colère: regard dur, sourcils obliques, dents serrées, veine
      return [
        oval(L, ey + 1.2, 3, 3.5),
        oval(R, ey + 1.2, 3, 3.5),
        ...path(`M ${L - 7} ${ey - 9.5} L ${L + 5.5} ${ey - 4.2}`, 1.25),
        ...path(`M ${R + 7} ${ey - 9.5} L ${R - 5.5} ${ey - 4.2}`, 1.25),
        ...path(`M 43.5 ${my - 0.5} L 56.5 ${my - 0.5} L 56.5 ${my + 5.5} L 43.5 ${my + 5.5} Z`, 1),
        ...path(`M 50 ${my - 0.5} L 50 ${my + 5.5}`, 0.7),
        ...path(`M ${mx - 5.5} ${mky - 1.6} L ${mx - 1.6} ${mky - 1.6} L ${mx - 1.6} ${mky - 5.5} M ${mx + 5.5} ${mky - 1.6} L ${mx + 1.6} ${mky - 1.6} L ${mx + 1.6} ${mky - 5.5} M ${mx - 5.5} ${mky + 1.6} L ${mx - 1.6} ${mky + 1.6} L ${mx - 1.6} ${mky + 5.5} M ${mx + 5.5} ${mky + 1.6} L ${mx + 1.6} ${mky + 1.6} L ${mx + 1.6} ${mky + 5.5}`, 1.05),
      ];
    case 3: // surprise: yeux ronds, sourcils hauts, bouche en O, point d'exclamation
      return [
        line(ellipse(L, ey, 5.2, 6.4), 0.95, true),
        line(ellipse(R, ey, 5.2, 6.4), 0.95, true),
        dot(L, ey + 0.5, 1.9),
        dot(R, ey + 0.5, 1.9),
        ...path(`M ${L - 4.5} ${ey - 12} Q ${L} ${ey - 15.5} ${L + 4.5} ${ey - 12}`, 1),
        ...path(`M ${R - 4.5} ${ey - 12} Q ${R} ${ey - 15.5} ${R + 4.5} ${ey - 12}`, 1),
        line(ellipse(50, my + 3.2, 3.5, 4.5), 1, true),
        line([mx, mky - 6, mx, mky + 1.5], 1.35),
        dot(mx, mky + 5.5, 1.5),
      ];
    case 4: // peur: yeux écarquillés, sourcils inquiets, bouche tremblante, goutte, frissons
      return [
        line(ellipse(L, ey, 4.9, 6), 0.95, true),
        line(ellipse(R, ey, 4.9, 6), 0.95, true),
        dot(L + 0.6, ey + 1, 1.5),
        dot(R - 0.6, ey + 1, 1.5),
        ...path(`M ${L - 5.5} ${ey - 9.5} L ${L + 4.5} ${ey - 13}`, 1),
        ...path(`M ${R + 5.5} ${ey - 9.5} L ${R - 4.5} ${ey - 13}`, 1),
        ...path(`M 42 ${my + 2.5} Q 44.5 ${my - 1.8} 47 ${my + 2.5} Q 49.5 ${my + 6.8} 52 ${my + 2.5} Q 54.5 ${my - 1.8} 58 ${my + 2.5}`, 1),
        ...drop(mx, mky + 2, 1.05),
      ];
    case 5: // gêne: regard fuyant, joues rouges (hachures), sourire tremblant, goutte
      return [
        oval(L - 1.8, ey + 1, 2.7, 3.4),
        oval(R - 1.8, ey + 1, 2.7, 3.4),
        ...path(`M ${L - 6} ${ey - 7} Q ${L - 1.5} ${ey - 9.5} ${L + 3} ${ey - 7.5}`, 0.8),
        ...path(`M ${R - 3} ${ey - 7.5} Q ${R + 1.5} ${ey - 9.5} ${R + 6} ${ey - 7}`, 0.8),
        ...hatch(L - 6.5, ey + 9.2),
        ...hatch(R + 3.5, ey + 9.2),
        ...path(`M 44.5 ${my + 1.5} Q 47.2 ${my - 1.8} 50 ${my + 1.5} Q 52.8 ${my + 4.8} 55.5 ${my + 1.5}`, 1),
        ...drop(mx, mky + 2, 1.05),
      ];
    default: {
      // joie: yeux en « ^ », grande bouche ouverte, joues rosies, étincelle
      const eye = (x: number) => path(`M ${x - 5} ${ey + 2} Q ${x} ${ey - 6.4} ${x + 5} ${ey + 2}`, 1.15);
      return [
        ...eye(L),
        ...eye(R),
        ...path(`M 42.5 ${my - 1.5} Q 50 ${my + 1} 57.5 ${my - 1.5} Q 55.5 ${my + 11} 50 ${my + 11} Q 44.5 ${my + 11} 42.5 ${my - 1.5} Z`, 1),
        ...path(`M 46.2 ${my + 8.2} Q 50 ${my + 4.6} 53.8 ${my + 8.2}`, 0.8),
        ...hatch(L - 6.5, ey + 8),
        ...hatch(R + 3.5, ey + 8),
        ...path(`M ${mx} ${mky - 5.2} Q ${mx} ${mky} ${mx + 5.2} ${mky} Q ${mx} ${mky} ${mx} ${mky + 5.2} Q ${mx} ${mky} ${mx - 5.2} ${mky} Q ${mx} ${mky} ${mx} ${mky - 5.2} Z`, 0.9),
      ];
    }
  }
}

/** Torse en U ouvert sous le menton, les jambes et les bras s'y attachent. */
function torso(o: Outfit): Shape[] {
  const l = 50 - o.top;
  const r = 50 + o.top;
  const lb = 50 - o.bottom;
  const rb = 50 + o.bottom;
  const out = path(`M ${l} ${CHIN - 0.8} Q ${l - 1} ${(CHIN + o.base) / 2} ${lb} ${o.base} Q 50 ${o.base + 2.6} ${rb} ${o.base} Q ${r + 1} ${(CHIN + o.base) / 2} ${r} ${CHIN - 0.8}`, 1);
  return o.dress ? [...out, ...path(`M ${lb} ${o.base} L ${lb - 1.5} ${o.base + 1.5} M ${rb} ${o.base} L ${rb + 1.5} ${o.base + 1.5}`, 1)] : out;
}

function legs(o: Outfit, kind: 'stand' | 'wide' | 'run' | 'fall'): Shape[] {
  const y = o.dress ? o.base + 1.5 : o.base;
  const hip = o.dress ? 5.5 : 4.6;
  switch (kind) {
    case 'run':
      return [
        line([50 + 2.5, y, 61, 89, 58.5, 96, 65, 97]),
        line([50 - 3, y, 38, 88.5, 31, 84.5, 26.5, 86.5]),
        ...path('M 3 71 L 15 71 M 6 79 L 17 79 M 3 87 L 12 87', 0.7),
      ];
    case 'fall':
      return [line([50 - hip, y, 39, 89, 31, 87]), line([50 + hip, y, 62, 90, 70, 85])];
    case 'wide':
      return [line([50 - hip, y, 41, 93, 36, 96.5]), line([50 + hip, y, 59, 93, 64, 96.5])];
    default:
      return [line([50 - hip, y, 44, 94.5, 39.5, 96.5]), line([50 + hip, y, 56, 94.5, 60.5, 96.5])];
  }
}

const hand = (x: number, y: number) => dot(x, y, 2.5);

function bodyOf(pose: number, o: Outfit): Shape[] {
  const sh = 50 - o.top - 0.5;
  const sy = 69.5;
  switch (pose) {
    case 1: // bras levés
      return [
        ...torso(o),
        ...legs(o, 'wide'),
        ...both([line([sh, sy, 27, 70.5, 17.5, 55.5]), hand(15.8, 52.6)]),
      ];
    case 2: // course
      return [
        ...torso(o),
        ...legs(o, 'run'),
        line([sh, sy, 33, 71.5, 29, 65]),
        hand(28, 63.2),
        line([50 + o.top + 0.5, sy, 66, 73, 73, 79.5]),
        hand(74.2, 81),
      ];
    case 3: {
      // assis en tailleur
      const sit = { ...o, base: o.base - 1 };
      return [
        ...torso(sit),
        ...path('M 33 91 C 32 84 40 83 50 85 C 60 83 68 84 67 91 C 66 97.5 56 97.5 50 96.5 C 44 97.5 34 97.5 33 91 Z', 1),
        ...path('M 41 93.5 Q 50 89 59 93.5', 0.8),
        ...both([line([sh, sy, 35.5, 76, 35, 85]), hand(34.7, 86.6)]),
      ];
    }
    case 4: {
      // chute: corps basculé, bras jetés de chaque côté, jambes en désordre
      const parts: Shape[] = [
        ...torso(o),
        ...legs(o, 'fall'),
        line([sh, sy, 28, 70, 19, 72.5]),
        hand(17.4, 73),
        line([50 + o.top + 0.5, sy, 70, 66, 81, 55]),
        hand(82.6, 52.6),
      ];
      return [
        ...rotate(parts, 20, 50, CHIN - 1),
        ...path('M 6 16 L 6 30 M 12 11 L 12 27', 0.7),
      ];
    }
    case 5: // bras croisés
      return [
        ...torso(o),
        ...legs(o, 'wide'),
        line([sh + 0.5, sy, 43, 75, 60, 77]),
        hand(61.6, 77.2),
        line([100 - sh - 0.5, sy, 57, 75, 40, 77]),
        hand(38.4, 77.2),
      ];
    default: // debout
      return [
        ...torso(o),
        ...legs(o, 'stand'),
        ...both([line([sh, sy, 34, 74, 33.5, 82]), hand(33.2, 83.8)]),
      ];
  }
}

const cache = new Map<number, Shape[]>();

/** Dessin complet d'un Mimo dans la boîte 100 × 100. Mémoïsé: la combinaison est la seule donnée du personnage. */
export function mimoShapes(spec: MimoSpec): Shape[] {
  const key = (spec.design * MIMO_EMOTIONS + spec.emotion) * MIMO_POSES + spec.pose;
  let shapes = cache.get(key);
  if (!shapes) {
    const head = headOf(spec.design);
    const face = faceOf(spec.emotion, head.face);
    const upper = [...head.shapes, ...face];
    shapes = [...(head.extra ?? []), ...bodyOf(spec.pose, head.outfit), ...upper];
    if (spec.pose === 4) {
      // chute: la tête penche aussi, un peu rapetissée pour rester dans la boîte
      shapes = [...(head.extra ?? []), ...bodyOf(4, head.outfit), ...transform(rotate(upper, -4, 50, 40), (x, y) => [50 + (x - 50) * 0.96, CHIN + (y - CHIN) * 0.96])];
    }
    cache.set(key, shapes);
  }
  return shapes;
}

export const MIMO_BOX = BOX;
export { mirrorPts };
