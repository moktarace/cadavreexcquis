// Recette de concurrence réelle du matchmaking Duel/Battle (migration 0018): plusieurs connexions PostgreSQL indépendantes.
//
// À lancer UNIQUEMENT sur une base de TEST jetable où 0013 à 0018 sont appliquées. Ce script ne lit jamais .env.local:
//   SURVIVOR_TEST_DB_URL=postgres://... SURVIVOR_TEST_DB_CONFIRM=oui-cest-une-base-de-test node scripts/check-concurrency.mjs
// Il crée des utilisateurs factices dans auth.users (supprimés à la fin) et des parties Duel/Battle de test.
import pg from 'pg';

const url = process.env.SURVIVOR_TEST_DB_URL;
if (!url || process.env.SURVIVOR_TEST_DB_CONFIRM !== 'oui-cest-une-base-de-test') {
  console.log('Refus: définir SURVIVOR_TEST_DB_URL (base de test) et SURVIVOR_TEST_DB_CONFIRM=oui-cest-une-base-de-test. Rien n\'a été exécuté.');
  process.exit(2);
}
const ROUNDS = Number(process.env.ROUNDS ?? 20);
const pool = new pg.Pool({ connectionString: url, max: 8 });
const users = [];
const failures = [];

async function newUser() {
  const id = crypto.randomUUID();
  await pool.query("insert into auth.users (id, aud, role, instance_id) values ($1, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')", [id]);
  users.push(id);
  return id;
}
// Chaque appel = sa propre connexion et sa propre transaction, avec l'identité de l'utilisateur (comme PostgREST).
async function asUser(uid, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [uid, JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await c.query('set local role authenticated');
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const matchmake = (u, mode) => asUser(u, 'select survivor_matchmake($1) r', [mode]).then((r) => r[0].r);
const check = (cond, msg) => { if (!cond) failures.push(msg); };

try {
  for (const mode of ['duel', 'battle']) {
    for (let i = 0; i < ROUNDS; i++) {
      await pool.query("update survivor_games set status = case when status = 'searching' then 'cancelled' else 'abandoned' end, ended_reason = case when status = 'searching' then 'cancelled' else 'expired' end, finished_at = now() where mode = $1 and status in ('searching','active')", [mode]);
      const [a, b] = [await newUser(), await newUser()];
      const res = await Promise.allSettled([matchmake(a, mode), matchmake(b, mode)]);
      const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const games = new Set(ok.map((r) => r.game.id));
      const waiting = (await pool.query("select count(*)::int n from survivor_games where mode = $1 and status = 'searching'", [mode])).rows[0].n;
      check(res.every((r) => r.status === 'fulfilled'), `${mode} #${i}: erreur ${res.find((r) => r.status === 'rejected')?.reason?.message}`);
      // Après les deux appels (un éventuel défi orphelin se résorbe au second appel de chacun), une seule partie active à deux.
      if (games.size !== 1) {
        await Promise.all([matchmake(a, mode), matchmake(b, mode)]).catch(() => undefined);
        const active = (await pool.query("select count(*)::int n from survivor_games g where g.mode = $1 and g.status = 'active' and exists (select 1 from survivor_players p where p.game_id = g.id and p.user_id = $2) and exists (select 1 from survivor_players p where p.game_id = g.id and p.user_id = $3)", [mode, a, b])).rows[0].n;
        check(active === 1, `${mode} #${i}: deux défis en attente, jamais appariés (${waiting} en attente, ${active} partie active)`);
        failures.push(`${mode} #${i}: course observée (deux parties distinctes après le premier appel)`);
      }
    }
    // Trois joueurs: deux appariés, un en attente.
    await pool.query("update survivor_games set status = case when status = 'searching' then 'cancelled' else 'abandoned' end, ended_reason = case when status = 'searching' then 'cancelled' else 'expired' end, finished_at = now() where mode = $1 and status in ('searching','active')", [mode]);
    const trio = [await newUser(), await newUser(), await newUser()];
    await Promise.all(trio.map((u) => matchmake(u, mode)));
    const rows = (await pool.query("select status, count(*)::int n from survivor_games where mode = $1 and status in ('searching','active') group by status", [mode])).rows;
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    check(by.active === 1 && by.searching === 1, `${mode}: trio → ${JSON.stringify(by)} (attendu 1 active, 1 en attente)`);
    for (const u of trio) check((await matchmake(u, mode)).game.id !== undefined, 'relance');
  }
} finally {
  await pool.query('delete from auth.users where id = any($1::uuid[])', [users]).catch(() => undefined);
  await pool.end();
}
if (failures.length) {
  console.log(`ÉCHEC (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`OK: ${ROUNDS} rondes par mode sans défis orphelins, trio apparié 2+1.`);
