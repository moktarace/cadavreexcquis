-- Survivor, étape 3: Arbitre (arbitrage des BD, votes, encre bonus). Complète 0013 et 0014 sans les réécrire.
-- Les arbitres jugent le respect de la contrainte, jamais le dessin. Aucune table n'est lisible directement (sauf son
-- solde et son historique): tout passe par des RPC qui n'exposent à l'arbitre que la BD attribuée, anonymisée.
-- Les récompenses sont calculées ici, une seule fois, à la validation complète d'un arbitrage (registre à clé unique).
-- NON DÉPLOYÉ: à valider avec `npm run db:check` puis sur une base de test.

-- ───────────── Paramètres provisoires (source unique côté serveur) ─────────────
create function public.survivor_arbitration_rules() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'min_cases', 4,            -- cases terminées minimum pour soumettre une BD (une défaite peut être incomplète)
    'max_arbitrations', 3,     -- arbitrages complets récompensés par BD
    'duel_arbitrations', 3,    -- arbitrages comparatifs complets avant le verdict narratif d'un Duel
    'daily_limit', 5,          -- arbitrages complets par compte et par jour (Europe/Paris)
    'assignment_minutes', 60,  -- au-delà, une attribution inachevée ne compte plus contre la capacité de la BD
    'flag_hide_after', 1,      -- signalements qui masquent une BD (comme les cases classiques: le premier suffit)
    'solo_open_max', 5,        -- BD Solo en attente d'arbitrage par joueur
    'rewards', jsonb_build_object('vote_given', 2, 'upvote_received', 5, 'complete_bonus', 10)
  )
$$;

-- ───────────── Tables ─────────────
-- Un groupe relie les deux BD d'un Duel, arbitrées ensemble par les mêmes arbitres.
create table public.survivor_bd_groups (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null unique references public.survivor_games (id) on delete cascade,
  verdict    text check (verdict in ('win', 'tie')),
  winner     uuid references public.profiles (id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- BD arbitrable. Solo: soumise par le joueur (performances déclarées, non certifiées). Relay et Battle: BD commune.
-- Duel: une BD par joueur. Les images ne sont jamais copiées: seules leurs références le sont.
create table public.survivor_bds (
  id                uuid primary key default gen_random_uuid(),
  source            text not null check (source in ('solo', 'relay', 'battle', 'duel')),
  game_id           uuid references public.survivor_games (id) on delete cascade,
  owner_id          uuid references public.profiles (id) on delete cascade,
  group_id          uuid references public.survivor_bd_groups (id) on delete set null,
  theme             text not null check (char_length(theme) between 1 and 120),
  status            text not null default 'pending' check (status in ('draft', 'pending', 'open', 'declined', 'hidden')),
  claimed           jsonb,
  arbitrations_done int not null default 0,
  arbitrations_max  int not null,
  flags             int not null default 0,
  created_at        timestamptz not null default now(),
  check ((source = 'solo') = (game_id is null)),
  check (source not in ('solo', 'duel') or owner_id is not null)
);
create unique index survivor_bds_game_owner on public.survivor_bds (game_id, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)) where game_id is not null;
create index survivor_bds_open on public.survivor_bds (created_at) where status = 'open';

create table public.survivor_bd_cases (
  id             uuid primary key default gen_random_uuid(),
  bd_id          uuid not null references public.survivor_bds (id) on delete cascade,
  position       smallint not null check (position between 1 and 32),
  author_id      uuid not null references public.profiles (id) on delete cascade,
  constraint_id  text not null check (char_length(constraint_id) between 1 and 8),
  image_path     text not null unique,
  source_case_id uuid,
  unique (bd_id, position)
);

-- Tous ceux qui ont participé à la BD ou à sa partie: ils ne l'arbitrent jamais.
create table public.survivor_bd_authors (
  bd_id   uuid not null references public.survivor_bds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (bd_id, user_id)
);
create index survivor_bd_authors_user on public.survivor_bd_authors (user_id);

-- Consentement des contributeurs (BD collectives et Duel): en attente, puis accepté ou refusé, définitif.
create table public.survivor_consents (
  bd_id      uuid not null references public.survivor_bds (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  decision   text check (decision in ('accepted', 'declined')),
  decided_at timestamptz,
  primary key (bd_id, user_id)
);

-- Une attribution par arbitre et par BD (ou groupe de Duel), même abandonnée; une seule en cours par arbitre.
create table public.survivor_arbitrations (
  id           uuid primary key default gen_random_uuid(),
  arbiter_id   uuid not null references public.profiles (id) on delete cascade,
  unit_key     uuid not null,
  status       text not null default 'assigned' check (status in ('assigned', 'completed', 'abandoned', 'flagged', 'expired')),
  reward_total int not null default 0,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  unique (arbiter_id, unit_key)
);
create unique index survivor_arbitrations_active on public.survivor_arbitrations (arbiter_id) where status = 'assigned';
create index survivor_arbitrations_unit on public.survivor_arbitrations (unit_key, status);

create table public.survivor_arbitration_bds (
  arbitration_id uuid not null references public.survivor_arbitrations (id) on delete cascade,
  bd_id          uuid not null references public.survivor_bds (id) on delete cascade,
  slot           smallint not null,
  primary key (arbitration_id, bd_id),
  unique (arbitration_id, slot)
);

create table public.survivor_votes (
  arbitration_id uuid not null references public.survivor_arbitrations (id) on delete cascade,
  case_id        uuid not null references public.survivor_bd_cases (id) on delete cascade,
  vote           text not null check (vote in ('up', 'down')),
  updated_at     timestamptz not null default now(),
  primary key (arbitration_id, case_id)
);

create table public.survivor_flags (
  id          uuid primary key default gen_random_uuid(),
  bd_id       uuid not null references public.survivor_bds (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  category    text not null check (category in ('incomprehensible', 'inappropriate', 'other')),
  created_at  timestamptz not null default now(),
  unique (bd_id, reporter_id)
);

-- Registre d'encre bonus: écritures par RPC seulement, jamais modifiées, une clé d'idempotence par gain.
-- Aucune dépense n'existe encore (étape 4): tous les montants sont positifs.
create table public.survivor_ink_ledger (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  amount          int not null check (amount > 0),
  reason          text not null check (reason in ('arbiter_vote', 'arbiter_complete', 'vote_received')),
  arbitration_id  uuid references public.survivor_arbitrations (id) on delete set null,
  case_id         uuid references public.survivor_bd_cases (id) on delete set null,
  idempotency_key text not null unique,
  created_at      timestamptz not null default now()
);
create index survivor_ink_ledger_user on public.survivor_ink_ledger (user_id, created_at desc);
create trigger survivor_ink_ledger_immutable before update on public.survivor_ink_ledger
  for each row execute function public.forbid_update();

create table public.survivor_wallets (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  balance    bigint not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create function public.survivor_ledger_apply() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.survivor_wallets as w (user_id, balance) values (new.user_id, new.amount)
  on conflict (user_id) do update set balance = w.balance + new.amount, updated_at = now();
  return new;
end $$;
create trigger survivor_ledger_apply after insert on public.survivor_ink_ledger
  for each row execute function public.survivor_ledger_apply();

-- ───────────── RLS: tout fermé, sauf son solde et son historique ─────────────
alter table public.survivor_bd_groups enable row level security;
alter table public.survivor_bds enable row level security;
alter table public.survivor_bd_cases enable row level security;
alter table public.survivor_bd_authors enable row level security;
alter table public.survivor_consents enable row level security;
alter table public.survivor_arbitrations enable row level security;
alter table public.survivor_arbitration_bds enable row level security;
alter table public.survivor_votes enable row level security;
alter table public.survivor_flags enable row level security;
alter table public.survivor_ink_ledger enable row level security;
alter table public.survivor_wallets enable row level security;
revoke all on public.survivor_bd_groups, public.survivor_bds, public.survivor_bd_cases, public.survivor_bd_authors, public.survivor_consents,
  public.survivor_arbitrations, public.survivor_arbitration_bds, public.survivor_votes, public.survivor_flags,
  public.survivor_ink_ledger, public.survivor_wallets from anon, authenticated;
create policy survivor_ledger_own on public.survivor_ink_ledger for select to authenticated using (user_id = auth.uid());
create policy survivor_wallet_own on public.survivor_wallets for select to authenticated using (user_id = auth.uid());
grant select on public.survivor_ink_ledger, public.survivor_wallets to authenticated;

-- ───────────── Outils internes ─────────────
create function public.survivor_daily_done(p_uid uuid) returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.survivor_arbitrations
   where arbiter_id = p_uid and status = 'completed'
     and completed_at >= date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris'
$$;

-- Ouvre une BD « en attente » quand tout le monde a accepté; la refuse dès qu'un contributeur refuse.
create function public.survivor_dissolve_group(p_bd uuid) returns void language plpgsql security definer set search_path = public as $$
declare v_group uuid;
begin
  select group_id into v_group from public.survivor_bds where id = p_bd;
  if v_group is not null then update public.survivor_bds set group_id = null where group_id = v_group; end if;
end $$;

create function public.survivor_settle_consent(p_bd uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.survivor_consents where bd_id = p_bd and decision = 'declined') then
    update public.survivor_bds set status = 'declined' where id = p_bd and status = 'pending';
    perform public.survivor_dissolve_group(p_bd);
  elsif not exists (select 1 from public.survivor_consents where bd_id = p_bd and decision is null) then
    update public.survivor_bds set status = 'open' where id = p_bd and status = 'pending';
  end if;
end $$;

-- Unités arbitrables par ce joueur (une BD, ou les deux BD d'un Duel), de la plus prioritaire à la moins prioritaire:
-- moins d'arbitrages (en cours compris), plus anciennes, puis auteurs jamais rencontrés.
create function public.survivor_candidate_units(p_uid uuid) returns table (unit uuid, arbs int, oldest timestamptz, met int)
language sql stable security definer set search_path = public as $$
  with rules as (select public.survivor_arbitration_rules() r),
  units as (
    select coalesce(b.group_id, b.id) as unit, min(b.created_at) as oldest, min(b.arbitrations_done) as done, min(b.arbitrations_max) as maxa
    from public.survivor_bds b group by 1
    having bool_and(b.status = 'open')
  )
  select u.unit, u.done + live.n as arbs, u.oldest,
         (select count(*)::int from public.survivor_arbitrations a2
            join public.survivor_arbitration_bds ab2 on ab2.arbitration_id = a2.id
            join public.survivor_bd_authors x2 on x2.bd_id = ab2.bd_id
           where a2.arbiter_id = p_uid and x2.user_id in (
             select x.user_id from public.survivor_bd_authors x join public.survivor_bds bb on bb.id = x.bd_id where coalesce(bb.group_id, bb.id) = u.unit)) as met
  from units u
  cross join rules
  cross join lateral (select count(*)::int n from public.survivor_arbitrations a
                       where a.unit_key = u.unit and a.status = 'assigned'
                         and a.created_at > now() - make_interval(mins => (rules.r ->> 'assignment_minutes')::int)) live
  where u.done + live.n < u.maxa
    and not exists (select 1 from public.survivor_bds b join public.survivor_bd_authors x on x.bd_id = b.id
                     where coalesce(b.group_id, b.id) = u.unit and x.user_id = p_uid)
    and not exists (select 1 from public.survivor_arbitrations a where a.unit_key = u.unit and a.arbiter_id = p_uid)
  order by arbs, u.oldest, met
$$;

-- Une attribution, anonymisée: ni auteur, ni votes des autres, ni popularité, ni gains.
create function public.survivor_arbitration_json(p_arb uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.survivor_arbitrations; v_bds jsonb; v_voted int; v_total int; v_theme text; v_n int;
begin
  select * into a from public.survivor_arbitrations where id = p_arb;
  if not found then return null; end if;
  select count(*) into v_n from public.survivor_arbitration_bds where arbitration_id = p_arb;
  select count(v.vote), count(*) into v_voted, v_total
    from public.survivor_bd_cases c join public.survivor_arbitration_bds ab on ab.bd_id = c.bd_id and ab.arbitration_id = p_arb
    left join public.survivor_votes v on v.arbitration_id = p_arb and v.case_id = c.id;
  select b.theme into v_theme from public.survivor_bds b join public.survivor_arbitration_bds ab on ab.bd_id = b.id
   where ab.arbitration_id = p_arb order by ab.slot limit 1;
  select jsonb_agg(jsonb_build_object('slot', ab.slot, 'label', case when v_n > 1 then chr(64 + ab.slot) end,
      'cases', (select jsonb_agg(jsonb_build_object('id', c.id, 'position', c.position, 'constraint_id', c.constraint_id,
                                                    'image_path', c.image_path, 'vote', v.vote) order by c.position)
                  from public.survivor_bd_cases c left join public.survivor_votes v on v.arbitration_id = p_arb and v.case_id = c.id
                 where c.bd_id = ab.bd_id)) order by ab.slot)
    into v_bds from public.survivor_arbitration_bds ab where ab.arbitration_id = p_arb;
  return jsonb_build_object('id', a.id, 'status', a.status, 'theme', v_theme, 'duel', v_n > 1, 'bds', coalesce(v_bds, '[]'::jsonb),
    'voted', v_voted, 'total', v_total, 'complete', v_voted = v_total and v_total > 0,
    'reward', case when a.status = 'completed' then a.reward_total end,
    'up', (select count(*) from public.survivor_votes where arbitration_id = p_arb and vote = 'up'),
    'down', (select count(*) from public.survivor_votes where arbitration_id = p_arb and vote = 'down'));
end $$;

-- ───────────── Soumission des BD ─────────────

-- Solo: un brouillon serveur minimal, créé avant l'envoi des images (le stockage vérifie qu'il existe et t'appartient).
create function public.survivor_solo_begin(p_bd uuid, p_theme text) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); b public.survivor_bds; r jsonb := public.survivor_arbitration_rules();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'solo', 10, 60);
  if p_theme is null or char_length(trim(p_theme)) not between 1 and 120 then raise exception 'INVALID_BD'; end if;
  select * into b from public.survivor_bds where id = p_bd;
  if found then
    if b.owner_id <> v_uid or b.source <> 'solo' then raise exception 'BD_NOT_FOUND'; end if;
    return jsonb_build_object('outcome', 'draft', 'bd', b.id, 'status', b.status);
  end if;
  if (select count(*) from public.survivor_bds where owner_id = v_uid and source = 'solo' and status in ('draft', 'open')
        and arbitrations_done < arbitrations_max) >= (r ->> 'solo_open_max')::int then
    raise exception 'SOLO_LIMIT';
  end if;
  insert into public.survivor_bds (id, source, owner_id, theme, status, arbitrations_max)
  values (p_bd, 'solo', v_uid, trim(p_theme), 'draft', (r ->> 'max_arbitrations')::int);
  return jsonb_build_object('outcome', 'draft', 'bd', p_bd, 'status', 'draft');
end $$;

-- Solo: dépose les cases terminées (position, demande, image déjà envoyée sous <joueur>/<bd>/<uuid>.png).
-- p_claimed (réserve, améliorations, issue) est conservé comme déclaration du client, jamais comme performance certifiée.
create function public.survivor_solo_submit(p_bd uuid, p_cases jsonb, p_claimed jsonb default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); b public.survivor_bds; r jsonb := public.survivor_arbitration_rules(); c jsonb; v_n int; o record; v_path text;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'solo', 10, 60);
  select * into b from public.survivor_bds where id = p_bd and owner_id = v_uid and source = 'solo' for update;
  if not found then raise exception 'BD_NOT_FOUND'; end if;
  if b.status <> 'draft' then return jsonb_build_object('outcome', 'duplicate', 'bd', b.id, 'status', b.status); end if;
  if p_cases is null or jsonb_typeof(p_cases) <> 'array' then raise exception 'INVALID_BD'; end if;
  v_n := jsonb_array_length(p_cases);
  if v_n < (r ->> 'min_cases')::int then raise exception 'TOO_SHORT'; end if;
  if v_n > (public.survivor_rules() ->> 'total_cases')::int then raise exception 'INVALID_BD'; end if;
  for i in 0 .. v_n - 1 loop
    c := p_cases -> i;
    v_path := c ->> 'image_path';
    if (c ->> 'position')::int is distinct from i + 1 or not exists (select 1 from public.survivor_constraints where id = c ->> 'constraint_id') then
      raise exception 'INVALID_BD';
    end if;
    if v_path !~ ('^' || v_uid::text || '/' || p_bd::text || '/[0-9a-f-]{36}\.png$') then raise exception 'INVALID_IMAGE'; end if;
    select * into o from storage.objects where bucket_id = 'survivor' and name = v_path;
    if not found then raise exception 'IMAGE_MISSING'; end if;
    if coalesce((o.metadata ->> 'size')::bigint, 0) not between 1 and 262144 or coalesce(o.metadata ->> 'mimetype', '') <> 'image/png' then
      raise exception 'INVALID_IMAGE';
    end if;
    insert into public.survivor_bd_cases (bd_id, position, author_id, constraint_id, image_path)
    values (p_bd, i + 1, v_uid, c ->> 'constraint_id', v_path);
  end loop;
  insert into public.survivor_bd_authors (bd_id, user_id) values (p_bd, v_uid);
  update public.survivor_bds set status = 'open', claimed = p_claimed where id = p_bd;
  return jsonb_build_object('outcome', 'submitted', 'bd', p_bd, 'status', 'open');
end $$;

-- Relay, Battle et Duel: demande l'arbitrage d'une partie terminée. Les contributeurs doivent accepter (la partie n'attend jamais).
create function public.survivor_submit_game_bd(p_game uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); g public.survivor_games; r jsonb := public.survivor_arbitration_rules(); v_bd uuid; v_made uuid[] := '{}'; v_group uuid; p record;
  v_ids uuid[];
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'submit_bd', 10, 60);
  select * into g from public.survivor_games where id = p_game for update;
  if not found or not exists (select 1 from public.survivor_players where game_id = p_game and user_id = v_uid) then raise exception 'GAME_NOT_FOUND'; end if;
  if g.status <> 'finished' then raise exception 'GAME_NOT_FINISHED'; end if;
  if exists (select 1 from public.survivor_bds where game_id = p_game) then
    return jsonb_build_object('outcome', 'duplicate', 'bds', (select jsonb_agg(id) from public.survivor_bds where game_id = p_game));
  end if;
  if g.mode = 'duel' then
    for p in select user_id from public.survivor_players where game_id = p_game order by seat loop
      if (select count(*) from public.survivor_cases where game_id = p_game and bd_owner = p.user_id) >= (r ->> 'min_cases')::int then
        insert into public.survivor_bds (source, game_id, owner_id, theme, arbitrations_max)
        values ('duel', p_game, p.user_id, g.theme, (r ->> 'duel_arbitrations')::int) returning id into v_bd;
        insert into public.survivor_bd_cases (bd_id, position, author_id, constraint_id, image_path, source_case_id)
          select v_bd, position, author_id, constraint_id, image_path, id from public.survivor_cases where game_id = p_game and bd_owner = p.user_id;
        insert into public.survivor_consents (bd_id, user_id, decision, decided_at)
        values (v_bd, p.user_id, case when p.user_id = v_uid then 'accepted' end, case when p.user_id = v_uid then now() end);
        v_made := v_made || v_bd;
      end if;
    end loop;
    if cardinality(v_made) = 0 then raise exception 'TOO_SHORT'; end if;
    insert into public.survivor_bd_authors (bd_id, user_id) select b, pl.user_id from unnest(v_made) b, public.survivor_players pl where pl.game_id = p_game;
    if cardinality(v_made) = 2 then
      insert into public.survivor_bd_groups (game_id) values (p_game) returning id into v_group;
      update public.survivor_bds set group_id = v_group where id = any (v_made);
    end if;
  else
    if (select count(*) from public.survivor_cases where game_id = p_game) < (r ->> 'min_cases')::int then raise exception 'TOO_SHORT'; end if;
    insert into public.survivor_bds (source, game_id, theme, arbitrations_max) values (g.mode, p_game, g.theme, (r ->> 'max_arbitrations')::int) returning id into v_bd;
    insert into public.survivor_bd_cases (bd_id, position, author_id, constraint_id, image_path, source_case_id)
      select v_bd, position, author_id, constraint_id, image_path, id from public.survivor_cases where game_id = p_game;
    insert into public.survivor_bd_authors (bd_id, user_id)
      select v_bd, user_id from public.survivor_players where game_id = p_game
      union select v_bd, author_id from public.survivor_cases where game_id = p_game;
    insert into public.survivor_consents (bd_id, user_id, decision, decided_at)
      select v_bd, a, case when a = v_uid then 'accepted' end, case when a = v_uid then now() end
        from (select distinct author_id a from public.survivor_cases where game_id = p_game) x;
    v_made := array[v_bd];
  end if;
  foreach v_bd in array v_made loop perform public.survivor_settle_consent(v_bd); end loop;
  select array_agg(id) into v_ids from public.survivor_bds where id = any (v_made);
  return jsonb_build_object('outcome', 'submitted', 'bds', to_jsonb(v_ids));
end $$;

-- Accepte ou refuse que sa BD (ou sa part d'une BD collective) soit arbitrée. Définitif.
create function public.survivor_consent(p_bd uuid, p_accept boolean) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); c public.survivor_consents; b public.survivor_bds;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'consent', 30, 60);
  select * into b from public.survivor_bds where id = p_bd for update;
  select * into c from public.survivor_consents where bd_id = p_bd and user_id = v_uid for update;
  if not found or b.id is null then raise exception 'BD_NOT_FOUND'; end if;
  if c.decision is not null then
    if (c.decision = 'accepted') = p_accept then return jsonb_build_object('outcome', 'duplicate', 'status', b.status); end if;
    raise exception 'CONSENT_FINAL';
  end if;
  update public.survivor_consents set decision = case when p_accept then 'accepted' else 'declined' end, decided_at = now() where bd_id = p_bd and user_id = v_uid;
  perform public.survivor_settle_consent(p_bd);
  return jsonb_build_object('outcome', case when p_accept then 'accepted' else 'declined' end, 'status', (select status from public.survivor_bds where id = p_bd));
end $$;

-- ───────────── Arbitrage ─────────────

-- Attribue automatiquement une BD (ou reprend l'attribution en cours). Le joueur ne choisit ni l'auteur ni la BD.
create function public.survivor_arbitrate_next() returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); r jsonb := public.survivor_arbitration_rules(); a public.survivor_arbitrations; c record; v_locked uuid[]; v_expected int; v_id uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'arbitrate', 30, 60);
  perform public.survivor_lock_user(v_uid, 'arbiter');
  select * into a from public.survivor_arbitrations where arbiter_id = v_uid and status = 'assigned';
  if found then return jsonb_build_object('outcome', 'resumed', 'arbitration', public.survivor_arbitration_json(a.id)); end if;
  if public.survivor_daily_done(v_uid) >= (r ->> 'daily_limit')::int then raise exception 'DAILY_LIMIT'; end if;
  for c in select unit from public.survivor_candidate_units(v_uid) limit 30 loop
    select count(*) into v_expected from public.survivor_bds where coalesce(group_id, id) = c.unit;
    select array_agg(id) into v_locked from (select id from public.survivor_bds where coalesce(group_id, id) = c.unit order by id for update skip locked) l;
    if coalesce(cardinality(v_locked), 0) <> v_expected then continue; end if;
    if not exists (select 1 from public.survivor_candidate_units(v_uid) cu where cu.unit = c.unit) then continue; end if;
    insert into public.survivor_arbitrations (arbiter_id, unit_key) values (v_uid, c.unit) returning id into v_id;
    insert into public.survivor_arbitration_bds (arbitration_id, bd_id, slot)
      select v_id, id, (row_number() over (order by random()))::int from public.survivor_bds where id = any (v_locked);
    return jsonb_build_object('outcome', 'assigned', 'arbitration', public.survivor_arbitration_json(v_id));
  end loop;
  return jsonb_build_object('outcome', 'none', 'arbitration', null);
end $$;

create function public.survivor_arbitration_current() returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select id into v_id from public.survivor_arbitrations where arbiter_id = v_uid and status = 'assigned';
  return case when v_id is null then null else public.survivor_arbitration_json(v_id) end;
end $$;

-- Vote provisoire sur une case de son attribution (modifiable jusqu'à la validation; p_vote nul = effacer).
create function public.survivor_vote(p_arb uuid, p_case uuid, p_vote text) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); a public.survivor_arbitrations; v_author uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'vote', 300, 60);
  select * into a from public.survivor_arbitrations where id = p_arb and arbiter_id = v_uid for update;
  if not found then raise exception 'ARBITRATION_NOT_FOUND'; end if;
  if a.status <> 'assigned' then raise exception 'ARBITRATION_CLOSED'; end if;
  if p_vote is not null and p_vote not in ('up', 'down') then raise exception 'INVALID_VOTE'; end if;
  select c.author_id into v_author from public.survivor_bd_cases c join public.survivor_arbitration_bds ab on ab.bd_id = c.bd_id
   where ab.arbitration_id = p_arb and c.id = p_case;
  if not found then raise exception 'CASE_NOT_IN_ARBITRATION'; end if;
  if v_author = v_uid then raise exception 'OWN_CASE'; end if;
  if p_vote is null then
    delete from public.survivor_votes where arbitration_id = p_arb and case_id = p_case;
  else
    insert into public.survivor_votes (arbitration_id, case_id, vote) values (p_arb, p_case, p_vote)
    on conflict (arbitration_id, case_id) do update set vote = excluded.vote, updated_at = now();
  end if;
  return public.survivor_arbitration_json(p_arb);
end $$;

-- Départage d'un Duel: quand les arbitrages comparatifs requis sont complets, celui des deux qui a le plus d'upvotes gagne.
-- Un verdict est définitif et ne touche jamais l'issue de survie ni un forfait déjà établi.
create function public.survivor_settle_duel(p_unit uuid) returns void language plpgsql security definer set search_path = public as $$
declare r jsonb := public.survivor_arbitration_rules(); v_a record; v_b record; v_done int;
begin
  if not exists (select 1 from public.survivor_bd_groups where id = p_unit and verdict is null) then return; end if;
  select count(*) into v_done from public.survivor_arbitrations where unit_key = p_unit and status = 'completed';
  if v_done < (r ->> 'duel_arbitrations')::int then return; end if;
  select b.owner_id, count(*) filter (where v.vote = 'up') ups into v_a from (select * from public.survivor_bds where group_id = p_unit order by id limit 1) b
    join public.survivor_bd_cases c on c.bd_id = b.id
    left join public.survivor_votes v on v.case_id = c.id and v.arbitration_id in (select id from public.survivor_arbitrations where unit_key = p_unit and status = 'completed')
   group by b.owner_id;
  select b.owner_id, count(*) filter (where v.vote = 'up') ups into v_b from (select * from public.survivor_bds where group_id = p_unit order by id desc limit 1) b
    join public.survivor_bd_cases c on c.bd_id = b.id
    left join public.survivor_votes v on v.case_id = c.id and v.arbitration_id in (select id from public.survivor_arbitrations where unit_key = p_unit and status = 'completed')
   group by b.owner_id;
  update public.survivor_bd_groups
     set verdict = case when v_a.ups = v_b.ups then 'tie' else 'win' end,
         winner = case when v_a.ups > v_b.ups then v_a.owner_id when v_b.ups > v_a.ups then v_b.owner_id end, decided_at = now()
   where id = p_unit;
end $$;

-- Validation finale: tout est voté, les récompenses sont versées une fois (registre à clé unique), les votes deviennent définitifs.
create function public.survivor_arbitration_finish(p_arb uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); a public.survivor_arbitrations; r jsonb := public.survivor_arbitration_rules(); rw jsonb := r -> 'rewards';
  v_total int; v_voted int; v_sum int := 0; v_unit uuid; v_ids uuid[];
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'finish', 30, 60);
  select * into a from public.survivor_arbitrations where id = p_arb and arbiter_id = v_uid for update;
  if not found then raise exception 'ARBITRATION_NOT_FOUND'; end if;
  if a.status = 'completed' then return jsonb_build_object('outcome', 'duplicate', 'arbitration', public.survivor_arbitration_json(p_arb)); end if;
  if a.status = 'expired' then return jsonb_build_object('outcome', 'closed', 'arbitration', public.survivor_arbitration_json(p_arb)); end if;
  if a.status <> 'assigned' then raise exception 'ARBITRATION_CLOSED'; end if;
  select array_agg(bd_id) into v_ids from public.survivor_arbitration_bds where arbitration_id = p_arb;
  select count(*), count(v.vote) into v_total, v_voted from public.survivor_bd_cases c left join public.survivor_votes v on v.arbitration_id = p_arb and v.case_id = c.id where c.bd_id = any (v_ids);
  if v_total = 0 or v_voted <> v_total then raise exception 'INCOMPLETE'; end if;
  if exists (select 1 from public.survivor_bds where id = any (v_ids) and status <> 'open') then raise exception 'BD_UNAVAILABLE'; end if;
  perform 1 from public.survivor_bds where id = any (v_ids) order by id for update;
  if exists (select 1 from public.survivor_bds where id = any (v_ids) and arbitrations_done >= arbitrations_max) then
    update public.survivor_arbitrations set status = 'expired' where id = p_arb;
    return jsonb_build_object('outcome', 'closed', 'arbitration', public.survivor_arbitration_json(p_arb));
  end if;
  if public.survivor_daily_done(v_uid) >= (r ->> 'daily_limit')::int then raise exception 'DAILY_LIMIT'; end if;

  insert into public.survivor_ink_ledger (user_id, amount, reason, arbitration_id, case_id, idempotency_key)
    select v_uid, (rw ->> 'vote_given')::int, 'arbiter_vote', p_arb, v.case_id, 'arb:' || p_arb || ':vote:' || v.case_id
      from public.survivor_votes v where v.arbitration_id = p_arb
    on conflict (idempotency_key) do nothing;
  insert into public.survivor_ink_ledger (user_id, amount, reason, arbitration_id, case_id, idempotency_key)
    select c.author_id, (rw ->> 'upvote_received')::int, 'vote_received', p_arb, c.id, 'rcv:' || p_arb || ':' || c.id
      from public.survivor_votes v join public.survivor_bd_cases c on c.id = v.case_id
     where v.arbitration_id = p_arb and v.vote = 'up' and c.author_id <> v_uid
    on conflict (idempotency_key) do nothing;
  insert into public.survivor_ink_ledger (user_id, amount, reason, arbitration_id, idempotency_key)
    values (v_uid, (rw ->> 'complete_bonus')::int, 'arbiter_complete', p_arb, 'arb:' || p_arb || ':bonus')
    on conflict (idempotency_key) do nothing;
  select coalesce(sum(amount), 0) into v_sum from public.survivor_ink_ledger where user_id = v_uid and arbitration_id = p_arb;
  update public.survivor_bds set arbitrations_done = arbitrations_done + 1 where id = any (v_ids);
  update public.survivor_arbitrations set status = 'completed', completed_at = now(), reward_total = v_sum where id = p_arb;
  v_unit := a.unit_key;
  perform public.survivor_settle_duel(v_unit);
  return jsonb_build_object('outcome', 'completed', 'arbitration', public.survivor_arbitration_json(p_arb));
end $$;

-- Quitter ou passer une BD: aucune récompense, les votes provisoires sont effacés, la BD reste arbitrable par d'autres.
create function public.survivor_arbitration_abandon(p_arb uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); a public.survivor_arbitrations;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into a from public.survivor_arbitrations where id = p_arb and arbiter_id = v_uid for update;
  if not found then raise exception 'ARBITRATION_NOT_FOUND'; end if;
  if a.status in ('abandoned', 'flagged', 'expired') then return jsonb_build_object('outcome', 'duplicate'); end if;
  if a.status = 'completed' then raise exception 'ARBITRATION_CLOSED'; end if;
  delete from public.survivor_votes where arbitration_id = p_arb;
  update public.survivor_arbitrations set status = 'abandoned' where id = p_arb;
  return jsonb_build_object('outcome', 'abandoned');
end $$;

-- Signale une BD problématique (p_slot: A = 1, B = 2): l'arbitrage s'arrête sans récompense; le premier signalement la masque.
create function public.survivor_arbitration_flag(p_arb uuid, p_slot int, p_category text) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); a public.survivor_arbitrations; v_bd uuid; r jsonb := public.survivor_arbitration_rules(); v_new int;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'flag', 20, 60);
  select * into a from public.survivor_arbitrations where id = p_arb and arbiter_id = v_uid for update;
  if not found then raise exception 'ARBITRATION_NOT_FOUND'; end if;
  if a.status = 'flagged' then return jsonb_build_object('outcome', 'duplicate'); end if;
  if a.status <> 'assigned' then raise exception 'ARBITRATION_CLOSED'; end if;
  select bd_id into v_bd from public.survivor_arbitration_bds where arbitration_id = p_arb and slot = coalesce(p_slot, 1);
  if not found then raise exception 'CASE_NOT_IN_ARBITRATION'; end if;
  insert into public.survivor_flags (bd_id, reporter_id, category) values (v_bd, v_uid, p_category) on conflict (bd_id, reporter_id) do nothing;
  get diagnostics v_new = row_count;
  update public.survivor_bds set flags = flags + v_new where id = v_bd;
  if (select flags from public.survivor_bds where id = v_bd) >= (r ->> 'flag_hide_after')::int then
    update public.survivor_bds set status = 'hidden' where id = v_bd and status = 'open';
    perform public.survivor_dissolve_group(v_bd);
  end if;
  delete from public.survivor_votes where arbitration_id = p_arb;
  update public.survivor_arbitrations set status = 'flagged' where id = p_arb;
  return jsonb_build_object('outcome', 'flagged');
end $$;

-- ───────────── Consultation ─────────────

create function public.survivor_wallet() returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  return jsonb_build_object('balance', coalesce((select balance from public.survivor_wallets where user_id = v_uid), 0),
    'history', coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'reason', reason, 'at', created_at) order by created_at desc, id)
                           from (select * from public.survivor_ink_ledger where user_id = v_uid order by created_at desc limit 50) h), '[]'::jsonb));
end $$;

-- Tout ce que le menu Arbitre affiche: solde, BD disponibles (un nombre), reprise, consentements demandés,
-- parties à soumettre et résultats reçus sur ses propres BD (jamais l'identité des arbitres).
create function public.survivor_hub() returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); r jsonb := public.survivor_arbitration_rules(); v_active uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'hub', 60, 60);
  select id into v_active from public.survivor_arbitrations where arbiter_id = v_uid and status = 'assigned';
  return jsonb_build_object(
    'balance', coalesce((select balance from public.survivor_wallets where user_id = v_uid), 0),
    'available', (select count(*) from public.survivor_candidate_units(v_uid)),
    'daily_done', public.survivor_daily_done(v_uid), 'daily_limit', (r ->> 'daily_limit')::int,
    'rules', jsonb_build_object('min_cases', r -> 'min_cases', 'max_arbitrations', r -> 'max_arbitrations', 'duel_arbitrations', r -> 'duel_arbitrations', 'rewards', r -> 'rewards'),
    'active', case when v_active is null then null else jsonb_build_object('id', v_active, 'voted', (public.survivor_arbitration_json(v_active) ->> 'voted')::int, 'total', (public.survivor_arbitration_json(v_active) ->> 'total')::int) end,
    'consents', coalesce((select jsonb_agg(jsonb_build_object('bd_id', b.id, 'source', b.source, 'theme', b.theme,
                    'cases', (select count(*) from public.survivor_bd_cases where bd_id = b.id)) order by b.created_at)
                  from public.survivor_consents c join public.survivor_bds b on b.id = c.bd_id where c.user_id = v_uid and c.decision is null and b.status = 'pending'), '[]'::jsonb),
    'submittable', coalesce((select jsonb_agg(jsonb_build_object('game_id', g.id, 'mode', g.mode, 'theme', g.theme,
                    'cases', case when g.mode = 'duel' then (select count(*) from public.survivor_cases where game_id = g.id and bd_owner = v_uid)
                                  else (select count(*) from public.survivor_cases where game_id = g.id) end) order by g.finished_at desc)
                  from public.survivor_games g join public.survivor_players p on p.game_id = g.id and p.user_id = v_uid
                 where g.status = 'finished' and not exists (select 1 from public.survivor_bds b where b.game_id = g.id)
                   and (case when g.mode = 'duel' then (select count(*) from public.survivor_cases where game_id = g.id and bd_owner = v_uid)
                             else (select count(*) from public.survivor_cases where game_id = g.id) end) >= (r ->> 'min_cases')::int), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(m order by m ->> 'created_at' desc) from (
      select jsonb_build_object('bd_id', b.id, 'source', b.source, 'game_id', b.game_id, 'theme', b.theme, 'status', b.status, 'created_at', b.created_at,
        'cases', (select count(*) from public.survivor_bd_cases where bd_id = b.id),
        'arbitrations_done', b.arbitrations_done, 'arbitrations_max', b.arbitrations_max,
        'ups', (select count(*) from public.survivor_votes v join public.survivor_bd_cases c on c.id = v.case_id join public.survivor_arbitrations a on a.id = v.arbitration_id
                 where c.bd_id = b.id and c.author_id = v_uid and v.vote = 'up' and a.status = 'completed'),
        'downs', (select count(*) from public.survivor_votes v join public.survivor_bd_cases c on c.id = v.case_id join public.survivor_arbitrations a on a.id = v.arbitration_id
                   where c.bd_id = b.id and c.author_id = v_uid and v.vote = 'down' and a.status = 'completed'),
        'ink_earned', coalesce((select sum(l.amount) from public.survivor_ink_ledger l join public.survivor_bd_cases c on c.id = l.case_id
                                 where c.bd_id = b.id and l.user_id = v_uid and l.reason = 'vote_received'), 0),
        'claimed', b.claimed,
        'narrative', case when b.group_id is null then (case when b.source = 'duel' then jsonb_build_object('status', 'unavailable') end)
                          else (select case when gr.verdict is null then jsonb_build_object('status', 'pending')
                                            else jsonb_build_object('status', 'decided', 'result', case when gr.verdict = 'tie' then 'tie' when gr.winner = v_uid then 'win' else 'loss' end) end
                                  from public.survivor_bd_groups gr where gr.id = b.group_id) end) m
      from public.survivor_bds b
     where b.status <> 'draft' and (b.owner_id = v_uid or exists (select 1 from public.survivor_bd_authors x where x.bd_id = b.id and x.user_id = v_uid))
     order by b.created_at desc limit 30) s), '[]'::jsonb));
end $$;

-- Résultat narratif d'un Duel (séparé de la survie et des forfaits): en attente, décidé ou indisponible.
create function public.survivor_duel_verdict(p_game uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); gr public.survivor_bd_groups; v_mine int; v_rival int;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not exists (select 1 from public.survivor_players where game_id = p_game and user_id = v_uid) then raise exception 'GAME_NOT_FOUND'; end if;
  select * into gr from public.survivor_bd_groups where game_id = p_game;
  if not found or exists (select 1 from public.survivor_bds where game_id = p_game and group_id is null) then return jsonb_build_object('status', 'unavailable'); end if;
  if gr.verdict is null then
    return jsonb_build_object('status', 'pending', 'arbitrations', (select count(*) from public.survivor_arbitrations where unit_key = gr.id and status = 'completed'));
  end if;
  select count(*) into v_mine from public.survivor_votes v join public.survivor_bd_cases c on c.id = v.case_id join public.survivor_bds b on b.id = c.bd_id
   join public.survivor_arbitrations a on a.id = v.arbitration_id where b.group_id = gr.id and b.owner_id = v_uid and v.vote = 'up' and a.status = 'completed';
  select count(*) into v_rival from public.survivor_votes v join public.survivor_bd_cases c on c.id = v.case_id join public.survivor_bds b on b.id = c.bd_id
   join public.survivor_arbitrations a on a.id = v.arbitration_id where b.group_id = gr.id and b.owner_id <> v_uid and v.vote = 'up' and a.status = 'completed';
  return jsonb_build_object('status', 'decided', 'result', case when gr.verdict = 'tie' then 'tie' when gr.winner = v_uid then 'win' else 'loss' end,
                            'my_ups', v_mine, 'rival_ups', v_rival);
end $$;

-- Modération: l'administration masque ou rétablit une BD (mêmes garde-fous que les autres fonctions d'administration).
create function public.survivor_admin_bd_status(p_bd uuid, p_status text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_admin();
  if p_status not in ('open', 'hidden') then raise exception 'INVALID_STATUS'; end if;
  update public.survivor_bds set status = p_status where id = p_bd and status in ('open', 'hidden');
  if p_status = 'hidden' then perform public.survivor_dissolve_group(p_bd); end if;
end $$;

-- ───────────── Stockage: autorisations élargies avec précaution ─────────────
-- Dépôt: aussi pour le brouillon Solo du joueur (le « jeu » du chemin est alors son identifiant de BD).
create or replace function public.survivor_can_upload(p_name text) returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_game uuid;
begin
  if p_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.png$' then return false; end if;
  v_game := (storage.foldername(p_name))[2]::uuid;
  return (storage.foldername(p_name))[1] = auth.uid()::text
     and (exists (select 1 from public.survivor_players where game_id = v_game and user_id = auth.uid())
          or exists (select 1 from public.survivor_reservations where game_id = v_game and user_id = auth.uid() and not completed and expires_at > now())
          or exists (select 1 from public.survivor_bds where id = v_game and source = 'solo' and owner_id = auth.uid() and status = 'draft'));
end $$;

-- Lecture: ajoute les images de l'attribution d'arbitrage EN COURS de l'arbitre, rien d'autre (les tables restent fermées).
create or replace function public.survivor_can_read_file(p_name text) returns boolean language sql stable security definer set search_path = public as $$
  select (storage.foldername(p_name))[1] = auth.uid()::text
      or exists (select 1 from public.survivor_cases c where c.image_path = p_name and public.survivor_can_read_case(c.game_id, c.bd_owner))
      or exists (select 1 from public.survivor_bd_cases bc
                   join public.survivor_arbitration_bds ab on ab.bd_id = bc.bd_id
                   join public.survivor_arbitrations a on a.id = ab.arbitration_id
                  where bc.image_path = p_name and a.arbiter_id = auth.uid() and a.status = 'assigned')
$$;

-- Les fichiers déjà soumis à l'arbitrage ne sont jamais des orphelins.
create or replace function public.survivor_queue_orphans(p_older interval default interval '1 day') returns int language plpgsql security definer set search_path = public as $$
declare v_n int := 0;
begin
  if not coalesce((select enabled from public.purge_state), false) then return 0; end if;
  insert into public.storage_deletions (bucket, path, reason)
  select o.bucket_id, o.name, 'orphan' from storage.objects o
   where o.bucket_id = 'survivor' and o.created_at < now() - p_older
     and not exists (select 1 from public.survivor_cases c where c.image_path = o.name)
     and not exists (select 1 from public.survivor_bd_cases c where c.image_path = o.name)
  on conflict (bucket, path) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Une partie qui se termine (victoire, défaite, forfait) libère ses réservations Relay: elles ne doivent pas
-- réapparaître comme « case réservée » dans le matchmaking pendant leur durée restante.
create function public.survivor_release_on_end() returns trigger language plpgsql as $$
begin
  if new.status in ('finished', 'abandoned', 'cancelled') and old.status not in ('finished', 'abandoned', 'cancelled') then
    update public.survivor_reservations set expires_at = now() where game_id = new.id and not completed and expires_at > now();
  end if;
  return new;
end $$;
create trigger survivor_release_on_end after update of status on public.survivor_games
  for each row execute function public.survivor_release_on_end();

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
        'survivor_set_demands', 'survivor_declare_stuck', 'survivor_submit_case', 'survivor_can_upload', 'survivor_can_read_file',
        'survivor_solo_begin', 'survivor_solo_submit', 'survivor_submit_game_bd', 'survivor_consent', 'survivor_arbitrate_next',
        'survivor_arbitration_current', 'survivor_vote', 'survivor_arbitration_finish', 'survivor_arbitration_abandon',
        'survivor_arbitration_flag', 'survivor_wallet', 'survivor_hub', 'survivor_duel_verdict', 'survivor_admin_bd_status']) then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
