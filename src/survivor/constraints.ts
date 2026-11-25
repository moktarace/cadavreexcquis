/** Table « Les demandes déraisonnables de l'éditeur » (annexe 2 de Manga Relay), traduite: deux dés, 36 consignes. */
export type Phase = 'intro' | 'complication' | 'escalade' | 'denouement';

export const PHASE_LABELS: Record<Phase, string> = {
  intro: 'Introduction',
  complication: 'Complications',
  escalade: 'Escalade',
  denouement: 'Dénouement',
};

export type Level = 'easy' | 'medium' | 'hard';

export const LEVELS: readonly Level[] = ['easy', 'medium', 'hard'];
export const LEVEL_LABELS: Record<Level, string> = { easy: 'Facile', medium: 'Intermédiaire', hard: 'Difficile' };

export interface Constraint {
  /** Les deux dés lus de gauche à droite, par exemple « 31 ». */
  id: string;
  text: string;
  level: Level;
  /** Étapes où la demande peut être proposée (toutes si absent). */
  phases?: readonly Phase[];
  /** Première case où elle peut être proposée. */
  minCase?: number;
}

/** Classement provisoire par difficulté (la récompense en encre est dans config.ts). */
const LEVEL_IDS: Record<Level, readonly string[]> = {
  easy: ['16', '21', '24', '25', '32', '34', '42', '44', '52', '54', '55', '63'],
  medium: ['12', '13', '22', '26', '31', '35', '36', '41', '43', '45', '64', '65'],
  hard: ['11', '14', '15', '23', '33', '46', '51', '53', '56', '61', '62', '66'],
};

/** Éligibilité narrative provisoire: ce qui n'a pas de sens trop tôt ou compliquerait la fin. */
const ELIGIBILITY: Record<string, Pick<Constraint, 'phases' | 'minCase'>> = {
  '12': { minCase: 2 },
  '21': { phases: ['intro', 'complication', 'escalade'] },
  '11': { phases: ['complication', 'escalade'] },
  '14': { phases: ['complication', 'escalade', 'denouement'] },
  '15': { phases: ['complication', 'escalade'] },
  '33': { phases: ['intro', 'complication', 'escalade'] },
  '51': { phases: ['intro', 'complication', 'escalade'] },
  '53': { phases: ['intro', 'complication', 'escalade'] },
  '62': { phases: ['intro', 'complication', 'escalade'] },
  '66': { phases: ['complication', 'escalade'] },
};

const TABLE: Record<string, string> = {
  '11': 'Un personnage révèle un pouvoir caché, ou un nouveau pouvoir s’éveille.',
  '12': 'Un personnage déjà vu dans une case précédente réapparaît.',
  '13': 'Une explosion ou un accident éclate soudain.',
  '14': 'Quelqu’un révèle un secret, ou un personnage montre un côté inattendu.',
  '15': 'Un voyage dans le temps a lieu.',
  '16': 'Quelque chose de désagréable arrive à quelqu’un.',
  '21': 'Un personnage mystérieux, un méchant par exemple, apparaît.',
  '22': 'Un objet magique est trouvé.',
  '23': 'Beaucoup de temps passe dans l’histoire.',
  '24': 'Un personnage chante une chanson.',
  '25': 'Un personnage arrive dans une tenue ridicule.',
  '26': 'Rencontre avec une créature inconnue: fantôme, extraterrestre, cryptide…',
  '31': 'Un personnage se transforme.',
  '32': 'Un animal entre dans l’histoire.',
  '33': 'Voyage vers un monde extraordinaire: autre monde, espace, terre cachée, passé ou futur.',
  '34': 'Change la météo de la scène: pluie, neige…',
  '35': 'Le héros fait un rêve.',
  '36': 'Dessine une scène comique ou une blague.',
  '41': 'Change complètement de lieu par rapport à la scène actuelle.',
  '42': 'Un message important, ou mystérieux, arrive.',
  '43': 'Un événement qui réchauffe le cœur a lieu.',
  '44': 'Quelqu’un se déguise en ninja.',
  '45': 'Dessine une scène d’action: combat ou poursuite.',
  '46': 'Le héros est mis face à l’adversité.',
  '51': 'Un signe annonce la mort prochaine de quelqu’un (un « drapeau de mort »).',
  '52': 'Un robot apparaît.',
  '53': 'Pose un indice qui influencera la suite de l’histoire.',
  '54': 'Quelque chose tombe soudain du ciel.',
  '55': 'Une formule magique est prononcée.',
  '56': 'Quelqu’un dit au héros quelque chose de désagréable.',
  '61': 'Un personnage doit faire un choix crucial.',
  '62': 'Un combat contre un monstre commence.',
  '63': 'Quelqu’un laisse éclater une émotion forte: pleurs, colère, grand rire.',
  '64': 'Fais dire à un personnage quelque chose de profond.',
  '65': 'Un moment romantique a lieu.',
  '66': 'Un allié trahit soudain.',
};

const levelOf = (id: string): Level => LEVELS.find((l) => LEVEL_IDS[l].includes(id))!;

export const CONSTRAINTS: readonly Constraint[] = Object.entries(TABLE).map(([id, text]) => ({ id, text, level: levelOf(id), ...ELIGIBILITY[id] }));

/** Les deux dés en faces Unicode: « 31 » donne ⚂⚀. */
export const diceOf = (id: string) => [...id].map((d) => String.fromCodePoint(0x267f + Number(d))).join('');

/** Phase d'une case: quatre tranches égales (introduction, complications, escalade, dénouement). */
export function phaseOf(caseNo: number, total: number): Phase {
  const q = Math.min(3, Math.floor(((caseNo - 1) / total) * 4));
  return (['intro', 'complication', 'escalade', 'denouement'] as const)[q];
}

export const constraintById = (id: string) => CONSTRAINTS.find((c) => c.id === id);

/** Une demande peut-elle être proposée à cette case (étape et rang)? */
export function isEligible(c: Constraint, caseNo: number, total: number): boolean {
  return (!c.phases || c.phases.includes(phaseOf(caseNo, total))) && caseNo >= (c.minCase ?? 1);
}

const pickOne = <T,>(pool: readonly T[], rng: () => number): T => pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];

/**
 * Les trois demandes d'une case, une par difficulté, dans l'ordre facile, intermédiaire, difficile.
 * Évite d'abord les demandes déjà choisies (et `avoid`, pour un Joker); n'en répète une qu'en dernier recours.
 */
export function drawProposals(caseNo: number, total: number, chosen: readonly string[], rng: () => number, avoid: readonly string[] = []): string[] {
  return LEVELS.map((level) => {
    const all = CONSTRAINTS.filter((c) => c.level === level);
    const fit = all.filter((c) => isEligible(c, caseNo, total));
    const tiers = [
      fit.filter((c) => !chosen.includes(c.id) && !avoid.includes(c.id)),
      fit.filter((c) => !chosen.includes(c.id)),
      fit,
      all,
    ];
    return pickOne(tiers.find((t) => t.length) ?? all, rng).id;
  });
}
