import { ellipse, line, outside, path, rotate, type Shape } from '../mimo/geometry';

/**
 * Décors: de petits lieux au trait noir, chacun composé d'éléments indépendants (on peut en retirer avant de placer).
 * Boîte de 100 × 75 (4:3, comme la toile), aucune couleur, aucun remplissage: les lieux s'écrivent en quelques traits.
 */
export const DECOR_W = 100;
export const DECOR_H = 75;
/** Épaisseur de trait de base, en unités du décor. */
export const DECOR_STROKE = 1.15;

export interface DecorElement {
  id: string;
  name: string;
  shapes: Shape[];
  /** Encombrement du dessin (trait compris), en unités du décor: sert de zone de sélection. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DecorPlace {
  id: string;
  name: string;
  elements: DecorElement[];
}

function el(id: string, name: string, ...groups: (Shape | Shape[])[]): DecorElement {
  const shapes = groups.flat();
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of shapes) {
    for (let i = 0; i < s.pts.length; i += 2) {
      x0 = Math.min(x0, s.pts[i]);
      x1 = Math.max(x1, s.pts[i]);
      y0 = Math.min(y0, s.pts[i + 1]);
      y1 = Math.max(y1, s.pts[i + 1]);
    }
  }
  const r = DECOR_STROKE / 2;
  return { id, name, shapes, x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
}

const P = (d: string) => path(d);
const circle = (cx: number, cy: number, r: number) => line(ellipse(cx, cy, r, r, 0, 360, 40), undefined, true);
const dotAt = (x: number, y: number) => P(`M ${x} ${y} L ${x} ${y}`);
const sparkle = (x: number, y: number, r: number) =>
  P(`M ${x} ${y - r} Q ${x} ${y} ${x + r} ${y} Q ${x} ${y} ${x} ${y + r} Q ${x} ${y} ${x - r} ${y} Q ${x} ${y} ${x} ${y - r} Z`);

/** Nuage de feuillage: une succession de bosses arrondies autour d'un centre. */
function crown(cx: number, cy: number, rx: number, ry: number, bumps = 7): Shape[] {
  const pts: string[] = [];
  const n = bumps;
  const at = (k: number, scale: number) => {
    const a = (k / n) * Math.PI * 2 - Math.PI / 2;
    return [cx + rx * scale * Math.cos(a), cy + ry * scale * Math.sin(a)];
  };
  const [sx, sy] = at(0, 1);
  pts.push(`M ${sx.toFixed(2)} ${sy.toFixed(2)}`);
  for (let k = 0; k < n; k++) {
    const [mx, my] = at(k + 0.5, 1.28);
    const [ex, ey] = at(k + 1, 1);
    pts.push(`Q ${mx.toFixed(2)} ${my.toFixed(2)} ${ex.toFixed(2)} ${ey.toFixed(2)}`);
  }
  return P(`${pts.join(' ')} Z`);
}

const tree = (id: string, name: string, x: number, ground: number, h: number): DecorElement => {
  const rx = h * 0.3;
  const ry = h * 0.28;
  const trunkTop = ground - h * 0.68 + ry * 1.02;
  return el(
    id,
    name,
    P(`M ${x - 2} ${ground} L ${x - 2} ${trunkTop} M ${x + 2} ${ground} L ${x + 2} ${trunkTop}`),
    crown(x, ground - h * 0.68, rx, ry),
  );
};

const chair = (x: number, ground: number, facing: 1 | -1): string =>
  `M ${x} ${ground - 24} L ${x} ${ground} M ${x} ${ground - 11} L ${x + 11 * facing} ${ground - 11} L ${x + 11 * facing} ${ground}`;

const GROUND = 62;

const PLACES: DecorPlace[] = [
  {
    id: 'chambre',
    name: 'Chambre',
    elements: [
      el('sol', 'Sol', P(`M 3 ${GROUND} L 97 ${GROUND}`)),
      el('fenetre', 'Fenêtre', P('M 18 10 L 40 10 L 40 32 L 18 32 Z M 29 10 L 29 32 M 18 21 L 40 21 M 15 32 L 43 32')),
      el('lit', 'Lit', P('M 6 36 L 6 62 M 6 50 L 52 50 L 52 57 L 6 57 M 9 44 C 9 40 21 40 21 44 L 21 50 M 24 50 Q 38 44 52 49 M 50 57 L 50 62')),
      el('armoire', 'Armoire', P('M 64 20 L 92 20 L 92 62 L 64 62 Z M 78 20 L 78 62 M 74 38 L 74 44 M 82 38 L 82 44')),
    ],
  },
  {
    id: 'cuisine',
    name: 'Cuisine',
    elements: [
      el('sol', 'Sol', P(`M 3 ${GROUND} L 97 ${GROUND}`)),
      el('frigo', 'Réfrigérateur', P('M 6 8 L 28 8 L 28 62 L 6 62 Z M 6 26 L 28 26 M 10 14 L 10 20 M 10 31 L 10 40')),
      el('evier', 'Évier', P('M 34 40 L 64 40 L 64 62 L 34 62 Z M 49 40 L 49 62 M 38 40 L 40 34 L 56 34 L 58 40 M 61 40 L 61 28 Q 61 25 55 25')),
      el('table', 'Table', P('M 68 44 L 98 44 L 98 47 L 68 47 Z M 72 47 L 72 62 M 94 47 L 94 62')),
    ],
  },
  {
    id: 'rue',
    name: 'Rue',
    elements: [
      el('trottoir', 'Trottoir', P('M 3 58 L 97 58 M 3 66 L 97 66 M 22 58 L 20 66 M 48 58 L 46 66 M 74 58 L 72 66')),
      el('facade', 'Façade', P('M 4 8 L 42 8 L 42 58 L 4 58 Z M 10 14 L 20 14 L 20 26 L 10 26 Z M 26 14 L 36 14 L 36 26 L 26 26 Z M 10 32 L 20 32 L 20 44 L 10 44 Z M 26 58 L 26 38 L 36 38 L 36 58')),
      el('lampadaire', 'Lampadaire', P('M 56 58 L 56 15 Q 56 9 63 9 M 53 58 L 59 58 M 61 9 L 69 9 L 67 14 L 63 14 Z')),
      el('maison', 'Maison', P('M 74 30 L 96 30 L 96 58 L 74 58 Z M 72 30 L 85 19 L 98 30 M 82 58 L 82 46 L 90 46 L 90 58')),
    ],
  },
  {
    id: 'foret',
    name: 'Forêt',
    elements: [
      el('sol', 'Sol', P('M 3 62 Q 12 58 22 62 Q 32 66 42 62 Q 52 58 62 62 Q 72 66 82 62 Q 90 58 97 61')),
      tree('arbre1', 'Arbre', 18, 62, 40),
      tree('arbre2', 'Grand arbre', 50, 62, 56),
      tree('arbre3', 'Petit arbre', 86, 62, 32),
      el('buisson', 'Buisson', P('M 64 62 Q 61 54 68 54 Q 69 48 75 51 Q 82 49 81 57 Q 85 62 80 62')),
    ],
  },
  {
    id: 'plage',
    name: 'Plage',
    elements: [
      el('soleil', 'Soleil', circle(18, 13, 5), P('M 18 3 L 18 5 M 18 21 L 18 23 M 8 13 L 10 13 M 26 13 L 28 13 M 11 6 L 12.5 7.5 M 24 19 L 25.5 20.5 M 25.5 6 L 24 7.5 M 12.5 19 L 11 20.5')),
      el('mer', 'Mer', P('M 3 28 L 97 28 M 14 35 Q 17 32 20 35 Q 23 38 26 35 M 44 37 Q 47 34 50 37 Q 53 40 56 37 M 76 34 Q 79 31 82 34 Q 85 37 88 34')),
      el('vague', 'Vague', P('M 3 48 Q 10 42 18 48 Q 26 42 34 48 Q 42 42 50 48 Q 58 42 66 48 Q 74 42 82 48 Q 90 42 97 48')),
      el('sable', 'Sable', P('M 3 56 Q 25 53 48 56 Q 72 59 97 55'), dotAt(14, 64), dotAt(30, 68), dotAt(54, 66), dotAt(86, 69)),
      el('parasol', 'Parasol', P('M 70 34 L 66 68 M 50 38 Q 70 8 90 38 Q 85 34 80 38 Q 75 34 70 38 Q 65 34 60 38 Q 55 34 50 38 Z')),
    ],
  },
  {
    id: 'classe',
    name: 'Classe',
    elements: [
      el('sol', 'Sol', P('M 3 64 L 97 64')),
      el('tableau', 'Tableau', P('M 10 8 L 66 8 L 66 36 L 10 36 Z M 7 39 L 69 39 M 16 16 L 38 16 M 16 23 L 30 23 M 16 30 L 44 30')),
      el('horloge', 'Horloge', circle(84, 17, 8), P('M 84 17 L 84 11 M 84 17 L 89 19')),
      el('bureau', 'Bureau', P('M 10 48 L 44 48 L 44 52 L 10 52 Z M 14 52 L 14 64 M 40 52 L 40 64 M 18 48 L 18 42 L 28 42 L 28 48')),
      el('chaise', 'Chaise', P('M 56 44 L 56 64 M 56 55 L 72 55 L 72 64')),
    ],
  },
  {
    id: 'bureau',
    name: 'Bureau',
    elements: [
      el('sol', 'Sol', P(`M 3 ${GROUND} L 97 ${GROUND}`)),
      el('table', 'Table', P('M 6 46 L 56 46 L 56 50 L 6 50 Z M 10 50 L 10 62 M 52 50 L 52 62')),
      el('ordinateur', 'Ordinateur', P('M 18 22 L 44 22 L 44 40 L 18 40 Z M 31 40 L 31 46 M 25 46 L 37 46')),
      el('etagere', 'Étagère', P('M 66 10 L 94 10 L 94 62 L 66 62 Z M 66 28 L 94 28 M 66 46 L 94 46 M 70 28 L 70 18 L 75 18 L 75 28 M 78 28 L 78 14 L 83 14 L 83 28 M 85 28 L 87 20 L 91 20 L 91 28 M 70 46 L 70 38 L 82 38 L 82 46')),
    ],
  },
  {
    id: 'parc',
    name: 'Parc',
    elements: [
      el('sol', 'Pelouse', P('M 3 62 L 97 62 M 12 62 L 10 57 M 14 62 L 14 56 M 16 62 L 18 57 M 52 62 L 50 58 M 54 62 L 55 58 M 94 62 L 92 58')),
      tree('arbre', 'Arbre', 23, 62, 52),
      el('banc', 'Banc', P('M 40 38 L 66 38 M 40 43 L 66 43 M 41 38 L 41 50 M 65 38 L 65 50 M 38 50 L 68 50 L 68 53 L 38 53 Z M 42 53 L 42 62 M 64 53 L 64 62')),
      el('balancoire', 'Balançoire', P('M 74 62 L 79 14 M 96 62 L 91 14 M 79 14 L 91 14 M 82 14 L 82 44 M 88 14 L 88 44 M 80 44 L 90 44')),
    ],
  },
  (() => {
    const planet = ellipse(60, 38, 17, 17, 0, 360, 48);
    const ring = (a0: number, a1: number) => rotate([line(ellipse(60, 38, 30, 7, a0, a1, 48))], -18, 60, 38)[0];
    return {
      id: 'espace',
      name: 'Espace',
      elements: [
        el('planete', 'Planète', line(planet, undefined, true), ring(0, 180), outside(ring(180, 360), planet)),
        el('lune', 'Lune', P('M 24 40 C 14 40 10 56 22 60 C 15 54 17 45 24 40 Z')),
        el('etoiles1', 'Étoiles', sparkle(14, 14, 5), sparkle(36, 26, 3), dotAt(90, 14), dotAt(48, 8), sparkle(93, 47, 4)),
        el('etoiles2', 'Étoiles', sparkle(92, 62, 5), sparkle(10, 64, 3), dotAt(34, 66), dotAt(26, 22), sparkle(80, 66, 3)),
      ],
    };
  })(),
  {
    id: 'restaurant',
    name: 'Restaurant',
    elements: [
      el('sol', 'Sol', P(`M 3 ${GROUND} L 97 ${GROUND}`)),
      el('lampe', 'Lampe', P('M 28 3 L 28 12 M 21 12 L 35 12 L 31 19 L 25 19 Z')),
      el('chaise1', 'Chaise', P(chair(4, GROUND, 1))),
      el('table', 'Table', line(ellipse(28, 40, 12, 3, 0, 360, 32), undefined, true), P('M 28 43 L 28 62 M 20 62 L 36 62')),
      el('chaise2', 'Chaise', P(chair(53, GROUND, -1))),
      el('comptoir', 'Comptoir', P('M 62 38 L 97 38 L 97 62 L 62 62 Z M 59 38 L 99 38 M 72 44 L 72 58 M 86 44 L 86 58 M 68 38 L 68 29 L 72 29 L 72 38')),
    ],
  },
];

export const DECOR_PLACES: readonly DecorPlace[] = PLACES;
export const DECOR_COUNT = PLACES.length;
