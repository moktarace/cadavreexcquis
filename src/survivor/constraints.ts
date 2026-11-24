/** Table « Les demandes déraisonnables de l'éditeur » (annexe 2 de Manga Relay), traduite: deux dés, 36 consignes. */
export type Phase = 'intro' | 'complication' | 'escalade' | 'denouement';

export const PHASE_LABELS: Record<Phase, string> = {
  intro: 'Introduction',
  complication: 'Complications',
  escalade: 'Escalade',
  denouement: 'Dénouement',
};

export interface Constraint {
  /** Les deux dés lus de gauche à droite, par exemple « 31 ». */
  id: string;
  text: string;
}

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

export const CONSTRAINTS: readonly Constraint[] = Object.entries(TABLE).map(([id, text]) => ({ id, text }));

/** Les deux dés en faces Unicode: « 31 » donne ⚂⚀. */
export const diceOf = (id: string) => [...id].map((d) => String.fromCodePoint(0x267f + Number(d))).join('');

/** Phase d'une case: quatre tranches égales (introduction, complications, escalade, dénouement). */
export function phaseOf(caseNo: number, total: number): Phase {
  const q = Math.min(3, Math.floor(((caseNo - 1) / total) * 4));
  return (['intro', 'complication', 'escalade', 'denouement'] as const)[q];
}

export const constraintById = (id: string) => CONSTRAINTS.find((c) => c.id === id);

/** Lance les deux dés: une consigne pas encore vue (ni celle qu'on remplace), ou à défaut n'importe laquelle sauf celle-ci. */
export function pickConstraint(used: readonly string[], rng: () => number, avoid?: string): Constraint {
  let pool = CONSTRAINTS.filter((c) => !used.includes(c.id) && c.id !== avoid);
  if (!pool.length) pool = CONSTRAINTS.filter((c) => c.id !== avoid);
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}
