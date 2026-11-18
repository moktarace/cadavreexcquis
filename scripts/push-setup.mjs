// Prépare Web Push: génère les clés VAPID et le secret du dispatcheur (une seule fois, dans .env.local),
// puis écrit les fichiers locaux (ignorés par git) utilisés au déploiement. N'affiche aucun secret.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const webpush = createRequire(import.meta.url)('web-push');

const ENV = '.env.local';
const read = () =>
  Object.fromEntries(
    (existsSync(ENV) ? readFileSync(ENV, 'utf8') : '')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );

let env = read();
const additions = [];
if (!env.VITE_VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  additions.push(`VITE_VAPID_PUBLIC_KEY=${keys.publicKey}`, `VAPID_PRIVATE_KEY=${keys.privateKey}`);
  console.log('Clés VAPID générées.');
}
if (!env.VAPID_SUBJECT) additions.push('VAPID_SUBJECT=mailto:remplace-moi@example.com');
if (!env.DISPATCH_SECRET) additions.push(`DISPATCH_SECRET=${randomBytes(24).toString('hex')}`);
if (additions.length) appendFileSync(ENV, `${existsSync(ENV) && !readFileSync(ENV, 'utf8').endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`);
env = read();

if (/example\.com|remplace-moi/.test(env.VAPID_SUBJECT)) {
  console.log('À FAIRE: remplace VAPID_SUBJECT dans .env.local par ton adresse (mailto:toi@domaine) ou l’URL du site.');
}

writeFileSync(
  'supabase/.env.functions',
  [
    `VAPID_PUBLIC_KEY=${env.VITE_VAPID_PUBLIC_KEY}`,
    `VAPID_PRIVATE_KEY=${env.VAPID_PRIVATE_KEY}`,
    `VAPID_SUBJECT=${env.VAPID_SUBJECT}`,
    `DISPATCH_SECRET=${env.DISPATCH_SECRET}`,
    '',
  ].join('\n'),
);

const ref = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const q = (s) => `'${s.replace(/'/g, "''")}'`;
writeFileSync(
  'supabase/schedule.local.sql',
  `select public.schedule_notifications(${q(`https://${ref}.supabase.co/functions/v1/dispatch`)}, ${q(env.DISPATCH_SECRET)});\n`,
);

console.log(`Fichiers écrits : supabase/.env.functions et supabase/schedule.local.sql (ignorés par git).
Étapes suivantes (voir README, section Notifications) :
  1. npx supabase login && npx supabase link --project-ref ${ref}
  2. npx supabase secrets set --env-file supabase/.env.functions
  3. npx supabase functions deploy dispatch --no-verify-jwt
  4. Tableau de bord > Database > Extensions : activer pg_cron et pg_net
  5. Éditeur SQL : appliquer supabase/migrations/0004_notifications.sql puis le contenu de supabase/schedule.local.sql`);
