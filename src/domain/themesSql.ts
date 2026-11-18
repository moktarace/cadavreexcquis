import { isoWeekOf } from './calendar';
import { generateTheme, weeklySeed, THEME_GENERATOR_VERSION } from './theme';

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Nombre de semaines ISO d'une année: la semaine du 28 décembre est toujours la dernière. */
export function isoWeeksInYear(year: number): number {
  return isoWeekOf({ y: year, m: 12, d: 28 }).isoWeek;
}

/** SQL idempotent créant les thèmes et les parties hebdomadaires de [fromYear, toYear]. */
export function themesSql(fromYear: number, toYear: number): string {
  const themes: string[] = [];
  const games: string[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    for (let week = 1; week <= isoWeeksInYear(year); week++) {
      const t = generateTheme(weeklySeed(year, week));
      const parts = JSON.stringify({ characterId: t.characterId, traitId: t.traitId, situationId: t.situationId });
      themes.push(`  (${q(t.seed)}, ${q(t.generatorVersion)}, ${q(t.text)}, ${q(parts)}::jsonb)`);
      games.push(`  (${year}, ${week}, ${q(t.seed)})`);
    }
  }
  return [
    '-- GÉNÉRÉ par `npm run db:themes` (src/domain/themesSql.ts): ne pas modifier à la main.',
    `-- Thèmes ${fromYear}–${toYear}, générateur ${THEME_GENERATOR_VERSION}. Le changement de semaine ne demande`,
    "-- aucune intervention: la partie de chaque semaine existe déjà. Regénérer avant la fin de la période.",
    '',
    'insert into public.themes (seed, generator_version, text, parts) values',
    themes.join(',\n'),
    'on conflict (seed, generator_version) do nothing;',
    '',
    'insert into public.weekly_games (iso_year, iso_week, theme_id)',
    'select v.y, v.w, t.id from (values',
    games.join(',\n'),
    `) as v(y, w, seed) join public.themes t on t.seed = v.seed and t.generator_version = ${q(THEME_GENERATOR_VERSION)}`,
    'on conflict (iso_year, iso_week) where not is_private do nothing;',
    '',
  ].join('\n');
}

export const THEMES_FROM_YEAR = 2026;
export const THEMES_TO_YEAR = 2030;
