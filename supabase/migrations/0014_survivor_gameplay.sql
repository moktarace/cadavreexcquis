-- Survivor, étape 2: gameplay multijoueur (réserves d'encre, tirages, tours, stockage privé). Complète 0013 sans la réécrire.
-- Le serveur calcule récompenses, améliorations, capacité, charges et transitions; le client ne déclare que la case
-- (position, soumission, demande choisie, image) et l'encre qu'il a dépensée en dessinant, seule donnée non vérifiable
-- (le coût de dessin est calculé par l'éditeur local: un client modifié peut sous-déclarer sa dépense).
-- NON DÉPLOYÉ: à valider avec `npm run db:check` puis sur une base de test.

-- ───────────── Évolutions de 0013 ─────────────
alter table public.survivor_games add column defeat_by uuid references public.profiles (id);
alter table public.survivor_games drop constraint survivor_games_ended_reason_check;
alter table public.survivor_games add constraint survivor_games_ended_reason_check
  check (ended_reason in ('completed', 'forfeit', 'expired', 'cancelled', 'defeat'));

-- Identifiant de soumission: un double clic ou une relance ne crée jamais une seconde case.
alter table public.survivor_cases add column submission_id uuid;
create unique index survivor_cases_submission on public.survivor_cases (game_id, submission_id);
drop function public.survivor_submit_case(uuid, text, text, numeric, numeric);

-- ───────────── Règles connues du serveur (bloc généré depuis la configuration TypeScript) ─────────────
create table public.survivor_constraints (
  id       text primary key,
  level    text not null check (level in ('easy', 'medium', 'hard')),
  phases   text[],
  min_case smallint
);
create table public.survivor_upgrade_defs (
  id         text primary key,
  max_stacks int not null check (max_stacks > 0)
);
alter table public.survivor_constraints enable row level security;
alter table public.survivor_upgrade_defs enable row level security;
revoke all on public.survivor_constraints, public.survivor_upgrade_defs from anon, authenticated;

-- BEGIN GENERATED (scripts/survivor-sql.ts: ne pas modifier à la main)
insert into public.survivor_constraints (id, level, phases, min_case) values
  ('11', 'hard', array['complication', 'escalade'], null),
  ('12', 'medium', null, 2),
  ('13', 'medium', null, null),
  ('14', 'hard', array['complication', 'escalade', 'denouement'], null),
  ('15', 'hard', array['complication', 'escalade'], null),
  ('16', 'easy', null, null),
  ('21', 'easy', array['intro', 'complication', 'escalade'], null),
  ('22', 'medium', null, null),
  ('23', 'hard', null, null),
  ('24', 'easy', null, null),
  ('25', 'easy', null, null),
  ('26', 'medium', null, null),
  ('31', 'medium', null, null),
  ('32', 'easy', null, null),
  ('33', 'hard', array['intro', 'complication', 'escalade'], null),
  ('34', 'easy', null, null),
  ('35', 'medium', null, null),
  ('36', 'medium', null, null),
  ('41', 'medium', null, null),
  ('42', 'easy', null, null),
  ('43', 'medium', null, null),
  ('44', 'easy', null, null),
  ('45', 'medium', null, null),
  ('46', 'hard', null, null),
  ('51', 'hard', array['intro', 'complication', 'escalade'], null),
  ('52', 'easy', null, null),
  ('53', 'hard', array['intro', 'complication', 'escalade'], null),
  ('54', 'easy', null, null),
  ('55', 'easy', null, null),
  ('56', 'hard', null, null),
  ('61', 'hard', null, null),
  ('62', 'hard', array['intro', 'complication', 'escalade'], null),
  ('63', 'easy', null, null),
  ('64', 'medium', null, null),
  ('65', 'medium', null, null),
  ('66', 'hard', array['complication', 'escalade'], null);
insert into public.survivor_upgrade_defs (id, max_stacks) values
  ('encrier', 5),
  ('plume', 4),
  ('ami', 3),
  ('architecte', 3),
  ('ecrivain', 3),
  ('recyclage', 4),
  ('regeneration', 5),
  ('joker', 99),
  ('narrateur', 4),
  ('souffle', 2);
create function public.survivor_economy() returns jsonb language sql immutable as $$
  select '{"ink":{"start":100,"capacity":100},"rewards":{"easy":10,"medium":20,"hard":35},"upgrade_every":2,"offer_size":3,"upgrades":{"encrier":25,"regeneration":4,"narrateur":5,"joker_charges":2,"dernier_souffle":25}}'::jsonb
$$;
-- END GENERATED

-- ───────────── État de jeu: une « run » par réserve d'encre ─────────────
-- Relay: une seule run commune (user_id nul). Duel et Battle: une run par joueur.
-- Étapes: choosing (choix puis dessin de la case), upgrade, demands (Battle: demandes pour l'adversaire),
-- waiting (Battle: tour de l'autre), finished. Aucun brouillon de dessin n'est conservé.
create table public.survivor_runs (
  id             uuid primary key default gen_random_uuid(),
  game_id        uuid not null references public.survivor_games (id) on delete cascade,
  user_id        uuid references public.profiles (id) on delete cascade,
  step           text not null default 'choosing' check (step in ('choosing', 'upgrade', 'demands', 'waiting', 'finished')),
  reserve        numeric(8, 2) not null check (reserve >= 0),
  capacity       numeric(8, 2) not null,
  upgrades       jsonb not null default '{}',
  upgrade_picks  text[] not null default '{}',
  jokers         int not null default 0,
  emergency      int not null default 0,
  joker_uses     int not null default 0,
  emergency_uses int not null default 0,
  upgrade_draws  int not null default 0,
  total_spent    numeric(10, 2) not null default 0,
  cases_done     smallint not null default 0,
  proposals      jsonb not null default '[]',
  pick           text,
  pick_by        uuid,
  offer          jsonb not null default '[]',
  upgrade_until  timestamptz,
  demands        jsonb,
  outcome        text check (outcome in ('victory', 'defeat')),
  created_at     timestamptz not null default now()
);
create unique index survivor_runs_owner on public.survivor_runs (game_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.survivor_runs enable row level security;
revoke all on public.survivor_runs from anon, authenticated; -- lecture par survivor_state seulement

create table public.survivor_rate_limits (
  user_id      uuid not null,
  key          text not null,
  window_start timestamptz not null default now(),
  hits         int not null default 0,
  primary key (user_id, key)
);
alter table public.survivor_rate_limits enable row level security;
revoke all on public.survivor_rate_limits from anon, authenticated;

-- Un joueur dont la réservation tombe sur une case pour laquelle un autre avait choisi repart de ses propres choix.
create function public.survivor_reservation_reset_pick() returns trigger language plpgsql as $$
begin
  update public.survivor_runs set pick = null, pick_by = null
   where game_id = new.game_id and user_id is null and pick_by is distinct from new.user_id;
  return new;
end $$;
create trigger survivor_reservation_reset_pick after insert on public.survivor_reservations
  for each row execute function public.survivor_reservation_reset_pick();

-- ───────────── Outils internes ─────────────

-- Anti-abus simple: au plus p_max appels par fenêtre de p_secs secondes, par joueur et par type d'action.
create function public.survivor_hit(p_uid uuid, p_key text, p_max int, p_secs int) returns void language plpgsql security definer set search_path = public as $$
declare v_hits int;
begin
  insert into public.survivor_rate_limits as l (user_id, key, hits) values (p_uid, p_key, 1)
  on conflict (user_id, key) do update
    set hits = case when now() - l.window_start > make_interval(secs => p_secs) then 1 else l.hits + 1 end,
        window_start = case when now() - l.window_start > make_interval(secs => p_secs) then now() else l.window_start end
  returning hits into v_hits;
  if v_hits > p_max then raise exception 'RATE_LIMITED'; end if;
end $$;

-- Étape de l'histoire: quatre tranches égales (comme phaseOf côté TypeScript).
create function public.survivor_phase_of(p_pos int, p_total int) returns text language sql immutable as $$
  select (array['intro', 'complication', 'escalade', 'denouement'])[least(3, floor(((p_pos - 1)::numeric / p_total) * 4)::int) + 1]
$$;

-- Demandes proposables à ce niveau et à cette case. Évite d'abord les demandes déjà choisies (et p_avoid), puis seulement
-- les déjà choisies, puis ignore l'éligibilité narrative en dernier recours (mêmes paliers que drawProposals).
create function public.survivor_allowed(p_level text, p_pos int, p_total int, p_chosen text[], p_avoid text[]) returns text[] language plpgsql stable security definer set search_path = public as $$
declare v text[]; v_phase text := public.survivor_phase_of(p_pos, p_total);
begin
  select array_agg(c.id order by c.id) into v from public.survivor_constraints c
   where c.level = p_level and (c.phases is null or v_phase = any (c.phases)) and p_pos >= coalesce(c.min_case, 1)
     and c.id <> all (p_chosen) and c.id <> all (p_avoid);
  if v is null then
    select array_agg(c.id order by c.id) into v from public.survivor_constraints c
     where c.level = p_level and (c.phases is null or v_phase = any (c.phases)) and p_pos >= coalesce(c.min_case, 1) and c.id <> all (p_chosen);
  end if;
  if v is null then
    select array_agg(c.id order by c.id) into v from public.survivor_constraints c
     where c.level = p_level and (c.phases is null or v_phase = any (c.phases)) and p_pos >= coalesce(c.min_case, 1);
  end if;
  if v is null then select array_agg(c.id order by c.id) into v from public.survivor_constraints c where c.level = p_level; end if;
  return v;
end $$;

-- Tirage déterministe: seed, case, difficulté et « sel » (0 = tirage normal, jN = Nième Joker) suffisent; aucun état de
-- générateur, donc un tirage supplémentaire d'un joueur ne décale jamais les suivants.
create function public.survivor_draw_proposals(p_seed bigint, p_pos int, p_total int, p_chosen text[], p_avoid text[], p_salt text) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_agg(pick.id order by pick.ord) from (
    select l.ord, (select id from unnest(public.survivor_allowed(l.level, p_pos, p_total, p_chosen, p_avoid)) id
                    order by hashtextextended(p_seed::text || ':c:' || p_pos || ':' || l.level || ':' || p_salt || ':' || id, 0), id limit 1) as id
    from (values (1, 'easy'), (2, 'medium'), (3, 'hard')) l(ord, level)
  ) pick
$$;

create function public.survivor_draw_offer(p_seed bigint, p_owned jsonb, p_n int) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(s.id order by s.h, s.id), '[]'::jsonb) from (
    select d.id, hashtextextended(p_seed::text || ':u:' || p_n || ':' || d.id, 0) as h
    from public.survivor_upgrade_defs d where coalesce((p_owned ->> d.id)::int, 0) < d.max_stacks
    order by 2, 1 limit (public.survivor_economy() ->> 'offer_size')::int
  ) s
$$;

create function public.survivor_chosen(p_game uuid, p_owner uuid) returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(constraint_id), '{}') from public.survivor_cases where game_id = p_game and bd_owner is not distinct from p_owner
$$;

-- Position de la prochaine case pour cette run (histoire commune: Relay, Battle; BD personnelle: Duel).
create function public.survivor_next_pos(g public.survivor_games, r public.survivor_runs) returns int language sql immutable as $$
  select case when g.mode = 'duel' then r.cases_done + 1 else g.cases_done + 1 end
$$;

create function public.survivor_proposals_for(g public.survivor_games, r public.survivor_runs, p_avoid text[], p_salt text) returns jsonb language sql stable security definer set search_path = public as $$
  select public.survivor_draw_proposals(g.seed, public.survivor_next_pos(g, r), g.total_cases,
    public.survivor_chosen(g.id, case when g.mode = 'duel' then r.user_id end), p_avoid, p_salt)
$$;

create function public.survivor_ensure_run(p_game uuid, p_uid uuid) returns public.survivor_runs language plpgsql security definer set search_path = public as $$
declare g public.survivor_games; r public.survivor_runs; e jsonb := public.survivor_economy(); v_owner uuid; v_step text;
begin
  select * into g from public.survivor_games where id = p_game;
  v_owner := case when g.mode = 'relay' then null else p_uid end;
  select * into r from public.survivor_runs where game_id = p_game and user_id is not distinct from v_owner;
  if found then
    -- Battle: le premier joueur, désigné à l'appariement, reçoit ses trois demandes initiales.
    if g.mode = 'battle' and r.step = 'waiting' and g.status = 'active' and g.turn_player = p_uid and g.cases_done = 0 and r.cases_done = 0 then
      update public.survivor_runs set step = 'choosing', proposals = public.survivor_proposals_for(g, r, '{}', '0') where id = r.id returning * into r;
    end if;
    return r;
  end if;
  v_step := case when g.mode = 'battle' and (g.status <> 'active' or g.turn_player is distinct from p_uid) then 'waiting' else 'choosing' end;
  insert into public.survivor_runs (game_id, user_id, step, reserve, capacity)
  values (p_game, v_owner, v_step, (e -> 'ink' ->> 'start')::numeric, (e -> 'ink' ->> 'capacity')::numeric)
  on conflict do nothing;
  select * into r from public.survivor_runs where game_id = p_game and user_id is not distinct from v_owner;
  if v_step = 'choosing' then
    update public.survivor_runs set proposals = public.survivor_proposals_for(g, r, '{}', '0') where id = r.id returning * into r;
  end if;
  return r;
end $$;

-- Ce joueur peut-il agir maintenant sur cette run? (la partie et la run doivent être à jour)
create function public.survivor_acting(g public.survivor_games, r public.survivor_runs, p_uid uuid) returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  if g.status not in ('searching', 'active') then return false; end if;
  if g.mode = 'duel' then
    return r.user_id = p_uid and r.step in ('choosing', 'upgrade')
       and exists (select 1 from public.survivor_players where game_id = g.id and user_id = p_uid and status = 'playing');
  elsif g.mode = 'battle' then
    return g.status = 'active' and g.turn_player = p_uid and r.user_id = p_uid and r.step in ('choosing', 'upgrade', 'demands');
  end if;
  if r.step = 'choosing' then
    return exists (select 1 from public.survivor_reservations where game_id = g.id and position = g.cases_done + 1 and user_id = p_uid and not completed and expires_at > now());
  elsif r.step = 'upgrade' then
    -- L'auteur de la case choisit d'abord; passé son délai, le joueur qui a réservé la suite le fait avant de dessiner.
    return public.survivor_last_author(g.id) = p_uid
        or (r.upgrade_until <= now() and exists (select 1 from public.survivor_reservations
              where game_id = g.id and position = g.cases_done + 1 and user_id = p_uid and not completed and expires_at > now()));
  end if;
  return false;
end $$;

-- Prélude des actions: authentification, limite d'appels, délais appliqués, verrous, run à jour.
create function public.survivor_enter(p_game uuid, p_key text, p_max int default 60) returns public.survivor_runs language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); g public.survivor_games; r public.survivor_runs;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, p_key, p_max, 60);
  perform public.survivor_expire_due();
  select * into g from public.survivor_games where id = p_game for update;
  if not found or not (g.mode = 'relay' or exists (select 1 from public.survivor_players where game_id = p_game and user_id = v_uid)) then
    raise exception 'GAME_NOT_FOUND';
  end if;
  r := public.survivor_ensure_run(p_game, v_uid);
  select * into r from public.survivor_runs where id = r.id for update;
  return r;
end $$;

create function public.survivor_require_acting(p_game uuid, r public.survivor_runs) returns void language plpgsql security definer set search_path = public as $$
declare g public.survivor_games;
begin
  select * into g from public.survivor_games where id = p_game;
  if not public.survivor_acting(g, r, auth.uid()) then
    if g.status not in ('searching', 'active') then raise exception 'GAME_NOT_ACTIVE'; end if;
    raise exception '%', case when g.mode <> 'relay' then 'NOT_YOUR_TURN' when r.step = 'upgrade' then 'UPGRADE_PENDING' else 'NO_RESERVATION' end;
  end if;
end $$;

-- ───────────── Lecture complète pour l'interface ─────────────
create function public.survivor_state_json(p_game uuid, p_uid uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g public.survivor_games; r public.survivor_runs; e jsonb := public.survivor_economy();
  v_ended boolean; v_acting boolean := false; v_props jsonb := '[]'; v_opts jsonb; v_cases jsonb; v_sum jsonb; v_wait numeric;
begin
  select * into g from public.survivor_games where id = p_game;
  if not found then return null; end if;
  select * into r from public.survivor_runs where game_id = p_game and user_id is not distinct from (case when g.mode = 'relay' then null else p_uid end);
  v_ended := g.status not in ('searching', 'active');
  if r.id is not null then
    v_acting := public.survivor_acting(g, r, p_uid);
    v_props := coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'level', c.level,
                  'reward', (e -> 'rewards' ->> c.level)::int + (e -> 'upgrades' ->> 'narrateur')::int * coalesce((r.upgrades ->> 'narrateur')::int, 0)) order by t.ord)
                from jsonb_array_elements_text(r.proposals) with ordinality t(id, ord) join public.survivor_constraints c on c.id = t.id), '[]');
    if g.mode = 'battle' and r.step = 'demands' and v_acting then
      v_opts := jsonb_build_object(
        'easy', to_jsonb(public.survivor_allowed('easy', g.cases_done + 1, g.total_cases, public.survivor_chosen(g.id, null), '{}')),
        'medium', to_jsonb(public.survivor_allowed('medium', g.cases_done + 1, g.total_cases, public.survivor_chosen(g.id, null), '{}')),
        'hard', to_jsonb(public.survivor_allowed('hard', g.cases_done + 1, g.total_cases, public.survivor_chosen(g.id, null), '{}')));
    end if;
    if g.mode = 'relay' and r.step = 'upgrade' and not v_acting and r.upgrade_until > now() then
      v_wait := extract(epoch from r.upgrade_until - now());
    end if;
  end if;
  v_cases := coalesce((select jsonb_agg(jsonb_build_object('position', c.position, 'author_id', c.author_id, 'nickname', pr.nickname,
                'constraint_id', c.constraint_id, 'image_path', c.image_path, 'ink_spent', c.ink_spent, 'reward', c.ink_reward,
                'bd_owner', c.bd_owner, 'mine', c.author_id = p_uid) order by c.bd_owner nulls first, c.position)
              from public.survivor_cases c join public.profiles pr on pr.id = c.author_id
              where c.game_id = p_game and public.survivor_can_read_case(c.game_id, c.bd_owner)), '[]');
  -- Réserves: la commune (Relay), les deux en Battle, la mienne en Duel jusqu'à la fin (puis les deux).
  v_sum := coalesce((select jsonb_agg(jsonb_build_object('nickname', pr.nickname, 'is_me', x.user_id = p_uid, 'shared', x.user_id is null,
                'step', case when x.user_id = p_uid or v_ended or g.mode = 'battle' then x.step end,
                'reserve', x.reserve, 'capacity', x.capacity, 'cases_done', x.cases_done, 'total_spent', x.total_spent,
                'upgrades', case when x.user_id is not distinct from p_uid or v_ended or x.user_id is null then x.upgrades end,
                'outcome', x.outcome) order by x.user_id is null desc, x.user_id = p_uid desc)
              from public.survivor_runs x left join public.profiles pr on pr.id = x.user_id
              where x.game_id = p_game and (x.user_id is not distinct from p_uid or x.user_id is null or g.mode = 'battle' or v_ended)), '[]');
  return jsonb_build_object(
    'game', public.survivor_view(p_game, p_uid), 'seed', g.seed::text, 'acting', v_acting, 'cases', v_cases, 'runs', v_sum,
    'demand_options', v_opts, 'upgrade_wait_seconds', case when v_wait is null then null else ceil(v_wait) end,
    'run', case when r.id is null then null else jsonb_build_object(
      'step', r.step, 'position', public.survivor_next_pos(g, r), 'reserve', r.reserve, 'capacity', r.capacity, 'upgrades', r.upgrades,
      'jokers', r.jokers, 'emergency', r.emergency, 'joker_uses', r.joker_uses, 'emergency_uses', r.emergency_uses,
      'total_spent', r.total_spent, 'cases_done', r.cases_done, 'proposals', v_props, 'pick', r.pick, 'offer', r.offer,
      'upgrade_until', r.upgrade_until, 'outcome', r.outcome, 'free_mimos', coalesce((r.upgrades ->> 'ami')::int, 0)) end);
end $$;

create function public.survivor_mp_result(p_outcome text, p_game uuid, p_uid uuid) returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('outcome', p_outcome, 'game', public.survivor_view(p_game, p_uid), 'state', public.survivor_state_json(p_game, p_uid))
$$;

-- ───────────── Remplacements (create or replace) de fonctions de 0013 ─────────────

-- Un joueur Relay qui a réservé la case lit les précédentes sans avoir encore publié; un Duel reste fermé jusqu'à sa fin.
create or replace function public.survivor_can_read_case(p_game uuid, p_owner uuid) returns boolean language sql stable security definer set search_path = public as $$
  select (public.survivor_is_player(p_game)
          or exists (select 1 from public.survivor_reservations r join public.survivor_games g on g.id = r.game_id
                      where r.game_id = p_game and g.mode = 'relay' and r.user_id = auth.uid() and not r.completed and r.expires_at > now()))
     and (p_owner is null or p_owner = auth.uid()
          or exists (select 1 from public.survivor_games g where g.id = p_game and g.status in ('finished', 'abandoned')))
$$;

-- Pendant que l'auteur de la dernière case choisit son amélioration, la suite n'est pas encore réservable par un autre.
create or replace function public.survivor_relay_ok(p_game uuid, p_uid uuid) returns boolean language plpgsql security definer set search_path = public as $$
declare g public.survivor_games;
begin
  select * into g from public.survivor_games where id = p_game;
  if not found or g.mode <> 'relay' or g.status <> 'active' or g.cases_done >= g.total_cases then return false; end if;
  if public.survivor_last_author(p_game) = p_uid then return false; end if;
  if exists (select 1 from public.survivor_runs where game_id = p_game and user_id is null and step = 'upgrade' and upgrade_until > now()) then return false; end if;
  if exists (select 1 from public.survivor_reservations r
              where r.game_id = p_game and r.position = g.cases_done + 1 and not r.completed and r.expires_at > now() and r.user_id <> p_uid) then
    return false;
  end if;
  if not exists (select 1 from public.survivor_players where game_id = p_game and user_id = p_uid)
     and (select count(*) from public.survivor_players where game_id = p_game) >= (g.rules -> 'relay' ->> 'max_players')::int then
    return false;
  end if;
  return true;
end $$;

create or replace function public.survivor_view(p_game uuid, p_uid uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g public.survivor_games; me public.survivor_players; r public.survivor_reservations; run public.survivor_runs;
  v_play boolean := false; v_secs numeric; v_bucket text; v_cancel boolean; v_abandon boolean; v_result text;
begin
  select * into g from public.survivor_games where id = p_game;
  if not found then return null; end if;
  select * into me from public.survivor_players where game_id = p_game and user_id = p_uid;
  select * into r from public.survivor_reservations
   where game_id = p_game and position = g.cases_done + 1 and user_id = p_uid and not completed and expires_at > now();
  select * into run from public.survivor_runs where game_id = p_game and user_id is not distinct from (case when g.mode = 'relay' then null else p_uid end);
  if g.status in ('searching', 'active') then
    if g.mode = 'duel' then v_play := coalesce(me.status = 'playing', false);
    elsif g.mode = 'battle' then v_play := g.status = 'active' and g.turn_player = p_uid;
    else
      v_play := r.user_id is not null or public.survivor_relay_ok(g.id, p_uid)
             or (run.step = 'upgrade' and public.survivor_last_author(g.id) = p_uid);
    end if;
    v_secs := case when g.mode = 'relay' then extract(epoch from r.expires_at - now()) else extract(epoch from g.deadline_at - now()) end;
  end if;
  v_bucket := case when g.status not in ('searching', 'active') then 'done' when v_play then 'mine' else 'waiting' end;
  v_cancel := g.status = 'searching' and g.created_by = p_uid;
  v_abandon := case when g.mode = 'relay' then r.user_id is not null
                    else g.status = 'active' and me.status = 'playing' end;
  v_result := case
    when g.status = 'cancelled' then 'cancelled'
    when g.ended_reason = 'expired' then 'expired'
    when g.ended_reason = 'defeat' and g.mode = 'relay' then 'defeat'
    when g.ended_reason = 'defeat' then case when g.defeat_by = p_uid then 'loss' else 'win' end
    when g.ended_reason = 'forfeit' then case when g.forfeit_by = p_uid then 'loss' else 'win' end
    when g.ended_reason = 'completed' then case g.mode when 'relay' then 'victory' when 'battle' then 'draw' else 'completed' end
  end;
  return jsonb_build_object(
    'id', g.id, 'mode', g.mode, 'status', g.status, 'visibility', g.visibility, 'theme', g.theme,
    'total_cases', g.total_cases, 'cases_done', g.cases_done, 'created_at', g.created_at,
    'deadline_at', g.deadline_at, 'ended_reason', g.ended_reason, 'server_now', now(), 'result', v_result,
    'seconds_left', case when v_secs is null then null else greatest(0, floor(v_secs)) end,
    'bucket', v_bucket, 'can_play', v_play, 'can_cancel', v_cancel, 'can_abandon', coalesce(v_abandon, false),
    'my_status', me.status, 'turn_is_mine', coalesce(g.status = 'active' and g.turn_player = p_uid, false),
    'forfeit_by_me', coalesce(g.forfeit_by = p_uid, false), 'reservation_until', r.expires_at,
    'reserve', run.reserve, 'capacity', run.capacity,
    'invite_token', case when v_cancel then (select token from public.survivor_invites where game_id = g.id) end,
    'players', coalesce((select jsonb_agg(jsonb_build_object('seat', p.seat, 'nickname', pr.nickname, 'status', p.status,
                                                            'cases_done', p.cases_done, 'is_me', p.user_id = p_uid) order by p.seat)
                           from public.survivor_players p join public.profiles pr on pr.id = p.user_id where p.game_id = g.id), '[]'::jsonb)
  );
end $$;

-- ───────────── Actions de jeu (RPC publiques) ─────────────

-- État complet d'une partie pour le joueur connecté: sa run, les cases qu'il a le droit de voir, les réserves visibles.
create function public.survivor_state(p_game uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'state', 120, 60);
  perform public.survivor_expire_due();
  if not (exists (select 1 from public.survivor_players where game_id = p_game and user_id = v_uid)
          or exists (select 1 from public.survivor_reservations where game_id = p_game and user_id = v_uid and not completed and expires_at > now())) then
    raise exception 'GAME_NOT_FOUND';
  end if;
  perform public.survivor_ensure_run(p_game, v_uid);
  -- Battle: la réserve de l'adversaire est visible dès l'appariement.
  perform public.survivor_ensure_run(p_game, (select user_id from public.survivor_players where game_id = p_game and user_id <> v_uid))
   where exists (select 1 from public.survivor_games where id = p_game and mode = 'battle' and status = 'active');
  if random() < 0.02 then perform public.survivor_queue_orphans(); end if;
  return public.survivor_state_json(p_game, v_uid);
end $$;

-- Choisit l'une des trois demandes proposées (idempotent; verrouillé une fois choisi).
create function public.survivor_pick(p_game uuid, p_constraint text) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.survivor_runs;
begin
  r := public.survivor_enter(p_game, 'act');
  if r.step = 'choosing' and r.pick = p_constraint and r.pick_by = auth.uid() then return public.survivor_mp_result('duplicate', p_game, auth.uid()); end if;
  perform public.survivor_require_acting(p_game, r);
  if r.step <> 'choosing' then raise exception 'STEP_MISMATCH'; end if;
  if r.pick is not null then raise exception 'PICK_LOCKED'; end if;
  if not (r.proposals @> to_jsonb(p_constraint)) then raise exception 'CONSTRAINT_NOT_ALLOWED'; end if;
  update public.survivor_runs set pick = p_constraint, pick_by = auth.uid() where id = r.id;
  return public.survivor_mp_result('picked', p_game, auth.uid());
end $$;

-- Joker: trois nouvelles demandes (tirage séparé, indexé par le nombre de Jokers déjà joués), avant de commencer à dessiner.
-- p_uses = nombre d'utilisations vu par le client: une relance rejouée n'est pas comptée deux fois.
create function public.survivor_joker(p_game uuid, p_uses int) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.survivor_runs; g public.survivor_games;
begin
  r := public.survivor_enter(p_game, 'act');
  if r.joker_uses = p_uses + 1 then return public.survivor_mp_result('duplicate', p_game, auth.uid()); end if;
  perform public.survivor_require_acting(p_game, r);
  if r.joker_uses <> p_uses then raise exception 'STALE_STATE'; end if;
  if r.step <> 'choosing' or r.pick is not null then raise exception 'PICK_LOCKED'; end if;
  if r.jokers <= 0 then raise exception 'NO_JOKER'; end if;
  select * into g from public.survivor_games where id = p_game;
  update public.survivor_runs set jokers = jokers - 1, joker_uses = joker_uses + 1,
         proposals = public.survivor_proposals_for(g, r, array(select jsonb_array_elements_text(r.proposals)), 'j' || (r.joker_uses + 1))
   where id = r.id;
  return public.survivor_mp_result('joker', p_game, auth.uid());
end $$;

-- Dernier souffle: ajoute la réserve d'urgence (même rejeu protégé que le Joker).
create function public.survivor_use_emergency(p_game uuid, p_uses int) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.survivor_runs;
begin
  r := public.survivor_enter(p_game, 'act');
  if r.emergency_uses = p_uses + 1 then return public.survivor_mp_result('duplicate', p_game, auth.uid()); end if;
  perform public.survivor_require_acting(p_game, r);
  if r.emergency_uses <> p_uses then raise exception 'STALE_STATE'; end if;
  if r.step <> 'choosing' then raise exception 'STEP_MISMATCH'; end if;
  if r.emergency <= 0 then raise exception 'NO_EMERGENCY'; end if;
  update public.survivor_runs set emergency = emergency - 1, emergency_uses = emergency_uses + 1,
         reserve = reserve + ((public.survivor_economy() -> 'upgrades' ->> 'dernier_souffle')::numeric)
   where id = r.id;
  return public.survivor_mp_result('emergency', p_game, auth.uid());
end $$;

-- Choisit une amélioration parmi celles proposées. Relay: l'auteur de la case d'abord, puis le joueur suivant.
create function public.survivor_choose_upgrade(p_game uuid, p_upgrade text) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.survivor_runs; g public.survivor_games; e jsonb := public.survivor_economy(); v_up jsonb; v_cap numeric; v_res numeric;
begin
  r := public.survivor_enter(p_game, 'act');
  if r.step <> 'upgrade' and cardinality(r.upgrade_picks) = r.upgrade_draws and r.upgrade_picks[cardinality(r.upgrade_picks)] = p_upgrade then
    return public.survivor_mp_result('duplicate', p_game, auth.uid());
  end if;
  if r.step <> 'upgrade' then raise exception 'STEP_MISMATCH'; end if;
  perform public.survivor_require_acting(p_game, r);
  if not (r.offer @> to_jsonb(p_upgrade)) then raise exception 'UPGRADE_NOT_OFFERED'; end if;
  select * into g from public.survivor_games where id = p_game;
  v_up := jsonb_set(r.upgrades, array[p_upgrade], to_jsonb(coalesce((r.upgrades ->> p_upgrade)::int, 0) + 1));
  v_cap := (e -> 'ink' ->> 'capacity')::numeric + (e -> 'upgrades' ->> 'encrier')::numeric * coalesce((v_up ->> 'encrier')::int, 0);
  v_res := r.reserve + case when p_upgrade = 'encrier' then least(v_cap - r.reserve, (e -> 'upgrades' ->> 'encrier')::numeric) else 0 end;
  update public.survivor_runs
     set upgrades = v_up, capacity = v_cap, reserve = greatest(r.reserve, v_res), offer = '[]', upgrade_until = null,
         upgrade_picks = upgrade_picks || p_upgrade,
         jokers = jokers + case when p_upgrade = 'joker' then (e -> 'upgrades' ->> 'joker_charges')::int else 0 end,
         emergency = emergency + case when p_upgrade = 'souffle' then 1 else 0 end,
         step = case when g.mode = 'battle' then 'demands' else 'choosing' end
   where id = r.id returning * into r;
  if g.mode <> 'battle' then
    update public.survivor_runs set proposals = public.survivor_proposals_for(g, r, '{}', '0') where id = r.id;
  end if;
  return public.survivor_mp_result('upgraded', p_game, auth.uid());
end $$;

-- Battle: transmet le tour en proposant exactement trois demandes (facile, intermédiaire, difficile) à l'adversaire.
create function public.survivor_set_demands(p_game uuid, p_ids text[]) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.survivor_runs; g public.survivor_games; v_opp uuid; o public.survivor_runs; v_levels text[] := array['easy', 'medium', 'hard'];
  v_chosen text[]; i int;
begin
  r := public.survivor_enter(p_game, 'act');
  select * into g from public.survivor_games where id = p_game;
  if g.mode <> 'battle' then raise exception 'INVALID_MODE'; end if;
  select user_id into v_opp from public.survivor_players where game_id = p_game and user_id <> auth.uid();
  if r.step = 'waiting' and g.turn_player = v_opp and r.demands = to_jsonb(p_ids) then
    return public.survivor_mp_result('duplicate', p_game, auth.uid());
  end if;
  perform public.survivor_require_acting(p_game, r);
  if r.step <> 'demands' then raise exception 'STEP_MISMATCH'; end if;
  if p_ids is null or cardinality(p_ids) <> 3 then raise exception 'INVALID_DEMAND'; end if;
  v_chosen := public.survivor_chosen(p_game, null);
  for i in 1..3 loop
    if not (p_ids[i] = any (public.survivor_allowed(v_levels[i], g.cases_done + 1, g.total_cases, v_chosen, '{}'))) then raise exception 'INVALID_DEMAND'; end if;
  end loop;
  o := public.survivor_ensure_run(p_game, v_opp);
  update public.survivor_runs set proposals = to_jsonb(p_ids), pick = null, pick_by = null, step = 'choosing' where id = o.id;
  update public.survivor_runs set step = 'waiting', demands = to_jsonb(p_ids) where id = r.id;
  update public.survivor_games
     set turn_player = v_opp, deadline_at = now() + make_interval(hours => (g.rules -> 'battle' ->> 'turn_hours')::int)
   where id = p_game;
  return public.survivor_mp_result('turn_passed', p_game, auth.uid());
end $$;

-- Panne d'encre déclarée par le client (le serveur ne voit pas le dessin): refusée tant qu'un secours existe.
-- Sans danger en Duel et en Battle (le joueur ne fait que se déclarer perdant); en Relay, il faut tenir la réservation.
create function public.survivor_declare_stuck(p_game uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.survivor_runs; g public.survivor_games; v_uid uuid := auth.uid();
begin
  r := public.survivor_enter(p_game, 'act');
  if r.outcome = 'defeat' then return public.survivor_mp_result('duplicate', p_game, v_uid); end if;
  perform public.survivor_require_acting(p_game, r);
  if r.step <> 'choosing' then raise exception 'STEP_MISMATCH'; end if;
  if r.emergency > 0 or coalesce((r.upgrades ->> 'ami')::int, 0) > 0 then raise exception 'NOT_STUCK'; end if;
  select * into g from public.survivor_games where id = p_game;
  update public.survivor_runs set step = 'finished', outcome = 'defeat', pick = null, proposals = '[]' where id = r.id;
  if g.mode = 'duel' then
    update public.survivor_players set status = 'done' where game_id = p_game and user_id = v_uid;
    if g.status = 'active' and not exists (select 1 from public.survivor_players where game_id = p_game and status <> 'done') then
      update public.survivor_games set status = 'finished', ended_reason = 'completed', finished_at = now() where id = p_game;
    end if;
  else
    update public.survivor_runs set step = 'finished', outcome = coalesce(outcome, 'victory') where game_id = p_game and id <> r.id and g.mode = 'battle';
    update public.survivor_games set status = 'finished', ended_reason = 'defeat', defeat_by = case when g.mode = 'battle' then v_uid end, finished_at = now() where id = p_game;
  end if;
  return public.survivor_mp_result('defeat', p_game, v_uid);
end $$;

-- Dépose la case terminée. Le serveur vérifie la place, la demande, l'encre et l'image, puis calcule lui-même récompense,
-- améliorations, réserve et transition (case suivante, amélioration à choisir, demandes à transmettre, fin de partie).
create function public.survivor_submit_case(
  p_game uuid, p_position int, p_submission uuid, p_constraint text, p_image text, p_ink_spent numeric
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); g public.survivor_games; r public.survivor_runs; e jsonb := public.survivor_economy();
  v_level text; v_reward numeric; v_regen numeric; v_after numeric; v_cases int; v_end boolean; v_step text; v_offer jsonb;
  v_until timestamptz; o record; v_expected int;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'submit', 12, 60);
  r := public.survivor_enter(p_game, 'act');
  select * into g from public.survivor_games where id = p_game;
  if exists (select 1 from public.survivor_cases where game_id = p_game and submission_id = p_submission) then
    if exists (select 1 from public.survivor_cases where game_id = p_game and submission_id = p_submission and author_id = v_uid) then
      return public.survivor_mp_result('duplicate', p_game, v_uid);
    end if;
    raise exception 'INVALID_SUBMISSION';
  end if;
  perform public.survivor_require_acting(p_game, r);
  if r.step <> 'choosing' then raise exception 'STEP_MISMATCH'; end if;
  v_expected := public.survivor_next_pos(g, r);
  if p_position is distinct from v_expected then raise exception 'STALE_POSITION'; end if;
  if r.pick is null or r.pick is distinct from p_constraint or not (r.proposals @> to_jsonb(p_constraint)) then raise exception 'CONSTRAINT_NOT_ALLOWED'; end if;
  if p_ink_spent is null or p_ink_spent = 'NaN'::numeric or p_ink_spent < 0 or p_ink_spent > r.reserve then raise exception 'INVALID_INK'; end if;
  if p_image is distinct from v_uid::text || '/' || p_game::text || '/' || p_submission::text || '.png' then raise exception 'INVALID_IMAGE'; end if;
  select * into o from storage.objects where bucket_id = 'survivor' and name = p_image;
  if not found then raise exception 'IMAGE_MISSING'; end if;
  if coalesce((o.metadata ->> 'size')::bigint, 0) not between 1 and 262144 or coalesce(o.metadata ->> 'mimetype', '') <> 'image/png' then
    raise exception 'INVALID_IMAGE';
  end if;

  select level into v_level from public.survivor_constraints where id = p_constraint;
  v_reward := (e -> 'rewards' ->> v_level)::numeric + (e -> 'upgrades' ->> 'narrateur')::numeric * coalesce((r.upgrades ->> 'narrateur')::int, 0);
  v_regen := (e -> 'upgrades' ->> 'regeneration')::numeric * coalesce((r.upgrades ->> 'regeneration')::int, 0);
  v_after := least(r.capacity, greatest(0, r.reserve - p_ink_spent) + v_reward + v_regen);
  v_cases := r.cases_done + 1;

  insert into public.survivor_cases (game_id, bd_owner, position, author_id, constraint_id, image_path, ink_spent, ink_reward, submission_id)
  values (p_game, case when g.mode = 'duel' then v_uid end, v_expected, v_uid, p_constraint, p_image, p_ink_spent, v_reward + v_regen, p_submission);

  -- Partie: progression commune, relais, tour.
  if g.mode = 'duel' then
    update public.survivor_players set cases_done = v_cases, status = case when v_cases >= g.total_cases then 'done' else status end where game_id = p_game and user_id = v_uid;
    update public.survivor_games set last_case_at = now() where id = p_game;
    v_end := v_cases >= g.total_cases;
    if v_end and g.status = 'active' and not exists (select 1 from public.survivor_players where game_id = p_game and status <> 'done') then
      update public.survivor_games set status = 'finished', ended_reason = 'completed', finished_at = now() where id = p_game;
    end if;
  else
    insert into public.survivor_players (game_id, user_id, seat, cases_done)
    values (p_game, v_uid, (select coalesce(max(seat), 0) + 1 from public.survivor_players where game_id = p_game), 1)
    on conflict (game_id, user_id) do update set cases_done = public.survivor_players.cases_done + 1;
    update public.survivor_reservations set completed = true where game_id = p_game and position = v_expected;
    update public.survivor_games set cases_done = v_expected, last_case_at = now() where id = p_game;
    v_end := v_expected >= g.total_cases;
    if v_end then
      update public.survivor_games set status = 'finished', ended_reason = 'completed', finished_at = now() where id = p_game;
    end if;
  end if;

  if v_end then
    v_step := 'finished';
  elsif v_cases % (e ->> 'upgrade_every')::int = 0 then
    v_step := 'upgrade';
    v_offer := public.survivor_draw_offer(g.seed, r.upgrades, r.upgrade_draws);
    v_until := case when g.mode = 'relay' then now() + make_interval(mins => (g.rules -> 'relay' ->> 'reserve_minutes')::int) end;
  else
    v_step := case when g.mode = 'battle' then 'demands' else 'choosing' end;
  end if;
  update public.survivor_runs
     set reserve = v_after, total_spent = total_spent + p_ink_spent, cases_done = v_cases, pick = null, pick_by = null, proposals = '[]',
         step = v_step, outcome = case when v_end then 'victory' end,
         offer = coalesce(v_offer, '[]'), upgrade_until = v_until, upgrade_draws = upgrade_draws + case when v_step = 'upgrade' then 1 else 0 end
   where id = r.id returning * into r;
  if v_end and g.mode = 'battle' then
    update public.survivor_runs set step = 'finished', outcome = 'victory' where game_id = p_game and outcome is null;
  end if;
  if v_step = 'choosing' then
    select * into g from public.survivor_games where id = p_game;
    update public.survivor_runs set proposals = public.survivor_proposals_for(g, r, '{}', '0') where id = r.id;
  end if;
  return public.survivor_mp_result('submitted', p_game, v_uid);
end $$;

-- ───────────── Stockage privé des dessins ─────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('survivor', 'survivor', false, 262144, array['image/png'])
on conflict (id) do nothing;

-- Chemin: <joueur>/<partie>/<soumission>.png. Seul un participant (ou le détenteur d'une réservation Relay) dépose.
create function public.survivor_can_upload(p_name text) returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_game uuid;
begin
  if p_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.png$' then return false; end if;
  v_game := (storage.foldername(p_name))[2]::uuid;
  return (storage.foldername(p_name))[1] = auth.uid()::text
     and (exists (select 1 from public.survivor_players where game_id = v_game and user_id = auth.uid())
          or exists (select 1 from public.survivor_reservations where game_id = v_game and user_id = auth.uid() and not completed and expires_at > now()));
end $$;

-- Lecture: ses propres envois, et les cases publiées que les règles de lecture des cases autorisent.
create function public.survivor_can_read_file(p_name text) returns boolean language sql stable security definer set search_path = public as $$
  select (storage.foldername(p_name))[1] = auth.uid()::text
      or exists (select 1 from public.survivor_cases c where c.image_path = p_name and public.survivor_can_read_case(c.game_id, c.bd_owner))
$$;

-- Ni mise à jour ni suppression: un dessin publié reste immuable.
create policy storage_survivor_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'survivor' and public.survivor_can_upload(name));
create policy storage_survivor_read on storage.objects for select to authenticated
  using (bucket_id = 'survivor' and public.survivor_can_read_file(name));

-- Fichiers envoyés mais jamais publiés (échec entre l'envoi et la validation): mis en file de suppression, appelé de façon
-- opportuniste par survivor_state (aucun service permanent). Même garde que les autres purges: inactive tant qu'elle est désarmée.
create function public.survivor_queue_orphans(p_older interval default interval '1 day') returns int language plpgsql security definer set search_path = public as $$
declare v_n int := 0;
begin
  if not coalesce((select enabled from public.purge_state), false) then return 0; end if;
  insert into public.storage_deletions (bucket, path, reason)
  select o.bucket_id, o.name, 'orphan' from storage.objects o
   where o.bucket_id = 'survivor' and o.created_at < now() - p_older
     and not exists (select 1 from public.survivor_cases c where c.image_path = o.name)
  on conflict (bucket, path) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ───────────── Droits d'exécution ─────────────
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'survivor\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any (array['survivor_rules', 'survivor_is_player', 'survivor_can_read_case', 'survivor_matchmake',
        'survivor_create_challenge', 'survivor_peek_invite', 'survivor_accept_invite', 'survivor_cancel', 'survivor_abandon',
        'survivor_reserve', 'survivor_extend_reservation', 'survivor_my_games', 'survivor_get_game',
        'survivor_state', 'survivor_pick', 'survivor_joker', 'survivor_use_emergency', 'survivor_choose_upgrade',
        'survivor_set_demands', 'survivor_declare_stuck', 'survivor_submit_case', 'survivor_can_upload', 'survivor_can_read_file']) then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
