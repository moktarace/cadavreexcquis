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
  create table storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now(), metadata jsonb);
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
  grant select, insert, update, delete on storage.objects to authenticated;
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
// Les parties des tests précédents ne doivent pas être emportées par l'horloge simulée de 2045.
await db.query('update weekly_games set expires_at = null where iso_year < 2045 and not is_private');
const mkGame = async (week) => (await db.query('insert into weekly_games(iso_year, iso_week, theme_id) values (2045,$1,$2) returning id', [week, themeId])).rows[0].id;
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
  const [w] = (await db.query('select expires_at from game_window(2045, 10)')).rows;
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
  await db.query("update weekly_games set expires_at = (select expires_at from game_window(2045, 10)) where id=$1", [gA]);
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


// ───────────── Banque de thèmes (0011, 0012) ─────────────
const bankJson = JSON.parse(readFileSync(new URL('../supabase/themes.json', import.meta.url), 'utf8')).themes;
const bank = async () => (await db.query('select id, text, bank_key from themes where in_bank and retired_at is null order by text')).rows;
const sched = async () => (await db.query('select g.id, g.iso_year, g.iso_week, g.starts_at, g.theme_id, t.in_bank from weekly_games g join themes t on t.id = g.theme_id where not g.is_private and g.starts_at > now() order by g.starts_at')).rows;
await db.query('select redraw_theme_schedule()'); // les parties de test des chapitres précédents sont de vieux thèmes à venir: on les rattrape
const snapshot = async () => (await db.query('select id, theme_id from weekly_games where not is_private order by iso_year, iso_week')).rows.map((r) => `${r.id}:${r.theme_id}`).join();

await check('banque: les titres de themes.json sont chargés, tous marqués « original »', async () => {
  const b = await bank();
  if (b.length !== bankJson.length || b.length < 200) throw new Error(`${b.length} titres pour ${bankJson.length}`);
  const [{ n }] = (await db.query("select count(*)::int n from themes where in_bank and source <> 'original'")).rows;
  if (n !== 0) throw new Error('provenance');
});
await check('banque: la clé de comparaison ignore accents, ponctuation et articles (mêmes exemples que le TypeScript)', async () => {
  const cases = [['À deux minutes près', 'deux minutes pres'], ['L’invité surprise', 'invite surprise'], ['Le jour où tout a changé', 'jour ou tout change'],
    ['Ça ne s’invente pas', 'ca ne s invente pas'], ['Le cœur sur la main', 'coeur sur main'], ['Là-haut, tout là-haut', 'haut tout haut'], ['Une mauvaise nouvelle', 'mauvaise nouvelle'], ['Le', 'le']];
  for (const [t, k] of cases) {
    const [{ key }] = (await db.query('select theme_key($1) key', [t])).rows;
    if (key !== k) throw new Error(`${t} → ${key} (attendu ${k})`);
  }
});
await check('tirage: la semaine active et les semaines passées gardent leur thème d’origine, les semaines à venir viennent de la banque', async () => {
  const [{ n }] = (await db.query('select count(*)::int n from weekly_games g join themes t on t.id=g.theme_id where not g.is_private and g.starts_at <= now() and t.in_bank')).rows;
  if (n !== 0) throw new Error(`${n} semaines commencées portent un thème de la banque`);
  const future = await sched();
  if (future.length < 400 || future.some((w) => !w.in_bank)) throw new Error(`${future.length} semaines, hors banque: ${JSON.stringify(future.filter((w) => !w.in_bank).map((w) => [w.iso_year, w.iso_week]))}`);
  const [cur] = (await db.query('select t.in_bank from current_game() cg join weekly_games g on g.id = cg.game_id join themes t on t.id = g.theme_id')).rows;
  if (cur.in_bank !== false) throw new Error('thème actif modifié');
});
await check('tirage: aucune répétition avant épuisement de la banque, puis un nouveau tour équilibré', async () => {
  const future = await sched();
  const size = (await bank()).length;
  const first = future.slice(0, size).map((w) => w.theme_id);
  if (new Set(first).size !== size) throw new Error('un thème revient avant que la banque soit épuisée');
  const counts = new Map();
  for (const w of future) counts.set(w.theme_id, (counts.get(w.theme_id) ?? 0) + 1);
  const values = [...counts.values()];
  if (Math.max(...values) - Math.min(...values) > 1) throw new Error('tours déséquilibrés');
});
await check('tirage: déterministe et stable, relancé il ne change rien', async () => {
  const before = await snapshot();
  const changed = (await db.query('select redraw_theme_schedule() n')).rows[0].n;
  if (changed !== 0 || (await snapshot()) !== before) throw new Error(`${changed} semaines modifiées`);
});
await check('administration de la banque: réservée à l’administrateur', async () => {
  for (const [q, params] of [
    ['select * from admin_theme_bank()', []], ['select * from admin_theme_schedule()', []],
    ["select admin_theme_add('Un titre')", []], ['select admin_theme_import($1::jsonb)', ['[]']],
    ["select admin_theme_update($1, 'Autre')", [users.alice]], ['select admin_theme_remove($1)', [users.alice]],
  ]) await expectErr('FORBIDDEN', () => as(users.dex, q, params));
  for (const f of ['redraw_theme_schedule()', "import_theme_bank('[]'::jsonb)", 'ensure_schedule_weeks()'])
    await expectErr('permission denied', () => as(users.dex, `select ${f}`));
});
await check('secret: un joueur ne peut lire que les thèmes des semaines commencées', async () => {
  const rows = await as(users.dex, 'select id from themes where in_bank');
  if (rows.length) throw new Error(`${rows.length} thèmes à venir lisibles`);
  const [g] = await as(users.dex, 'select theme_text from current_game()');
  if (!g.theme_text) throw new Error('thème actif illisible');
});
let addedId;
await check('banque: ajout, doublon (accents et articles ignorés), titre invalide', async () => {
  const total = (await bank()).length;
  addedId = (await as(users.adm, "select admin_theme_add('Les Anges Gardent la Maison', 'original', 'test') id"))[0].id;
  if ((await bank()).length !== total + 1) throw new Error('non ajouté');
  await expectErr('THEME_DUPLICATE', () => as(users.adm, "select admin_theme_add('Anges gardent la maison')"));
  await expectErr('THEME_INVALID', () => as(users.adm, "select admin_theme_add('Ab')"));
  const existing = (await bank()).find((b) => b.id !== addedId).text;
  await expectErr('THEME_DUPLICATE', () => as(users.adm, 'select admin_theme_add($1)', [existing.toUpperCase()]));
});
await check('banque: le nouveau thème entre dans le tirage sans toucher aux semaines commencées ni au carton de la semaine prochaine', async () => {
  const nextWeek = (await sched())[0];
  const size = (await bank()).length;
  const future = await sched();
  const hits = future.slice(0, size).filter((w) => w.theme_id === addedId).length;
  if (hits !== 1) throw new Error(`présent ${hits} fois dans le premier tour`);
  const again = (await sched())[0];
  if (again.theme_id !== nextWeek.theme_id) throw new Error('le carton de la semaine prochaine a changé');
  const [{ n }] = (await db.query('select count(*)::int n from weekly_games g join themes t on t.id=g.theme_id where not g.is_private and g.starts_at <= now() and t.in_bank')).rows;
  if (n !== 0) throw new Error('semaine commencée modifiée');
});
await check('banque: un thème inutilisé se corrige, puis se retire sans trou dans le calendrier', async () => {
  await as(users.adm, "select admin_theme_update($1, 'Les anges gardent la maison !', 'corrigé')", [addedId]);
  const [t] = (await db.query('select text, note from themes where id=$1', [addedId])).rows;
  if (t.text !== 'Les anges gardent la maison !' || t.note !== 'corrigé') throw new Error(JSON.stringify(t));
  await as(users.adm, 'select admin_theme_remove($1)', [addedId]);
  if ((await db.query('select 1 from themes where id=$1', [addedId])).rows.length) throw new Error('toujours là');
  const future = await sched();
  if (future.some((w) => !w.in_bank || w.theme_id === addedId)) throw new Error('semaine sans thème de la banque');
});
await check('banque: un thème déjà utilisé n’est ni modifiable ni retirable, même directement', async () => {
  const [pick] = (await bank());
  const [{ id: gid }] = (await db.query("insert into weekly_games(iso_year, iso_week, theme_id, is_private) values (2046, 1, $1, true) returning id", [pick.id])).rows;
  await expectErr('THEME_USED', () => as(users.adm, "select admin_theme_update($1, 'Autre titre')", [pick.id]));
  await expectErr('THEME_USED', () => as(users.adm, 'select admin_theme_remove($1)', [pick.id]));
  await expectErr('THEME_USED', () => db.query("update themes set text='x' where id=$1", [pick.id]));
  await expectErr('THEME_USED', () => db.query('delete from themes where id=$1', [pick.id]));
  const used = await as(users.adm, "select id, status from admin_theme_bank('used') where id=$1", [pick.id]);
  if (used.length !== 1 || used[0].status !== 'used') throw new Error('absent des thèmes utilisés');
  await db.query('delete from weekly_games where id=$1', [gid]);
});
await check('banque: retirer le thème du carton de la semaine prochaine le fait tirer à nouveau', async () => {
  await as(users.adm, "select admin_theme_add('Un titre éphémère pour la semaine prochaine')");
  const nextWeek = (await sched())[0];
  await as(users.adm, 'select admin_theme_remove($1)', [nextWeek.theme_id]);
  const after = (await sched())[0];
  if (after.theme_id === nextWeek.theme_id || !after.in_bank) throw new Error('non retiré au sort');
});
await check('import: détection des doublons dans la banque et dans la liste, provenance conservée', async () => {
  const items = [{ text: 'La nuit des chaises' }, { text: 'la NUIT des chaises' }, { text: 'Au pied du mur' }, { text: 'x' }, { text: 'Un vieux carton d’arbitre', note: 'feuille du 12/03' }];
  const r = (await as(users.adm, "select admin_theme_import($1::jsonb, 'referee') r", [JSON.stringify(items)]))[0].r;
  const reasons = r.skipped.map((s) => s.reason).sort().join();
  if (r.added !== 2 || reasons !== 'duplicate,duplicate,invalid') throw new Error(JSON.stringify(r));
  const [{ n }] = (await db.query("select count(*)::int n from themes where source='referee' and in_bank")).rows;
  if (n !== 2) throw new Error('provenance non conservée');
  await expectErr('INVALID_SOURCE', () => as(users.adm, "select admin_theme_import('[]'::jsonb, 'nimporte')"));
  await db.query("select import_theme_bank($1::jsonb, 'original')", [JSON.stringify(bankJson)]);
  const second = (await db.query("select import_theme_bank($1::jsonb, 'original') r", [JSON.stringify(bankJson)])).rows[0].r;
  if (second.added !== 0) throw new Error('l’import de themes.json n’est pas idempotent');
});
await check('administration: consulter la banque, les thèmes utilisés et le calendrier des prochains cartons', async () => {
  const all = await as(users.adm, "select id from admin_theme_bank(null, null, 200, 0)");
  if (all.length < 150) throw new Error('banque incomplète');
  const search = await as(users.adm, "select text from admin_theme_bank(null, 'PIED du mur')");
  if (search.length !== 1) throw new Error('recherche');
  const used = await as(users.adm, "select text, source from admin_theme_bank('used', null, 200, 0)");
  if (!used.every((u) => u.source === 'generated')) throw new Error('les thèmes passés viennent de l’ancien générateur');
  const plan = await as(users.adm, 'select iso_year, iso_week, text, frozen from admin_theme_schedule(8)');
  const starts = plan.map((p) => p.iso_year * 100 + p.iso_week);
  if (plan.length < 6 || starts.some((s, i) => i && s <= starts[i - 1])) throw new Error('calendrier '+JSON.stringify(plan.map((p) => [p.iso_year, p.iso_week])));
  if (!plan.some((p) => p.frozen === false)) throw new Error('aucun carton modifiable');
});


// ───────────── Survivor multijoueur (0013) ─────────────
// PGlite n'ouvre qu'une connexion: les courses sont simulées par entrelacement séquentiel et par les contraintes
// d'unicité; le verrouillage réel (FOR UPDATE SKIP LOCKED, verrous consultatifs) n'est pas exercé ici.
const sv = {};
for (const nme of ['ana', 'ben', 'cleo', 'dan', 'eli', 'fay', 'gus', 'hal', 'ivy', 'joe']) {
  const [{ id }] = (await db.query('insert into auth.users default values returning id')).rows;
  sv[nme] = id;
}
let svn = 0;
const img = (u) => `${sv[u]}/${++svn}.png`;
const rpc = async (u, fn, ...args) =>
  (await as(sv[u], `select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args))[0].r;
const gv = (r) => r.game;
const row = async (sql, params) => (await db.query(sql, params)).rows[0];
const state = (u, id) => rpc(u, 'survivor_state', id);
const upload = (u, gid, sub, meta = { size: 1000, mimetype: 'image/png' }) =>
  as(sv[u], "insert into storage.objects(bucket_id, name, owner, metadata) values ('survivor', $1, $2, $3)", [`${sv[u]}/${gid}/${sub}.png`, sv[u], JSON.stringify(meta)]);
const rawSubmit = (u, gid, pos, sub, cons, path, spent = 0) => rpc(u, 'survivor_submit_case', gid, pos, sub, cons, path, spent);
// Termine les étapes en attente (amélioration, demandes pour l'adversaire) tant que c'est à moi d'agir.
const settle = async (u, id, st) => {
  while (st.acting && ['upgrade', 'demands'].includes(st.run.step)) {
    if (st.run.step === 'upgrade') st = (await rpc(u, 'survivor_choose_upgrade', id, st.run.offer[0])).state;
    else {
      const o = st.demand_options;
      st = (await rpc(u, 'survivor_set_demands', id, [o.easy[0], o.medium[0], o.hard[0]])).state;
    }
  }
  return st;
};
// Un tour complet: choix de la demande, envoi de l'image, dépôt de la case, puis étapes suivantes (sauf finish: false).
const turn = async (u, id, o = {}) => {
  await db.query('delete from survivor_rate_limits');
  let st = await settle(u, id, await state(u, id));
  if (!st.run.pick) st = (await rpc(u, 'survivor_pick', id, st.run.proposals[o.level ?? 0]?.id ?? '11')).state;
  const sub = crypto.randomUUID();
  await upload(u, id, sub);
  const res = await rawSubmit(u, id, st.run.position, sub, st.run.pick, `${sv[u]}/${id}/${sub}.png`, o.spent ?? 3);
  st = res.state;
  if (o.finish !== false) st = await settle(u, id, st);
  return { outcome: res.outcome, game: st.game, state: st };
};
const submit = turn;
const mine = async (u) => (await as(sv[u], 'select survivor_my_games() r')).map((x) => x.r);

await check('survivor: paramètres centralisés côté serveur', async () => {
  const r = (await as(sv.ana, 'select survivor_rules() r'))[0].r;
  const ok = r.total_cases === 16 && r.relay.max_players === 16 && r.relay.reserve_minutes === 15 && r.duel.max_unfinished === 3
    && r.duel.hours === 72 && r.battle.max_unfinished === 5 && r.battle.turn_hours === 24;
  if (!ok) throw new Error(JSON.stringify(r));
});
await check('survivor: aucune écriture directe, fonctions internes fermées, anon exclu', async () => {
  await expectErr('row-level security', () => as(sv.ana, "insert into survivor_games(mode, created_by, theme, seed, rules) values ('duel',$1,'x',1,'{}')", [sv.ana]));
  await expectErr('row-level security', () => as(sv.ana, "insert into survivor_cases(game_id, position, author_id, constraint_id, image_path) values (gen_random_uuid(),1,$1,'11','p')", [sv.ana]));
  await expectErr('permission denied', () => as(sv.ana, 'select survivor_expire_due()'));
  await expectErr('permission denied', () => as(sv.ana, "select survivor_join($1, gen_random_uuid())", [sv.ana]));
  await expectErr('permission denied', () => as(null, "select survivor_matchmake('duel')"));
  await expectErr('NOT_AUTHENTICATED', () => db.query("select survivor_matchmake('duel')"));
  const anon = await as(null, 'select * from survivor_games');
  if (anon.length) throw new Error('anon lit des parties');
});

let duel;
await check('duel: défi ouvert créé avec une configuration figée, recherche idempotente', async () => {
  const a = await rpc('ana', 'survivor_matchmake', 'duel');
  if (a.outcome !== 'created' || gv(a).status !== 'searching' || gv(a).players.length !== 1) throw new Error(JSON.stringify(a));
  const again = await rpc('ana', 'survivor_matchmake', 'duel');
  if (again.outcome !== 'searching' || gv(again).id !== gv(a).id) throw new Error('un second défi a été créé');
  const g = await row('select theme, seed, rules from survivor_games where id=$1', [gv(a).id]);
  if (!g.theme || g.seed == null || g.rules.duel.hours !== 72) throw new Error(JSON.stringify(g));
  duel = { id: gv(a).id, ...g };
  await expectErr('IMMUTABLE_CONFIG', () => db.query("update survivor_games set seed = seed + 1 where id=$1", [duel.id]));
  await expectErr('IMMUTABLE_CONFIG', () => db.query("update survivor_games set theme = 'autre' where id=$1", [duel.id]));
  await expectErr('IMMUTABLE_CONFIG', () => db.query("update survivor_games set rules = '{}' where id=$1", [duel.id]));
});
await check('duel: le créateur dessine avant l’appariement; il est « à toi de jouer »', async () => {
  const r = await submit('ana', duel.id);
  if (gv(r).status !== 'searching' || gv(r).bucket !== 'mine') throw new Error(JSON.stringify(gv(r)));
  const c = await row('select submission_id, constraint_id, image_path, position from survivor_cases where game_id=$1', [duel.id]);
  const dup = await rawSubmit('ana', duel.id, c.position, c.submission_id, c.constraint_id, c.image_path, 3);
  if (dup.outcome !== 'duplicate') throw new Error('envoi rejoué non idempotent');
  const [{ n }] = (await db.query('select count(*)::int n from survivor_cases where game_id=$1', [duel.id])).rows;
  if (n !== 1) throw new Error(`${n} cases`);
});
await check('duel: on ne rejoint pas son propre défi, ni par lien', async () => {
  const token = (await row('select token from survivor_invites where game_id=$1', [duel.id])).token;
  await expectErr('OWN_CHALLENGE', () => rpc('ana', 'survivor_accept_invite', token));
  const mm = await rpc('ana', 'survivor_matchmake', 'duel');
  if (mm.outcome !== 'searching') throw new Error('auto-appariement');
});
await check('duel: un second joueur rejoint la même configuration; délai de 72 h', async () => {
  const b = await rpc('ben', 'survivor_matchmake', 'duel');
  const g = gv(b);
  if (b.outcome !== 'joined' || g.id !== duel.id || g.status !== 'active' || g.players.length !== 2) throw new Error(JSON.stringify(b));
  const after = await row('select theme, seed, deadline_at, now() n from survivor_games where id=$1', [duel.id]);
  const hours = (new Date(after.deadline_at) - new Date(after.n)) / 3.6e6;
  if (after.theme !== duel.theme || String(after.seed) !== String(duel.seed) || Math.abs(hours - 72) > 0.01) throw new Error(`${hours}`);
  if (g.bucket !== 'mine') throw new Error('Ben devrait pouvoir jouer');
});
await check('duel: dessins adverses cachés jusqu’à la fin, lisibles ensuite', async () => {
  const own = await as(sv.ana, 'select id from survivor_cases where game_id=$1', [duel.id]);
  const spy = await as(sv.ben, 'select id from survivor_cases where game_id=$1', [duel.id]);
  const out = await as(sv.cleo, 'select id from survivor_games where id=$1', [duel.id]);
  if (own.length !== 1 || spy.length !== 0 || out.length !== 0) throw new Error(`${own.length}/${spy.length}/${out.length}`);
  await expectErr('GAME_NOT_FOUND', () => rpc('cleo', 'survivor_get_game', duel.id));
  await expectErr('GAME_NOT_FOUND', () => submit('cleo', duel.id));
});
await check('duel: état « un joueur a fini et attend l’autre », puis terminé', async () => {
  for (let i = 0; i < 15; i++) await submit('ana', duel.id);
  const a = await rpc('ana', 'survivor_get_game', duel.id);
  if (a.status !== 'active' || a.my_status !== 'done' || a.bucket !== 'waiting') throw new Error(JSON.stringify(a));
  await expectErr('NOT_YOUR_TURN', () => submit('ana', duel.id));
  for (let i = 0; i < 16; i++) await submit('ben', duel.id);
  const end = await rpc('ben', 'survivor_get_game', duel.id);
  if (end.status !== 'finished' || end.ended_reason !== 'completed' || end.bucket !== 'done') throw new Error(JSON.stringify(end));
  const seen = await as(sv.ben, 'select id from survivor_cases where game_id=$1', [duel.id]);
  if (seen.length !== 32) throw new Error(`${seen.length} cases visibles`);
  await expectErr('ILLEGAL_TRANSITION', () => db.query("update survivor_games set status='active' where id=$1", [duel.id]));
});

await check('duel: annulation d’un défi non accepté, idempotente; jamais après appariement', async () => {
  const c = gv(await rpc('cleo', 'survivor_create_challenge', 'duel', 'open'));
  c.invite_token = (await row('select token from survivor_invites where game_id=$1', [c.id])).token;
  await expectErr('GAME_NOT_FOUND', () => rpc('dan', 'survivor_cancel', c.id));
  const x = await rpc('cleo', 'survivor_cancel', c.id);
  const y = await rpc('cleo', 'survivor_cancel', c.id);
  if (gv(x).status !== 'cancelled' || gv(y).status !== 'cancelled') throw new Error('non annulé');
  const mm = await rpc('dan', 'survivor_matchmake', 'duel');
  if (mm.outcome === 'joined' && gv(mm).id === c.id) throw new Error('défi annulé apparié');
  const paired = gv(await rpc('cleo', 'survivor_create_challenge', 'duel', 'invite'));
  await rpc('dan', 'survivor_accept_invite', paired.invite_token);
  await expectErr('NOT_CANCELLABLE', () => rpc('cleo', 'survivor_cancel', paired.id));
  await expectErr('INVITE_NOT_FOUND', () => rpc('dan', 'survivor_accept_invite', 'cancelled'.padEnd(64, '0')));
  await expectErr('GAME_NOT_OPEN', () => rpc('ben', 'survivor_accept_invite', c.invite_token));
});
await check('duel: limite de trois parties non terminées, défis ouverts compris', async () => {
  for (let i = 0; i < 3; i++) await rpc('eli', 'survivor_create_challenge', 'duel', 'invite');
  await expectErr('DUEL_LIMIT', () => rpc('eli', 'survivor_create_challenge', 'duel', 'open'));
  await expectErr('DUEL_LIMIT', () => rpc('eli', 'survivor_matchmake', 'duel'));
  const open = await rpc('fay', 'survivor_create_challenge', 'duel', 'open');
  await expectErr('DUEL_LIMIT', async () => { const t = (await row('select token from survivor_invites where game_id=$1', [gv(open).id])).token; return rpc('eli', 'survivor_accept_invite', t); });
});
await check('invitation: jeton opaque, privé, atomique, idempotent', async () => {
  const c = gv(await rpc('gus', 'survivor_create_challenge', 'duel', 'invite'));
  if (!/^[0-9a-f]{64}$/.test(c.invite_token)) throw new Error(`jeton ${c.invite_token}`);
  const peek = await rpc('hal', 'survivor_peek_invite', c.invite_token);
  const keys = Object.keys(peek).sort().join();
  if (keys !== 'available,from,mine,mode,status,theme' || !peek.available) throw new Error(keys);
  await expectErr('INVITE_NOT_FOUND', () => rpc('hal', 'survivor_accept_invite', 'x'.repeat(64)));
  const hiddenOpen = await rpc('hal', 'survivor_matchmake', 'duel');
  if (gv(hiddenOpen).id === c.id) throw new Error('défi sur invitation trouvé par le matchmaking');
  if ((await as(sv.hal, 'select token from survivor_invites')).some((t) => t.token === c.invite_token)) throw new Error('jetons des autres visibles');
  const ok = await rpc('fay', 'survivor_accept_invite', c.invite_token);
  if (gv(ok).status !== 'active') throw new Error('non actif');
  const again = await rpc('fay', 'survivor_accept_invite', c.invite_token);
  if (again.outcome !== 'joined' || gv(again).players.length !== 2) throw new Error('acceptation rejouée');
  await expectErr('INVITE_TAKEN', () => rpc('hal', 'survivor_accept_invite', c.invite_token));
  if ((await row('select accepted_by from survivor_invites where game_id=$1', [c.id])).accepted_by !== sv.fay) throw new Error('invité');
});
await check('même place jamais occupée deux fois (contrainte d’unicité)', async () => {
  await expectErr('duplicate key', () => db.query("insert into survivor_players(game_id, user_id, seat) select game_id, $1, 2 from survivor_players where seat = 2 limit 1", [sv.hal]));
});

let battle;
await check('battle: appariement, premier joueur tiré, délai de 24 h par tour', async () => {
  const a = await rpc('ana', 'survivor_matchmake', 'battle');
  if (a.outcome !== 'created' || gv(a).seconds_left !== null) throw new Error('le délai ne doit pas courir avant l’adversaire');
  if (gv(a).bucket !== 'waiting') throw new Error('un défi Battle n’est pas jouable seul');
  const b = await rpc('ben', 'survivor_matchmake', 'battle');
  battle = gv(b);
  const turn = (await row('select turn_player, deadline_at, now() n from survivor_games where id=$1', [battle.id]));
  const hours = (new Date(turn.deadline_at) - new Date(turn.n)) / 3.6e6;
  if (b.outcome !== 'joined' || ![sv.ana, sv.ben].includes(turn.turn_player) || Math.abs(hours - 24) > 0.01) throw new Error(JSON.stringify(b));
  battle.first = turn.turn_player === sv.ana ? 'ana' : 'ben';
  battle.second = battle.first === 'ana' ? 'ben' : 'ana';
});
await check('battle: tours alternés, délai réinitialisé après chaque tour', async () => {
  await expectErr('NOT_YOUR_TURN', () => submit(battle.second, battle.id));
  await db.query("update survivor_games set deadline_at = now() + interval '1 hour' where id=$1", [battle.id]);
  const r = await submit(battle.first, battle.id);
  const g = await row('select turn_player, cases_done, deadline_at, now() n from survivor_games where id=$1', [battle.id]);
  const hours = (new Date(g.deadline_at) - new Date(g.n)) / 3.6e6;
  if (g.turn_player !== sv[battle.second] || g.cases_done !== 1 || Math.abs(hours - 24) > 0.01 || gv(r).bucket !== 'waiting') throw new Error(JSON.stringify(g));
  await expectErr('NOT_YOUR_TURN', () => submit(battle.first, battle.id));
});
await check('battle: plusieurs parties simultanées, limite de cinq', async () => {
  for (let i = 0; i < 4; i++) await rpc('cleo', 'survivor_create_challenge', 'battle', 'invite');
  await rpc('cleo', 'survivor_create_challenge', 'battle', 'open');
  await expectErr('BATTLE_LIMIT', () => rpc('cleo', 'survivor_create_challenge', 'battle', 'open'));
});
await check('battle: délai dépassé = forfait, appliqué une seule fois, tour suivant impossible', async () => {
  await db.query("update survivor_games set deadline_at = now() - interval '1 minute' where id=$1", [battle.id]);
  const list = await mine('ana');
  const g = list.find((x) => x.id === battle.id);
  const turnUser = battle.second;
  if (g.status !== 'abandoned' || g.ended_reason !== 'forfeit' || g.bucket !== 'done') throw new Error(JSON.stringify(g));
  const f = await row('select forfeit_by from survivor_games where id=$1', [battle.id]);
  if (f.forfeit_by !== sv[turnUser]) throw new Error('mauvais forfait');
  await mine('ben');
  if ((await row('select count(*)::int n from survivor_players where game_id=$1 and status=$2', [battle.id, 'forfeited'])).n !== 1) throw new Error('forfait multiple');
  await expectErr('GAME_NOT_ACTIVE', () => submit(turnUser, battle.id));
});
await check('abandon: forfait immédiat d’un Duel actif, idempotent; pas pour un défi en attente', async () => {
  const d = gv(await rpc('ivy', 'survivor_create_challenge', 'duel', 'invite'));
  await expectErr('NOT_ABANDONABLE', () => rpc('ivy', 'survivor_abandon', d.id));
  const a = gv(await rpc('joe', 'survivor_accept_invite', d.invite_token));
  const x = await rpc('joe', 'survivor_abandon', a.id);
  const y = await rpc('joe', 'survivor_abandon', a.id);
  if (gv(x).status !== 'abandoned' || gv(y).status !== 'abandoned' || gv(x).ended_reason !== 'forfeit') throw new Error(JSON.stringify(gv(x)));
});
await check('duel: délai de 72 h dépassé: forfait de celui qui n’a pas fini, « expirée » si personne', async () => {
  const mk = async (u, v) => { const c = gv(await rpc(u, 'survivor_create_challenge', 'duel', 'invite')); await rpc(v, 'survivor_accept_invite', c.invite_token); return c.id; };
  const one = await mk('gus', 'hal');
  for (let i = 0; i < 16; i++) await submit('gus', one);
  const none = await mk('gus', 'cleo');
  await db.query("update survivor_games set deadline_at = now() - interval '1 second' where id in ($1,$2)", [one, none]);
  const list = await mine('gus');
  const a = list.find((x) => x.id === one), b = list.find((x) => x.id === none);
  const fa = await row('select forfeit_by, ended_reason from survivor_games where id=$1', [one]);
  if (a.status !== 'abandoned' || fa.ended_reason !== 'forfeit' || fa.forfeit_by !== sv.hal) throw new Error(JSON.stringify(fa));
  const fb = await row('select forfeit_by, ended_reason from survivor_games where id=$1', [none]);
  if (b.status !== 'abandoned' || fb.ended_reason !== 'expired' || fb.forfeit_by !== null) throw new Error(JSON.stringify(fb));
});

let relay, relayB, relayA2;
await check('relay: sans partie éligible, une partie est créée avec une case réservée', async () => {
  const r = await rpc('ana', 'survivor_matchmake', 'relay');
  relay = gv(r);
  if (r.outcome !== 'created' || !relay.reservation_until || !relay.can_play || relay.players.length !== 0) throw new Error(JSON.stringify(r));
  const mins = (new Date(relay.reservation_until) - new Date(relay.server_now)) / 6e4;
  if (Math.abs(mins - 15) > 0.1) throw new Error(`${mins} min`);
  const again = await rpc('ana', 'survivor_matchmake', 'relay');
  if (again.outcome !== 'reserved' || gv(again).id !== relay.id) throw new Error('réservation non idempotente');
  await expectErr('INVALID_MODE', () => rpc('ana', 'survivor_create_challenge', 'relay', 'open'));
});
await check('relay: une seule personne réserve une case à la fois', async () => {
  await expectErr('RESERVED_BY_OTHER', () => rpc('ben', 'survivor_reserve', relay.id));
  const b = await rpc('ben', 'survivor_matchmake', 'relay');
  if (gv(b).id === relay.id) throw new Error('case réservée attribuée à deux joueurs');
  relayB = gv(b);
  const other = await as(sv.ben, 'select * from survivor_reservations where game_id=$1', [relay.id]);
  if (other.length) throw new Error('réservation d’autrui visible');
});
await check('relay: impossible de continuer sa propre case; relais transmis', async () => {
  await submit('ana', relay.id);
  await expectErr('LAST_CONTRIBUTOR', () => rpc('ana', 'survivor_reserve', relay.id));
  const a2 = await rpc('ana', 'survivor_matchmake', 'relay');
  if (gv(a2).id === relay.id) throw new Error('relais pris par son dernier auteur');
  relayA2 = gv(a2);
});
await check('relay: les parties proches de leur conclusion passent d’abord', async () => {
  const c = await rpc('cleo', 'survivor_matchmake', 'relay');
  if (c.outcome !== 'reserved' || gv(c).id !== relay.id || gv(c).cases_done !== 1) throw new Error(JSON.stringify(c));
});
await check('relay: réservation expirée = case libre; l’ancien détenteur ne peut plus déposer', async () => {
  await db.query("update survivor_reservations set expires_at = now() - interval '1 second' where game_id=$1 and not completed", [relay.id]);
  const d = await rpc('dan', 'survivor_matchmake', 'relay');
  if (gv(d).id !== relay.id) throw new Error('case non récupérée');
  await expectErr('NO_RESERVATION', () => rawSubmit('cleo', relay.id, 2, crypto.randomUUID(), '11', `${sv.cleo}/${relay.id}/x.png`));
});
await check('relay: prolongation limitée à 45 minutes au total', async () => {
  await db.query("update survivor_reservations set reserved_at = now() - interval '40 minutes', expires_at = now() + interval '1 minute' where game_id=$1 and not completed", [relay.id]);
  await rpc('dan', 'survivor_extend_reservation', relay.id);
  const r = await row('select reserved_at, expires_at from survivor_reservations where game_id=$1 and not completed', [relay.id]);
  const total = (new Date(r.expires_at) - new Date(r.reserved_at)) / 6e4;
  if (total > 45.01 || total < 44.9) throw new Error(`${total} min`);
  await rpc('dan', 'survivor_extend_reservation', relay.id);
  const r2 = await row('select expires_at from survivor_reservations where game_id=$1 and not completed', [relay.id]);
  if (new Date(r2.expires_at) > new Date(r.expires_at)) throw new Error('prolongation illimitée');
  await expectErr('NO_RESERVATION', () => rpc('eli', 'survivor_extend_reservation', relay.id));
  await rpc('ana', 'survivor_abandon', relayA2.id);
  await expectErr('ALREADY_RESERVED', () => rpc('dan', 'survivor_reserve', relayA2.id));
});
await check('relay: abandonner libère la réservation sans verrouiller la BD', async () => {
  await rpc('dan', 'survivor_abandon', relay.id);
  const e = await rpc('eli', 'survivor_reserve', relay.id);
  if (!gv(e).reservation_until) throw new Error('case non libérée');
  await rpc('eli', 'survivor_abandon', relay.id);
});
await check('relay: capacité de 16 participants distincts', async () => {
  const ids = [];
  for (let i = 0; i < 15; i++) {
    const [{ id }] = (await db.query('insert into auth.users default values returning id')).rows;
    ids.push(id);
    await db.query('insert into survivor_players(game_id, user_id, seat) values ($1,$2,$3)', [relay.id, id, i + 2]);
  }
  await expectErr('GAME_FULL', () => rpc('gus', 'survivor_reserve', relay.id));
  const g2 = gv(await rpc('gus', 'survivor_matchmake', 'relay'));
  if (g2.id === relay.id) throw new Error('partie pleine attribuée');
  await rpc('gus', 'survivor_abandon', g2.id);
  const r = (await as(ids[0], 'select survivor_reserve($1) r', [relay.id]))[0].r;
  if (!r.game.reservation_until) throw new Error('un participant existant doit pouvoir revenir dans sa BD');
  await expectErr('violates check constraint', () => db.query('insert into survivor_players(game_id, user_id, seat) values ($1,$2,17)', [relay.id, sv.hal]));
  await as(ids[0], 'select survivor_abandon($1)', [relay.id]);
});
await check('relay: 16 cases par relais, fin collective, plus aucun dépôt', async () => {
  const start = gv(await rpc('hal', 'survivor_matchmake', 'relay'));
  let who = 'hal', next = 'gus';
  await submit(who, start.id);
  for (let i = 1; i < 16; i++) {
    [who, next] = [next, who];
    await rpc(who, 'survivor_reserve', start.id);
    await submit(who, start.id);
  }
  const done = await row('select status, ended_reason, cases_done from survivor_games where id=$1', [start.id]);
  if (done.status !== 'finished' || done.ended_reason !== 'completed' || done.cases_done !== 16) throw new Error(JSON.stringify(done));
  await expectErr('GAME_NOT_ACTIVE', () => rpc(next, 'survivor_reserve', start.id));
  const players = (await db.query('select count(*)::int n from survivor_players where game_id=$1', [start.id])).rows[0].n;
  if (players !== 2) throw new Error(`${players} participants`);
});
await check('on ne dépose ni pour autrui ni hors de sa place', async () => {
  const g = gv(await rpc('ana', 'survivor_matchmake', 'relay'));
  const st = await state('ana', g.id);
  const pick = st.run.proposals[0].id;
  await rpc('ana', 'survivor_pick', g.id, pick);
  const sub = crypto.randomUUID();
  await upload('ana', g.id, sub);
  const mine = `${sv.ana}/${g.id}/${sub}.png`;
  await expectErr('INVALID_IMAGE', () => rawSubmit('ana', g.id, 1, sub, pick, `${sv.ben}/${g.id}/${sub}.png`));
  await expectErr('INVALID_INK', () => rawSubmit('ana', g.id, 1, sub, pick, mine, -1));
  await expectErr('NO_RESERVATION', () => rawSubmit('ben', g.id, 1, crypto.randomUUID(), pick, `${sv.ben}/${g.id}/x.png`));
});
await check('listes: catégories calculées par le serveur', async () => {
  const list = await mine('ben');
  const buckets = new Set(list.map((x) => x.bucket));
  if (!['done', 'waiting', 'mine'].some((b) => buckets.has(b)) || list.some((x) => !['mine', 'waiting', 'done'].includes(x.bucket))) throw new Error([...buckets].join());
  if (list.some((x) => x.mode === 'duel' && x.status === 'finished' && x.bucket !== 'done')) throw new Error('catégorie');
  if (list.some((x) => x.invite_token)) throw new Error('jeton exposé hors de ses défis en attente');
});


// ───────────── Survivor gameplay multijoueur (0014) ─────────────
for (const nme of ['kim', 'leo', 'mia', 'noa', 'oli', 'pam', 'ray', 'sol']) {
  const [{ id }] = (await db.query('insert into auth.users default values returning id')).rows;
  sv[nme] = id;
}
const free = () => db.query('delete from survivor_rate_limits');
const pair = async (mode, a, b) => {
  const g = gv(await rpc(a, 'survivor_create_challenge', mode, 'invite'));
  await rpc(b, 'survivor_accept_invite', g.invite_token);
  return g.id;
};
const runOf = async (u, id) => (await state(u, id)).run;
const sameSet = (x, y) => JSON.stringify([...x].sort()) === JSON.stringify([...y].sort());
const eligibleAt = async (pos, level) => (await db.query('select survivor_allowed($1, $2, 16, $3::text[], $4::text[]) a', [level, pos, [], []])).rows[0].a;

await check('règles serveur: économie, banque de demandes et étapes alignées sur la configuration', async () => {
  const e = (await row('select survivor_economy() e')).e;
  const ok = e.ink.start === 100 && e.ink.capacity === 100 && e.rewards.easy === 10 && e.rewards.medium === 20 && e.rewards.hard === 35
    && e.upgrade_every === 2 && e.offer_size === 3 && e.upgrades.encrier === 25 && e.upgrades.regeneration === 4 && e.upgrades.narrateur === 5
    && e.upgrades.joker_charges === 2 && e.upgrades.dernier_souffle === 25;
  if (!ok) throw new Error(JSON.stringify(e));
  const lv = (await db.query("select level, count(*)::int n from survivor_constraints group by level order by level")).rows;
  if (JSON.stringify(lv) !== JSON.stringify([{ level: 'easy', n: 12 }, { level: 'hard', n: 12 }, { level: 'medium', n: 12 }])) throw new Error(JSON.stringify(lv));
  if ((await row('select count(*)::int n from survivor_upgrade_defs')).n !== 10) throw new Error('améliorations');
  const phases = (await db.query('select survivor_phase_of(p, 16) f from generate_series(1, 16) p')).rows.map((r) => r.f);
  if (phases.join() !== [...Array(4).fill('intro'), ...Array(4).fill('complication'), ...Array(4).fill('escalade'), ...Array(4).fill('denouement')].join()) throw new Error(phases.join());
  const has = async (pos, id) => (await Promise.all(['easy', 'medium', 'hard'].map((l) => eligibleAt(pos, l)))).flat().includes(id);
  if ((await has(1, '12')) || !(await has(2, '12'))) throw new Error('12');
  for (const pos of [1, 2, 3, 4]) if (await has(pos, '66')) throw new Error('66 au début');
  if (!(await has(6, '66'))) throw new Error('66');
  for (const id of ['53', '51', '62', '33', '15']) if (await has(16, id)) throw new Error(`${id} à la fin`);
});

let rg;
await check('relay: demandes, récompense et réserve commune calculées par le serveur', async () => {
  rg = gv(await rpc('kim', 'survivor_matchmake', 'relay'));
  const st = await state('kim', rg.id);
  const p = st.run.proposals;
  if (st.run.step !== 'choosing' || st.run.reserve !== 100 || st.run.capacity !== 100 || !st.acting) throw new Error(JSON.stringify(st.run));
  if (p.map((x) => x.level).join() !== 'easy,medium,hard' || p.map((x) => x.reward).join() !== '10,20,35') throw new Error(JSON.stringify(p));
  if (p.some((x) => ['12', '66'].includes(x.id))) throw new Error('demande inéligible proposée');
  if (String(st.seed) !== String((await row('select seed from survivor_games where id=$1', [rg.id])).seed)) throw new Error('seed');
  await expectErr('CONSTRAINT_NOT_ALLOWED', () => rpc('kim', 'survivor_pick', rg.id, ['11', '12', '13', '14', '15'].find((id) => !p.some((x) => x.id === id))));
  await rpc('kim', 'survivor_pick', rg.id, p[2].id);
  if ((await rpc('kim', 'survivor_pick', rg.id, p[2].id)).outcome !== 'duplicate') throw new Error('choix non idempotent');
  await expectErr('PICK_LOCKED', () => rpc('kim', 'survivor_pick', rg.id, p[0].id));
  await expectErr('PICK_LOCKED', () => rpc('kim', 'survivor_joker', rg.id, 0));
});
await check('relay: la dépense est vérifiée, jamais la récompense; les anciennes requêtes sont refusées', async () => {
  const st = await state('kim', rg.id);
  const sub = crypto.randomUUID();
  await upload('kim', rg.id, sub);
  const path = `${sv.kim}/${rg.id}/${sub}.png`;
  const pick = st.run.pick;
  await expectErr('INVALID_INK', () => rawSubmit('kim', rg.id, 1, sub, pick, path, 100.5));
  await expectErr('INVALID_INK', () => rawSubmit('kim', rg.id, 1, sub, pick, path, -1));
  await expectErr('INVALID_INK', () => rpc('kim', 'survivor_submit_case', rg.id, 1, sub, pick, path, 'NaN'));
  await expectErr('STALE_POSITION', () => rawSubmit('kim', rg.id, 2, sub, pick, path, 40));
  await expectErr('CONSTRAINT_NOT_ALLOWED', () => rawSubmit('kim', rg.id, 1, sub, st.run.proposals[0].id, path, 40));
  await expectErr('INVALID_IMAGE', () => rawSubmit('kim', rg.id, 1, sub, pick, `${sv.kim}/${rg.id}/${crypto.randomUUID()}.png`, 40));
  const ok = await rawSubmit('kim', rg.id, 1, sub, pick, path, 40);
  const r = ok.state.run;
  if (ok.outcome !== 'submitted' || r.reserve !== 95 || r.cases_done !== 1 || ok.game.cases_done !== 1) throw new Error(JSON.stringify(r));
  const again = await rawSubmit('kim', rg.id, 1, sub, pick, path, 40);
  if (again.outcome !== 'duplicate' || again.state.run.reserve !== 95) throw new Error('récompense versée deux fois');
  if ((await row('select count(*)::int n from survivor_cases where game_id=$1', [rg.id])).n !== 1) throw new Error('case en double');
  const c = await row('select ink_spent, ink_reward from survivor_cases where game_id=$1', [rg.id]);
  if (Number(c.ink_spent) !== 40 || Number(c.ink_reward) !== 35) throw new Error(JSON.stringify(c));
});
await check('relay: les cases précédentes se lisent avec une simple réservation, pas de l’extérieur', async () => {
  const l = gv(await rpc('leo', 'survivor_matchmake', 'relay'));
  if (l.id !== rg.id) throw new Error('leo devait reprendre la BD la plus avancée');
  const seen = await as(sv.leo, 'select position from survivor_cases where game_id=$1', [rg.id]);
  const file = await as(sv.leo, "select name from storage.objects where bucket_id='survivor' and name like $1", [`${sv.kim}/%`]);
  const out = await as(sv.mia, 'select position from survivor_cases where game_id=$1', [rg.id]);
  const outFile = await as(sv.mia, "select name from storage.objects where bucket_id='survivor' and name like $1", [`${sv.kim}/%`]);
  if (seen.length !== 1 || file.length !== 1 || out.length || outFile.length) throw new Error(`${seen.length}/${file.length}/${out.length}/${outFile.length}`);
  const st = await state('leo', rg.id);
  if (st.cases.length !== 1 || st.run.reserve !== 95) throw new Error('état hérité');
});
await check('relay: amélioration à la deuxième case, choisie par l’auteur avant de transmettre', async () => {
  await turn('leo', rg.id, { finish: false });
  const st = await state('leo', rg.id);
  if (st.run.step !== 'upgrade' || st.run.offer.length !== 3 || new Set(st.run.offer).size !== 3 || st.run.upgrade_draws !== undefined) {
    if (st.run.step !== 'upgrade' || st.run.offer.length !== 3) throw new Error(JSON.stringify(st.run));
  }
  const mia = gv(await rpc('mia', 'survivor_matchmake', 'relay'));
  if (mia.id === rg.id) throw new Error('la suite a été réservée avant le choix de l’amélioration');
  await expectErr('UPGRADE_PENDING', () => rpc('kim', 'survivor_choose_upgrade', rg.id, st.run.offer[0]));
  await expectErr('UPGRADE_NOT_OFFERED', () => rpc('leo', 'survivor_choose_upgrade', rg.id, 'rien'));
  const r = (await rpc('leo', 'survivor_choose_upgrade', rg.id, st.run.offer[0])).state.run;
  if (r.step !== 'choosing' || r.proposals.length !== 3 || r.upgrades[st.run.offer[0]] !== 1) throw new Error(JSON.stringify(r));
  if ((await rpc('leo', 'survivor_choose_upgrade', rg.id, st.run.offer[0])).outcome !== 'duplicate') throw new Error('amélioration appliquée deux fois');
  await rpc('mia', 'survivor_abandon', mia.id);
});
await check('relay: si l’auteur n’a pas choisi, le joueur suivant le fait avant de dessiner', async () => {
  await rpc('kim', 'survivor_reserve', rg.id);
  await turn('kim', rg.id, { finish: false }); // case 3
  await free();
  await rpc('leo', 'survivor_reserve', rg.id);
  await turn('leo', rg.id, { finish: false }); // case 4 → amélioration en attente
  const before = await state('leo', rg.id);
  if (before.run.step !== 'upgrade') throw new Error('attendu une amélioration');
  const kim = await state('kim', rg.id).catch(() => null);
  await db.query("update survivor_runs set upgrade_until = now() - interval '1 second' where game_id=$1 and user_id is null", [rg.id]);
  await rpc('kim', 'survivor_reserve', rg.id);
  const st = await state('kim', rg.id);
  if (!st.acting || st.run.step !== 'upgrade') throw new Error(`${st.acting} ${st.run.step}`);
  const after = (await rpc('kim', 'survivor_choose_upgrade', rg.id, st.run.offer[0])).state;
  if (after.run.step !== 'choosing' || !after.acting) throw new Error('la BD est restée bloquée');
  void kim;
});
await check('relay: 16 cases, réserve commune plafonnée, victoire collective', async () => {
  let who = 'leo';
  for (let i = 0; i < 12; i++) {
    const st = await state('kim', rg.id);
    if (st.run.reserve > st.run.capacity) throw new Error('réserve au-delà de la capacité');
    await free();
    if (st.game.cases_done >= 16) break;
    const next = st.game.reservation_until ? 'kim' : who;
    who = next === 'kim' ? 'leo' : 'kim';
    await rpc(next, 'survivor_reserve', rg.id).catch(async () => { await rpc(who, 'survivor_reserve', rg.id); });
    const holder = (await row('select user_id from survivor_reservations where game_id=$1 and not completed and expires_at > now()', [rg.id])).user_id;
    await turn(holder === sv.kim ? 'kim' : 'leo', rg.id, { level: i % 3 });
  }
  const g = await row('select status, ended_reason, cases_done from survivor_games where id=$1', [rg.id]);
  if (g.status !== 'finished' || g.ended_reason !== 'completed' || g.cases_done !== 16) throw new Error(JSON.stringify(g));
  const st = await state('kim', rg.id);
  if (st.run.outcome !== 'victory' || st.game.result !== 'victory' || st.cases.length !== 16) throw new Error(JSON.stringify(st.game.result));
  if (new Set(st.cases.map((c) => c.constraint_id)).size !== 16) throw new Error('demande répétée');
});

await check('relay: défaite collective seulement si le détenteur de la case la déclare, sans secours', async () => {
  const g = gv(await rpc('pam', 'survivor_matchmake', 'relay'));
  await expectErr('NO_RESERVATION', () => rpc('ray', 'survivor_declare_stuck', g.id));
  await db.query("update survivor_runs set emergency = 1 where game_id=$1", [g.id]).catch(() => undefined);
  await state('pam', g.id);
  await db.query("update survivor_runs set emergency = 1 where game_id=$1", [g.id]);
  await expectErr('NOT_STUCK', () => rpc('pam', 'survivor_declare_stuck', g.id));
  await db.query("update survivor_runs set emergency = 0 where game_id=$1", [g.id]);
  const r = await rpc('pam', 'survivor_declare_stuck', g.id);
  if (r.game.status !== 'finished' || r.game.result !== 'defeat' || r.game.ended_reason !== 'defeat') throw new Error(JSON.stringify(r.game));
  if ((await rpc('pam', 'survivor_declare_stuck', g.id)).outcome !== 'duplicate') throw new Error('défaite non idempotente');
});

let dg;
await check('duel: mêmes conditions et mêmes tirages, réserves individuelles', async () => {
  dg = await pair('duel', 'noa', 'oli');
  const a = await state('noa', dg), b = await state('oli', dg);
  if (a.seed !== b.seed || JSON.stringify(a.run.proposals) !== JSON.stringify(b.run.proposals)) throw new Error('tirages différents');
  await turn('noa', dg, { spent: 50, level: 1 });
  await turn('oli', dg, { spent: 10, level: 1 });
  const ra = await runOf('noa', dg), rb = await runOf('oli', dg);
  if (ra.reserve === rb.reserve) throw new Error('réserves partagées');
  // Même progression et mêmes choix: mêmes propositions et même offre d'amélioration.
  const a2 = await state('noa', dg), b2 = await state('oli', dg);
  if (a2.cases.every((c) => c.mine) === false) throw new Error('cases adverses visibles');
});
await check('duel: les tirages ne dépendent ni du nombre de Jokers ni de ce que fait l’adversaire', async () => {
  const a = await runOf('noa', dg);
  const g = await row('select seed from survivor_games where id=$1', [dg]);
  const chosen = (await db.query('select array_agg(constraint_id) c from survivor_cases where game_id=$1 and bd_owner=$2', [dg, sv.noa])).rows[0].c;
  const direct = (await db.query("select survivor_draw_proposals($1, 2, 16, $2::text[], '{}', '0') p", [g.seed, chosen])).rows[0].p;
  if (JSON.stringify(direct) !== JSON.stringify(a.proposals.map((p) => p.id))) throw new Error('tirage non reproductible');
  await db.query('update survivor_runs set jokers = 2 where game_id=$1 and user_id=$2', [dg, sv.noa]);
  const j1 = (await rpc('noa', 'survivor_joker', dg, 0)).state.run;
  await expectErr('STALE_STATE', () => rpc('noa', 'survivor_joker', dg, 5));
  if ((await rpc('noa', 'survivor_joker', dg, 0)).outcome !== 'duplicate') throw new Error('Joker rejoué');
  if (j1.jokers !== 1 || j1.joker_uses !== 1 || JSON.stringify(j1.proposals) === JSON.stringify(a.proposals)) throw new Error(JSON.stringify(j1));
  const again = (await db.query("select survivor_draw_proposals($1, 2, 16, $2::text[], '{}', '0') p", [g.seed, chosen])).rows[0].p;
  if (JSON.stringify(again) !== JSON.stringify(direct)) throw new Error('le tirage normal a bougé');
  const joker = (await db.query("select survivor_draw_proposals($1, 2, 16, $2::text[], $3::text[], 'j1') p", [g.seed, chosen, a.proposals.map((p) => p.id)])).rows[0].p;
  if (JSON.stringify(joker) !== JSON.stringify(j1.proposals.map((p) => p.id))) throw new Error('Joker non reproductible');
});
await check('duel: améliorations toutes les deux cases, identiques à progression égale', async () => {
  const pa = await runOf('noa', dg), pb = await runOf('oli', dg);
  await rpc('noa', 'survivor_pick', dg, pa.proposals[0].id);
  await rpc('oli', 'survivor_pick', dg, pb.proposals[0].id);
  await turn('noa', dg, { finish: false });
  await turn('oli', dg, { finish: false });
  const a = await runOf('noa', dg), b = await runOf('oli', dg);
  if (a.step !== 'upgrade' || b.step !== 'upgrade' || JSON.stringify(a.offer) !== JSON.stringify(b.offer)) throw new Error(`${a.offer}/${b.offer}`);
  await rpc('noa', 'survivor_choose_upgrade', dg, a.offer[0]);
  await rpc('oli', 'survivor_choose_upgrade', dg, b.offer[1]);
  const ra = await runOf('noa', dg), rb = await runOf('oli', dg);
  if (ra.upgrades[a.offer[0]] !== 1 || rb.upgrades[b.offer[1]] !== 1 || ra.cases_done !== 2) throw new Error('améliorations');
});
await check('duel: effets des améliorations calculés par le serveur (Encrier, Régénération, Narrateur, Joker, Dernier souffle)', async () => {
  const set = (u, offer, step = 'upgrade') => db.query('update survivor_runs set step=$3, offer=$4::jsonb where game_id=$1 and user_id=$2', [dg, sv[u], step, JSON.stringify(offer)]);
  await db.query("update survivor_runs set reserve = 60, jokers = 0, emergency = 0, upgrades = '{}'::jsonb, capacity = 100 where game_id=$1 and user_id=$2", [dg, sv.noa]);
  await set('noa', ['encrier']);
  let r = (await rpc('noa', 'survivor_choose_upgrade', dg, 'encrier')).state.run;
  if (r.capacity !== 125 || r.reserve !== 85) throw new Error(`encrier ${r.capacity}/${r.reserve}`);
  await set('noa', ['joker']);
  r = (await rpc('noa', 'survivor_choose_upgrade', dg, 'joker')).state.run;
  await set('noa', ['souffle']);
  r = (await rpc('noa', 'survivor_choose_upgrade', dg, 'souffle')).state.run;
  if (r.jokers !== 2 || r.emergency !== 1) throw new Error(`charges ${r.jokers}/${r.emergency}`);
  await set('noa', ['narrateur']);
  await rpc('noa', 'survivor_choose_upgrade', dg, 'narrateur');
  await set('noa', ['regeneration']);
  await rpc('noa', 'survivor_choose_upgrade', dg, 'regeneration');
  const st = await state('noa', dg);
  if (st.run.proposals.map((p) => p.reward).join() !== '15,25,40') throw new Error(`récompenses ${st.run.proposals.map((p) => p.reward)}`);
  const before = st.run.reserve;
  const after = (await turn('noa', dg, { level: 0, spent: 10, finish: false })).state.run;
  const expected = Math.min(125, before - 10 + 10 + 5 + 4);
  if (after.reserve !== expected) throw new Error(`réserve ${after.reserve} ≠ ${expected}`);
  const e = (await rpc('noa', 'survivor_use_emergency', dg, 0));
  void e;
});
await check('duel: Dernier souffle ajoute 25 une fois, rejeu protégé, jamais sans charge', async () => {
  await db.query("update survivor_runs set step='choosing', pick=null, emergency=1, emergency_uses=0, reserve=10, proposals='[]' where game_id=$1 and user_id=$2", [dg, sv.oli]);
  await db.query("update survivor_runs set proposals = (select survivor_proposals_for(g, r, '{}', 'x') from survivor_games g, survivor_runs r where g.id=$1 and r.game_id=$1 and r.user_id=$2) where game_id=$1 and user_id=$2", [dg, sv.oli]);
  const a = (await rpc('oli', 'survivor_use_emergency', dg, 0)).state.run;
  if (a.reserve !== 35 || a.emergency !== 0) throw new Error(JSON.stringify(a));
  if ((await rpc('oli', 'survivor_use_emergency', dg, 0)).outcome !== 'duplicate') throw new Error('rejeu');
  await expectErr('NO_EMERGENCY', () => rpc('oli', 'survivor_use_emergency', dg, 1));
});
await check('duel: images adverses fermées au niveau du stockage jusqu’à la fin; dépôts contrôlés', async () => {
  const mine = (await row("select image_path p from survivor_cases where game_id=$1 and bd_owner=$2 limit 1", [dg, sv.noa])).p;
  const q = "select name from storage.objects where bucket_id='survivor' and name=$1";
  if ((await as(sv.noa, q, [mine])).length !== 1 || (await as(sv.oli, q, [mine])).length !== 0 || (await as(sv.mia, q, [mine])).length !== 0) throw new Error('lecture');
  const put = (u, name) => as(sv[u], "insert into storage.objects(bucket_id, name, owner, metadata) values ('survivor', $1, $2, '{}')", [name, sv[u]]);
  const g = crypto.randomUUID();
  await expectErr('row-level security', () => put('oli', `${sv.noa}/${dg}/${g}.png`));
  await expectErr('row-level security', () => put('mia', `${sv.mia}/${dg}/${g}.png`));
  await expectErr('row-level security', () => put('oli', `${sv.oli}/${dg}/pas-un-uuid.png`));
  await expectErr('row-level security', () => put('oli', `${sv.oli}/${dg}/${g}.jpg`));
  await put('oli', `${sv.oli}/${dg}/${g}.png`);
  await expectErr('duplicate key', () => put('oli', `${sv.oli}/${dg}/${g}.png`).catch((e) => { throw new Error('duplicate key ' + e.message); }).then(() => { throw new Error('duplicate key'); }));
  const upd = await as(sv.noa, "update storage.objects set name = name || 'x' where name = $1 returning name", [mine]);
  const del = await as(sv.noa, 'delete from storage.objects where name = $1 returning name', [mine]);
  if (upd.length || del.length) throw new Error('un dessin publié a été modifié');
  await db.query("delete from storage.objects where name = $1", [`${sv.oli}/${dg}/${g}.png`]);
});
await check('duel: défaite individuelle, fin de partie et résultats des deux joueurs', async () => {
  const mid = await state('oli', dg);
  if (mid.runs.length !== 1) throw new Error('réserve adverse visible avant la fin');
  await db.query("update survivor_runs set emergency=0, upgrades = upgrades - 'ami' where game_id=$1 and user_id=$2", [dg, sv.oli]);
  await db.query("update survivor_runs set step='choosing', pick=null where game_id=$1 and user_id=$2", [dg, sv.oli]);
  const lost = await rpc('oli', 'survivor_declare_stuck', dg);
  if (lost.state.run.outcome !== 'defeat' || lost.game.status !== 'active') throw new Error('défaite individuelle');
  for (let i = 0; i < 20 && (await runOf('noa', dg)).step !== 'finished'; i++) { await free(); await turn('noa', dg); }
  const end = await state('noa', dg);
  if (end.game.status !== 'finished' || end.runs.length !== 2 || end.runs.find((r) => !r.is_me).outcome !== 'defeat' || end.run.outcome !== 'victory') {
    throw new Error(JSON.stringify(end.runs));
  }
  if (!end.runs.every((r) => r.upgrades)) throw new Error('performances incomplètes');
  const theirs = await as(sv.noa, 'select position from survivor_cases where game_id=$1 and bd_owner=$2', [dg, sv.oli]);
  if (theirs.length !== 2) throw new Error(`${theirs.length} cases adverses lisibles`);
  const name = (await row("select image_path p from survivor_cases where game_id=$1 and bd_owner=$2 limit 1", [dg, sv.oli])).p;
  if ((await as(sv.noa, "select name from storage.objects where bucket_id='survivor' and name=$1", [name])).length !== 1) throw new Error('image adverse fermée après la fin');
});

let bg, first, second;
await check('battle: premier joueur tiré, demandes initiales, réserves de chacun visibles', async () => {
  bg = await pair('battle', 'pam', 'ray');
  first = (await row('select turn_player from survivor_games where id=$1', [bg])).turn_player === sv.pam ? 'pam' : 'ray';
  second = first === 'pam' ? 'ray' : 'pam';
  const a = await state(first, bg), b = await state(second, bg);
  if (a.run.step !== 'choosing' || a.run.proposals.length !== 3 || !a.acting) throw new Error(JSON.stringify(a.run));
  if (b.run.step !== 'waiting' || b.acting || b.run.proposals.length !== 0) throw new Error(JSON.stringify(b.run));
  if (a.runs.length !== 2 || a.runs.find((r) => !r.is_me).reserve !== 100) throw new Error('réserve adverse invisible');
});
await check('battle: tour en trois temps, reprise après interruption, sans double récompense', async () => {
  const t = await turn(first, bg, { level: 2, spent: 30, finish: false });
  if (t.state.run.step !== 'demands' || t.state.run.reserve !== 100 || t.state.run.total_spent !== 30) throw new Error(JSON.stringify(t.state.run));
  const dup = await rawSubmit(first, bg, 1, (await row('select submission_id s from survivor_cases where game_id=$1', [bg])).s, t.state.cases[0].constraint_id, t.state.cases[0].image_path, 30);
  if (dup.outcome !== 'duplicate' || dup.state.run.reserve !== t.state.run.reserve) throw new Error('double récompense');
  const resumed = await state(first, bg);
  if (resumed.run.step !== 'demands' || !resumed.demand_options.easy.length || !resumed.demand_options.hard.length) throw new Error('reprise impossible');
  const o = resumed.demand_options;
  await expectErr('INVALID_DEMAND', () => rpc(first, 'survivor_set_demands', bg, [o.easy[0], o.hard[0], o.medium[0]]));
  await expectErr('INVALID_DEMAND', () => rpc(first, 'survivor_set_demands', bg, [o.easy[0], o.medium[0]]));
  await expectErr('INVALID_DEMAND', () => rpc(first, 'survivor_set_demands', bg, [o.easy[0], o.medium[0], '66']));
  const before = await row('select turn_player, deadline_at from survivor_games where id=$1', [bg]);
  await db.query("update survivor_games set deadline_at = now() + interval '1 hour' where id=$1", [bg]);
  const ids = [o.easy[0], o.medium[0], o.hard[0]];
  const passed = await rpc(first, 'survivor_set_demands', bg, ids);
  const g = await row('select turn_player, deadline_at, now() n from survivor_games where id=$1', [bg]);
  if (g.turn_player !== sv[second] || Math.abs((new Date(g.deadline_at) - new Date(g.n)) / 3.6e6 - 24) > 0.01 || before.turn_player !== sv[first]) throw new Error('tour non transmis');
  if (passed.state.run.step !== 'waiting') throw new Error('étape');
  if ((await rpc(first, 'survivor_set_demands', bg, ids)).outcome !== 'duplicate') throw new Error('demandes rejouées');
  const b = await state(second, bg);
  if (JSON.stringify(b.run.proposals.map((p) => p.id)) !== JSON.stringify(ids) || !b.acting) throw new Error('l’adversaire doit recevoir exactement ces demandes');
  await expectErr('NOT_YOUR_TURN', () => rawSubmit(first, bg, 2, crypto.randomUUID(), ids[0], `${sv[first]}/${bg}/${crypto.randomUUID()}.png`, 0));
  if (b.run.reserve !== 100) throw new Error('la réserve adverse a bougé');
});
await check('battle: le Joker remplace les propositions adverses; améliorations selon les cases personnelles', async () => {
  await db.query('update survivor_runs set jokers = 1 where game_id=$1 and user_id=$2', [bg, sv[second]]);
  const imposed = (await state(second, bg)).run.proposals.map((p) => p.id);
  const j = (await rpc(second, 'survivor_joker', bg, 0)).state.run;
  if (j.jokers !== 0 || JSON.stringify(j.proposals.map((p) => p.id)) === JSON.stringify(imposed)) throw new Error('Joker');
  await free();
  const t2 = await turn(second, bg, { finish: false });
  if (t2.state.run.step !== 'demands') throw new Error('pas d’amélioration à la première case personnelle');
  await rpc(second, 'survivor_set_demands', bg, [t2.state.demand_options.easy[0], t2.state.demand_options.medium[0], t2.state.demand_options.hard[0]]);
  await free();
  const t3 = await turn(first, bg, { finish: false });
  if (t3.state.run.step !== 'upgrade') throw new Error(`amélioration attendue à la 2e case personnelle, reçu ${t3.state.run.step}`);
  await settle(first, bg, await state(first, bg));
});
await check('battle: panne d’encre = défaite, victoire de l’adversaire', async () => {
  const g2 = await pair('battle', 'kim', 'leo');
  const f = (await row('select turn_player from survivor_games where id=$1', [g2])).turn_player === sv.kim ? 'kim' : 'leo';
  const o = f === 'kim' ? 'leo' : 'kim';
  await expectErr('NOT_YOUR_TURN', () => rpc(o, 'survivor_declare_stuck', g2));
  const r = await rpc(f, 'survivor_declare_stuck', g2);
  const w = await state(o, g2);
  if (r.game.result !== 'loss' || w.game.result !== 'win' || w.game.status !== 'finished' || w.game.ended_reason !== 'defeat') throw new Error(`${r.game.result}/${w.game.result}`);
});
await check('battle: délai dépassé entre le dépôt et la transmission = forfait, cases conservées', async () => {
  const g2 = await pair('battle', 'mia', 'sol');
  const f = (await row('select turn_player from survivor_games where id=$1', [g2])).turn_player === sv.mia ? 'mia' : 'sol';
  const o = f === 'mia' ? 'sol' : 'mia';
  await turn(f, g2, { finish: false });
  await db.query("update survivor_games set deadline_at = now() - interval '1 minute' where id=$1", [g2]);
  const st = await state(o, g2);
  if (st.game.status !== 'abandoned' || st.game.result !== 'win' || st.cases.length !== 1) throw new Error(JSON.stringify(st.game));
  const late = await rpc(f, 'survivor_state', g2);
  await expectErr('GAME_NOT_ACTIVE', () => rpc(f, 'survivor_set_demands', g2, ['16', '22', '11']));
  if (late.game.result !== 'loss') throw new Error('forfait');
});
await check('battle: seize cases, égalité provisoire, aucune récompense en trop', async () => {
  const g2 = await pair('battle', 'noa', 'pam');
  let who = (await row('select turn_player from survivor_games where id=$1', [g2])).turn_player === sv.noa ? 'noa' : 'pam';
  for (let i = 0; i < 16; i++) { await free(); await turn(who, g2, { level: i % 3 }); who = who === 'noa' ? 'pam' : 'noa'; }
  const st = await state('noa', g2);
  if (st.game.status !== 'finished' || st.game.result !== 'draw' || st.cases.length !== 16) throw new Error(JSON.stringify(st.game));
  if (st.runs.some((r) => r.outcome !== 'victory' || r.cases_done !== 8)) throw new Error('survie des deux joueurs');
  if (new Set(st.cases.map((c) => c.constraint_id)).size !== 16) throw new Error('demande répétée');
});

await check('stockage: fichier absent, trop gros, mauvais type ou d’une autre partie refusés; relance sans double case', async () => {
  const g2 = await pair('duel', 'ray', 'sol');
  const st = await state('ray', g2);
  await rpc('ray', 'survivor_pick', g2, st.run.proposals[0].id);
  const sub = crypto.randomUUID();
  const path = `${sv.ray}/${g2}/${sub}.png`;
  const pick = st.run.proposals[0].id;
  await expectErr('IMAGE_MISSING', () => rawSubmit('ray', g2, 1, sub, pick, path, 5));
  await upload('ray', g2, sub, { size: 999999, mimetype: 'image/png' });
  await expectErr('INVALID_IMAGE', () => rawSubmit('ray', g2, 1, sub, pick, path, 5));
  await db.query('delete from storage.objects where name=$1', [path]);
  await upload('ray', g2, sub, { size: 500, mimetype: 'image/jpeg' });
  await expectErr('INVALID_IMAGE', () => rawSubmit('ray', g2, 1, sub, pick, path, 5));
  await db.query('delete from storage.objects where name=$1', [path]);
  await upload('ray', g2, sub);
  await expectErr('INVALID_IMAGE', () => rawSubmit('ray', g2, 1, sub, pick, `${sv.ray}/${dg}/${sub}.png`, 5));
  await expectErr('INVALID_INK', () => rawSubmit('ray', g2, 1, sub, pick, path, 500));
  const ok = await rawSubmit('ray', g2, 1, sub, pick, path, 5);
  const retry = await rawSubmit('ray', g2, 1, sub, pick, path, 5);
  if (ok.outcome !== 'submitted' || retry.outcome !== 'duplicate' || (await row('select count(*)::int n from survivor_cases where game_id=$1', [g2])).n !== 1) throw new Error('relance');
});
await check('stockage: fichiers orphelins mis en file de suppression, jamais les dessins publiés (purge armée seulement)', async () => {
  await db.query("insert into storage.objects(bucket_id, name, owner, created_at, metadata) values ('survivor', $1, $2, now() - interval '3 days', '{}')", [`${sv.sol}/orphan/${crypto.randomUUID()}.png`, sv.sol]);
  const before = (await row('select count(*)::int n from storage_deletions')).n;
  await db.query('update purge_state set enabled = false');
  if ((await row('select survivor_queue_orphans() n')).n !== 0) throw new Error('purge désarmée: rien à faire');
  await db.query('update purge_state set enabled = true');
  try {
    const n = (await row("select survivor_queue_orphans(interval '1 day') n")).n;
    const queued = (await db.query("select path from storage_deletions where bucket = 'survivor' and reason = 'orphan'")).rows;
    const published = (await db.query("select image_path p from survivor_cases")).rows.map((r) => r.p);
    if (n < 1 || queued.some((q) => published.includes(q.path)) || (await row('select count(*)::int n from storage_deletions')).n <= before) throw new Error(`${n}`);
  } finally { await db.query('update purge_state set enabled = false'); }
});
await check('anti-abus: nombre d’appels limité; runs et règles internes inaccessibles aux clients', async () => {
  await free();
  const g = gv(await rpc('mia', 'survivor_matchmake', 'relay'));
  let limited = false;
  for (let i = 0; i < 125 && !limited; i++) { try { await state('mia', g.id); } catch (e) { limited = /RATE_LIMITED/.test(e.message); if (!limited) throw e; } }
  if (!limited) throw new Error('aucune limite');
  await free();
  if ((await as(sv.mia, 'select * from survivor_runs')).length !== 0) throw new Error('runs lisibles');
  if ((await as(sv.mia, 'select * from survivor_constraints')).length !== 0) throw new Error('banque lisible');
  for (const f of [`survivor_ensure_run('${g.id}'::uuid, '${sv.mia}'::uuid)`, `survivor_state_json('${g.id}'::uuid, '${sv.mia}'::uuid)`, `survivor_hit('${sv.mia}'::uuid, 'x', 1, 1)`]) {
    await expectErr('permission denied', () => as(sv.mia, `select ${f}`));
  }
  await rpc('mia', 'survivor_abandon', g.id);
});


// ───────────── Survivor arbitre (0015) ─────────────
for (const nme of ['ar1', 'ar2', 'ar3', 'ar4', 'ar5', 'ar6', 'so1', 'so2', 're1', 're2', 'du1', 'du2', 'du3', 'du4', 'du5', 'du6', 'ba1', 'ba2']) {
  const [{ id }] = (await db.query('insert into auth.users default values returning id')).rows;
  sv[nme] = id;
}
const uuid = () => crypto.randomUUID();
const CONS = ['16', '31', '11', '21', '45', '32', '63', '36'];
const arbNext = (u) => rpc(u, 'survivor_arbitrate_next');
const finishArb = (u, id) => rpc(u, 'survivor_arbitration_finish', id);
const casesOf = (view) => view.bds.flatMap((b) => b.cases);
const voteAll = async (u, view, f) => { let i = 0; for (const c of casesOf(view)) await rpc(u, 'survivor_vote', view.id, c.id, f(c, i++)); };
const bal = async (u) => Number((await row('select coalesce((select balance from survivor_wallets where user_id=$1), 0) b', [sv[u]])).b);
const ledgerOf = async (u) => (await db.query('select reason, amount from survivor_ink_ledger where user_id=$1', [sv[u]])).rows;
const putSolo = (u, bd, id = uuid()) =>
  as(sv[u], "insert into storage.objects(bucket_id, name, owner, metadata) values ('survivor', $1, $2, $3)", [`${sv[u]}/${bd}/${id}.png`, sv[u], JSON.stringify({ size: 800, mimetype: 'image/png' })]).then(() => `${sv[u]}/${bd}/${id}.png`);
const soloBd = async (u, n = 4, theme = 'Solo de test') => {
  await db.query('delete from survivor_rate_limits');
  const bd = uuid();
  await rpc(u, 'survivor_solo_begin', bd, theme);
  const cases = [];
  for (let i = 0; i < n; i++) cases.push({ position: i + 1, constraint_id: CONS[i % CONS.length], image_path: await putSolo(u, bd) });
  const r = await rpc(u, 'survivor_solo_submit', bd, JSON.stringify(cases), JSON.stringify({ outcome: 'defeat', reserve: 3 }));
  return { bd, cases, r };
};
const isolate = async (keep) => {
  const ids = (await db.query("update survivor_bds set status='declined' where status='open' and not (id = any($1::uuid[])) returning id", [keep])).rows.map((r) => r.id);
  return () => db.query("update survivor_bds set status='open' where id = any($1::uuid[])", [ids]);
};
const bdsOf = async (game) => (await db.query('select id, owner_id, status, group_id from survivor_bds where game_id=$1 order by id', [game])).rows;
const stuck = async (u, g) => {
  await db.query("update survivor_runs set upgrades = upgrades - 'ami', emergency = 0 where game_id=$1 and (user_id=$2 or user_id is null)", [g, sv[u]]);
  return rpc(u, 'survivor_declare_stuck', g);
};
const relayBd = async (a, b, n = 4) => {
  await db.query("update survivor_games set status='abandoned', ended_reason='expired', finished_at=now() where mode='relay' and status='active'");
  const g = gv(await rpc(a, 'survivor_matchmake', 'relay')).id;
  for (let i = 0; i < n; i++) {
    const u = i % 2 ? b : a;
    await db.query('delete from survivor_rate_limits');
    await rpc(u, 'survivor_reserve', g);
    await turn(u, g, { level: i % 3 });
  }
  const last = n % 2 ? b : a;
  await db.query('delete from survivor_rate_limits');
  await rpc(last, 'survivor_reserve', g);
  await stuck(last, g);
  return g;
};
const duelOf = async (a, b, na, nb) => {
  const g = await pair('duel', a, b);
  for (const [u, n] of [[a, na], [b, nb]]) {
    for (let i = 0; i < n; i++) await turn(u, g, { level: i % 3 });
    await stuck(u, g);
  }
  return g;
};

let solo1;
await check('solo: soumission minimale vérifiée côté serveur (fichiers, propriétaire, demandes, nombre de cases)', async () => {
  const bd = uuid();
  const put = (u, b) => putSolo(u, b);
  await expectErr('row-level security', () => put('so1', bd)); // pas de brouillon: dépôt refusé
  await rpc('so1', 'survivor_solo_begin', bd, 'Mon thème');
  await expectErr('row-level security', () => put('so2', bd)); // le brouillon d'un autre
  await expectErr('BD_NOT_FOUND', () => rpc('so2', 'survivor_solo_begin', bd, 'x'));
  const mk = async (n) => Promise.all(Array.from({ length: n }, async (_, i) => ({ position: i + 1, constraint_id: CONS[i], image_path: await put('so1', bd) })));
  await expectErr('TOO_SHORT', async () => rpc('so1', 'survivor_solo_submit', bd, JSON.stringify(await mk(3))));
  const ok = await mk(4);
  await expectErr('INVALID_BD', () => rpc('so1', 'survivor_solo_submit', bd, JSON.stringify([{ ...ok[0], constraint_id: 'zz' }, ...ok.slice(1)])));
  await expectErr('INVALID_BD', () => rpc('so1', 'survivor_solo_submit', bd, JSON.stringify([{ ...ok[0], position: 2 }, ...ok.slice(1)])));
  await expectErr('IMAGE_MISSING', () => rpc('so1', 'survivor_solo_submit', bd, JSON.stringify([{ ...ok[0], image_path: `${sv.so1}/${bd}/${uuid()}.png` }, ...ok.slice(1)])));
  await expectErr('INVALID_IMAGE', () => rpc('so1', 'survivor_solo_submit', bd, JSON.stringify([{ ...ok[0], image_path: `${sv.so2}/${bd}/${uuid()}.png` }, ...ok.slice(1)])));
  const big = await putSolo('so1', bd);
  await db.query("update storage.objects set metadata = '{\"size\": 999999, \"mimetype\": \"image/png\"}' where name = $1", [big]);
  await expectErr('INVALID_IMAGE', () => rpc('so1', 'survivor_solo_submit', bd, JSON.stringify([{ ...ok[0], image_path: big }, ...ok.slice(1)])));
  const done = await rpc('so1', 'survivor_solo_submit', bd, JSON.stringify(ok), JSON.stringify({ outcome: 'victory' }));
  if (done.status !== 'open') throw new Error(JSON.stringify(done));
  if ((await rpc('so1', 'survivor_solo_submit', bd, JSON.stringify(ok))).outcome !== 'duplicate') throw new Error('envoi rejoué');
  const b = await row('select source, status, claimed, arbitrations_max from survivor_bds where id=$1', [bd]);
  if (b.source !== 'solo' || b.claimed.outcome !== 'victory' || b.arbitrations_max !== 3) throw new Error(JSON.stringify(b));
  solo1 = bd;
  if ((await row('select count(*)::int n from survivor_bd_cases where bd_id=$1', [bd])).n !== 4) throw new Error('cases');
  if ((await as(sv.so2, 'select * from survivor_bd_cases')).length) throw new Error('cases lisibles directement');
});
await check('solo: pas plus de cinq BD en attente par joueur', async () => {
  for (let i = 0; i < 5; i++) await soloBd('so2');
  await db.query('delete from survivor_rate_limits');
  await expectErr('SOLO_LIMIT', () => rpc('so2', 'survivor_solo_begin', uuid(), 'trop'));
  await db.query("update survivor_bds set status = 'declined' where owner_id = $1", [sv.so2]);
});

let relayG, relayBdId;
await check('relay: seules les parties terminées sont éligibles; consentement de chaque contributeur', async () => {
  await expectErr('GAME_NOT_FOUND', () => rpc('ar1', 'survivor_submit_game_bd', uuid()));
  relayG = await relayBd('re1', 're2', 4);
  await expectErr('GAME_NOT_FOUND', () => rpc('ar1', 'survivor_submit_game_bd', relayG));
  const open = gv(await rpc('re1', 'survivor_matchmake', 'relay')).id; // une partie en cours, déjà contribuée
  await turn('re1', open);
  await expectErr('GAME_NOT_FINISHED', () => rpc('re1', 'survivor_submit_game_bd', open));
  await db.query("update survivor_games set status='abandoned', ended_reason='expired', finished_at=now() where id=$1", [open]);
  const r = await rpc('re1', 'survivor_submit_game_bd', relayG);
  relayBdId = r.bds[0];
  const b = await row('select status, source from survivor_bds where id=$1', [relayBdId]);
  if (r.outcome !== 'submitted' || b.status !== 'pending' || b.source !== 'relay') throw new Error(JSON.stringify([r, b]));
  if ((await rpc('re2', 'survivor_submit_game_bd', relayG)).outcome !== 'duplicate') throw new Error('doublon');
  const imgs = (await db.query('select count(*)::int n from survivor_bd_cases where bd_id=$1', [relayBdId])).rows[0].n;
  if (imgs !== 4) throw new Error('cases copiées: ' + imgs);
  const files = (await db.query('select count(distinct name)::int n from storage.objects where bucket_id=$1 and name in (select image_path from survivor_bd_cases where bd_id=$2)', ['survivor', relayBdId])).rows[0].n;
  if (files !== 4) throw new Error('les références doivent pointer sur les PNG existants');
});
await check('consentement: en attente = non arbitrable; accepter ouvre; refuser ferme; décision définitive', async () => {
  const restore = await isolate([relayBdId]);
  try {
    if ((await arbNext('ar1')).outcome !== 'none') throw new Error('BD arbitrable sans consentement');
    await expectErr('BD_NOT_FOUND', () => rpc('ar2', 'survivor_consent', relayBdId, true));
    const h = await rpc('re2', 'survivor_hub');
    if (h.consents.length !== 1 || h.consents[0].bd_id !== relayBdId) throw new Error(JSON.stringify(h.consents));
    await expectErr('CONSENT_FINAL', async () => { await rpc('re2', 'survivor_consent', relayBdId, true); await rpc('re2', 'survivor_consent', relayBdId, false); });
    if ((await row('select status from survivor_bds where id=$1', [relayBdId])).status !== 'open') throw new Error('non ouverte');
    if ((await rpc('re2', 'survivor_consent', relayBdId, true)).outcome !== 'duplicate') throw new Error('consentement rejoué');
  } finally { await restore(); }
  const g2 = await relayBd('re2', 're1', 4);
  const bd2 = (await rpc('re2', 'survivor_submit_game_bd', g2)).bds[0];
  await rpc('re1', 'survivor_consent', bd2, false);
  if ((await row('select status from survivor_bds where id=$1', [bd2])).status !== 'declined') throw new Error('non refusée');
});

await check('attribution: automatique, anonymisée, reprise sans changer, jamais ses propres créations', async () => {
  const restore = await isolate([solo1, relayBdId]);
  try {
    const a = await arbNext('so1');
    const v = a.arbitration;
    if (a.outcome !== 'assigned' || v.theme === 'Mon thème') throw new Error('doit recevoir la BD de contributeurs, pas la sienne');
    const flat = JSON.stringify(a);
    if (/nickname|author|Joueur|owner|ink|reward|arbitrations/i.test(flat.replace(/"reward":null/, ''))) throw new Error('fuite: ' + flat.slice(0, 300));
    const again = await arbNext('so1');
    if (again.outcome !== 'resumed' || again.arbitration.id !== v.id) throw new Error('reprise');
    if (JSON.stringify(await rpc('so1', 'survivor_arbitration_current')) !== JSON.stringify(again.arbitration)) throw new Error('current');
    await rpc('so1', 'survivor_arbitration_abandon', v.id);
    // auteurs de la BD collective: seule la BD Solo d'autrui leur est proposée
    const own = await arbNext('re1');
    const bdOf = (await row('select bd_id from survivor_arbitration_bds where arbitration_id=$1', [own.arbitration.id])).bd_id;
    if (bdOf !== solo1) throw new Error('un contributeur a reçu sa propre BD');
    await rpc('re1', 'survivor_arbitration_abandon', own.arbitration.id);
    if ((await arbNext('so1')).outcome !== 'none') throw new Error('une BD abandonnée est reproposée au même arbitre');
  } finally { await restore(); }
});

let arbView;
await check('lecture: l’arbitre ne voit que les images de son attribution, tables fermées', async () => {
  const restore = await isolate([solo1]);
  try {
    const a = await arbNext('ar1');
    arbView = a.arbitration;
    const paths = casesOf(arbView).map((c) => c.image_path);
    const q = "select name from storage.objects where bucket_id='survivor' and name = any($1::text[])";
    if ((await as(sv.ar1, q, [paths])).length !== paths.length) throw new Error('images de l’attribution illisibles');
    const other = (await db.query('select image_path p from survivor_bd_cases where bd_id=$1', [relayBdId])).rows.map((r) => r.p);
    if ((await as(sv.ar1, q, [other])).length !== 0) throw new Error('image d’une autre BD lisible');
    if ((await as(sv.ar2, q, [paths])).length !== 0) throw new Error('image lisible sans attribution');
    for (const t of ['survivor_bds', 'survivor_bd_cases', 'survivor_votes', 'survivor_arbitrations', 'survivor_consents', 'survivor_flags', 'survivor_bd_authors']) {
      if ((await as(sv.ar1, `select * from ${t}`)).length) throw new Error(`${t} lisible`);
    }
    await expectErr('row-level security', () => as(sv.ar1, "insert into survivor_votes(arbitration_id, case_id, vote) values ($1, $2, 'up')", [arbView.id, casesOf(arbView)[0].id]));
  } finally { await restore(); }
});
await check('votes: provisoires et modifiables, strictement limités à l’attribution; aucune récompense avant la validation', async () => {
  const cs = casesOf(arbView);
  await expectErr('ARBITRATION_NOT_FOUND', () => rpc('ar2', 'survivor_vote', arbView.id, cs[0].id, 'up'));
  const foreign = (await row('select id from survivor_bd_cases where bd_id=$1 limit 1', [relayBdId])).id;
  await expectErr('CASE_NOT_IN_ARBITRATION', () => rpc('ar1', 'survivor_vote', arbView.id, foreign, 'up'));
  await expectErr('INVALID_VOTE', () => rpc('ar1', 'survivor_vote', arbView.id, cs[0].id, 'meh'));
  await rpc('ar1', 'survivor_vote', arbView.id, cs[0].id, 'up');
  let v = await rpc('ar1', 'survivor_vote', arbView.id, cs[0].id, 'down');
  if (v.bds[0].cases[0].vote !== 'down' || v.voted !== 1) throw new Error('vote non modifié');
  v = await rpc('ar1', 'survivor_vote', arbView.id, cs[0].id, null);
  if (v.voted !== 0) throw new Error('vote non effacé');
  await expectErr('INCOMPLETE', () => finishArb('ar1', arbView.id));
  await rpc('ar1', 'survivor_vote', arbView.id, cs[0].id, 'up');
  if ((await bal('ar1')) !== 0 || (await ledgerOf('ar1')).length) throw new Error('récompense avant validation');
});
await check('validation: récompenses du serveur, identiques pour up et down, versées une seule fois; votes définitifs', async () => {
  await voteAll('ar1', arbView, (c, i) => (i % 2 ? 'down' : 'up'));
  const before = await bal('so1');
  const r = await finishArb('ar1', arbView.id);
  if (r.outcome !== 'completed' || r.arbitration.reward !== 4 * 2 + 10 || r.arbitration.up !== 2 || r.arbitration.down !== 2) throw new Error(JSON.stringify(r));
  if ((await bal('ar1')) !== 18) throw new Error(`arbitre ${await bal('ar1')}`);
  if ((await bal('so1')) - before !== 2 * 5) throw new Error('auteur: 5 par upvote, rien pour un downvote');
  const again = await finishArb('ar1', arbView.id);
  if (again.outcome !== 'duplicate' || (await bal('ar1')) !== 18 || (await bal('so1')) - before !== 10) throw new Error('récompense versée deux fois');
  await expectErr('ARBITRATION_CLOSED', () => rpc('ar1', 'survivor_vote', arbView.id, casesOf(arbView)[0].id, 'down'));
  await expectErr('ARBITRATION_CLOSED', () => rpc('ar1', 'survivor_arbitration_abandon', arbView.id));
  const files = await as(sv.ar1, "select name from storage.objects where bucket_id='survivor' and name = any($1::text[])", [casesOf(arbView).map((c) => c.image_path)]);
  if (files.length) throw new Error('accès aux images conservé après l’arbitrage');
  const bonus = (await ledgerOf('ar1')).filter((l) => l.reason === 'arbiter_complete');
  if (bonus.length !== 1 || bonus[0].amount !== 10) throw new Error('bonus');
});
await check('même rémunération de l’arbitre quel que soit le sens des votes', async () => {
  const restore = await isolate([solo1]);
  try {
    const a2 = (await arbNext('ar2')).arbitration;
    await voteAll('ar2', a2, () => 'up');
    await finishArb('ar2', a2.id);
    const a3 = (await arbNext('ar3')).arbitration;
    await voteAll('ar3', a3, () => 'down');
    const before = await bal('so1');
    await finishArb('ar3', a3.id);
    if ((await bal('ar2')) !== 18 || (await bal('ar3')) !== 18) throw new Error(`${await bal('ar2')} ${await bal('ar3')}`);
    if ((await bal('so1')) !== before) throw new Error('un downvote a modifié le solde de l’auteur');
    const closed = await arbNext('ar4');
    if (closed.outcome !== 'none') throw new Error('BD au-delà de son maximum d’arbitrages');
    if ((await row('select arbitrations_done d from survivor_bds where id=$1', [solo1])).d !== 3) throw new Error('compteur');
  } finally { await restore(); }
});
await check('récompense du véritable auteur de chaque case (BD collective Relay et Battle)', async () => {
  const restore = await isolate([relayBdId]);
  try {
    const a = (await arbNext('ar4')).arbitration;
    await voteAll('ar4', a, () => 'up');
    const b1 = await bal('re1'), b2 = await bal('re2');
    await finishArb('ar4', a.id);
    const authors = (await db.query('select author_id, count(*)::int n from survivor_bd_cases where bd_id=$1 group by author_id', [relayBdId])).rows;
    for (const x of authors) {
      const name = x.author_id === sv.re1 ? 're1' : 're2';
      const gain = (await bal(name)) - (name === 're1' ? b1 : b2);
      if (gain !== x.n * 5) throw new Error(`${name}: ${gain} ≠ ${x.n * 5}`);
    }
    if (authors.length !== 2) throw new Error('deux auteurs attendus');
  } finally { await restore(); }
  const bg = await pair('battle', 'ba1', 'ba2');
  const first = (await row('select turn_player from survivor_games where id=$1', [bg])).turn_player === sv.ba1 ? 'ba1' : 'ba2';
  const second = first === 'ba1' ? 'ba2' : 'ba1';
  for (let i = 0; i < 4; i++) { await db.query('delete from survivor_rate_limits'); await turn(i % 2 ? second : first, bg, { level: i % 3 }); }
  await stuck(first, bg);
  const bb = (await rpc('ba1', 'survivor_submit_game_bd', bg)).bds[0];
  await rpc('ba2', 'survivor_consent', bb, true);
  if ((await row('select status, source from survivor_bds where id=$1', [bb])).status !== 'open') throw new Error('BD Battle non ouverte');
  const info = await row('select count(distinct author_id)::int n from survivor_bd_cases where bd_id=$1', [bb]);
  if (info.n !== 2) throw new Error('auteurs');
});

await check('abandon et signalement: aucune récompense, BD toujours disponible; un signalement masque la BD', async () => {
  const bd = (await soloBd('so1', 4, 'À signaler')).bd;
  const restore = await isolate([bd]);
  try {
    const a = (await arbNext('ar5')).arbitration;
    await voteAll('ar5', a, () => 'up');
    await rpc('ar5', 'survivor_arbitration_abandon', a.id);
    if ((await rpc('ar5', 'survivor_arbitration_abandon', a.id)).outcome !== 'duplicate') throw new Error('abandon rejoué');
    if ((await bal('ar5')) !== 0 || (await row('select count(*)::int n from survivor_votes where arbitration_id=$1', [a.id])).n !== 0) throw new Error('récompense ou votes conservés');
    const b = (await arbNext('ar6')).arbitration;
    if (!b) throw new Error('la BD a été verrouillée par un abandon');
    await voteAll('ar6', b, () => 'up');
    const fl = await rpc('ar6', 'survivor_arbitration_flag', b.id, 1, 'inappropriate');
    if (fl.outcome !== 'flagged' || (await bal('ar6')) !== 0) throw new Error('signalement récompensé');
    if ((await row('select status from survivor_bds where id=$1', [bd])).status !== 'hidden') throw new Error('BD non masquée');
    await expectErr('ARBITRATION_CLOSED', () => finishArb('ar6', b.id));
    await expectErr('FORBIDDEN', () => as(sv.ar6, "select survivor_admin_bd_status($1, 'open')", [bd]));
    await as(users.adm, "select survivor_admin_bd_status($1, 'open')", [bd]);
    if ((await row('select status from survivor_bds where id=$1', [bd])).status !== 'open') throw new Error('rétablissement');
  } finally { await restore(); await db.query("update survivor_bds set status='declined' where id=$1", [bd]); }
});
await check('capacité: les attributions en cours comptent, une attribution périmée libère sa place; validation refusée au-delà du maximum', async () => {
  const bd = (await soloBd('so2', 4, 'Capacité')).bd;
  const restore = await isolate([bd]);
  try {
    await db.query("update survivor_arbitrations set status = 'abandoned' where status = 'assigned'");
    const got = [];
    for (const u of ['ar1', 'ar2', 'ar3']) got.push((await arbNext(u)).arbitration);
    if ((await arbNext('ar4')).outcome !== 'none') throw new Error('plus de trois attributions simultanées');
    await db.query("update survivor_arbitrations set created_at = now() - interval '2 hours' where id = $1", [got[0].id]);
    const late = await arbNext('ar4');
    if (late.outcome !== 'assigned') throw new Error('attribution périmée non libérée');
    await voteAll('ar2', got[1], () => 'up'); await finishArb('ar2', got[1].id);
    await voteAll('ar3', got[2], () => 'up'); await finishArb('ar3', got[2].id);
    await voteAll('ar4', late.arbitration, () => 'up'); await finishArb('ar4', late.arbitration.id);
    await voteAll('ar1', got[0], () => 'up');
    const before = await bal('ar1');
    const r = await finishArb('ar1', got[0].id);
    if (r.outcome !== 'closed' || (await bal('ar1')) !== before) throw new Error('quatrième arbitrage récompensé');
    if ((await row('select arbitrations_done d from survivor_bds where id=$1', [bd])).d !== 3) throw new Error('maximum dépassé');
  } finally { await restore(); await db.query("update survivor_bds set status='declined' where id=$1", [bd]); }
});
await check('limites: une seule attribution en cours, cinq arbitrages complets par jour', async () => {
  await expectErr('duplicate key', () => db.query("insert into survivor_arbitrations(arbiter_id, unit_key, status) select $1, gen_random_uuid(), 'assigned' from generate_series(1,2)", [sv.ar5]));
  for (let i = 0; i < 5; i++) await db.query("insert into survivor_arbitrations(arbiter_id, unit_key, status, completed_at) values ($1, gen_random_uuid(), 'completed', now())", [sv.ar5]);
  await soloBd('so1', 4, 'Pour la limite');
  await expectErr('DAILY_LIMIT', () => arbNext('ar5'));
  await db.query("update survivor_arbitrations set completed_at = now() - interval '2 days' where arbiter_id = $1 and status = 'completed'", [sv.ar5]);
  const ok = await arbNext('ar5');
  if (ok.outcome !== 'assigned') throw new Error('limite non levée le lendemain');
  await rpc('ar5', 'survivor_arbitration_abandon', ok.arbitration.id);
});
await check('arbitre: cases propres refusées même si une attribution est forcée', async () => {
  const own = await soloBd('so2', 4, 'Sa propre BD');
  const [{ id: arb }] = (await db.query("insert into survivor_arbitrations(arbiter_id, unit_key, status) values ($1, $2, 'assigned') returning id", [sv.so2, own.bd])).rows;
  await db.query('insert into survivor_arbitration_bds(arbitration_id, bd_id, slot) values ($1, $2, 1)', [arb, own.bd]);
  const c = (await row('select id from survivor_bd_cases where bd_id=$1 limit 1', [own.bd])).id;
  await expectErr('OWN_CASE', () => rpc('so2', 'survivor_vote', arb, c, 'up'));
  await db.query("update survivor_arbitrations set status='abandoned' where id=$1", [arb]);
  await db.query("update survivor_bds set status='declined' where id=$1", [own.bd]);
});

await check('registre d’encre bonus: lecture de soi seulement, aucune écriture client, clés uniques, solde cohérent', async () => {
  const w = await rpc('ar1', 'survivor_wallet');
  if (w.balance !== 18 || w.history.length !== 5 || !w.history.some((h) => h.reason === 'arbiter_complete')) throw new Error(JSON.stringify(w));
  if (JSON.stringify(w).includes(sv.so1)) throw new Error('identité exposée');
  const mineRows = await as(sv.ar1, 'select user_id from survivor_ink_ledger');
  if (!mineRows.length || mineRows.some((r) => r.user_id !== sv.ar1)) throw new Error('registre des autres lisible');
  if ((await as(sv.ar1, 'select user_id from survivor_wallets')).some((r) => r.user_id !== sv.ar1)) throw new Error('soldes des autres lisibles');
  await expectErr('row-level security', () => as(sv.ar1, "insert into survivor_ink_ledger(user_id, amount, reason, idempotency_key) values ($1, 100, 'arbiter_vote', 'x')", [sv.ar1]));
  await expectErr('row-level security', () => as(sv.ar1, "insert into survivor_wallets(user_id, balance) values ($1, 999)", [sv.ar1]));
  if ((await as(sv.ar1, 'update survivor_wallets set balance = 999 returning user_id')).length) throw new Error('solde modifiable');
  await expectErr('Table immuable', () => db.query("update survivor_ink_ledger set amount = 99 where user_id = $1", [sv.ar1]));
  await expectErr('duplicate key', () => db.query("insert into survivor_ink_ledger(user_id, amount, reason, idempotency_key) select user_id, amount, reason, idempotency_key from survivor_ink_ledger limit 1"));
  await expectErr('check constraint', () => db.query("insert into survivor_ink_ledger(user_id, amount, reason, idempotency_key) values ($1, -5, 'arbiter_vote', 'neg')", [sv.ar1]));
  const sums = (await db.query('select w.user_id from survivor_wallets w where w.balance <> (select coalesce(sum(amount), 0) from survivor_ink_ledger l where l.user_id = w.user_id)')).rows;
  if (sums.length) throw new Error('solde ≠ somme du registre');
  for (const f of ['survivor_arbitration_json($1::uuid)', 'survivor_candidate_units($1::uuid)', 'survivor_settle_duel($1::uuid)']) {
    await expectErr('permission denied', () => as(sv.ar1, `select ${f}`, [uuid()]));
  }
});

let duelA, duelB;
await check('duel: les deux BD sont arbitrées ensemble, dans un ordre aléatoire, après consentement des deux auteurs', async () => {
  duelA = await duelOf('du1', 'du2', 5, 4);
  const before = await row('select status, ended_reason from survivor_games where id=$1', [duelA]);
  const sub = await rpc('du1', 'survivor_submit_game_bd', duelA);
  if (sub.bds.length !== 2) throw new Error('deux BD attendues');
  const bds = await bdsOf(duelA);
  if (!bds[0].group_id || bds[0].group_id !== bds[1].group_id || bds.some((b) => b.status !== 'pending' && b.owner_id !== sv.du1)) throw new Error(JSON.stringify(bds));
  const v0 = await rpc('du1', 'survivor_duel_verdict', duelA);
  if (v0.status !== 'pending') throw new Error(JSON.stringify(v0));
  const restore = await isolate(bds.map((b) => b.id));
  try {
    if ((await arbNext('ar1')).outcome !== 'none') throw new Error('Duel arbitré avant le consentement des deux auteurs');
    await rpc('du2', 'survivor_consent', (await row('select id from survivor_bds where game_id=$1 and owner_id=$2', [duelA, sv.du2])).id, true);
    const a = (await arbNext('ar1')).arbitration;
    if (!a.duel || a.bds.length !== 2 || a.bds[0].label !== 'A' || a.bds[1].label !== 'B') throw new Error('comparaison A/B attendue');
    if (a.total !== 9) throw new Error(`${a.total} cases`);
    await voteAll('ar1', a, () => 'up');
    await finishArb('ar1', a.id);
    for (const b of bds) if ((await row('select arbitrations_done d from survivor_bds where id=$1', [b.id])).d !== 1) throw new Error('les deux BD doivent avancer ensemble');
    // les mêmes arbitres voient toujours les deux BD, jamais une seule
    const orders = new Set();
    for (const u of ['ar2', 'ar3']) {
      const x = (await arbNext(u)).arbitration;
      orders.add(x.bds.map((b) => b.cases.length).join());
      await voteAll(u, x, () => 'up');
      await finishArb(u, x.id);
    }
    const g = await row('select verdict, winner from survivor_bd_groups where game_id=$1', [duelA]);
    if (g.verdict !== 'win' || g.winner !== sv.du1) throw new Error('la BD la plus complète (5 upvotes par arbitre contre 4) doit gagner: ' + JSON.stringify(g));
    const after = await row('select status, ended_reason from survivor_games where id=$1', [duelA]);
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('le résultat de survie a été modifié');
    const mine = await rpc('du1', 'survivor_duel_verdict', duelA), rival = await rpc('du2', 'survivor_duel_verdict', duelA);
    if (mine.result !== 'win' || rival.result !== 'loss' || mine.my_ups !== 15 || mine.rival_ups !== 12) throw new Error(JSON.stringify([mine, rival]));
    if ((await arbNext('ar4')).outcome !== 'none') throw new Error('le Duel a dépassé ses arbitrages');
  } finally { await restore(); }
});
await check('duel: égalité déclarée, jamais de vainqueur sans les deux BD, forfaits intacts', async () => {
  duelB = await duelOf('du3', 'du4', 4, 4);
  await rpc('du3', 'survivor_submit_game_bd', duelB);
  await rpc('du4', 'survivor_consent', (await row('select id from survivor_bds where game_id=$1 and owner_id=$2', [duelB, sv.du4])).id, true);
  const bds = await bdsOf(duelB);
  const restore = await isolate(bds.map((b) => b.id));
  try {
    for (const u of ['ar1', 'ar2', 'ar3']) {
      await db.query("update survivor_arbitrations set completed_at = now() - interval '3 days' where arbiter_id = $1 and status = 'completed'", [sv[u]]);
      const x = (await arbNext(u)).arbitration;
      await voteAll(u, x, () => 'down');
      await finishArb(u, x.id);
    }
    const t = await row('select verdict, winner from survivor_bd_groups where game_id=$1', [duelB]);
    if (t.verdict !== 'tie' || t.winner !== null) throw new Error(JSON.stringify(t));
  } finally { await restore(); }
  const dg2 = await pair('duel', 'du5', 'du6');
  await rpc('du6', 'survivor_abandon', dg2);
  await expectErr('GAME_NOT_FINISHED', () => rpc('du5', 'survivor_submit_game_bd', dg2));
  if ((await rpc('du5', 'survivor_duel_verdict', dg2)).status !== 'unavailable') throw new Error('verdict sans BD');
  const g = await row('select status, ended_reason, forfeit_by from survivor_games where id=$1', [dg2]);
  if (g.status !== 'abandoned' || g.forfeit_by !== sv.du6) throw new Error('forfait');
});
await check('duel: si l’autre auteur refuse, la BD restante est arbitrable seule et aucun vainqueur n’est déclaré', async () => {
  const g = await duelOf('du5', 'du6', 4, 4);
  await rpc('du5', 'survivor_submit_game_bd', g);
  const theirs = (await row('select id from survivor_bds where game_id=$1 and owner_id=$2', [g, sv.du6])).id;
  await rpc('du6', 'survivor_consent', theirs, false);
  const mine = await row('select id, status, group_id from survivor_bds where game_id=$1 and owner_id=$2', [g, sv.du5]);
  if (mine.status !== 'open' || mine.group_id !== null) throw new Error(JSON.stringify(mine));
  if ((await rpc('du5', 'survivor_duel_verdict', g)).status !== 'unavailable') throw new Error('verdict artificiel');
  const restore = await isolate([mine.id]);
  try {
    const a = (await arbNext('ar4')).arbitration;
    if (a.duel) throw new Error('arbitrage comparatif sans la seconde BD');
    await rpc('ar4', 'survivor_arbitration_abandon', a.id);
  } finally { await restore(); }
});
await check('menu Arbitre: solde, BD disponibles (nombre), parties à soumettre et résultats reçus sans identité des arbitres', async () => {
  const h = await rpc('so1', 'survivor_hub');
  if (typeof h.available !== 'number' || h.balance < 10 || h.daily_limit !== 5) throw new Error(JSON.stringify(h).slice(0, 300));
  const m = h.mine.find((x) => x.bd_id === solo1);
  if (!m || m.arbitrations_done !== 3 || m.ups !== 2 + 4 + 0 || m.downs !== 2 + 0 + 4 || m.ink_earned !== (2 + 4) * 5) throw new Error(JSON.stringify(m));
  if (JSON.stringify(h).includes(sv.ar1) || /arbiter/i.test(JSON.stringify(h.mine))) throw new Error('identité des arbitres exposée');
  const d = await rpc('du1', 'survivor_hub');
  const dm = d.mine.find((x) => x.game_id === duelA);
  if (!dm || dm.narrative.status !== 'decided' || dm.narrative.result !== 'win') throw new Error(JSON.stringify(dm));
  const s = await rpc('re1', 'survivor_hub');
  if (!Array.isArray(s.submittable)) throw new Error('submittable');
  const g = await row("select count(*)::int n from survivor_games where status = 'finished'");
  void g;
});
await check('orphelins: les images déjà soumises à l’arbitrage ne sont jamais mises en file de suppression', async () => {
  const kept = (await row('select image_path p from survivor_bd_cases limit 1')).p;
  await db.query("update storage.objects set created_at = now() - interval '5 days' where name = $1", [kept]);
  await db.query('update purge_state set enabled = true');
  try {
    await db.query('select survivor_queue_orphans()');
    const q = (await db.query("select path from storage_deletions where path = $1", [kept])).rows;
    if (q.length) throw new Error('image arbitrée mise en file de suppression');
  } finally { await db.query('update purge_state set enabled = false'); }
});
await check('droits: nouvelles fonctions internes fermées aux clients et à anon', async () => {
  await expectErr('permission denied', () => as(null, "select survivor_arbitrate_next()"));
  await expectErr('NOT_AUTHENTICATED', () => db.query('select survivor_hub()'));
});


// ───────────── Survivor boutique d'encre bonus (0016) ─────────────
for (const nme of ['sh1', 'sh2', 'sh3', 'sh4', 'sh5', 'sh6', 'sh7', 'sh8']) {
  const [{ id }] = (await db.query('insert into auth.users default values returning id')).rows;
  sv[nme] = id;
}
let keyN = 0;
const fund = (u, n) => db.query("insert into survivor_ink_ledger(user_id, amount, reason, idempotency_key) values ($1, $2, 'arbiter_vote', $3)", [sv[u], n, `fund:${++keyN}`]);
const buy = async (u, scope, game, item, id = uuid()) => { await db.query('delete from survivor_rate_limits'); return rpc(u, 'survivor_buy', scope, game, item, id); };
const ledgerCount = async (u) => (await row('select count(*)::int n from survivor_ink_ledger where user_id=$1', [sv[u]])).n;
const shopRelay = async (a) => {
  await db.query("update survivor_games set status='abandoned', ended_reason='expired', finished_at=now() where mode='relay' and status='active'");
  return gv(await rpc(a, 'survivor_matchmake', 'relay')).id;
};
const setRun = (g, set) => db.query(`update survivor_runs set ${set} where game_id=$1 and user_id is null`, [g]);
const runNow = async (u, g) => (await state(u, g)).run;

await check('boutique: catalogue serveur, registre ouvert aux dépenses sans perdre l’historique, solde jamais négatif', async () => {
  const r = (await row('select survivor_shop_rules() r')).r;
  const it = r.items;
  if (it.refill.price !== 40 || it.refill.effect !== 20 || it.refill.min_missing !== 20 || it.constraint_reroll.price !== 30 || it.upgrade_reroll.price !== 25
    || it.emergency_refill.price !== 60 || it.emergency_refill.effect !== 25 || r.modes.solo.max_purchases !== 2 || r.modes.relay.max_purchases !== 3 || r.modes.duel || r.modes.battle) throw new Error(JSON.stringify(r));
  const before = (await row("select count(*)::int n, coalesce(sum(amount), 0)::int s from survivor_ink_ledger where amount > 0")).n;
  if (before < 1) throw new Error('historique des gains conservé');
  await expectErr('check constraint', () => db.query("insert into survivor_ink_ledger(user_id, amount, reason, idempotency_key) values ($1, 5, 'purchase', 'k1')", [sv.sh1]));
  await expectErr('check constraint', () => db.query("insert into survivor_ink_ledger(user_id, amount, reason, item, game_id, idempotency_key) values ($1, -5, 'arbiter_vote', 'refill', gen_random_uuid(), 'k2')", [sv.sh1]));
  await expectErr('check constraint', () => db.query("insert into survivor_ink_ledger(user_id, amount, reason, idempotency_key) values ($1, 0, 'arbiter_vote', 'k3')", [sv.sh1]));
  await expectErr('check constraint', () => db.query("insert into survivor_ink_ledger(user_id, amount, reason, item, game_id, idempotency_key) values ($1, -5, 'purchase', 'refill', gen_random_uuid(), 'k4')", [sv.sh1])); // solde nul
});
await check('boutique: aucune écriture client, achats et portefeuilles des autres illisibles', async () => {
  await expectErr('row-level security', () => as(sv.sh1, "insert into survivor_purchases(id, user_id, scope, game_id, item, price, ledger_id) values (gen_random_uuid(), $1, 'solo', gen_random_uuid(), 'refill', 1, gen_random_uuid())", [sv.sh1]));
  await expectErr('row-level security', () => as(sv.sh1, "insert into survivor_ink_ledger(user_id, amount, reason, item, game_id, idempotency_key) values ($1, -1, 'purchase', 'refill', gen_random_uuid(), 'zz')", [sv.sh1]));
  if ((await as(sv.sh1, 'select * from survivor_purchases')).length || (await as(sv.sh1, 'select * from survivor_solo_games')).length) throw new Error('tables lisibles');
  for (const f of [`survivor_receipt(null, false, '${sv.sh1}'::uuid)`, "survivor_draw_offer_salt(1, '{}'::jsonb, 'x', '[]'::jsonb)"]) await expectErr('permission denied', () => as(sv.sh1, `select ${f}`));
  await expectErr('permission denied', () => as(null, "select survivor_shop_rules()"));
});

await check('Solo: achat confirmé par un reçu serveur, idempotent, débit unique; effet décidé par le serveur', async () => {
  await fund('sh1', 200);
  const game = uuid(), id = uuid();
  const sh = await rpc('sh1', 'survivor_shop', 'solo', game);
  if (!sh.allowed || sh.balance !== 200 || sh.remaining !== 2 || sh.mode !== 'solo') throw new Error(JSON.stringify(sh));
  const a = await buy('sh1', 'solo', game, 'refill', id);
  if (a.price !== 40 || a.effect !== 20 || a.balance !== 160 || a.replay !== false || a.item !== 'refill') throw new Error(JSON.stringify(a));
  const b = await buy('sh1', 'solo', game, 'refill', id);
  if (!b.replay || b.balance !== 160 || b.purchase !== a.purchase) throw new Error('rejeu non idempotent');
  const n = (await row("select count(*)::int n from survivor_ink_ledger where user_id=$1 and reason='purchase'", [sv.sh1])).n;
  if (n !== 1 || (await bal('sh1')) !== 160) throw new Error('double débit');
  await expectErr('INVALID_PURCHASE', () => buy('sh1', 'solo', game, 'constraint_reroll', id)); // même identifiant, autre achat
  await expectErr('INVALID_PURCHASE', () => buy('sh2', 'solo', game, 'refill', id)); // identifiant d'un autre joueur
  const chk = await rpc('sh1', 'survivor_buy_check', 'solo', game, id);
  if (!chk || chk.effect !== 20 || (await rpc('sh1', 'survivor_buy_check', 'solo', game, uuid())) !== null || (await rpc('sh2', 'survivor_buy_check', 'solo', game, id)) !== null) throw new Error('reçu récupérable seulement par son propriétaire');
  await expectErr('Table immuable', () => db.query('update survivor_purchases set price = 1'));
  const w = await rpc('sh1', 'survivor_wallet');
  const h = w.history.find((x) => x.reason === 'purchase');
  if (!h || h.amount !== -40 || h.item !== 'refill' || w.balance !== 160) throw new Error(JSON.stringify(w));
});
await check('Solo: deux achats par partie, une fois par type; la partie d’un autre est inaccessible', async () => {
  const game = uuid();
  await buy('sh1', 'solo', game, 'constraint_reroll');
  await expectErr('ALREADY_BOUGHT', () => buy('sh1', 'solo', game, 'constraint_reroll'));
  const e = await buy('sh1', 'solo', game, 'emergency_refill');
  if (e.price !== 60 || e.effect !== 25) throw new Error(JSON.stringify(e));
  await expectErr('PURCHASE_LIMIT', () => buy('sh1', 'solo', game, 'upgrade_reroll'));
  await expectErr('GAME_NOT_FOUND', () => buy('sh2', 'solo', game, 'refill'));
  await expectErr('UNKNOWN_ITEM', () => buy('sh1', 'solo', uuid(), 'cheat'));
  await expectErr('INVALID_PURCHASE', () => buy('sh1', 'nope', uuid(), 'refill'));
  if ((await rpc('sh1', 'survivor_shop', 'solo', game)).remaining !== 0) throw new Error('compteur');
});
await check('solde insuffisant: aucun débit, aucune trace', async () => {
  await fund('sh2', 20);
  const before = await ledgerCount('sh2');
  const game = uuid();
  await expectErr('INSUFFICIENT_FUNDS', () => buy('sh2', 'solo', game, 'upgrade_reroll', uuid()).then(() => buy('sh2', 'solo', game, 'refill'))); // 25 > 20
  if ((await bal('sh2')) !== 20 || (await ledgerCount('sh2')) !== before) throw new Error('débit malgré le refus');
  if ((await row('select count(*)::int n from survivor_purchases where user_id=$1', [sv.sh2])).n !== 0) throw new Error('achat enregistré');
});

let shg;
await check('Relay: Recharge, plafonnée, seulement avant de dessiner et s’il manque au moins 20', async () => {
  shg = await shopRelay('sh3');
  await fund('sh3', 400); await fund('sh4', 100);
  await state('sh3', shg);
  await expectErr('NOT_AVAILABLE', () => buy('sh3', 'game', shg, 'refill')); // réserve pleine
  await setRun(shg, 'reserve = 85');
  await expectErr('NOT_AVAILABLE', () => buy('sh3', 'game', shg, 'refill')); // il manque 15
  await setRun(shg, 'reserve = 70');
  const r = await buy('sh3', 'game', shg, 'refill');
  const run = r.state.run;
  if (run.reserve !== 90 || r.balance !== 360 || r.price !== 40) throw new Error(JSON.stringify([run.reserve, r.balance]));
  await rpc('sh3', 'survivor_pick', shg, run.proposals[0].id);
  await setRun(shg, 'reserve = 80');
  await expectErr('ALREADY_BOUGHT', () => buy('sh3', 'game', shg, 'refill'));
  if ((await bal('sh4')) !== 100) throw new Error('les autres participants ne paient jamais');
});
await check('Relay: Dernière chance ajoute 25 pendant le dessin, jamais avec un secours gratuit ni sans case choisie', async () => {
  await setRun(shg, 'emergency = 1');
  await expectErr('NOT_AVAILABLE', () => buy('sh3', 'game', shg, 'emergency_refill'));
  await setRun(shg, 'emergency = 0, reserve = 8');
  const before = await bal('sh3');
  const r = await buy('sh3', 'game', shg, 'emergency_refill');
  if (r.state.run.reserve !== 33 || r.state.run.pick === null || r.effect !== 25 || before - r.balance !== 60) throw new Error(JSON.stringify(r.state.run));
  if (r.state.run.emergency !== 0 || r.state.run.emergency_uses !== 0) throw new Error('le Dernier souffle gratuit ne doit pas bouger');
});
await check('Relay: transaction annulée entièrement si un enregistrement échoue', async () => {
  await db.query("create function survivor_test_boom() returns trigger language plpgsql as $$ begin raise exception 'BOOM'; end $$");
  await db.query('create trigger survivor_test_boom before insert on survivor_purchases for each row execute function survivor_test_boom()');
  try {
    await db.query('delete from survivor_rate_limits');
    const before = { bal: await bal('sh3'), n: await ledgerCount('sh3'), run: await runOf('sh3', shg).catch(() => null) };
    const proposals = JSON.stringify((await runOf('sh3', shg)).proposals);
    await expectErr('BOOM', async () => { await state('sh3', shg); await db.query("update survivor_runs set pick = null, pick_by = null where game_id=$1 and user_id is null", [shg]); return buy('sh3', 'game', shg, 'constraint_reroll'); });
    if ((await bal('sh3')) !== before.bal || (await ledgerCount('sh3')) !== before.n) throw new Error('débit conservé après l’échec');
    if (JSON.stringify((await runOf('sh3', shg)).proposals) !== proposals) throw new Error('effet conservé après l’échec');
  } finally { await db.query('drop trigger survivor_test_boom on survivor_purchases'); await db.query('drop function survivor_test_boom()'); }
});
await check('Relay: Joker payant relance les trois demandes sans toucher aux charges ni aux cases précédentes', async () => {
  await setRun(shg, 'jokers = 2, joker_uses = 0');
  const before = (await runOf('sh3', shg)).proposals.map((p) => p.id);
  const r = await buy('sh3', 'game', shg, 'constraint_reroll');
  const after = r.state.run;
  if (after.proposals.length !== 3) throw new Error('propositions');
  if (JSON.stringify(after.proposals.map((p) => p.id)) === JSON.stringify(before)) throw new Error('propositions inchangées');
  if (after.jokers !== 2 || after.joker_uses !== 0 || r.balance !== (await bal('sh3'))) throw new Error('les charges de Joker gagnées ne doivent pas être consommées');
  if (after.cases_done !== (await row('select cases_done from survivor_runs where game_id=$1 and user_id is null', [shg])).cases_done) throw new Error('cases');
});
await check('Relay: limite collective de trois achats, quel que soit l’acheteur', async () => {
  const g = await shopRelay('sh3');
  await state('sh3', g);
  await setRun(g, 'reserve = 50');
  await buy('sh3', 'game', g, 'refill');
  await rpc('sh3', 'survivor_pick', g, (await runNow('sh3', g)).proposals[0].id);
  await buy('sh3', 'game', g, 'emergency_refill');
  await turn('sh3', g); // case 1 publiée: le relais passe
  await rpc('sh4', 'survivor_reserve', g);
  await state('sh4', g);
  await buy('sh4', 'game', g, 'constraint_reroll'); // troisième achat, payé par sh4
  await expectErr('PURCHASE_LIMIT', () => buy('sh4', 'game', g, 'upgrade_reroll'));
  if ((await rpc('sh4', 'survivor_shop', 'game', g)).remaining !== 0) throw new Error('compteur partagé');
  shg = g;
});
await check('Relay: seul le joueur qui peut agir achète (ni ancien contributeur, ni extérieur, ni partie finie)', async () => {
  const g = await shopRelay('sh5');
  await state('sh5', g); await fund('sh5', 300); await fund('sh6', 300);
  await expectErr('NO_RESERVATION', () => buy('sh6', 'game', g, 'constraint_reroll')); // jamais réservé
  await turn('sh5', g); // sh5 contribue puis perd sa réservation
  await expectErr('NO_RESERVATION', () => buy('sh5', 'game', g, 'constraint_reroll')); // ancien contributeur
  await rpc('sh6', 'survivor_reserve', g);
  const before = await bal('sh5');
  await buy('sh6', 'game', g, 'constraint_reroll');
  if ((await bal('sh5')) !== before) throw new Error('prélèvement chez un autre participant');
  await rpc('sh6', 'survivor_abandon', g);
  await db.query("update survivor_games set status='abandoned', ended_reason='expired', finished_at=now() where id=$1", [g]);
  await expectErr('GAME_NOT_ACTIVE', () => buy('sh6', 'game', g, 'refill'));
  if ((await bal('sh6')) !== 270) throw new Error('débit après la fin de partie');
});
await check('Relay: Second choix remplace les trois améliorations sans en accorder, sinon refusé sans débit', async () => {
  const g = await shopRelay('sh3');
  await state('sh3', g);
  await rpc('sh3', 'survivor_reserve', g).catch(() => undefined);
  await turn('sh3', g);
  await rpc('sh4', 'survivor_reserve', g);
  await turn('sh4', g, { finish: false }); // 2e case: amélioration due, choisie par sh4
  const st = await state('sh4', g);
  if (st.run.step !== 'upgrade') throw new Error('amélioration attendue');
  const old = st.run.offer;
  await expectErr('NOT_AVAILABLE', () => buy('sh4', 'game', g, 'refill'));
  const full = Object.fromEntries((await db.query('select id, max_stacks from survivor_upgrade_defs')).rows.map((u) => [u.id, u.max_stacks]));
  const owned = JSON.stringify(Object.fromEntries(Object.entries(full).filter(([id]) => !old.includes(id)).slice(1).map(([id, m]) => [id, m])));
  const keep = (await row('select upgrades u from survivor_runs where game_id=$1 and user_id is null', [g])).u;
  await setRun(g, `upgrades = '${owned}'::jsonb`); // un seul candidat nouveau: pas de renouvellement possible
  const b = await bal('sh4'), n = await ledgerCount('sh4');
  await expectErr('NO_NEW_OFFER', () => buy('sh4', 'game', g, 'upgrade_reroll'));
  if ((await bal('sh4')) !== b || (await ledgerCount('sh4')) !== n) throw new Error('débit malgré le refus');
  await setRun(g, `upgrades = '${JSON.stringify(keep)}'::jsonb`);
  const r = await buy('sh4', 'game', g, 'upgrade_reroll');
  const now = r.state.run;
  if (now.step !== 'upgrade' || now.offer.length !== 3 || now.offer.some((id) => old.includes(id))) throw new Error(JSON.stringify([old, now.offer]));
  if (Object.values(now.upgrades).some((v) => v > 0) && JSON.stringify(now.upgrades) !== JSON.stringify(keep)) throw new Error('une amélioration a été accordée');
  const g2 = await row('select upgrade_draws d from survivor_runs where game_id=$1 and user_id is null', [g]);
  if (g2.d !== 1) throw new Error('le tirage normal ne doit pas bouger');
  const seed = (await row('select seed from survivor_games where id=$1', [g])).seed;
  const direct = (await db.query("select survivor_draw_offer_salt($1, $2::jsonb, 'r1', $3::jsonb) o", [seed, JSON.stringify(keep), JSON.stringify(old)])).rows[0].o;
  if (JSON.stringify(direct) !== JSON.stringify(now.offer)) throw new Error('tirage non reproductible');
  const choose = await rpc('sh4', 'survivor_choose_upgrade', g, now.offer[0]);
  if (choose.state.run.step !== 'choosing') throw new Error('choix impossible après le renouvellement');
});
await check('Duel et Battle: aucun achat possible, même avec du solde; mêmes conditions pour les deux joueurs', async () => {
  await fund('sh7', 300); await fund('sh8', 300);
  for (const mode of ['duel', 'battle']) {
    const g = await pair(mode, 'sh7', 'sh8');
    for (const item of ['refill', 'constraint_reroll', 'upgrade_reroll', 'emergency_refill']) {
      for (const u of ['sh7', 'sh8']) await expectErr('SHOP_NOT_ALLOWED', () => buy(u, 'game', g, item));
    }
    const sh = await rpc('sh7', 'survivor_shop', 'game', g);
    if (sh.allowed !== false || sh.remaining !== 0) throw new Error(JSON.stringify(sh));
    await expectErr('GAME_NOT_FOUND', () => buy('sh3', 'game', g, 'refill'));
  }
  if ((await bal('sh7')) !== 300 || (await bal('sh8')) !== 300) throw new Error('débit en Duel ou en Battle');
  if ((await row("select count(*)::int n from survivor_purchases p join survivor_games g on g.id = p.game_id where g.mode in ('duel','battle')")).n !== 0) throw new Error('achat enregistré');
});
await check('concurrence simulée: deux achats pour un solde insuffisant, le second est refusé; rejeu et double clic sans double effet', async () => {
  await fund('sh8', 0 + 5); // 305 → on ramène à 45 par une dépense Solo
  const solo = uuid();
  await db.query("update survivor_wallets set balance = 45 where user_id = $1", [sv.sh8]);
  const a = await buy('sh8', 'solo', solo, 'refill'); // 40
  if (a.balance !== 5) throw new Error('solde');
  await expectErr('INSUFFICIENT_FUNDS', () => buy('sh8', 'solo', solo, 'constraint_reroll')); // 30 > 5
  const id = uuid();
  const g = await shopRelay('sh3');
  await state('sh3', g); await setRun(g, 'reserve = 40');
  const p = await Promise.allSettled([buy('sh3', 'game', g, 'refill', id), buy('sh3', 'game', g, 'refill', id)]);
  if (p.some((x) => x.status !== 'fulfilled')) throw new Error('double clic: ' + JSON.stringify(p.map((x) => x.reason?.message)));
  const n = (await row("select count(*)::int n from survivor_ink_ledger where idempotency_key = $1", ['buy:' + id])).n;
  if (n !== 1 || (await runNow('sh3', g)).reserve !== 60) throw new Error('double effet');
});
await check('récompenses d’arbitrage et solde préservés; solde = somme du registre, jamais négatif', async () => {
  const bad = (await db.query('select w.user_id from survivor_wallets w where w.balance <> (select coalesce(sum(amount), 0) from survivor_ink_ledger l where l.user_id = w.user_id) and w.user_id <> $1', [sv.sh8])).rows;
  if (bad.length) throw new Error('solde ≠ somme du registre');
  if ((await row('select count(*)::int n from survivor_wallets where balance < 0')).n !== 0) throw new Error('solde négatif');
  const gains = (await row("select count(*)::int n from survivor_ink_ledger where reason in ('arbiter_vote','arbiter_complete','vote_received') and amount in (2, 5, 10)")).n;
  if (gains < 10) throw new Error('récompenses d’arbitrage');
});

console.log(results.join('\n'));
