// Applique supabase/migrations/*.sql dans l'ordre sur la base indiquée par SUPABASE_DB_URL (.env.local).
// Chaque fichier est exécuté une seule fois: les noms appliqués sont consignés dans public._app_migrations.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import pg from 'pg';

function env(name) {
  if (process.env[name]) return process.env[name];
  if (!existsSync('.env.local')) return undefined;
  const line = readFileSync('.env.local', 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim();
}

const url = env('SUPABASE_DB_URL');
if (!url) {
  console.error('SUPABASE_DB_URL manquant (chaîne de connexion Postgres du projet, dans .env.local).');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('create table if not exists public._app_migrations (name text primary key, applied_at timestamptz default now())');
const done = new Set((await client.query('select name from public._app_migrations')).rows.map((r) => r.name));

for (const file of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) {
    console.log(`déjà appliquée: ${file}`);
    continue;
  }
  console.log(`application de ${file}…`);
  try {
    await client.query('begin');
    await client.query(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    await client.query('insert into public._app_migrations (name) values ($1)', [file]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    console.error(`échec de ${file}: ${e.message}`);
    process.exit(1);
  }
}
await client.end();
console.log('terminé');
