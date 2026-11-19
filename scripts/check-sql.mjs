import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../supabase/migrations', import.meta.url).pathname;
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users(id uuid primary key default gen_random_uuid());
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage;
  create table storage.buckets(id text primary key, name text, public bool, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
  grant usage on schema auth, storage to authenticated, anon;
`);
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  try { await db.exec(readFileSync(`${dir}/${f}`, 'utf8').replace('create extension if not exists pgcrypto;', '')); }
  catch (e) { console.log(`MIGRATION ${f} ERROR:`, e.message); process.exit(1); }
}
// Équivalent des privilèges par défaut de Supabase
await db.exec(`
  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to authenticated, service_role;
  grant select on all tables in schema public to anon;
  grant all on all functions in schema public to service_role;
`);

const results = [];
const check = async (name, fn) => { try { await fn(); results.push(`PASS ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); } };
const expectErr = async (code, fn) => {
  try { await fn(); } catch (e) { if (String(e.message).includes(code)) return; throw new Error(`attendu ${code}, reçu ${e.message}`); }
  throw new Error(`attendu ${code}, aucune erreur`);
};
// Exécute une requête avec l'identité d'un utilisateur (rôle authenticated) ou anon.
const as = async (uid, sql, params) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${uid ? 'authenticated' : 'anon'}`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); }
};

const users = {};
for (const n of ['alice', 'bob', 'chloe']) {
  const [{ id }] = (await db.query('insert into auth.users default values returning id')).rows;
  users[n] = id;
}
await check('abonnements push (RLS: les siens seulement)', async () => {
  for (const u of ['alice', 'bob']) {
    await as(users[u], 'insert into push_subscriptions(user_id, endpoint, p256dh, auth, new_theme, social) values ($1,$2,$3,$4,true,true)', [users[u], `https://push.example/${u}`, 'k', 'a']);
  }
  await expectErr('row-level security', () => as(users.bob, 'insert into push_subscriptions(user_id, endpoint, p256dh, auth) values ($1,$2,$3,$4)', [users.alice, 'https://push.example/x', 'k', 'a']));
  const seen = await as(users.alice, 'select endpoint from push_subscriptions');
  if (seen.length !== 1) throw new Error(`${seen.length} abonnements visibles`);
});
await check('profil créé automatiquement', async () => {
  const rows = (await db.query('select nickname from profiles order by nickname')).rows;
  if (rows.length !== 3 || !rows[0].nickname.startsWith('Joueur ')) throw new Error(JSON.stringify(rows));
});

let game;
await check('current_game retourne la partie de la semaine', async () => {
  const [g] = await as(users.alice, 'select * from current_game()');
  if (!g) throw new Error('aucune partie pour la semaine courante');
  if (!g.theme_text || new Date(g.next_theme_at) <= new Date(g.server_now)) throw new Error(JSON.stringify(g));
  game = g.game_id;
});
await check('themes: 260+ parties pré-créées', async () => {
  const [{ n }] = (await db.query('select count(*)::int n from weekly_games')).rows;
  if (n < 260) throw new Error(`${n}`);
});
await check('themes immuables', () => expectErr('immuable', () => db.query("update themes set text='x'")));
await check('anon ne peut rien lire', async () => {
  const rows = await as(null, 'select * from contribution_cards');
  const g = await as(null, 'select * from weekly_games');
  if (rows.length || g.length) throw new Error('lisible');
});

const roomOf = async (u) => (await as(users[u], 'select join_game($1) r', [game]))[0].r;
let n = 0;
const draft = async (u) => {
  const [{ id: p }] = await as(users[u], 'insert into drawing_projects(owner_id) values ($1) returning id', [users[u]]);
  const [{ id: a }] = await as(users[u], `insert into drawing_assets(project_id, kind, path, bytes, sha256) values ($1,'preview',$2,10,'x') returning id`, [p, `${users[u]}/${++n}.png`]);
  return { p, a };
};
const pub = async (u, room, parent) => {
  const { p, a } = await draft(u);
  return (await as(users[u], 'select publish_contribution($1,$2,$3,$4) id', [room, parent, p, a]))[0].id;
};

let aliceRoom, root, c2, c3, c4;
await check('alice publie une case 1', async () => { aliceRoom = await roomOf('alice'); root = await pub('alice', aliceRoom, null); });
await check('auto-continuation refusée', () => expectErr('CANNOT_CONTINUE_OWN', () => pub('alice', null, root)));
await check('bob continue (case 2), alice puis chloe', async () => {
  c2 = await pub('bob', null, root); c3 = await pub('alice', null, c2); c4 = await pub('chloe', null, c3);
  const path = await as(users.chloe, 'select case_number, author_nickname from contribution_path($1)', [c4]);
  if (path.map((r) => r.case_number).join() !== '1,2,3,4') throw new Error(JSON.stringify(path));
});
await check('case 4 non continuable', () => expectErr('PARENT_IS_FINAL', () => pub('bob', null, c4)));
await check('vue: child_count, sous-arbre et lecture par un autre joueur', async () => {
  const [r] = await as(users.bob, 'select child_count from contribution_cards where id=$1', [root]);
  const sub = await as(users.bob, 'select id from contribution_subtree($1)', [root]);
  if (r.child_count !== 1 || sub.length !== 3) throw new Error(`${r.child_count} ${sub.length}`);
});
await check('projet publié non modifiable par son auteur', async () => {
  const rows = await as(users.alice, "update drawing_projects set status='draft' where owner_id=$1 and status='published' returning id", [users.alice]);
  if (rows.length !== 0) throw new Error('modifié');
});
await check('projet réutilisé refusé', async () => {
  const [{ project_id, preview_asset }] = (await db.query('select project_id, preview_asset from contributions where id=$1', [root])).rows;
  await expectErr('INVALID_PROJECT', () => as(users.bob, 'select publish_contribution($1,$2,$3,$4)', [aliceRoom, root, project_id, preview_asset]));
});
await check('projet d’autrui refusé', async () => {
  const { p, a } = await draft('bob');
  await expectErr('INVALID_PROJECT', () => as(users.alice, 'select publish_contribution($1,$2,$3,$4)', [aliceRoom, null, p, a]));
});
await check('insertion directe de contribution refusée (RLS)', async () => {
  const { p, a } = await draft('bob');
  await expectErr('row-level security', () => as(users.bob, 'insert into contributions(game_id,room_id,author_id,case_number,project_id,preview_asset) values ($1,$2,$3,1,$4,$5)', [game, aliceRoom, users.bob, p, a]));
});
await check('projet au nom d’un autre refusé', () => expectErr('row-level security', () => as(users.bob, 'insert into drawing_projects(owner_id) values ($1)', [users.alice])));
await check('brouillon de bob invisible pour alice', async () => {
  const rows = await as(users.alice, "select id from drawing_projects where owner_id=$1 and status='draft'", [users.bob]);
  if (rows.length) throw new Error('visible');
});
await check('signalement', async () => {
  await as(users.bob, 'insert into reports(contribution_id, reporter_id, reason) values ($1,$2,$3)', [root, users.bob, 'test']);
  await expectErr('row-level security', () => as(users.bob, 'insert into reports(contribution_id, reporter_id, reason) values ($1,$2,$3)', [root, users.alice, 'usurpation']));
});
await check('publier sans session refusé', () => expectErr('permission', () => as(null, 'select publish_contribution($1,$2,$3,$4)', [aliceRoom, null, root, root])));
// ───────────── Notifications ─────────────
const pending = async (u) => (await db.query("select kind, group_key, count, payload from notifications where user_id=$1 and sent_at is null order by kind", [users[u]])).rows;
await check('événements: continuation et histoire terminée, destinataires sans doublon', async () => {
  const a = await pending('alice');
  const b = await pending('bob');
  const kinds = (rows) => rows.map((r) => r.kind).join();
  if (kinds(a) !== 'continuation,story_completed') throw new Error('alice: ' + kinds(a));
  if (kinds(b) !== 'continuation,story_completed') throw new Error('bob: ' + kinds(b));
  if ((await pending('chloe')).length) throw new Error('chloe sans abonnement ne doit rien recevoir');
  if (!a[0].payload.url.startsWith('/#/case/')) throw new Error(a[0].payload.url);
  if (!a[1].payload.url.startsWith('/#/story/')) throw new Error(a[1].payload.url);
});
await check('regroupement: 3 suites de plus = une seule notification avec compteur', async () => {
  for (const n of ['x1', 'x2', 'x3']) {
    const [{ id }] = (await db.query('insert into auth.users default values returning id')).rows;
    users[n] = id;
    await pub(n, null, root);
  }
  const a = (await pending('alice')).find((r) => r.kind === 'continuation' && r.group_key.startsWith('cont:'));
  if (a.count !== 4) throw new Error(`count ${a.count}`);
  const [{ n }] = (await db.query("select count(*)::int n from notifications where user_id=$1 and kind='continuation'", [users.alice])).rows;
  if (n !== 1) throw new Error(`${n} lignes de continuation`);
});
await check('nouvelle branche signalée aux auteurs du fil (sans la continuation du parent)', async () => {
  // x4 continue b2 qui a déjà une suite (a3): alice (racine) apprend une nouvelle branche, bob une continuation.
  const [{ id }] = (await db.query('insert into auth.users default values returning id')).rows;
  users.x4 = id;
  await pub('x4', null, c2);
  const a = (await pending('alice')).map((r) => r.kind);
  if (!a.includes('new_branch')) throw new Error(a.join());
});
await check('rien n’est réservé avant le délai de regroupement', async () => {
  const rows = (await db.query('select * from claim_due_notifications(50)')).rows;
  if (rows.length) throw new Error(`${rows.length} réservées trop tôt`);
});
await check('réservation atomique: une seule fois, avec les points d’envoi', async () => {
  await db.exec("update notifications set send_after = now() - interval '1 minute'");
  const first = (await db.query('select * from claim_due_notifications(50)')).rows;
  if (!first.length || !first.every((r) => r.endpoint.startsWith('https://push.example/'))) throw new Error(JSON.stringify(first.slice(0, 1)));
  const second = (await db.query('select * from claim_due_notifications(50)')).rows;
  if (second.length) throw new Error('réservées deux fois');
});
await check('échec temporaire: remise en attente (3 tentatives au plus)', async () => {
  const [{ id }] = (await db.query('select id from notifications where sent_at is not null limit 1')).rows;
  await db.query('select release_notification($1)', [id]);
  const [r] = (await db.query('select sent_at, attempts from notifications where id=$1', [id])).rows;
  if (r.sent_at !== null) throw new Error('non remise');
  await db.query('update notifications set attempts = 3 where id=$1', [id]);
  await db.query("update notifications set sent_at = now() where id=$1", [id]);
  await db.query('select release_notification($1)', [id]);
  const [r2] = (await db.query('select sent_at from notifications where id=$1', [id])).rows;
  if (r2.sent_at === null) throw new Error('remise malgré 3 tentatives');
});
await check('heures de silence: la notification attend', async () => {
  const h = (await db.query("select extract(hour from now() at time zone 'Europe/Paris')::int h")).rows[0].h;
  await db.query('update push_subscriptions set quiet_start=$1, quiet_end=$2 where user_id=$3', [h, (h + 2) % 24, users.alice]);
  await db.query("update notifications set sent_at = null, send_after = now() - interval '1 minute' where user_id=$1", [users.alice]);
  const rows = (await db.query('select * from claim_due_notifications(50)')).rows.filter((r) => r.endpoint.endsWith('/alice'));
  if (rows.length) throw new Error('envoyée pendant le silence');
  await db.query('update push_subscriptions set quiet_start=null, quiet_end=null where user_id=$1', [users.alice]);
  const after = (await db.query('select * from claim_due_notifications(50)')).rows.filter((r) => r.endpoint.endsWith('/alice'));
  if (!after.length) throw new Error('jamais envoyée après le silence');
});
await check('préférences: sans « social », aucune notification sociale', async () => {
  await db.query('update push_subscriptions set social=false where user_id=$1', [users.bob]);
  await db.query("update notifications set sent_at = null, send_after = now() - interval '1 minute' where user_id=$1", [users.bob]);
  const rows = (await db.query('select * from claim_due_notifications(50)')).rows.filter((r) => r.endpoint.endsWith('/bob'));
  if (rows.length) throw new Error('envoyée malgré le refus');
});
await check('nouveau thème: lundi 08:00 Paris, une seule annonce par semaine', async () => {
  await db.query('update push_subscriptions set social=true where user_id=$1', [users.bob]);
  const tuesday = (await db.query("select enqueue_new_theme('2026-11-24 10:00+01') n")).rows[0].n;
  if (tuesday !== 0) throw new Error('annonce un mardi');
  const early = (await db.query("select enqueue_new_theme('2026-11-23 07:00+01') n")).rows[0].n;
  if (early !== 0) throw new Error('annonce avant 08:00');
  const first = (await db.query("select enqueue_new_theme('2026-11-23 08:00+01') n")).rows[0].n;
  if (first !== 2) throw new Error(`premier appel: ${first}`);
  const again = (await db.query("select enqueue_new_theme('2026-11-23 09:00+01') n")).rows[0].n;
  if (again !== 0) throw new Error('deuxième annonce');
  const [t] = (await db.query("select payload from notifications where kind='new_theme' limit 1")).rows;
  if (!t.payload.theme) throw new Error('thème absent');
});
await check('fonctions serveur inaccessibles aux joueurs', async () => {
  await expectErr('permission', () => as(users.alice, 'select * from claim_due_notifications(10)'));
  await expectErr('permission', () => as(users.alice, "select enqueue_notification($1,'continuation','g','/')", [users.alice]));
  const own = await as(users.alice, 'select id from notifications');
  const other = await as(users.alice, 'select id from notifications where user_id <> $1', [users.alice]);
  if (!own.length || other.length) throw new Error('lecture des notifications d’autrui');
});
// ───────────── Découverte et archives ─────────────
const plant = async (gameId, roomId, author, caseNumber, parentId) => {
  const [{ id: project }] = (await db.query("insert into drawing_projects(owner_id, status) values ($1,'published') returning id", [users[author]])).rows;
  const [{ id: asset }] = (await db.query("insert into drawing_assets(project_id, kind, path, bytes, sha256) values ($1,'preview',$2,10,'x') returning id", [project, `${users[author]}/${++n}.png`])).rows;
  return (await db.query('insert into contributions(game_id, room_id, author_id, case_number, parent_id, project_id, preview_asset) values ($1,$2,$3,$4,$5,$6,$7) returning id', [gameId, roomId, users[author], caseNumber, parentId, project, asset])).rows[0].id;
};
const room = async (gameId) => (await db.query('insert into rooms(game_id, number) values ($1,1) returning id', [gameId])).rows[0].id;
let pastA, pastB, privateGame, storyEnd;
await check('archives: histoires et dessins des autres parties publiques seulement', async () => {
  const games = (await db.query('select id from weekly_games where not is_private and iso_year=2026 and iso_week in (1,2) order by iso_week')).rows;
  pastA = games[0].id; pastB = games[1].id;
  privateGame = (await db.query("insert into weekly_games(iso_year, iso_week, theme_id, is_private) values (2020,10,(select id from themes limit 1),true) returning id")).rows[0].id;
  const ra = await room(pastA);
  const a1 = await plant(pastA, ra, 'alice', 1, null);
  const a2 = await plant(pastA, ra, 'bob', 2, a1);
  const a3 = await plant(pastA, ra, 'chloe', 3, a2);
  storyEnd = await plant(pastA, ra, 'alice', 4, a3);
  await plant(pastB, await room(pastB), 'bob', 1, null);
  await plant(privateGame, await room(privateGame), 'chloe', 1, null);
  const rows = await as(users.alice, 'select id, game_id, case_number from archive_highlights($1, 8)', [game]);
  if (rows.length !== 5) throw new Error(`${rows.length} lignes`);
  if (rows[0].id !== storyEnd) throw new Error('la fin d’histoire doit venir en premier');
  if (rows.some((r) => r.game_id === game || r.game_id === privateGame)) throw new Error('partie courante ou privée incluse');
});
await check('archives: la partie demandée est exclue et le nombre est borné', async () => {
  const rows = await as(users.alice, 'select game_id from archive_highlights($1, 8)', [pastA]);
  if (rows.some((r) => r.game_id === pastA)) throw new Error('partie exclue présente');
  const few = await as(users.alice, 'select id from archive_highlights($1, 2)', [game]);
  if (few.length !== 2) throw new Error(`${few.length}`);
  const capped = await as(users.alice, 'select id from archive_highlights($1, 100000)', [game]);
  if (capped.length > 24) throw new Error('limite dépassée');
});
await check('semaines d’archives: publiques avec dessins, la plus récente d’abord', async () => {
  const weeks = await as(users.alice, 'select game_id, iso_year, iso_week from archive_weeks()');
  const ids = weeks.map((w) => w.game_id);
  if (!ids.includes(pastA) || !ids.includes(pastB) || !ids.includes(game)) throw new Error('semaine manquante');
  if (ids.includes(privateGame)) throw new Error('partie privée listée');
  const keys = weeks.map((w) => w.iso_year * 100 + w.iso_week);
  if (keys.some((k, i) => i > 0 && k > keys[i - 1])) throw new Error('ordre');
});
await check('pagination des cases à continuer: aucune case perdue ni dupliquée', async () => {
  const where = 'room_id=$1 and case_number < 4 and author_id <> $2';
  const order = 'order by child_count, published_at, id';
  const all = (await db.query(`select id from contribution_cards where ${where} ${order}`, [aliceRoom, users.chloe])).rows.map((r) => r.id);
  const paged = [];
  for (let offset = 0; ; offset += 3) {
    const page = (await db.query(`select id from contribution_cards where ${where} ${order} limit 3 offset ${offset}`, [aliceRoom, users.chloe])).rows;
    paged.push(...page.map((r) => r.id));
    if (page.length < 3) break;
  }
  if (all.length < 5 || paged.join() !== all.join() || new Set(paged).size !== paged.length) throw new Error(`${paged.length}/${all.length}`);
  const [first] = (await db.query(`select child_count from contribution_cards where ${where} ${order} limit 1`, [aliceRoom, users.chloe])).rows;
  if (first.child_count !== 0) throw new Error('les cases sans suite doivent venir en premier');
});
await check('progression: suites, histoire terminée et dernière case', async () => {
  const [{ id: a1 }] = (await db.query('select id from contributions where game_id=$1 and case_number=1', [pastA])).rows;
  const [{ id: b1 }] = (await db.query('select id from contributions where game_id=$1 and case_number=1', [pastB])).rows;
  const rows = await as(users.alice, 'select * from contribution_progress($1::uuid[])', [`{${a1},${storyEnd},${b1}}`]);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  if (by[a1].descendants !== 3 || by[a1].finished !== 1 || by[a1].finished_leaf !== storyEnd) throw new Error(JSON.stringify(by[a1]));
  if (by[storyEnd].descendants !== 0 || by[storyEnd].finished !== 1) throw new Error(JSON.stringify(by[storyEnd]));
  if (by[b1].descendants !== 0 || by[b1].finished !== 0 || by[b1].finished_leaf !== null) throw new Error(JSON.stringify(by[b1]));
});

// ───────────── Réponses à découvrir (0008) ─────────────
for (const n of ['ana', 'ben', 'cleo']) users[n] = (await db.query('insert into auth.users default values returning id')).rows[0].id;
const unreadOf = async (u) => (await as(users[u], 'select reply_id, parent_id from unread_replies()')).map((r) => r.reply_id);
const readOf = async (u) => (await as(users[u], 'select reply_id from reply_reads')).map((r) => r.reply_id);
const markAs = (u, replyId, asUser = u) => as(users[asUser], 'insert into reply_reads(user_id, reply_id) values ($1,$2) on conflict do nothing', [users[u], replyId]);
let ana1, benReply, cleoReply, cleoCase3, anaEnd;
await check('réponses: aucune nouveauté pour une case 1 publiée', async () => {
  ana1 = await pub('ana', aliceRoom, null);
  if ((await unreadOf('ana')).length) throw new Error('nouveauté inattendue');
});
await check('réponses: Bob continue Alice, Alice reçoit une nouveauté (pas Bob)', async () => {
  benReply = await pub('ben', aliceRoom, ana1);
  const u = await unreadOf('ana');
  if (u.join() !== benReply) throw new Error(u.join());
  if ((await unreadOf('ben')).length) throw new Error('l’auteur de la réponse ne doit rien recevoir');
});
await check('réponses: deux réponses distinctes à la même case', async () => {
  cleoReply = await pub('cleo', aliceRoom, ana1);
  const u = await unreadOf('ana');
  if (u.length !== 2 || !u.includes(benReply) || !u.includes(cleoReply)) throw new Error(u.join());
  if (u[0] !== cleoReply) throw new Error('la plus récente doit venir en premier');
});
await check('réponses: ouvrir une seule réponse laisse l’autre non lue, de façon idempotente', async () => {
  await markAs('ana', benReply);
  await markAs('ana', benReply);
  const u = await unreadOf('ana');
  if (u.join() !== cleoReply) throw new Error(u.join());
  if ((await readOf('ana')).join() !== benReply) throw new Error('état de lecture');
});
await check('réponses: un autre appareil du même compte voit le même état', async () => {
  const again = await as(users.ana, 'select reply_id from unread_replies()');
  if (again.length !== 1 || again[0].reply_id !== cleoReply) throw new Error(JSON.stringify(again));
});
await check('réponses: RLS, on ne lit et n’écrit que son propre état', async () => {
  if ((await readOf('ben')).length) throw new Error('état d’un autre joueur visible');
  await expectErr('row-level security', () => markAs('ana', cleoReply, 'ben'));
  await expectErr('row-level security', () => markAs('ben', cleoReply));
  await expectErr('row-level security', () => markAs('ana', ana1));
  const [upd] = await as(users.ana, 'with u as (update reply_reads set read_at = now() returning 1) select count(*)::int n from u');
  const [del] = await as(users.ana, 'with d as (delete from reply_reads returning 1) select count(*)::int n from d');
  if (upd.n !== 0 || del.n !== 0) throw new Error('un état de lecture ne se modifie pas');
  if ((await readOf('ana')).length !== 1) throw new Error('état perdu');
  if ((await as(null, 'select * from reply_reads')).length) throw new Error('anon lit');
});
await check('réponses: une suite plus lointaine notifie l’auteur parent, pas l’auteur de la case 1', async () => {
  cleoCase3 = await pub('cleo', aliceRoom, benReply);
  const ben = await unreadOf('ben');
  if (ben.join() !== cleoCase3) throw new Error(ben.join());
  const ana = await unreadOf('ana');
  if (ana.join() !== cleoReply) throw new Error('Ana ne doit pas être notifiée de la case 3');
});
await check('réponses: une case 4 notifie l’auteur de la case 3 et ne peut pas être continuée', async () => {
  anaEnd = await pub('ana', aliceRoom, cleoCase3);
  const cleo = await unreadOf('cleo');
  if (cleo.join() !== anaEnd) throw new Error(cleo.join());
  if ((await unreadOf('ana')).join() !== cleoReply) throw new Error('on ne se notifie pas soi-même');
  await expectErr('PARENT_IS_FINAL', () => pub('ben', aliceRoom, anaEnd));
});
await check('réponses: le rattrapage de la migration marque les réponses existantes comme connues', async () => {
  const sql = readFileSync(`${dir}/0008_replies.sql`, 'utf8');
  const backfill = sql.slice(sql.indexOf('insert into public.reply_reads'), sql.indexOf('on conflict do nothing;') + 'on conflict do nothing;'.length);
  if ((await unreadOf('ben')).length === 0) throw new Error('précondition: Ben a une nouveauté');
  await db.exec(backfill);
  for (const u of ['ana', 'ben', 'cleo', 'alice', 'bob', 'chloe']) {
    const rows = await unreadOf(u);
    if (rows.length) throw new Error(`${u}: ${rows.length} non lues après rattrapage`);
  }
});
console.log(results.join('\n'));
