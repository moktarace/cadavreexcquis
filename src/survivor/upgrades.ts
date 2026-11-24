import type { IconName } from '../ui';
import { SURVIVOR } from './config';

export type UpgradeId = 'encrier' | 'plume' | 'ami' | 'architecte' | 'ecrivain' | 'recyclage' | 'regeneration' | 'joker' | 'narrateur' | 'souffle';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  /** Effet, formulé avec les valeurs de config. */
  text: string;
  icon: IconName;
  /** Nombre maximal d'exemplaires. */
  max: number;
}

const U = SURVIVOR.upgrades;
const pct = (v: number) => `${Math.round(v * 100)} %`;

export const UPGRADES: readonly UpgradeDef[] = [
  { id: 'encrier', name: 'Encrier', icon: 'archive', max: 5, text: `Capacité d'encre +${U.encrier} (et ${U.encrier} d'encre offerts).` },
  { id: 'plume', name: 'Plume légère', icon: 'pencil', max: 4, text: `Les traits coûtent ${pct(U.plume)} de moins.` },
  { id: 'ami', name: 'Ami imaginaire', icon: 'star', max: 3, text: `Le premier Mimo de chaque case est gratuit (+${U.amiFreeMimos} par exemplaire).` },
  { id: 'architecte', name: 'Architecte', icon: 'home', max: 3, text: `Les décors coûtent ${pct(U.architecte)} de moins.` },
  { id: 'ecrivain', name: 'Écrivain', icon: 'book', max: 3, text: `Les textes coûtent ${pct(U.ecrivain)} de moins.` },
  { id: 'recyclage', name: 'Recyclage', icon: 'rotate', max: 4, text: `La gomme rend ${pct(U.recyclage)} de l'encre dépensée sur ce qu'elle efface.` },
  { id: 'regeneration', name: 'Régénération', icon: 'plus', max: 5, text: `+${U.regeneration} d'encre entre deux cases.` },
  { id: 'joker', name: 'Joker', icon: 'swap', max: 99, text: `${U.jokerCharges} remplacements de contrainte.` },
  { id: 'narrateur', name: 'Narrateur', icon: 'pages', max: 4, text: `Une contrainte respectée rapporte +${U.narrateur} d'encre.` },
  { id: 'souffle', name: 'Dernier souffle', icon: 'alert', max: 2, text: `Une réserve d'urgence de ${U.dernierSouffle} d'encre, utilisable une seule fois.` },
];

export const upgradeById = (id: string) => UPGRADES.find((u) => u.id === id);

export type Owned = Readonly<Record<string, number>>;

export interface Modifiers {
  capacity: number;
  /** Multiplicateur du coût des traits et remplissages. */
  stroke: number;
  freeMimos: number;
  decor: number;
  text: number;
  /** Part de l'encre rendue par la gomme. */
  eraseRefund: number;
  /** Encre gagnée en plus entre deux cases. */
  regen: number;
  /** Bonus de la récompense d'une contrainte respectée. */
  reward: number;
}

/** Effets cumulés d'un ensemble d'améliorations: de quoi construire des synergies (plume + recyclage, encrier + régénération…). */
export function modifiersOf(owned: Owned): Modifiers {
  const n = (id: UpgradeId) => owned[id] ?? 0;
  return {
    capacity: SURVIVOR.ink.capacity + U.encrier * n('encrier'),
    stroke: Math.max(U.plumeFloor, 1 - U.plume * n('plume')),
    freeMimos: U.amiFreeMimos * n('ami'),
    decor: Math.max(U.discountFloor, 1 - U.architecte * n('architecte')),
    text: Math.max(U.discountFloor, 1 - U.ecrivain * n('ecrivain')),
    eraseRefund: Math.min(U.recyclageMax, SURVIVOR.eraseRefund + U.recyclage * n('recyclage')),
    regen: U.regeneration * n('regeneration'),
    reward: U.narrateur * n('narrateur'),
  };
}

/** Tire `count` améliorations différentes parmi celles qui peuvent encore être prises. */
export function offerUpgrades(owned: Owned, rng: () => number, count: number = SURVIVOR.offerSize): UpgradeId[] {
  const pool = UPGRADES.filter((u) => (owned[u.id] ?? 0) < u.max).map((u) => u.id);
  const out: UpgradeId[] = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.min(pool.length - 1, Math.floor(rng() * pool.length)), 1)[0]);
  return out;
}
