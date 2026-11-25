import { SURVIVOR } from '../config';
import { CONSTRAINTS } from '../constraints';
import { UPGRADES } from '../upgrades';

export const SQL_BEGIN = '-- BEGIN GENERATED (scripts/survivor-sql.ts: ne pas modifier à la main)';
export const SQL_END = '-- END GENERATED';

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Données de règles que le serveur doit connaître pour être l'autorité (banque de demandes, améliorations, récompenses).
 * Générées depuis la configuration TypeScript, puis comparées au fichier de migration par un test de cohérence.
 */
export function survivorSqlData(): string {
  const U = SURVIVOR.upgrades;
  const economy = {
    ink: { start: SURVIVOR.ink.start, capacity: SURVIVOR.ink.capacity },
    rewards: { ...SURVIVOR.rewards },
    upgrade_every: SURVIVOR.upgradeEvery,
    offer_size: SURVIVOR.offerSize,
    upgrades: { encrier: U.encrier, regeneration: U.regeneration, narrateur: U.narrateur, joker_charges: U.jokerCharges, dernier_souffle: U.dernierSouffle },
  };
  const constraints = CONSTRAINTS.map((c) => `  (${q(c.id)}, ${q(c.level)}, ${c.phases ? `array[${c.phases.map(q).join(', ')}]` : 'null'}, ${c.minCase ?? 'null'})`);
  const upgrades = UPGRADES.map((u) => `  (${q(u.id)}, ${u.max})`);
  return [
    SQL_BEGIN,
    'insert into public.survivor_constraints (id, level, phases, min_case) values',
    constraints.join(',\n') + ';',
    'insert into public.survivor_upgrade_defs (id, max_stacks) values',
    upgrades.join(',\n') + ';',
    'create function public.survivor_economy() returns jsonb language sql immutable as $$',
    `  select ${q(JSON.stringify(economy))}::jsonb`,
    '$$;',
    SQL_END,
  ].join('\n');
}
