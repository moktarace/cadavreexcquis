/**
 * Équilibrage de Survivor: tout ce qui se règle à la main est ici. Valeurs provisoires, à ajuster en jouant.
 * Repère: un trait de 100 px au stylo d'épaisseur 3 coûte 3 d'encre; un Mimo 8; un texte 5; un décor 10.
 */
export const SURVIVOR = {
  /** Nombre de cases d'une partie. */
  totalCases: 16,
  /** Une amélioration à choisir toutes les N cases. */
  upgradeEvery: 2,
  /** Nombre d'améliorations proposées à chaque fois. */
  offerSize: 3,

  ink: {
    /** Réserve de départ, et capacité maximale de base. */
    start: 100,
    capacity: 100,
    /** Réserve en dessous de laquelle plus aucun trait n'est possible. */
    minPlayable: 0.05,
  },

  costs: {
    /** Encre par pixel de longueur et par pixel d'épaisseur d'un trait (0,01 ≈ le coût d'un pixel d'aire). */
    strokePerPixel: 0.01,
    /** Pot de peinture: base + par pixel rempli, plafonné. */
    fillBase: 3,
    fillPerPixel: 0.0004,
    fillMax: 25,
    mimo: 8,
    text: 5,
    decor: 10,
    stamp: 3,
  },

  /** Part de l'encre rendue par la gomme sans amélioration (0 = rien). */
  eraseRefund: 0,

  rewards: {
    respected: 20,
    notRespected: 5,
  },

  /** Pixels dessinés minimum pour qu'une case compte comme terminée. */
  minCasePixels: 60,

  upgrades: {
    /** Encrier: capacité (et encre offerte) en plus par exemplaire. */
    encrier: 25,
    /** Plume légère: réduction du coût des traits par exemplaire, et plancher du coût. */
    plume: 0.15,
    plumeFloor: 0.35,
    /** Ami imaginaire: Mimo gratuits par case et par exemplaire. */
    amiFreeMimos: 1,
    /** Architecte et Écrivain: réduction du coût par exemplaire, et plancher. */
    architecte: 0.25,
    ecrivain: 0.25,
    discountFloor: 0.25,
    /** Recyclage: part de l'encre rendue par la gomme, par exemplaire, plafonnée. */
    recyclage: 0.2,
    recyclageMax: 0.8,
    /** Régénération: encre en plus entre deux cases, par exemplaire. */
    regeneration: 4,
    /** Joker: remplacements de contrainte accordés par exemplaire. */
    jokerCharges: 2,
    /** Narrateur: récompense en plus pour une contrainte respectée, par exemplaire. */
    narrateur: 5,
    /** Dernier souffle: encre de la réserve d'urgence, et charges par exemplaire. */
    dernierSouffle: 25,
  },
} as const;
