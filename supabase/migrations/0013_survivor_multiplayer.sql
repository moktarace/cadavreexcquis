-- Survivor (laboratoire): fondations multijoueurs asynchrones (Relay, Duel, Battle). Le mode Solo reste local.
-- Isolé du Cadavre Exquis classique: tables et fonctions préfixées `survivor_`, seule dépendance `profiles` et `themes`.
-- Le serveur est l'autorité: toute écriture passe par une RPC (SECURITY DEFINER, search_path figé, identité lue dans
-- auth.uid()); les tables ne sont lisibles que par les participants. Les délais utilisent now() (heure serveur) et
-- les expirations sont appliquées paresseusement par `survivor_expire_due()`, sans tâche planifiée.
-- NON DÉPLOYÉ: à valider avec `npm run db:check` puis sur une base de test (voir README).

-- ───────────── Paramètres (source unique, lus par le client via survivor_rules()) ─────────────
create function public.survivor_rules() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'total_cases', 16,
    'relay',  jsonb_build_object('max_players', 16, 'reserve_minutes', 15, 'extend_minutes', 10, 'reserve_max_minutes', 45),
    'duel',   jsonb_build_object('max_unfinished', 3, 'hours', 72),
    'battle', jsonb_build_object('max_unfinished', 5, 'turn_hours', 24)
  )
$$;

-- ───────────── Tables ─────────────
-- États. Partie: searching (défi ouvert, Duel/Battle) → active → finished | abandoned; searching → cancelled.
-- Joueur: playing | done (a fini sa BD, Duel) | forfeited. Tour: déduit (Battle: turn_player; Relay: réservation).
create table public.survivor_games (
  id           uuid primary key default gen_random_uuid(),
  mode         text not null check (mode in ('relay', 'duel', 'battle')),
  status       text not null default 'active' check (status in ('searching', 'active', 'finished', 'abandoned', 'cancelled')),
  visibility   text not null default 'open' check (visibility in ('open', 'invite')),
  created_by   uuid not null references public.profiles (id) on delete cascade,
  -- Configuration initiale: immuable (voir survivor_games_guard).
  theme        text not null,
  seed         bigint not null,
  total_cases  smallint not null default 16 check (total_cases between 1 and 32),
  rules        jsonb not null,
  -- Progression de la BD commune (Relay, Battle); en Duel, la progression est par joueur.
  cases_done   smallint not null default 0,
  turn_player  uuid references public.profiles (id),
  -- Battle: fin du tour en cours. Duel: fin de la partie. Relay: sans objet (voir survivor_reservations).
  deadline_at  timestamptz,
  last_case_at timestamptz,
  active_at    timestamptz,
  finished_at  timestamptz,
  ended_reason text check (ended_reason in ('completed', 'forfeit', 'expired', 'cancelled')),
  forfeit_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  check (mode <> 'relay' or (status <> 'searching' and visibility = 'open'))
);
create index survivor_games_open on public.survivor_games (mode, created_at) where status = 'searching' and visibility = 'open';
create index survivor_games_relay on public.survivor_games (cases_done desc, created_at) where mode = 'relay' and status = 'active';
create index survivor_games_due on public.survivor_games (deadline_at) where status = 'active' and deadline_at is not null;

create table public.survivor_players (
  game_id    uuid not null references public.survivor_games (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  seat       smallint not null check (seat between 1 and 16),
  status     text not null default 'playing' check (status in ('playing', 'done', 'forfeited')),
  cases_done smallint not null default 0,
  joined_at  timestamptz not null default now(),
  primary key (game_id, user_id),
  unique (game_id, seat)
);
create index survivor_players_user on public.survivor_players (user_id);

-- Contrat des cases (l'envoi des images et l'économie d'encre arrivent à l'étape suivante).
create table public.survivor_cases (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references public.survivor_games (id) on delete cascade,
  -- Duel: propriétaire de la BD individuelle; nul quand la BD est commune.
  bd_owner      uuid references public.profiles (id) on delete cascade,
  position      smallint not null check (position between 1 and 32),
  author_id     uuid not null references public.profiles (id) on delete cascade,
  constraint_id text not null check (char_length(constraint_id) between 1 and 8),
  image_path    text not null,
  ink_spent     numeric(8, 2) not null default 0 check (ink_spent >= 0),
  ink_reward    numeric(8, 2) not null default 0 check (ink_reward >= 0),
  created_at    timestamptz not null default now(),
  unique (game_id, image_path)
);
create unique index survivor_cases_slot on public.survivor_cases (game_id, coalesce(bd_owner, '00000000-0000-0000-0000-000000000000'::uuid), position);

-- Relay: une seule case à la fois est réservable; la réservation expire d'elle-même (expires_at).
create table public.survivor_reservations (
  game_id     uuid not null references public.survivor_games (id) on delete cascade,
  position    smallint not null,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  reserved_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  completed   boolean not null default false,
  primary key (game_id, position)
);
create index survivor_reservations_user on public.survivor_reservations (user_id) where not completed;

-- Un jeton opaque (244 bits aléatoires) par défi Duel/Battle; il n'expose que le défi qu'il ouvre.
create table public.survivor_invites (
  token       text primary key default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  game_id     uuid not null unique references public.survivor_games (id) on delete cascade,
  created_by  uuid not null references public.profiles (id) on delete cascade,
  accepted_by uuid references public.profiles (id),
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);

-- ───────────── Garde-fous: configuration immuable, transitions d'état légales ─────────────
create function public.survivor_games_guard() returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.mode <> old.mode or new.created_by <> old.created_by or new.theme <> old.theme
     or new.seed <> old.seed or new.total_cases <> old.total_cases or new.rules <> old.rules
     or new.visibility <> old.visibility or new.created_at <> old.created_at then
    raise exception 'IMMUTABLE_CONFIG';
  end if;
  if new.status <> old.status and not (
       (old.status = 'searching' and new.status in ('active', 'cancelled'))
    or (old.status = 'active' and new.status in ('finished', 'abandoned'))) then
    raise exception 'ILLEGAL_TRANSITION: % -> %', old.status, new.status;
  end if;
  return new;
end $$;
create trigger survivor_games_guard before update on public.survivor_games
  for each row execute function public.survivor_games_guard();

create function public.survivor_players_guard() returns trigger language plpgsql as $$
begin
  if new.game_id <> old.game_id or new.user_id <> old.user_id or new.seat <> old.seat then raise exception 'IMMUTABLE_CONFIG'; end if;
  return new;
end $$;
create trigger survivor_players_guard before update on public.survivor_players
  for each row execute function public.survivor_players_guard();

create trigger survivor_cases_immutable before update on public.survivor_cases
  for each row execute function public.forbid_update();

-- ───────────── Lecture: participants seulement; aucune écriture directe ─────────────
create function public.survivor_is_player(p_game uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.survivor_players where game_id = p_game and user_id = auth.uid())
$$;

-- Les dessins adverses d'un Duel restent cachés tant qu'il n'est pas terminé.
create function public.survivor_can_read_case(p_game uuid, p_owner uuid) returns boolean language sql stable security definer set search_path = public as $$
  select public.survivor_is_player(p_game) and (
    p_owner is null or p_owner = auth.uid()
    or exists (select 1 from public.survivor_games g where g.id = p_game and g.status in ('finished', 'abandoned'))
  )
$$;

alter table public.survivor_games enable row level security;
alter table public.survivor_players enable row level security;
alter table public.survivor_cases enable row level security;
alter table public.survivor_reservations enable row level security;
alter table public.survivor_invites enable row level security;

create policy survivor_games_read on public.survivor_games for select to authenticated using (public.survivor_is_player(id));
create policy survivor_players_read on public.survivor_players for select to authenticated using (public.survivor_is_player(game_id));
create policy survivor_cases_read on public.survivor_cases for select to authenticated using (public.survivor_can_read_case(game_id, bd_owner));
create policy survivor_reservations_read on public.survivor_reservations for select to authenticated using (user_id = auth.uid());
create policy survivor_invites_read on public.survivor_invites for select to authenticated using (created_by = auth.uid());

revoke all on public.survivor_games, public.survivor_players, public.survivor_cases, public.survivor_reservations, public.survivor_invites from anon, authenticated;
grant select on public.survivor_games, public.survivor_players, public.survivor_cases, public.survivor_reservations, public.survivor_invites to authenticated;

-- ───────────── Fonctions internes (jamais appelables par un client) ─────────────

-- Sérialise les opérations d'un même joueur sur un mode (anti double-clic, limites de parties).
create function public.survivor_lock_user(p_uid uuid, p_mode text) returns void language sql security definer set search_path = public as $$
  select pg_advisory_xact_lock(hashtextextended('survivor:' || p_uid::text || ':' || p_mode, 0))
$$;

-- Applique les délais dépassés (Battle: forfait du joueur dont c'est le tour; Duel: forfait de ceux qui n'ont pas fini).
-- Idempotent; appelé au début de chaque RPC.
create function public.survivor_expire_due() returns integer language plpgsql security definer set search_path = public as $$
declare g public.survivor_games; n int := 0; v_forfeit uuid; v_count int;
begin
  for g in select * from public.survivor_games where status = 'active' and deadline_at is not null and deadline_at <= now()
           order by deadline_at for update skip locked loop
    if g.mode = 'battle' then
      update public.survivor_players set status = 'forfeited' where game_id = g.id and user_id = g.turn_player;
      v_forfeit := g.turn_player;
      v_count := 1;
    else
      update public.survivor_players set status = 'forfeited' where game_id = g.id and status = 'playing';
      get diagnostics v_count = row_count;
      select user_id into v_forfeit from public.survivor_players where game_id = g.id and status = 'forfeited' limit 1;
    end if;
    update public.survivor_games
       set status = 'abandoned', finished_at = g.deadline_at,
           ended_reason = case when v_count = 1 then 'forfeit' else 'expired' end,
           forfeit_by = case when v_count = 1 then v_forfeit end
     where id = g.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create function public.survivor_check_limit(p_uid uuid, p_mode text) returns void language plpgsql security definer set search_path = public as $$
declare v_max int; v_n int;
begin
  if p_mode = 'relay' then return; end if;
  v_max := (public.survivor_rules() -> p_mode ->> 'max_unfinished')::int;
  select count(*) into v_n from public.survivor_players p join public.survivor_games g on g.id = p.game_id
   where p.user_id = p_uid and g.mode = p_mode and g.status in ('searching', 'active');
  if v_n >= v_max then raise exception '%', upper(p_mode) || '_LIMIT'; end if;
end $$;

-- Nouvelle partie: configuration tirée par le serveur (thème de la banque, seed), figée pour toujours.
create function public.survivor_new_game(p_uid uuid, p_mode text, p_visibility text) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.survivor_games (mode, status, visibility, created_by, theme, seed, total_cases, rules, active_at)
  values (p_mode, case when p_mode = 'relay' then 'active' else 'searching' end, p_visibility, p_uid,
          coalesce((select text from public.themes where in_bank and retired_at is null order by random() limit 1), 'Sans thème'),
          floor(random() * 2147483647)::bigint, (public.survivor_rules() ->> 'total_cases')::smallint, public.survivor_rules(),
          case when p_mode = 'relay' then now() end)
  returning id into v_id;
  if p_mode <> 'relay' then
    insert into public.survivor_players (game_id, user_id, seat) values (v_id, p_uid, 1);
    insert into public.survivor_invites (game_id, created_by) values (v_id, p_uid);
  end if;
  return v_id;
end $$;

-- Second joueur d'un défi: la partie devient active et ses délais démarrent maintenant. Sans effet si déjà inscrit.
create function public.survivor_join(p_uid uuid, p_game uuid) returns void language plpgsql security definer set search_path = public as $$
declare g public.survivor_games;
begin
  select * into g from public.survivor_games where id = p_game for update;
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if g.created_by = p_uid then raise exception 'OWN_CHALLENGE'; end if;
  if exists (select 1 from public.survivor_players where game_id = p_game and user_id = p_uid) then return; end if;
  if g.status <> 'searching' then raise exception 'GAME_NOT_OPEN'; end if;
  perform public.survivor_check_limit(p_uid, g.mode);
  insert into public.survivor_players (game_id, user_id, seat) values (p_game, p_uid, 2);
  update public.survivor_games
     set status = 'active', active_at = now(),
         deadline_at = now() + case g.mode
           when 'duel' then make_interval(hours => (g.rules -> 'duel' ->> 'hours')::int)
           else make_interval(hours => (g.rules -> 'battle' ->> 'turn_hours')::int) end,
         turn_player = case when g.mode = 'battle' then (case when random() < 0.5 then g.created_by else p_uid end) end
   where id = p_game;
  update public.survivor_invites set accepted_by = p_uid, accepted_at = now() where game_id = p_game and accepted_by is null;
end $$;

create function public.survivor_last_author(p_game uuid) returns uuid language sql stable security definer set search_path = public as $$
  select author_id from public.survivor_cases where game_id = p_game order by position desc limit 1
$$;

-- Une case de Relay est-elle réservable par ce joueur? (la partie doit être verrouillée par l'appelant)
create function public.survivor_relay_ok(p_game uuid, p_uid uuid) returns boolean language plpgsql security definer set search_path = public as $$
declare g public.survivor_games;
begin
  select * into g from public.survivor_games where id = p_game;
  if not found or g.mode <> 'relay' or g.status <> 'active' or g.cases_done >= g.total_cases then return false; end if;
  if public.survivor_last_author(p_game) = p_uid then return false; end if;
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

-- Réserve la prochaine case (partie déjà verrouillée). Idempotent pour le détenteur.
create function public.survivor_reserve_locked(p_uid uuid, p_game uuid) returns void language plpgsql security definer set search_path = public as $$
declare g public.survivor_games; r public.survivor_reservations;
begin
  select * into g from public.survivor_games where id = p_game;
  if g.mode <> 'relay' then raise exception 'INVALID_MODE'; end if;
  if g.status <> 'active' or g.cases_done >= g.total_cases then raise exception 'GAME_NOT_ACTIVE'; end if;
  select * into r from public.survivor_reservations where game_id = p_game and position = g.cases_done + 1;
  if found and not r.completed and r.expires_at > now() then
    if r.user_id = p_uid then return; end if;
    raise exception 'RESERVED_BY_OTHER';
  end if;
  if exists (select 1 from public.survivor_reservations where user_id = p_uid and not completed and expires_at > now() and game_id <> p_game) then
    raise exception 'ALREADY_RESERVED';
  end if;
  if public.survivor_last_author(p_game) = p_uid then raise exception 'LAST_CONTRIBUTOR'; end if;
  if not exists (select 1 from public.survivor_players where game_id = p_game and user_id = p_uid)
     and (select count(*) from public.survivor_players where game_id = p_game) >= (g.rules -> 'relay' ->> 'max_players')::int then
    raise exception 'GAME_FULL';
  end if;
  delete from public.survivor_reservations where game_id = p_game and position = g.cases_done + 1;
  insert into public.survivor_reservations (game_id, position, user_id, expires_at)
  values (p_game, g.cases_done + 1, p_uid, now() + make_interval(mins => (g.rules -> 'relay' ->> 'reserve_minutes')::int));
end $$;

-- Vue d'une partie pour un joueur: tout ce que l'interface affiche, calculé ici (état, catégorie, actions, délais).
create function public.survivor_view(p_game uuid, p_uid uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g public.survivor_games; me public.survivor_players; r public.survivor_reservations;
  v_play boolean := false; v_secs numeric; v_bucket text; v_cancel boolean; v_abandon boolean;
begin
  select * into g from public.survivor_games where id = p_game;
  if not found then return null; end if;
  select * into me from public.survivor_players where game_id = p_game and user_id = p_uid;
  select * into r from public.survivor_reservations
   where game_id = p_game and position = g.cases_done + 1 and user_id = p_uid and not completed and expires_at > now();
  if g.status in ('searching', 'active') then
    if g.mode = 'duel' then v_play := coalesce(me.status = 'playing', false);
    elsif g.mode = 'battle' then v_play := g.status = 'active' and g.turn_player = p_uid;
    else v_play := r.user_id is not null or public.survivor_relay_ok(g.id, p_uid);
    end if;
    v_secs := case when g.mode = 'relay' then extract(epoch from r.expires_at - now()) else extract(epoch from g.deadline_at - now()) end;
  end if;
  v_bucket := case when g.status not in ('searching', 'active') then 'done' when v_play then 'mine' else 'waiting' end;
  v_cancel := g.status = 'searching' and g.created_by = p_uid;
  v_abandon := case when g.mode = 'relay' then r.user_id is not null
                    else g.status = 'active' and me.status = 'playing' end;
  return jsonb_build_object(
    'id', g.id, 'mode', g.mode, 'status', g.status, 'visibility', g.visibility, 'theme', g.theme,
    'total_cases', g.total_cases, 'cases_done', g.cases_done, 'created_at', g.created_at,
    'deadline_at', g.deadline_at, 'ended_reason', g.ended_reason, 'server_now', now(),
    'seconds_left', case when v_secs is null then null else greatest(0, floor(v_secs)) end,
    'bucket', v_bucket, 'can_play', v_play, 'can_cancel', v_cancel, 'can_abandon', coalesce(v_abandon, false),
    'my_status', me.status, 'turn_is_mine', coalesce(g.status = 'active' and g.turn_player = p_uid, false),
    'forfeit_by_me', coalesce(g.forfeit_by = p_uid, false), 'reservation_until', r.expires_at,
    'invite_token', case when v_cancel then (select token from public.survivor_invites where game_id = g.id) end,
    'players', coalesce((select jsonb_agg(jsonb_build_object('seat', p.seat, 'nickname', pr.nickname, 'status', p.status,
                                                            'cases_done', p.cases_done, 'is_me', p.user_id = p_uid) order by p.seat)
                           from public.survivor_players p join public.profiles pr on pr.id = p.user_id where p.game_id = g.id), '[]'::jsonb)
  );
end $$;

create function public.survivor_result(p_outcome text, p_game uuid, p_uid uuid) returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('outcome', p_outcome, 'game', public.survivor_view(p_game, p_uid))
$$;

-- ───────────── RPC publiques ─────────────

-- Trouve une partie ou en crée une; la recherche persiste côté serveur (le joueur peut fermer l'application).
-- Relay: réserve la prochaine case d'une partie éligible, sinon crée une partie. Duel/Battle: rejoint un défi ouvert
-- (le plus ancien, jamais le sien), sinon crée un défi ouvert. Idempotent: un défi ou une réservation déjà en cours est renvoyé.
create function public.survivor_matchmake(p_mode text) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); c record; g public.survivor_games; v_id uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_mode not in ('relay', 'duel', 'battle') then raise exception 'INVALID_MODE'; end if;
  perform public.survivor_lock_user(v_uid, p_mode);
  perform public.survivor_expire_due();

  if p_mode = 'relay' then
    select r.game_id into v_id from public.survivor_reservations r
     where r.user_id = v_uid and not r.completed and r.expires_at > now() order by r.reserved_at desc limit 1;
    if v_id is not null then return public.survivor_result('reserved', v_id, v_uid); end if;
    -- Proches de leur conclusion d'abord, puis les plus anciennes, puis les plus longtemps sans contribution.
    for c in select id from public.survivor_games
              where mode = 'relay' and status = 'active' and cases_done < total_cases
              order by cases_done desc, coalesce(last_case_at, created_at), created_at limit 100 loop
      select * into g from public.survivor_games where id = c.id for update skip locked;
      if found and public.survivor_relay_ok(g.id, v_uid) then
        perform public.survivor_reserve_locked(v_uid, g.id);
        return public.survivor_result('reserved', g.id, v_uid);
      end if;
    end loop;
    v_id := public.survivor_new_game(v_uid, 'relay', 'open');
    perform public.survivor_reserve_locked(v_uid, v_id);
    return public.survivor_result('created', v_id, v_uid);
  end if;

  select id into v_id from public.survivor_games
   where mode = p_mode and status = 'searching' and visibility = 'open' and created_by = v_uid limit 1;
  if v_id is not null then return public.survivor_result('searching', v_id, v_uid); end if;
  perform public.survivor_check_limit(v_uid, p_mode);
  for c in select id from public.survivor_games
            where mode = p_mode and status = 'searching' and visibility = 'open' and created_by <> v_uid
            order by created_at limit 20 loop
    select * into g from public.survivor_games where id = c.id for update skip locked;
    if found and g.status = 'searching' then
      perform public.survivor_join(v_uid, g.id);
      return public.survivor_result('joined', g.id, v_uid);
    end if;
  end loop;
  v_id := public.survivor_new_game(v_uid, p_mode, 'open');
  return public.survivor_result('created', v_id, v_uid);
end $$;

-- Crée un défi sans chercher d'adversaire: ouvert (visible du matchmaking) ou sur invitation (lien seulement).
create function public.survivor_create_challenge(p_mode text, p_visibility text default 'open') returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_mode not in ('duel', 'battle') or p_visibility not in ('open', 'invite') then raise exception 'INVALID_MODE'; end if;
  perform public.survivor_lock_user(v_uid, p_mode);
  perform public.survivor_expire_due();
  perform public.survivor_check_limit(v_uid, p_mode);
  v_id := public.survivor_new_game(v_uid, p_mode, p_visibility);
  return public.survivor_result('created', v_id, v_uid);
end $$;

-- Ce qu'un lien révèle avant d'être accepté: le mode, le thème, le pseudonyme de l'invitant, rien d'autre.
create function public.survivor_peek_invite(p_token text) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); i public.survivor_invites; g public.survivor_games;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into i from public.survivor_invites where token = p_token;
  if not found then raise exception 'INVITE_NOT_FOUND'; end if;
  select * into g from public.survivor_games where id = i.game_id;
  return jsonb_build_object('mode', g.mode, 'theme', g.theme, 'status', g.status,
    'from', (select nickname from public.profiles where id = g.created_by),
    'mine', g.created_by = v_uid,
    'available', g.status = 'searching' and (i.accepted_by is null or i.accepted_by = v_uid));
end $$;

-- Accepte une invitation: atomique (la ligne d'invitation est verrouillée), sans effet si déjà acceptée par soi-même.
create function public.survivor_accept_invite(p_token text) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); i public.survivor_invites; v_mode text;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select g.mode into v_mode from public.survivor_invites iv join public.survivor_games g on g.id = iv.game_id where iv.token = p_token;
  if v_mode is null then raise exception 'INVITE_NOT_FOUND'; end if;
  perform public.survivor_lock_user(v_uid, v_mode);
  perform public.survivor_expire_due();
  select * into i from public.survivor_invites where token = p_token for update;
  if i.created_by = v_uid then raise exception 'OWN_CHALLENGE'; end if;
  if i.accepted_by is not null and i.accepted_by <> v_uid then raise exception 'INVITE_TAKEN'; end if;
  perform public.survivor_join(v_uid, i.game_id);
  return public.survivor_result('joined', i.game_id, v_uid);
end $$;

-- Annule un défi non accepté (créateur seulement). Idempotent.
create function public.survivor_cancel(p_game uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); g public.survivor_games;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_expire_due();
  select * into g from public.survivor_games where id = p_game and created_by = v_uid for update;
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if g.status = 'cancelled' then return public.survivor_result('cancelled', p_game, v_uid); end if;
  if g.status <> 'searching' then raise exception 'NOT_CANCELLABLE'; end if;
  update public.survivor_games set status = 'cancelled', ended_reason = 'cancelled', finished_at = now() where id = p_game;
  return public.survivor_result('cancelled', p_game, v_uid);
end $$;

-- Abandon: Duel/Battle actifs, forfait immédiat (l'adversaire reste). Relay: libère sa réservation. Idempotent.
create function public.survivor_abandon(p_game uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); g public.survivor_games; me public.survivor_players;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_expire_due();
  select * into g from public.survivor_games where id = p_game for update;
  if not found or not (exists (select 1 from public.survivor_players where game_id = p_game and user_id = v_uid)
                       or exists (select 1 from public.survivor_reservations where game_id = p_game and user_id = v_uid)) then
    raise exception 'GAME_NOT_FOUND';
  end if;
  if g.mode = 'relay' then
    update public.survivor_reservations set expires_at = now() where game_id = p_game and user_id = v_uid and not completed and expires_at > now();
    return public.survivor_result('released', p_game, v_uid);
  end if;
  select * into me from public.survivor_players where game_id = p_game and user_id = v_uid;
  if g.status = 'abandoned' and me.status = 'forfeited' then return public.survivor_result('abandoned', p_game, v_uid); end if;
  if g.status <> 'active' or me.status <> 'playing' then raise exception 'NOT_ABANDONABLE'; end if;
  update public.survivor_players set status = 'forfeited' where game_id = p_game and user_id = v_uid;
  update public.survivor_games set status = 'abandoned', ended_reason = 'forfeit', forfeit_by = v_uid, finished_at = now() where id = p_game;
  return public.survivor_result('abandoned', p_game, v_uid);
end $$;

-- Réservation Relay d'une partie précise (le matchmaking le fait déjà); idempotente pour le détenteur.
create function public.survivor_reserve(p_game uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); g public.survivor_games;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_lock_user(v_uid, 'relay');
  perform public.survivor_expire_due();
  select * into g from public.survivor_games where id = p_game for update;
  if not found or g.mode <> 'relay' then raise exception 'GAME_NOT_FOUND'; end if;
  perform public.survivor_reserve_locked(v_uid, p_game);
  return public.survivor_result('reserved', p_game, v_uid);
end $$;

-- Prolonge la réservation pendant une activité réelle de dessin, sans jamais dépasser reserve_max_minutes au total.
create function public.survivor_extend_reservation(p_game uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); g public.survivor_games; r public.survivor_reservations; v_new timestamptz;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into g from public.survivor_games where id = p_game for update;
  if not found or g.mode <> 'relay' then raise exception 'GAME_NOT_FOUND'; end if;
  select * into r from public.survivor_reservations
   where game_id = p_game and position = g.cases_done + 1 and user_id = v_uid and not completed and expires_at > now() for update;
  if not found then raise exception 'NO_RESERVATION'; end if;
  v_new := least(now() + make_interval(mins => (g.rules -> 'relay' ->> 'extend_minutes')::int),
                 r.reserved_at + make_interval(mins => (g.rules -> 'relay' ->> 'reserve_max_minutes')::int));
  if v_new > r.expires_at then
    update public.survivor_reservations set expires_at = v_new where game_id = p_game and position = r.position;
  end if;
  return public.survivor_result('extended', p_game, v_uid);
end $$;

-- Dépose une case terminée et fait avancer la partie (relais, alternance de Battle, progression de Duel).
-- Contrat pour l'étape suivante: l'interface ne l'appelle pas encore et le chemin d'image n'est pas vérifié dans le stockage.
create function public.survivor_submit_case(
  p_game uuid, p_constraint text, p_image text, p_ink_spent numeric default 0, p_ink_reward numeric default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); g public.survivor_games; me public.survivor_players; v_pos int; v_other uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_expire_due();
  select * into g from public.survivor_games where id = p_game for update;
  -- Les parties Relay sont ouvertes: un joueur sans réservation reçoit NO_RESERVATION plutôt qu'une partie « introuvable ».
  if not found or not (g.mode = 'relay' or exists (select 1 from public.survivor_players where game_id = p_game and user_id = v_uid)) then
    raise exception 'GAME_NOT_FOUND';
  end if;
  if exists (select 1 from public.survivor_cases where game_id = p_game and image_path = p_image and author_id = v_uid) then
    return public.survivor_result('duplicate', p_game, v_uid);
  end if;
  if p_image is null or p_image not like v_uid::text || '/%' or char_length(p_image) > 300 then raise exception 'INVALID_IMAGE'; end if;
  if p_constraint is null or char_length(p_constraint) not between 1 and 8 or coalesce(p_ink_spent, -1) < 0 or coalesce(p_ink_reward, -1) < 0 then
    raise exception 'INVALID_CASE';
  end if;
  if g.status not in ('searching', 'active') or (g.mode <> 'duel' and g.status <> 'active') then raise exception 'GAME_NOT_ACTIVE'; end if;

  if g.mode = 'duel' then
    select * into me from public.survivor_players where game_id = p_game and user_id = v_uid for update;
    if me.status <> 'playing' then raise exception 'NOT_YOUR_TURN'; end if;
    v_pos := me.cases_done + 1;
    insert into public.survivor_cases (game_id, bd_owner, position, author_id, constraint_id, image_path, ink_spent, ink_reward)
    values (p_game, v_uid, v_pos, v_uid, p_constraint, p_image, p_ink_spent, p_ink_reward);
    update public.survivor_players set cases_done = v_pos, status = case when v_pos >= g.total_cases then 'done' else 'playing' end
     where game_id = p_game and user_id = v_uid;
    update public.survivor_games set last_case_at = now() where id = p_game;
    if g.status = 'active' and not exists (select 1 from public.survivor_players where game_id = p_game and status <> 'done') then
      update public.survivor_games set status = 'finished', ended_reason = 'completed', finished_at = now() where id = p_game;
    end if;
  else
    v_pos := g.cases_done + 1;
    if g.mode = 'battle' then
      if g.turn_player is distinct from v_uid then raise exception 'NOT_YOUR_TURN'; end if;
    elsif not exists (select 1 from public.survivor_reservations where game_id = p_game and position = v_pos and user_id = v_uid
                        and not completed and expires_at > now()) then
      raise exception 'NO_RESERVATION';
    end if;
    insert into public.survivor_cases (game_id, position, author_id, constraint_id, image_path, ink_spent, ink_reward)
    values (p_game, v_pos, v_uid, p_constraint, p_image, p_ink_spent, p_ink_reward);
    insert into public.survivor_players (game_id, user_id, seat, cases_done)
    values (p_game, v_uid, (select coalesce(max(seat), 0) + 1 from public.survivor_players where game_id = p_game), 1)
    on conflict (game_id, user_id) do update set cases_done = public.survivor_players.cases_done + 1;
    update public.survivor_reservations set completed = true where game_id = p_game and position = v_pos;
    select user_id into v_other from public.survivor_players where game_id = p_game and user_id <> v_uid limit 1;
    update public.survivor_games
       set cases_done = v_pos, last_case_at = now(),
           turn_player = case when g.mode = 'battle' and v_pos < g.total_cases then v_other else turn_player end,
           deadline_at = case when g.mode = 'battle' and v_pos < g.total_cases
                              then now() + make_interval(hours => (g.rules -> 'battle' ->> 'turn_hours')::int) else deadline_at end,
           status = case when v_pos >= g.total_cases then 'finished' else status end,
           ended_reason = case when v_pos >= g.total_cases then 'completed' else ended_reason end,
           finished_at = case when v_pos >= g.total_cases then now() else finished_at end
     where id = p_game;
  end if;
  return public.survivor_result('submitted', p_game, v_uid);
end $$;

-- Mes parties (jouées ou réservées), expirations appliquées. La catégorie (bucket) est calculée ici.
create function public.survivor_my_games() returns setof jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_expire_due();
  for v_id in select g.id from public.survivor_games g
               where exists (select 1 from public.survivor_players p where p.game_id = g.id and p.user_id = v_uid)
                  or exists (select 1 from public.survivor_reservations r
                              where r.game_id = g.id and r.user_id = v_uid and not r.completed and r.expires_at > now())
               order by g.created_at desc limit 100 loop
    return next public.survivor_view(v_id, v_uid);
  end loop;
end $$;

create function public.survivor_get_game(p_game uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_expire_due();
  if not (exists (select 1 from public.survivor_players where game_id = p_game and user_id = v_uid)
          or exists (select 1 from public.survivor_reservations where game_id = p_game and user_id = v_uid and not completed and expires_at > now())) then
    raise exception 'GAME_NOT_FOUND';
  end if;
  return public.survivor_view(p_game, v_uid);
end $$;

-- ───────────── Droits d'exécution: tout est fermé, sauf l'API publique ─────────────
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'survivor\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any (array['survivor_rules', 'survivor_is_player', 'survivor_can_read_case', 'survivor_matchmake',
        'survivor_create_challenge', 'survivor_peek_invite', 'survivor_accept_invite', 'survivor_cancel', 'survivor_abandon',
        'survivor_reserve', 'survivor_extend_reservation', 'survivor_submit_case', 'survivor_my_games', 'survivor_get_game']) then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
