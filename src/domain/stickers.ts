/**
 * Tampons narratifs et récompenses: fichier de configuration centralisé.
 * Les seuils d'ici sont la référence; le serveur les applique (table `sticker_rules`, `reward_config`).
 * Après une modification: `npm run db:stickers` affiche la commande SQL de synchronisation à exécuter.
 */

export const REWARD_CONFIG = {
  /** Nombre de tampons posés au plus par case (réglage de l'éditeur, non vérifié côté serveur). */
  maxStampsPerCase: 3,
  /** Agrandissements entiers autorisés (jamais de flou) et agrandissement initial. */
  stampScales: [1, 2, 3, 4] as readonly number[],
  defaultStampScale: 2,
  /** Une célébration « Ton dessin a inspiré N histoires » à chacun de ces totaux, pour une même case 1. */
  inspiredMilestones: [3, 5, 10] as readonly number[],
};

export type StickerFamily = 'base' | 'collective' | 'inspired';

export interface StickerDef {
  id: string;
  name: string;
  family: StickerFamily;
  /** Histoires nécessaires (absent pour les tampons de départ). */
  threshold?: number;
  /** Phrase affichée au déblocage. */
  blurb: string;
  /**
   * Pixel art, une chaîne par rangée, même largeur partout. `.` = transparent, sinon l'initiale de la palette
   * du dessin: w blanc, k noir, r rouge, y jaune, g vert, b bleu.
   */
  art: readonly string[];
}

export const STICKERS: readonly StickerDef[] = [
  {
    id: 'heart', name: 'Cœur', family: 'base', blurb: 'Une histoire d’amour ?',
    art: [
      '..kkkk....kkkk..',
      '.krrrrk..krrrrk.',
      'krrwwrrkkrrrrrrk',
      'krwwrrrrrrrrrrrk',
      'krwrrrrrrrrrrrrk',
      'krrrrrrrrrrrrrrk',
      '.krrrrrrrrrrrrk.',
      '..krrrrrrrrrrk..',
      '...krrrrrrrrk...',
      '....krrrrrrk....',
      '.....krrrrk.....',
      '......krrk......',
      '.......kk.......',
    ],
  },
  {
    id: 'tear', name: 'Larme', family: 'base', blurb: 'Quelqu’un a du chagrin.',
    art: [
      '.......kk.......',
      '.......kk.......',
      '......kbbk......',
      '......kbbk......',
      '.....kbbbbk.....',
      '.....kbwbbk.....',
      '....kbbwbbbk....',
      '....kbbwbbbk....',
      '....kbbbbbbk....',
      '....kbbbbbbk....',
      '.....kbbbbk.....',
      '......kkkk......',
    ],
  },
  {
    id: 'star', name: 'Étoile', family: 'base', blurb: 'Quelque chose brille.',
    art: [
      '.......kk.......',
      '......kyyk......',
      '......kyyk......',
      '.....kyyyyk.....',
      'kkkkkkyyyykkkkkk',
      'kyyyyyyyyyyyyyyk',
      '.kyyyyyyyyyyyyk.',
      '..kyyyyyyyyyyk..',
      '...kyyyyyyyyk...',
      '...kyyyyyyyyk...',
      '..kyyyyyyyyyyk..',
      '..kyyyykkyyyyk..',
      '.kyyyyk..kyyyyk.',
      '.kkkkk....kkkkk.',
    ],
  },
  {
    id: 'crown', name: 'Couronne', family: 'base', blurb: 'Un nouveau statut.',
    art: [
      '..k....kk....k..',
      '.kyk..kyyk..kyk.',
      '.kyyk.kyyk.kyyk.',
      '.kyyykkyyykkyyk.',
      '.kyyyyyyyyyyyyk.',
      '.kyyyyyrryyyyyk.',
      '.kyyyyyyyyyyyyk.',
      '.kkkkkkkkkkkkkk.',
    ],
  },
  {
    id: 'impact', name: 'Petit impact', family: 'base', blurb: 'Pouf ! Quelque chose vient de se passer.',
    art: [
      '.k.....kk.....k.',
      '..k....kk....k..',
      '...k...kk...k...',
      '....k..kk..k....',
      '.....k.kk.k.....',
      '......kyyk......',
      'kkkkkkyyyykkkkkk',
      'kkkkkkyyyykkkkkk',
      '......kyyk......',
      '.....k.kk.k.....',
      '....k..kk..k....',
      '...k...kk...k...',
      '..k....kk....k..',
      '.k.....kk.....k.',
    ],
  },
  {
    id: 'bolt', name: 'Éclair', family: 'base', blurb: 'Ça va secouer.',
    art: [
      '.........kkkk...',
      '........kyyyk...',
      '.......kyyyk....',
      '......kyyyk.....',
      '.....kyyyk......',
      '....kyyyyyyyk...',
      '...kkkkkyyyk....',
      '........kyyk....',
      '.......kyyk.....',
      '......kyyk......',
      '.....kyk........',
      '....kyk.........',
      '....kk..........',
    ],
  },
  {
    id: 'explosion', name: 'L’explosion', family: 'collective', threshold: 1,
    blurb: 'Tu as terminé ta première histoire à plusieurs. Tu peux maintenant tout faire sauter !',
    art: [
      '.......kk.......',
      '..k...kyyk...k..',
      '..kk.kyyyyk.kk..',
      '...kkyyrryykk...',
      '.kkyyyrrrryyykk.',
      'kyyyrrrrrrrryyyk',
      '.kkyyrrrrrryykk.',
      '..kyyyrrrryyyk..',
      '.kkyyyyrryyyykk.',
      'kyyykkyyyykkyyyk',
      'kykk..kyyk..kkyk',
      'kk...kyyyyk...kk',
      '.....kk..kk.....',
    ],
  },
  {
    id: 'speed', name: 'L’effet de vitesse', family: 'collective', threshold: 3,
    blurb: 'Trois histoires terminées ensemble. Quelqu’un file à toute allure !',
    art: [
      '..kkkkkkkkkk....',
      '................',
      '......kkkkkkkkkk',
      '................',
      '.kkkkkkkkk......',
      '................',
      '.........kkkkkkk',
      '................',
      'kkkkkkk.........',
    ],
  },
  {
    id: 'smoke', name: 'Le nuage de fumée', family: 'collective', threshold: 5,
    blurb: 'Cinq histoires terminées ensemble. Il s’est passé quelque chose… et ça sent le roussi.',
    art: [
      '.....kkkk.......',
      '...kkwwwwkkkk...',
      '..kwwwwwwwwwwkk.',
      '.kwwwwwwwwwwwwwk',
      'kwwwwwwwwwwwwwwk',
      'kwwwwwwwwwwwwwwk',
      '.kwwwwwwwwwwwwk.',
      '..kkkkkkkkkkkk..',
    ],
  },
  {
    id: 'ghost', name: 'Le fantôme', family: 'collective', threshold: 10,
    blurb: 'Dix histoires terminées ensemble. Quelqu’un hante maintenant tes dessins.',
    art: [
      '.....kkkkkk.....',
      '...kkwwwwwwkk...',
      '..kwwwwwwwwwwk..',
      '.kwwwwwwwwwwwwk.',
      '.kwwkkwwwwkkwwk.',
      '.kwwkkwwwwkkwwk.',
      '.kwwwwwwwwwwwwk.',
      '.kwwwwwkkwwwwwk.',
      '.kwwwwwwwwwwwwk.',
      '.kwwwwwwwwwwwwk.',
      '.kwwwwwwwwwwwwk.',
      '.kwkkwwkkwwkkwk.',
      '..k..kk..kk..k..',
    ],
  },
  {
    id: 'mustache', name: 'La moustache', family: 'inspired', threshold: 1,
    blurb: 'Une histoire est née de ta première case. Tu peux maintenant ajouter une moustache à tes dessins !',
    art: [
      '.....kk..kk.....',
      '..kkkkkkkkkkkk..',
      '.kkkkkkkkkkkkkk.',
      'kkkkkkkkkkkkkkkk',
      'kkkk..kkkk..kkkk',
      '.kk..........kk.',
    ],
  },
  {
    id: 'glasses', name: 'Les lunettes', family: 'inspired', threshold: 3,
    blurb: 'Trois histoires sont nées de tes premières cases. Qui se cache derrière ces lunettes ?',
    art: [
      '.kkkkk....kkkkk.',
      'kwwwwwk..kwwwwwk',
      'kwbbwwkkkkwwbbwk',
      'kwbwwwk..kwwwbwk',
      'kwwwwwk..kwwwwwk',
      '.kkkkk....kkkkk.',
    ],
  },
  {
    id: 'hat', name: 'Le chapeau extravagant', family: 'inspired', threshold: 5,
    blurb: 'Cinq histoires sont nées de tes premières cases. Voici un chapeau digne d’elles !',
    art: [
      '......kkkkkk....',
      '.....kggggggk...',
      '.....kggggggk...',
      '.....kggggggk...',
      '.....krrrrrrk...',
      '.....krrrrrrk...',
      '.kkkkkkkkkkkkkk.',
      '.kggggggggggggk.',
      '..kkkkkkkkkkkk..',
    ],
  },
  {
    id: 'mask', name: 'Le masque mystérieux', family: 'inspired', threshold: 10,
    blurb: 'Dix histoires sont nées de tes premières cases. Qui es-tu vraiment ?',
    art: [
      '..kkkkkkkkkkkk..',
      '.kkkkkkkkkkkkkk.',
      'kkkkkkkkkkkkkkkk',
      'kkk..kkkkkk..kkk',
      'kkk..kkkkkk..kkk',
      '.kkkkkkkkkkkkkk.',
      '..kkkkk..kkkkk..',
    ],
  },
];

export const BASE_STICKER_IDS: readonly string[] = STICKERS.filter((s) => s.family === 'base').map((s) => s.id);

export const stickerById = (id: string): StickerDef | undefined => STICKERS.find((s) => s.id === id);

/** Tampons utilisables: ceux de départ, plus ceux que le serveur a débloqués. */
export function unlockedSet(serverUnlocked: readonly string[]): Set<string> {
  return new Set([...BASE_STICKER_IDS, ...serverUnlocked]);
}

export function unlockCondition(def: StickerDef): string {
  const n = def.threshold ?? 0;
  if (def.family === 'collective') return `Termine ${n} histoire${n > 1 ? 's' : ''} à plusieurs`;
  if (def.family === 'inspired') return `${n} histoire${n > 1 ? 's' : ''} née${n > 1 ? 's' : ''} de tes premières cases`;
  return 'Disponible dès le départ';
}

/** Texte de déblocage: « Trois histoires sont nées de tes premières cases… ». */
export function unlockMessage(def: StickerDef): string {
  return def.blurb;
}

// ───────────── Pixel art ─────────────

/** Indices de palette de l'éditeur (src/editor/palette.ts). */
const PALETTE_INDEX: Record<string, number> = { w: 0, k: 1, r: 2, y: 3, g: 4, b: 5 };
export const TRANSPARENT = 255;

export interface Sprite {
  w: number;
  h: number;
  /** Indice de palette par pixel, ou TRANSPARENT. */
  pixels: Uint8Array;
}

export function parseArt(art: readonly string[]): Sprite {
  const w = art[0]?.length ?? 0;
  const pixels = new Uint8Array(w * art.length).fill(TRANSPARENT);
  art.forEach((row, y) => {
    if (row.length !== w) throw new Error(`Rangée ${y} de largeur ${row.length}, attendu ${w}`);
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const index = PALETTE_INDEX[ch];
      if (index === undefined) throw new Error(`Couleur inconnue « ${ch} »`);
      pixels[y * w + x] = index;
    });
  });
  return { w, h: art.length, pixels };
}

/** Agrandissement par multiplication entière des pixels: aucun flou, aucune couleur nouvelle. */
export function scaleSprite(sprite: Sprite, scale: number): Sprite {
  if (!Number.isInteger(scale) || scale < 1) throw new Error('Agrandissement entier attendu');
  const w = sprite.w * scale;
  const h = sprite.h * scale;
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) pixels[y * w + x] = sprite.pixels[Math.floor(y / scale) * sprite.w + Math.floor(x / scale)];
  }
  return { w, h, pixels };
}

/** Commande SQL qui applique cette configuration au serveur (voir README). */
export function syncSql(): string {
  const rules = STICKERS.filter((s) => s.family !== 'base').map((s) => ({ id: s.id, family: s.family, threshold: s.threshold }));
  return `select public.sync_reward_rules('${JSON.stringify(rules)}'::jsonb, '{${REWARD_CONFIG.inspiredMilestones.join(',')}}'::int[]);`;
}
