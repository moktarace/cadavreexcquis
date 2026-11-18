import { writeFileSync } from 'node:fs';
import { THEMES_FROM_YEAR, THEMES_TO_YEAR, themesSql } from '../src/domain/themesSql';

writeFileSync('supabase/migrations/0003_themes.sql', themesSql(THEMES_FROM_YEAR, THEMES_TO_YEAR));
console.log('supabase/migrations/0003_themes.sql régénéré');
