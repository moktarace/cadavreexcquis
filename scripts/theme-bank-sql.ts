// Banque de thèmes: supabase/themes.json est la source des titres.
//  npm run db:themes            affiche la commande SQL d'import (à coller dans l'éditeur SQL: les doublons sont ignorés)
//  npm run db:themes -- --seed  régénère supabase/migrations/0012_theme_bank_seed.sql (premier chargement de la banque)
import { readFileSync, writeFileSync } from 'node:fs';

interface Entry {
  text: string;
  source?: string;
  note?: string;
}

const file = new URL('../supabase/themes.json', import.meta.url);
const bank = JSON.parse(readFileSync(file, 'utf8')) as { themes: Entry[] };
const items = JSON.stringify(bank.themes.map((t) => ({ text: t.text, source: t.source ?? 'original', ...(t.note ? { note: t.note } : {}) })));
const call = `select public.import_theme_bank($themes$${items}$themes$::jsonb, 'original');`;

if (process.argv.includes('--seed')) {
  const header = `-- GÉNÉRÉ par \`npm run db:themes -- --seed\` à partir de supabase/themes.json: ne pas modifier à la main.
-- Premier chargement de la banque (titres originaux, non issus de matchs) puis tirage des semaines à venir:
-- la semaine en cours et les semaines passées ne changent pas, le prochain lundi ouvre le premier carton.
`;
  writeFileSync(new URL('../supabase/migrations/0012_theme_bank_seed.sql', import.meta.url), `${header}${call}\n`);
  console.log(`supabase/migrations/0012_theme_bank_seed.sql régénéré (${bank.themes.length} titres)`);
} else {
  console.log(call);
}
