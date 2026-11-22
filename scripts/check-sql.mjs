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
  create table storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now());
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
await check('signalement: insertion directe refusée (passer par report_contribution)', () =>
  expectErr('row-level security', () => as(users.bob, 'insert into reports(contribution_id, reporter_id, reason, category) values ($1,$2,$3,$4)', [root, users.bob, 'test', 'spam'])));
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
  await db.query("update weekly_games set expires_at = now() + interval '1 day' where id in ($1,$2)", [pastA, pastB]);
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

// ───────────── Administration, modération, expiration (0009) ─────────────
for (const n of ['ada', 'bea', 'cyd', 'dex', 'eli', 'fay', 'gus', 'adm']) users[n] = (await db.query('insert into auth.users default values returning id')).rows[0].id;
const cardOf = async (u, id) => (await as(users[u], 'select hidden, hidden_kind, preview_path from contribution_cards where id=$1', [id]))[0];
const report = (u, id, category = 'offensive', details = null) => as(users[u], 'select report_contribution($1,$2,$3) r', [id, category, details]).then((r) => r[0].r);
const statusOf = async (id) => (await db.query('select status, hidden_kind, restored_at from contributions where id=$1', [id])).rows[0];

await check('fenêtre d’un thème: lundi 00:00 Paris, suppression le deuxième lundi suivant (exemple du cahier des charges)', async () => {
  const [w] = (await db.query('select starts_at, expires_at from game_window(2026, 47)')).rows;
  if (w.starts_at.toISOString() !== '2026-11-15T23:00:00.000Z') throw new Error(`début ${w.starts_at.toISOString()}`);
  if (w.expires_at.toISOString() !== '2026-11-29T23:00:00.000Z') throw new Error(`fin ${w.expires_at.toISOString()}`);
});
await check('fenêtre d’un thème: exacte autour des changements d’heure', async () => {
  const cases = [
    [2026, 42, '2026-10-11T22:00:00.000Z', '2026-10-25T23:00:00.000Z'],   // fin de l’heure d’été le 25/10
    [2026, 43, '2026-10-18T22:00:00.000Z', '2026-11-01T23:00:00.000Z'],
    [2027, 11, '2027-03-14T23:00:00.000Z', '2027-03-28T22:00:00.000Z'],   // début de l’heure d’été le 28/03
    [2027, 12, '2027-03-21T23:00:00.000Z', '2027-04-04T22:00:00.000Z'],
    [2026, 53, '2026-12-27T23:00:00.000Z', '2027-01-10T23:00:00.000Z'],   // semaine 53 → fin à cheval sur l’année
  ];
  for (const [y, w, start, end] of cases) {
    const [r] = (await db.query('select starts_at, expires_at from game_window($1, $2)', [y, w])).rows;
    if (r.starts_at.toISOString() !== start || r.expires_at.toISOString() !== end) throw new Error(`${y}-${w}: ${r.starts_at.toISOString()} → ${r.expires_at.toISOString()}`);
  }
});
await check('les parties publiques existantes reçoivent leur fenêtre, pas les parties privées', async () => {
  const [a] = (await db.query('select count(*)::int n from weekly_games where not is_private and (starts_at is null or expires_at is null)')).rows;
  const [b] = (await db.query('select count(*)::int n from weekly_games where is_private and expires_at is not null')).rows;
  if (a.n !== 0 || b.n !== 0) throw new Error(`${a.n} ${b.n}`);
});

let modRoot, modTwo, modThree;
await check('un dessin publié est immédiatement visible', async () => {
  modRoot = await pub('ada', aliceRoom, null);
  const c = await cardOf('bea', modRoot);
  if (c.hidden || !c.preview_path) throw new Error(JSON.stringify(c));
});
await check('signalement: motif invalide, auto-signalement et doublon refusés', async () => {
  await expectErr('INVALID_CATEGORY', () => report('bea', modRoot, 'nimporte'));
  await expectErr('CANNOT_REPORT_OWN', () => report('ada', modRoot));
  await expectErr('NOT_AUTHENTICATED', () => as(null, 'select report_contribution($1,$2,$3)', [modRoot, 'spam', null]).catch((e) => { throw new Error('NOT_AUTHENTICATED ' + e.message); }));
});
await check('un dessin signalé est masqué dès le premier signalement valide, sans image publique', async () => {
  modTwo = await pub('bea', aliceRoom, modRoot);
  modThree = await pub('cyd', aliceRoom, modTwo);
  if (await report('cyd', modTwo, 'spam', 'pub') !== 'hidden') throw new Error('non masqué');
  const c = await cardOf('dex', modTwo);
  if (!c.hidden || c.hidden_kind !== 'review' || c.preview_path !== null) throw new Error(JSON.stringify(c));
  await expectErr('ALREADY_REPORTED', () => report('cyd', modTwo));
  const [{ n }] = (await db.query('select count(*)::int n from reports where contribution_id=$1', [modTwo])).rows;
  if (n !== 1) throw new Error(`${n} signalements`);
});
await check('une case masquée garde la structure: descendants conservés, chemin lisible avec un emplacement neutre', async () => {
  const path = await as(users.dex, 'select id, hidden, preview_path from contribution_path($1)', [modThree]);
  if (path.map((r) => r.id).join() !== [modRoot, modTwo, modThree].join()) throw new Error('chemin');
  if (path[1].hidden !== true || path[1].preview_path !== null || path[0].preview_path === null || path[2].preview_path === null) throw new Error('masquage');
  const sub = await as(users.dex, 'select id from contribution_subtree($1)', [modRoot]);
  if (sub.length !== 2) throw new Error(`${sub.length}`);
});
await check('on ne peut pas continuer directement une case masquée', () =>
  expectErr('PARENT_HIDDEN', () => pub('dex', aliceRoom, modTwo)));
await check('l’image d’une case masquée n’est plus lisible par les autres joueurs', async () => {
  const rows = await as(users.dex, 'select path from drawing_assets a where exists (select 1 from contributions c where c.preview_asset = a.id and c.id = $1)', [modTwo]);
  if (rows.length) throw new Error('chemin visible');
});
await check('personne n’accède aux signalements, aux administrateurs ni aux journaux', async () => {
  if ((await as(users.dex, 'select * from reports')).length) throw new Error('signalements lisibles');
  if ((await as(users.dex, 'select * from admins')).length) throw new Error('admins lisibles');
  if ((await as(users.dex, 'select * from storage_deletions')).length) throw new Error('file lisible');
  await expectErr('row-level security', () => as(users.dex, 'insert into admins(user_id) values ($1)', [users.dex]));
});
await check('un utilisateur sans droits ne peut déclencher aucune opération d’administration', async () => {
  if ((await as(users.dex, 'select is_admin() a'))[0].a !== false) throw new Error('admin');
  for (const q of [
    ['select * from admin_contributions()', []],
    ['select * from admin_reports()', []],
    ['select * from admin_games()', []],
    ['select admin_set_hidden($1::uuid[], false)', [`{${modTwo}}`]],
    ['select admin_cleanup_preview($1::uuid[], $2)', [`{${modTwo}}`, 'selection']],
    ['select admin_cleanup_execute($1::uuid[], $2, $3, $4)', [`{${modTwo}}`, 'selection', 'x', 'SUPPRIMER']],
    ['select * from admin_purge_log()', []],
  ]) await expectErr('FORBIDDEN', () => as(users.dex, q[0], q[1]));
  for (const f of ['purge_expired_games()', 'enable_expiry_purge()', "claim_storage_deletions(10)", 'purge_stale_drafts()'])
    await expectErr('permission denied', () => as(users.dex, `select ${f}`));
  await expectErr('permission denied', () => as(users.dex, 'select * from cleanup_plan($1::uuid[], $2)', [`{${modTwo}}`, 'selection']));
});
await check('l’administrateur voit les dessins masqués et leurs signalements, filtrables', async () => {
  await db.query('insert into admins(user_id) values ($1)', [users.adm]);
  const hiddenOnes = await as(users.adm, "select id, preview_path, open_reports from admin_contributions(null, null, 'review')");
  if (!hiddenOnes.some((r) => r.id === modTwo && r.preview_path && r.open_reports === 1)) throw new Error(JSON.stringify(hiddenOnes));
  const byAuthor = await as(users.adm, 'select id from admin_contributions(null, $1)', [users.bea]);
  if (byAuthor.length !== 1 || byAuthor[0].id !== modTwo) throw new Error('filtre auteur');
  const bySearch = await as(users.adm, 'select id from admin_contributions(null, null, null, $1)', [modThree.slice(0, 8)]);
  if (bySearch.length !== 1 || bySearch[0].id !== modThree) throw new Error('recherche');
  const reps = await as(users.adm, "select category, details, status, reporter_reports from admin_reports('open')");
  if (!reps.some((r) => r.category === 'spam' && r.details === 'pub')) throw new Error('signalements');
});
await check('l’administrateur rétablit un dessin: image et continuation reviennent, signalements clos', async () => {
  await as(users.adm, 'select admin_set_hidden($1::uuid[], false)', [`{${modTwo}}`]);
  const c = await cardOf('dex', modTwo);
  if (c.hidden || !c.preview_path) throw new Error(JSON.stringify(c));
  const [{ status }] = (await db.query('select status from reports where contribution_id=$1', [modTwo])).rows;
  if (status !== 'dismissed') throw new Error(status);
  const again = await pub('dex', aliceRoom, modTwo);
  if (!again) throw new Error('continuation refusée');
});
await check('un ancien signalement ne remasque pas un dessin rétabli; trois nouveaux signalements, si', async () => {
  const s = await statusOf(modTwo);
  if (s.status !== 'published') throw new Error('remasqué');
  if (await report('dex', modTwo) !== 'recorded') throw new Error('masqué trop tôt (1)');
  if (await report('eli', modTwo) !== 'recorded') throw new Error('masqué trop tôt (2)');
  if ((await statusOf(modTwo)).status !== 'published') throw new Error('remasqué à 2');
  if (await report('fay', modTwo, 'hateful') !== 'hidden') throw new Error('devrait être masqué au troisième');
});
await check('l’administrateur confirme le retrait: le dessin reste masqué, rien n’est détruit', async () => {
  await as(users.adm, 'select admin_set_hidden($1::uuid[], true)', [`{${modTwo}}`]);
  const s = await statusOf(modTwo);
  if (s.status !== 'hidden' || s.hidden_kind !== 'removed') throw new Error(JSON.stringify(s));
  const [{ n }] = (await db.query("select count(*)::int n from reports where contribution_id=$1 and status='upheld'", [modTwo])).rows;
  if (n !== 3) throw new Error(`${n} upheld`);
  const [{ files }] = (await db.query('select count(*)::int files from drawing_assets a join contributions c on c.preview_asset = a.id where c.id=$1', [modTwo])).rows;
  if (files !== 1) throw new Error('fichier supprimé par erreur');
});
await check('signalements abusifs: limite horaire et blocage du signaleur', async () => {
  const targets = [];
  for (let i = 0; i < 11; i++) targets.push(await plant(game, aliceRoom, 'ada', 1, null));
  for (let i = 0; i < 10; i++) await report('gus', targets[i], 'spam');
  await expectErr('REPORT_RATE_LIMITED', () => report('gus', targets[10], 'spam'));
  const [rep] = await as(users.adm, "select report_id from admin_reports('open') where reporter_id = $1 limit 1", [users.gus]);
  await as(users.adm, 'select admin_review_report($1, $2, true)', [rep.report_id, 'abusive']);
  const [{ blocked }] = (await db.query('select exists (select 1 from report_blocks where user_id=$1) blocked', [users.gus])).rows;
  if (!blocked) throw new Error('non bloqué');
  const victim = await plant(game, aliceRoom, 'ada', 1, null);
  await db.query("delete from reports where reporter_id=$1 and id <> $2", [users.gus, rep.report_id]);
  if (await report('gus', victim, 'spam') !== 'recorded') throw new Error('un compte bloqué ne doit pas masquer');
  if ((await statusOf(victim)).status !== 'published') throw new Error('masqué');
  // le seul signalement ouvert écarté comme abusif rétablit le dessin masqué en attente d'examen
  const only = await plant(game, aliceRoom, 'ada', 1, null);
  await report('fay', only, 'other');
  const [r2] = await as(users.adm, "select report_id from admin_reports('open') where contribution_id=$1", [only]);
  await as(users.adm, 'select admin_review_report($1, $2, false)', [r2.report_id, 'dismissed']);
  if ((await statusOf(only)).status !== 'published') throw new Error('non rétabli');
});

// Thèmes de test: A (semaine « 10 ») puis B (semaine « 11 ») dans un futur lointain.
let gA, gB, rA, rB, a1, a2, a3, b1, notifBefore;
const themeId = (await db.query('select id from themes limit 1')).rows[0].id;
// Les parties des tests précédents ne doivent pas être emportées par l'horloge simulée de 2031.
await db.query('update weekly_games set expires_at = null where iso_year < 2031 and not is_private');
const mkGame = async (week) => (await db.query('insert into weekly_games(iso_year, iso_week, theme_id) values (2031,$1,$2) returning id', [week, themeId])).rows[0].id;
const stored = async (userId, label) => { await db.query("insert into storage.objects(bucket_id, name) select 'previews', path from drawing_assets where path like $1 || '/%'", [userId]); return label; };
await check('arrivée du thème B: le thème A reste intact, consultable et continuable (deuxième semaine)', async () => {
  gA = await mkGame(10); gB = await mkGame(11);
  rA = await room(gA); rB = await room(gB);
  a1 = await plant(gA, rA, 'alice', 1, null);
  a2 = await pub('bob', rA, a1);                     // notifie alice (abonnée) → notification en file
  notifBefore = (await db.query("select count(*)::int n from notifications where payload->>'url' like '%' || $1", [a2])).rows[0].n;
  b1 = await plant(gB, rB, 'chloe', 1, null);
  await db.query('select enable_expiry_purge()');
  const [bw] = (await db.query('select starts_at from weekly_games where id=$1', [gB])).rows;
  const res = (await db.query('select purge_expired_games($1) r', [bw.starts_at])).rows[0].r;
  if (res.purged !== 0) throw new Error(JSON.stringify(res));
  const read = await as(users.dex, 'select id from contribution_cards where game_id=$1', [gA]);
  if (read.length !== 2) throw new Error(`${read.length} lisibles`);
  a3 = await pub('chloe', rA, a2);                    // continuation d’une ancienne histoire
  if (!a3) throw new Error('continuation refusée');
});
await check('une continuation hérite de l’expiration du thème d’origine, quelle que soit sa date de publication', async () => {
  const [r] = (await db.query('select g.expires_at, c.published_at from contributions c join weekly_games g on g.id=c.game_id where c.id=$1', [a3])).rows;
  const [w] = (await db.query('select expires_at from game_window(2031, 10)')).rows;
  if (r.expires_at.toISOString() !== w.expires_at.toISOString()) throw new Error('échéance différente');
});
await check('la purge est désarmée tant qu’elle n’est pas activée explicitement', async () => {
  await db.query('select enable_expiry_purge(false)');
  const [gw] = (await db.query('select expires_at from weekly_games where id=$1', [gA])).rows;
  const res = (await db.query('select purge_expired_games($1) r', [new Date(gw.expires_at.getTime() + 1000)])).rows[0].r;
  const [{ n }] = (await db.query('select count(*)::int n from contributions where game_id=$1', [gA])).rows;
  if (res.enabled !== false || n !== 3) throw new Error(JSON.stringify(res));
  await db.query('select enable_expiry_purge(true)');
});
await check('à l’échéance, un thème expiré disparaît de la lecture et refuse toute publication, même ancien onglet', async () => {
  await db.query("update weekly_games set expires_at = now() - interval '1 second' where id=$1", [gA]);
  const read = await as(users.dex, 'select id from contribution_cards where game_id=$1', [gA]);
  if (read.length) throw new Error('encore lisible');
  await expectErr('GAME_EXPIRED', () => pub('dex', rA, a3));
  await expectErr('GAME_EXPIRED', () => as(users.dex, 'select join_game($1)', [gA]));
  await expectErr('CONTRIBUTION_NOT_FOUND', () => report('dex', a2));
  await db.query("update weekly_games set expires_at = (select expires_at from game_window(2031, 10)) where id=$1", [gA]);
});

// Fichiers: un objet Storage par dessin publié, comme dans Supabase.
const drain = async ({ failFirst = false } = {}) => {
  let removed = 0;
  for (;;) {
    const claimed = (await db.query('select * from claim_storage_deletions(50)')).rows;
    if (!claimed.length) return removed;
    const done = [];
    for (const [i, c] of claimed.entries()) {
      if (failFirst && i === 0) { await db.query('select fail_storage_deletion($1, $2)', [c.id, 'réseau']); failFirst = false; continue; }
      await db.query("delete from storage.objects where bucket_id=$1 and name=$2", [c.bucket, c.path]);
      done.push(c.id); removed++;
    }
    await db.query('select complete_storage_deletions($1::uuid[])', [`{${done.join(',')}}`]);
    if (!done.length) return removed;
  }
};
await check('suppression interrompue (échec en cours de route) puis reprise: rien de partiel, journal d’erreur, puis succès', async () => {
  for (const id of [a1, a2, a3, b1]) await db.query("insert into storage.objects(bucket_id, name) select 'previews', a.path from drawing_assets a join contributions c on c.preview_asset=a.id where c.id=$1", [id]);
  await db.query("create function boom() returns trigger language plpgsql as $$ begin raise exception 'panne simulée'; end $$");
  await db.query('create trigger boom before delete on rooms for each row execute function boom()');
  const [gw] = (await db.query('select expires_at from weekly_games where id=$1', [gA])).rows;
  const at = new Date(gw.expires_at.getTime() + 1000);
  const res = (await db.query('select purge_expired_games($1) r', [at])).rows[0].r;
  const [{ n }] = (await db.query('select count(*)::int n from contributions where game_id=$1', [gA])).rows;
  const [{ q }] = (await db.query("select count(*)::int q from storage_deletions where reason='expiry'")).rows;
  if (res.errors !== 1 || n !== 3 || q !== 0) throw new Error(`${JSON.stringify(res)} ${n} ${q}`);
  const [log] = (await db.query("select status, error from purge_log where game_id=$1 order by created_at desc limit 1", [gA])).rows;
  if (log.status !== 'error' || !log.error.includes('panne')) throw new Error(JSON.stringify(log));
  await db.query('drop trigger boom on rooms');
  const again = (await db.query('select purge_expired_games($1) r', [at])).rows[0].r;
  if (again.purged !== 1 || again.errors !== 0) throw new Error(JSON.stringify(again));
});
await check('après l’expiration: seul le thème A disparaît (contributions, fichiers, notifications, salles), pas le thème B', async () => {
  const [a] = (await db.query('select count(*)::int n from contributions where game_id=$1', [gA])).rows;
  const [b] = (await db.query('select count(*)::int n from contributions where game_id=$1', [gB])).rows;
  const [assets] = (await db.query("select count(*)::int n from drawing_assets where path in (select path from storage_deletions)")).rows;
  const [rooms] = (await db.query('select count(*)::int n from rooms where game_id=$1', [gA])).rows;
  const [roomB] = (await db.query('select count(*)::int n from rooms where game_id=$1', [gB])).rows;
  if (a.n !== 0 || b.n !== 1 || assets.n !== 0 || rooms.n !== 0 || roomB.n !== 1) throw new Error(JSON.stringify({ a, b, assets, rooms, roomB }));
  if (notifBefore < 1) throw new Error('précondition: une notification existait');
  const [notif] = (await db.query("select count(*)::int n from notifications where payload->>'url' like '%' || $1 or payload->>'url' like '%' || $2", [a2, a3])).rows;
  if (notif.n !== 0) throw new Error('notifications orphelines');
  const [pg] = (await db.query('select purged_at from weekly_games where id=$1', [gA])).rows;
  if (!pg.purged_at) throw new Error('purged_at');
});
await check('aucun fichier orphelin dans Storage après la purge et la reprise de la file (échec partiel inclus)', async () => {
  const [{ before }] = (await db.query("select count(*)::int before from storage.objects where name in (select path from storage_deletions)")).rows;
  if (before < 3) throw new Error(`${before} fichiers en attente`);
  const removed = await drain({ failFirst: true });
  if (removed !== before) throw new Error(`${removed}/${before}`);
  const [{ left }] = (await db.query("select count(*)::int left from storage.objects where name in (select path from storage_deletions)")).rows;
  const [{ pending }] = (await db.query('select count(*)::int pending from storage_deletions where deleted_at is null')).rows;
  const [{ kept }] = (await db.query("select count(*)::int kept from storage.objects o where exists (select 1 from drawing_assets a join contributions c on c.preview_asset=a.id where a.path=o.name and c.id=$1)", [b1])).rows;
  if (left !== 0 || pending !== 0 || kept !== 1) throw new Error(JSON.stringify({ left, pending, kept }));
});
await check('la tâche exécutée deux fois ne supprime rien de plus et ne touche pas les autres semaines', async () => {
  const [gw] = (await db.query('select expires_at from weekly_games where id=$1', [gA])).rows;
  const at = new Date(gw.expires_at.getTime() + 1000);
  const [before] = (await db.query('select count(*)::int n from contributions')).rows;
  const r2 = (await db.query('select purge_expired_games($1) r', [at])).rows[0].r;
  const [after] = (await db.query('select count(*)::int n from contributions')).rows;
  const [logs] = (await db.query("select count(*)::int n from purge_log where kind='expiry' and game_id=$1 and status='ok'", [gA])).rows;
  const [queued] = (await db.query('select count(*)::int n from storage_deletions where deleted_at is null')).rows;
  if (r2.purged !== 0 || before.n !== after.n || logs.n !== 1 || queued.n !== 0) throw new Error(JSON.stringify({ r2, before, after, logs, queued }));
  const [b] = (await db.query('select count(*)::int n from contributions where game_id=$1', [gB])).rows;
  if (b.n !== 1) throw new Error('thème B touché');
});
await check('une publication sur un thème tout juste expiré est refusée, la purge supprime ce qui a été accepté avant', async () => {
  const g = await mkGame(12);
  const r = await room(g);
  const root = await plant(g, r, 'alice', 1, null);
  const accepted = await pub('bob', r, root);                    // acceptée avant l’échéance
  await db.query("update weekly_games set expires_at = now() - interval '1 second' where id=$1", [g]);
  await expectErr('GAME_EXPIRED', () => pub('chloe', r, accepted));   // arrivée après l’échéance
  await db.query('select purge_expired_games(clock_timestamp())');
  const [{ n }] = (await db.query('select count(*)::int n from contributions where game_id=$1', [g])).rows;
  if (n !== 0) throw new Error(`${n} restantes`);
});
await check('fichiers orphelins: seuls les aperçus anciens et non référencés sont mis en file', async () => {
  await db.query("insert into storage.objects(bucket_id, name, created_at) values ('previews', 'x/orphan-old.png', now() - interval '3 days'), ('previews', 'x/orphan-new.png', now())");
  await db.query("insert into storage.objects(bucket_id, name, created_at) select 'previews', path, now() - interval '3 days' from drawing_assets where path like $1 || '/%' limit 1", [users.ada]);
  const n = (await db.query('select queue_orphan_previews() n')).rows[0].n;
  const [q] = (await db.query("select array_agg(path order by path) p from storage_deletions where reason='orphan'")).rows;
  if (n !== 1 || q.p.join() !== 'x/orphan-old.png') throw new Error(`${n} ${q.p}`);
  await drain();
});

// Nettoyage manuel: aperçu, confirmation, emplacements neutres.
let t1, t2, t3, t4, t5;
await check('nettoyage: aperçu précis, sans rien supprimer, avec les suites des autres joueurs préservées', async () => {
  const g = await mkGame(20); const r = await room(g);
  t1 = await plant(g, r, 'adm', 1, null);
  t2 = await plant(g, r, 'bob', 2, t1);
  t3 = await plant(g, r, 'chloe', 2, t1);
  t4 = await plant(g, r, 'alice', 3, t2);
  t5 = await plant(g, r, 'adm', 3, t3);
  const mine = await as(users.adm, 'select id from admin_contributions(null, $1)', [users.adm]);
  if (!mine.some((x) => x.id === t1) || mine.some((x) => x.id === t2)) throw new Error('filtre mes contributions');
  const [p] = await as(users.adm, "select admin_cleanup_preview($1::uuid[], 'selection') p", [`{${t1}}`]);
  const pv = p.p;
  if (pv.tombstone_rows !== 1 || pv.delete_rows !== 0 || pv.children_kept !== 2 || pv.files !== 1 || pv.stories !== 1 || pv.cascaded_rows !== 0) throw new Error(JSON.stringify(pv));
  const [{ n }] = (await db.query('select count(*)::int n from contributions where game_id=$1', [g])).rows;
  if (n !== 5) throw new Error('l’aperçu a supprimé');
});
await check('nettoyage: confirmation explicite et signature de l’aperçu exigées', async () => {
  const pv = (await as(users.adm, "select admin_cleanup_preview($1::uuid[], 'selection') p", [`{${t1}}`]))[0].p;
  await expectErr('CONFIRMATION_REQUIRED', () => as(users.adm, 'select admin_cleanup_execute($1::uuid[], $2, $3, $4)', [`{${t1}}`, 'selection', pv.signature, 'oui']));
  await expectErr('PLAN_CHANGED', () => as(users.adm, 'select admin_cleanup_execute($1::uuid[], $2, $3, $4)', [`{${t1}}`, 'selection', 'obsolete', 'SUPPRIMER']));
  const [{ n }] = (await db.query('select count(*)::int n from contributions where id=$1', [t1])).rows;
  if (n !== 1) throw new Error('supprimé sans confirmation');
});
await check('nettoyage: la case choisie devient un emplacement neutre, les suites d’autres auteurs sont préservées', async () => {
  const pv = (await as(users.adm, "select admin_cleanup_preview($1::uuid[], 'selection') p", [`{${t1}}`]))[0].p;
  const res = (await as(users.adm, 'select admin_cleanup_execute($1::uuid[], $2, $3, $4) r', [`{${t1}}`, 'selection', pv.signature, 'SUPPRIMER']))[0].r;
  if (res.files_queued !== 1) throw new Error(JSON.stringify(res));
  const c = await cardOf('dex', t1);
  if (!c.hidden || c.hidden_kind !== 'deleted' || c.preview_path !== null) throw new Error(JSON.stringify(c));
  const rest = await as(users.dex, 'select id from contribution_cards where id = any($1::uuid[])', [`{${t2},${t3},${t4},${t5}}`]);
  if (rest.length !== 4) throw new Error('suites perdues');
  const [{ n }] = (await db.query("select count(*)::int n from storage_deletions where reason='cleanup' and deleted_at is null")).rows;
  if (n !== 1) throw new Error(`${n} fichiers en file`);
  const tombRoom = (await db.query('select room_id from contributions where id=$1', [t1])).rows[0].room_id;
  await expectErr('PARENT_HIDDEN', () => pub('dex', tombRoom, t1));
  await drain();
});
await check('nettoyage: supprimer la dernière suite retire aussi l’emplacement neutre devenu inutile', async () => {
  const ids = `{${t2},${t3},${t4},${t5}}`;
  const pv = (await as(users.adm, "select admin_cleanup_preview($1::uuid[], 'selection') p", [ids]))[0].p;
  if (pv.delete_rows !== 4 || pv.tombstone_rows !== 0) throw new Error(JSON.stringify(pv));
  const res = (await as(users.adm, 'select admin_cleanup_execute($1::uuid[], $2, $3, $4) r', [ids, 'selection', pv.signature, 'SUPPRIMER']))[0].r;
  const [{ n }] = (await db.query('select count(*)::int n from contributions where id = any($1::uuid[])', [`{${t1},${t2},${t3},${t4},${t5}}`])).rows;
  if (n !== 0 || res.pruned !== 1) throw new Error(`${n} ${JSON.stringify(res)}`);
  await drain();
});
await check('nettoyage d’une histoire entière: réservé au mode « story », avec l’aperçu des autres auteurs touchés', async () => {
  const g = await mkGame(21); const r = await room(g);
  const s1 = await plant(g, r, 'adm', 1, null);
  const s2 = await plant(g, r, 'bob', 2, s1);
  const s3 = await plant(g, r, 'chloe', 3, s2);
  const sel = (await as(users.adm, "select admin_cleanup_preview($1::uuid[], 'selection') p", [`{${s1}}`]))[0].p;
  if (sel.tombstone_rows !== 1 || sel.cascaded_rows !== 0) throw new Error('la sélection simple ne doit pas supprimer les suites');
  const pv = (await as(users.adm, "select admin_cleanup_preview($1::uuid[], 'story') p", [`{${s1}}`]))[0].p;
  if (pv.delete_rows !== 3 || pv.cascaded_rows !== 2 || pv.authors !== 3 || pv.files !== 3) throw new Error(JSON.stringify(pv));
  await as(users.adm, 'select admin_cleanup_execute($1::uuid[], $2, $3, $4)', [`{${s1}}`, 'story', pv.signature, 'SUPPRIMER']);
  const [{ n }] = (await db.query('select count(*)::int n from contributions where game_id=$1', [g])).rows;
  if (n !== 0) throw new Error(`${n}`);
  await drain();
});
await check('journal: chaque opération laisse une trace minimale', async () => {
  const logs = await as(users.adm, 'select kind, status from admin_purge_log(100)');
  const kinds = new Set(logs.map((l) => `${l.kind}:${l.status}`));
  for (const k of ['expiry:ok', 'expiry:error', 'cleanup:ok', 'orphans:ok']) if (!kinds.has(k)) throw new Error(`manque ${k}`);
  const [b] = await as(users.adm, 'select pending from admin_storage_backlog()');
  if (b.pending !== 0) throw new Error('file non vide');
});


// ───────────── Récompenses collectives et tampons (0010) ─────────────
for (const n of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'm1', 'm2', 'm3', 'm4', 'r1', 'r2', 'r3', 's1', 's2', 's3', 's4', 'e1', 'e2', 'e3', 'e4', 'b1', 'b2', 'b3', 'b4'])
  users[n] = (await db.query('insert into auth.users default values returning id')).rows[0].id;
const prog = async (u) => (await as(users[u], 'select completed, inspired, stickers from my_progress()'))[0];
const events = (u, unseen = true, kind = null) => as(users[u], 'select id, kind, end_id, root_id, ref, n, expired, seen from my_reward_events($1, $2)', [unseen, kind]);
const kinds = (rows) => rows.map((r) => r.kind + (r.ref ? ':' + r.ref : '')).sort().join();
const chain = async (authors, room = aliceRoom) => {
  const ids = [];
  for (const [i, a] of authors.entries()) ids.push(await pub(a, room, i === 0 ? null : ids[i - 1]));
  return ids;
};

let ends1;
await check('récompenses: quatre auteurs différents, tous récompensés, l’auteur de la case 1 aussi comme inspirateur', async () => {
  ends1 = await chain(['p1', 'p2', 'p3', 'p4']);
  for (const u of ['p1', 'p2', 'p3', 'p4']) if ((await prog(u)).completed !== 1) throw new Error(`${u} completed`);
  if ((await prog('p1')).inspired !== 1 || (await prog('p2')).inspired !== 0) throw new Error('inspired');
});
await check('récompenses: aucun crédit pour une branche inachevée', async () => {
  await chain(['r1', 'r2', 'r3']);
  for (const u of ['r1', 'r2', 'r3']) {
    const p = await prog(u);
    if (p.completed !== 0 || p.inspired !== 0 || (await events(u)).length) throw new Error(`${u} ${JSON.stringify(p)}`);
  }
});
await check('récompenses: un auteur présent deux fois dans le chemin ne reçoit qu’une récompense', async () => {
  await chain(['p5', 'p6', 'p5', 'p7']);
  const p5 = await prog('p5');
  if (p5.completed !== 1 || p5.inspired !== 1) throw new Error(JSON.stringify(p5));
  const [{ n }] = (await db.query("select count(*)::int n from story_credits where user_id=$1 and kind='participant'", [users.p5])).rows;
  if (n !== 1) throw new Error(`${n} crédits`);
  const e = await events('p5');
  if (e.filter((x) => x.kind === 'story_done').length !== 1) throw new Error('une seule nouveauté d’histoire terminée');
});
let q = {};
await check('récompenses: plusieurs fins issues de la même case 1, chacune comptée une seule fois', async () => {
  const [c1, c2, c3] = await chain(['q1', 'q2', 'q3']);
  const ends = [await pub('q4', aliceRoom, c3), await pub('q5', aliceRoom, c3), await pub('q6', aliceRoom, c3)];
  q = { c1, ends };
  const p1 = await prog('q1');
  if (p1.completed !== 3 || p1.inspired !== 3) throw new Error(JSON.stringify(p1));
  const p3 = await prog('q3');
  if (p3.completed !== 3 || p3.inspired !== 0) throw new Error(JSON.stringify(p3));
  const [{ n }] = (await db.query("select count(*)::int n from story_credits where root_id=$1 and kind='inspired'", [c1])).rows;
  if (n !== 3) throw new Error(`${n} fins pour la case 1`);
  const inspired = (await events('q1')).filter((e) => e.kind === 'inspired');
  if (inspired.length !== 1 || inspired[0].n !== 3) throw new Error(JSON.stringify(inspired));
});
await check('récompenses: traitement répété du même événement, aucune récompense en double', async () => {
  const before = await prog('q1');
  const evBefore = (await events('q1')).length;
  for (const end of q.ends) {
    const again = (await db.query('select credit_story($1) n', [end])).rows[0].n;
    if (again !== 0) throw new Error(`recrédité: ${again}`);
  }
  const after = await prog('q1');
  if (JSON.stringify(before) !== JSON.stringify(after) || (await events('q1')).length !== evBefore) throw new Error('double comptage');
});
await check('récompenses: un joueur avec plusieurs premières cases cumule ses histoires inspirées', async () => {
  const a = await chain(['m1', 'm2', 'm3', 'm4']);
  const b = await chain(['m1', 'm3', 'm2', 'm4']);
  const p = await prog('m1');
  if (p.inspired !== 2 || p.completed !== 2) throw new Error(JSON.stringify(p));
  const per = (await db.query("select root_id, count(*)::int n from story_credits where user_id=$1 and kind='inspired' group by root_id", [users.m1])).rows;
  if (per.length !== 2 || per.some((r) => r.n !== 1) || !per.some((r) => r.root_id === a[0]) || !per.some((r) => r.root_id === b[0])) throw new Error(JSON.stringify(per));
});
await check('tampons: débloqués aux bons seuils, plusieurs à la fois, une seule nouveauté par tampon', async () => {
  const s = (await prog('p4')).stickers.join();
  if (s !== 'explosion') throw new Error(`p4: ${s}`);
  if ((await prog('p1')).stickers.slice().sort().join() !== 'explosion,mustache') throw new Error('p1');
  const q1 = (await prog('q1')).stickers.slice().sort().join();
  if (q1 !== 'explosion,glasses,mustache,speed') throw new Error(`q1: ${q1}`);
  const ev = kinds((await events('q1')).filter((e) => e.kind === 'sticker'));
  if (ev !== 'sticker:explosion,sticker:glasses,sticker:mustache,sticker:speed') throw new Error(ev);
  if ((await prog('q4')).stickers.includes('smoke')) throw new Error('seuil de 5 non atteint');
});
await check('tampons: changer un seuil débloque aux joueurs concernés sans jamais retirer un tampon acquis', async () => {
  const rules = [{ id: 'smoke', family: 'collective', threshold: 3 }];
  const n = (await db.query('select sync_reward_rules($1::jsonb, $2::int[]) n', [JSON.stringify(rules), '{3,5,10}'])).rows[0].n;
  if (n < 1 || !(await prog('q1')).stickers.includes('smoke')) throw new Error('smoke non débloqué à 3');
  await db.query("select sync_reward_rules($1::jsonb, '{3,5,10}'::int[])", [JSON.stringify([{ id: 'smoke', family: 'collective', threshold: 50 }])]);
  if (!(await prog('q1')).stickers.includes('smoke')) throw new Error('un tampon acquis a été retiré');
  await db.query("select sync_reward_rules($1::jsonb, '{3,5,10}'::int[])", [JSON.stringify([{ id: 'smoke', family: 'collective', threshold: 5 }])]);
});
await check('récompenses: lecture et écriture réservées au serveur, chacun ne voit que les siennes', async () => {
  if ((await as(users.p2, 'select * from story_credits where user_id=$1', [users.p1])).length) throw new Error('crédits d’autrui visibles');
  if ((await as(users.p2, 'select * from reward_events where user_id=$1', [users.p1])).length) throw new Error('nouveautés d’autrui visibles');
  await expectErr('row-level security', () => as(users.p2, "insert into story_credits(end_id, user_id, kind, root_id) values ($1,$2,'participant',$1)", [ends1[3], users.p2]));
  await expectErr('row-level security', () => as(users.p2, "insert into sticker_unlocks(user_id, sticker_id) values ($1,'ghost')", [users.p2]));
  await expectErr('row-level security', () => as(users.p2, "insert into reward_events(user_id, kind, dedupe_key) values ($1,'sticker','x')", [users.p2]));
  for (const f of ['credit_story($1)', 'evaluate_unlocks($1)', 'backfill_story_credits()', 'sync_reward_rules(\'[]\'::jsonb, \'{3}\'::int[])'])
    await expectErr('permission denied', () => as(users.p2, `select ${f}`, f.includes('$1') ? [ends1[3]] : []));
  const [mine] = await events('p1');
  if ((await as(users.p2, 'select mark_reward_events_seen($1::uuid[]) n', [`{${mine.id}}`]))[0].n !== 0) throw new Error('marqué par un autre joueur');
  if ((await as(users.p1, 'select mark_reward_events_seen($1::uuid[]) n', [`{${mine.id}}`]))[0].n !== 1) throw new Error('non marqué');
  if ((await as(users.p1, 'select mark_reward_events_seen($1::uuid[]) n', [`{${mine.id}}`]))[0].n !== 0) throw new Error('non idempotent');
  if ((await events('p1')).some((e) => e.id === mine.id)) throw new Error('toujours non lu');
});

let modEnd;
await check('modération: une histoire contenant un dessin masqué ne produit aucune récompense, puis en produit une une fois rétablie', async () => {
  const [s1, s2, s3] = await chain(['s1', 's2', 's3']);
  await as(users.s4, "select report_contribution($1, 'spam', null)", [s2]);
  modEnd = await pub('s4', aliceRoom, s3);
  if ((await prog('s1')).completed !== 0 || (await prog('s4')).completed !== 0) throw new Error('récompensé malgré le masquage');
  await as(users.adm, 'select admin_set_hidden($1::uuid[], false)', [`{${s2}}`]);
  for (const u of ['s1', 's2', 's3', 's4']) if ((await prog(u)).completed !== 1) throw new Error(`${u} non crédité après rétablissement`);
  if ((await prog('s1')).inspired !== 1) throw new Error('inspired');
});
await check('modération: l’administration peut retirer les récompenses d’une histoire abusive, définitivement', async () => {
  await expectErr('FORBIDDEN', () => as(users.s1, 'select admin_revoke_story($1)', [modEnd]));
  const n = (await as(users.adm, 'select admin_revoke_story($1) n', [modEnd]))[0].n;
  if (n !== 5) throw new Error(`${n} crédits retirés`);
  if ((await prog('s1')).completed !== 0) throw new Error('crédit conservé');
  if ((await db.query('select credit_story($1) n', [modEnd])).rows[0].n !== 0) throw new Error('recrédité');
  if (!(await prog('s1')).stickers.includes('explosion')) throw new Error('les tampons acquis doivent rester');
});

let gE, eEnd, eRoot;
await check('éphémère: après l’expiration du thème, récompenses et tampons restent acquis, les nouveautés sont marquées disparues', async () => {
  gE = await mkGame(40);
  const rE = await room(gE);
  eRoot = await plant(gE, rE, 'e1', 1, null);
  const e2 = await pub('e2', rE, eRoot);
  const e3 = await pub('e3', rE, e2);
  eEnd = await pub('e4', rE, e3);
  for (const u of ['e1', 'e2', 'e3', 'e4']) if ((await prog(u)).completed !== 1) throw new Error(`${u} avant`);
  const before = JSON.stringify(await prog('e1'));
  await db.query('select enable_expiry_purge()');
  const [gw] = (await db.query('select expires_at from weekly_games where id=$1', [gE])).rows;
  const res = (await db.query('select purge_expired_games($1) r', [new Date(gw.expires_at.getTime() + 1000)])).rows[0].r;
  if (res.purged < 1 || res.errors !== 0) throw new Error(JSON.stringify(res));
  if (JSON.stringify(await prog('e1')) !== before) throw new Error('compteur modifié par l’expiration');
  const [{ n }] = (await db.query('select count(*)::int n from contributions where game_id=$1', [gE])).rows;
  if (n !== 0) throw new Error('contributions restantes');
  const unseen = await events('e1');
  if (!unseen.every((e) => e.kind === 'sticker' || e.expired)) throw new Error(JSON.stringify(unseen));
  if (!unseen.some((e) => e.kind === 'story_done' && e.expired)) throw new Error('nouveauté non marquée disparue');
  if ((await events('e2', false, 'story_done')).length !== 0) throw new Error('une histoire disparue ne doit plus être listée');
  if ((await prog('e4')).stickers.join() !== 'explosion') throw new Error('tampon perdu');
});
await check('rattrapage: les histoires publiées avant le déploiement sont créditées une fois, sans nouveauté d’histoire', async () => {
  const gB = await mkGame(41);
  const rB = await room(gB);
  const b1 = await plant(gB, rB, 'b1', 1, null);
  const b2 = await plant(gB, rB, 'b2', 2, b1);
  const b3 = await plant(gB, rB, 'b3', 3, b2);
  const bEnd = await plant(gB, rB, 'b4', 4, b3);
  await db.query('select backfill_story_credits()');
  const second = (await db.query('select backfill_story_credits() n')).rows[0].n;
  const [{ n: credits }] = (await db.query('select count(*)::int n from story_credits where end_id=$1', [bEnd])).rows;
  if (credits !== 5 || second !== 0) throw new Error(`${credits} crédits, relance: ${second}`);
  if ((await prog('b1')).completed !== 1 || (await prog('b1')).inspired !== 1) throw new Error('b1');
  const ev = await events('b2');
  if (ev.some((e) => e.kind === 'story_done') || kinds(ev) !== 'sticker:explosion') throw new Error(kinds(ev));
  if (kinds(await events('b1')) !== 'sticker:explosion,sticker:mustache') throw new Error(kinds(await events('b1')));
});

console.log(results.join('\n'));
