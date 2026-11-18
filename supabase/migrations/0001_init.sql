-- Case Ludique — schéma initial (Supabase / PostgreSQL 15+).
-- NON DÉPLOYÉ ET NON TESTÉ contre une base réelle: à valider avec `supabase db reset` (voir README).
-- Jeu continu 7j/7: aucune règle ne dépend du jour; seul le thème change chaque lundi 00:00 (Europe/Paris).

create extension if not exists pgcrypto;

-- ───────────── Utilisateurs (identité anonyme persistante rattachable à un e-mail) ─────────────
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 1 and 24),
  created_at  timestamptz not null default now()
);

-- ───────────── Thèmes: immuables, un par (seed, version) ─────────────
create table public.themes (
  id                 uuid primary key default gen_random_uuid(),
  seed               text not null,
  generator_version  text not null,
  text               text not null,
  parts              jsonb not null,
  created_at         timestamptz not null default now(),
  unique (seed, generator_version)
);

create function public.forbid_update() returns trigger language plpgsql as $$
begin raise exception 'Table immuable: %', tg_table_name; end $$;

create trigger themes_immutable before update or delete on public.themes
  for each row execute function public.forbid_update();

-- ───────────── Parties hebdomadaires et salles ─────────────
create table public.weekly_games (
  id          uuid primary key default gen_random_uuid(),
  iso_year    smallint not null,
  iso_week    smallint not null check (iso_week between 1 and 53),
  theme_id    uuid not null references public.themes (id),
  is_private  boolean not null default false,
  created_at  timestamptz not null default now()
);
-- Une seule partie publique par semaine; les parties privées/test sont libres.
create unique index weekly_games_public_week on public.weekly_games (iso_year, iso_week) where not is_private;

create table public.rooms (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null references public.weekly_games (id) on delete cascade,
  number     int not null,
  capacity   int not null default 99 check (capacity between 1 and 99),
  created_at timestamptz not null default now(),
  unique (game_id, number)
);

create table public.room_members (
  room_id    uuid not null references public.rooms (id) on delete cascade,
  game_id    uuid not null references public.weekly_games (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (room_id, user_id),
  unique (game_id, user_id)               -- une seule salle par joueur et par partie
);

-- ───────────── Projets de dessin et fichiers ─────────────
create table public.drawing_projects (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.profiles (id) on delete cascade,
  format_version  smallint not null,       -- version du format de projet interne
  status          text not null default 'draft' check (status in ('draft', 'published')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.drawing_assets (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.drawing_projects (id) on delete cascade,
  kind        text not null check (kind in ('project', 'preview', 'frame')),
  path        text not null,               -- chemin dans Supabase Storage
  bytes       int not null check (bytes between 1 and 1048576),   -- 1 Mio max par fichier
  sha256      text not null,
  created_at  timestamptz not null default now()
);
create index drawing_assets_project on public.drawing_assets (project_id);

-- ───────────── Contributions (nœuds de l'arbre) ─────────────
-- Les brouillons restent dans drawing_projects (status = 'draft'): ils n'ont aucune ligne ici,
-- donc ne sont jamais proposés à la continuation.
create table public.contributions (
  id             uuid primary key default gen_random_uuid(),
  game_id        uuid not null references public.weekly_games (id) on delete cascade,
  room_id        uuid not null references public.rooms (id) on delete cascade,
  author_id      uuid not null references public.profiles (id),
  case_number    smallint not null check (case_number between 1 and 4),   -- profondeur de la branche
  parent_id      uuid references public.contributions (id),
  project_id     uuid not null references public.drawing_projects (id),
  preview_asset  uuid not null references public.drawing_assets (id),
  status         text not null default 'published' check (status in ('published', 'hidden')),
  created_at     timestamptz not null default now(),
  published_at   timestamptz not null default now(),
  check ((case_number = 1) = (parent_id is null))
);
create index contributions_parent on public.contributions (parent_id);
create index contributions_room_case on public.contributions (room_id, case_number, published_at);
create index contributions_game_case on public.contributions (game_id, case_number);
create index contributions_author on public.contributions (author_id, published_at desc);

-- Garde-fou ultime, même si une écriture contourne publish_contribution:
-- même salle, rang = rang du parent + 1, jamais l'auteur du parent.
create function public.check_contribution_parent() returns trigger language plpgsql as $$
declare p public.contributions;
begin
  if new.parent_id is null then return new; end if;
  select * into p from public.contributions where id = new.parent_id;
  if p.id is null or p.status <> 'published' then raise exception 'PARENT_NOT_FOUND'; end if;
  if p.case_number >= 4 then raise exception 'PARENT_IS_FINAL'; end if;
  if p.author_id = new.author_id then raise exception 'CANNOT_CONTINUE_OWN'; end if;
  if p.room_id <> new.room_id or p.game_id <> new.game_id or p.case_number <> new.case_number - 1 then
    raise exception 'Parent invalide pour la contribution';
  end if;
  return new;
end $$;

create trigger contributions_parent_check before insert on public.contributions
  for each row execute function public.check_contribution_parent();

-- Descendants d'une case (profondeur max 4 → CTE récursive bon marché grâce à contributions_parent).
create function public.contribution_descendants(root uuid)
returns setof public.contributions language sql stable as $$
  with recursive tree as (
    select c.* from public.contributions c where c.parent_id = root and c.status = 'published'
    union all
    select c.* from public.contributions c join tree t on c.parent_id = t.id where c.status = 'published'
  )
  select * from tree;
$$;

-- ───────────── Fonctions serveur ─────────────
-- join_game et publish_contribution identifient l'appelant par auth.uid() (jamais par un paramètre)
-- et sont accessibles aux comptes anonymes, qui ont le rôle `authenticated`.
-- ensure_weekly_game reste réservée au service_role (secours de la génération des thèmes, voir 0003).

-- Idempotent: crée la partie d'une semaine si elle manque. Le thème est calculé par src/domain/theme.ts.
create function public.ensure_weekly_game(
  p_iso_year smallint, p_iso_week smallint,
  p_seed text, p_version text, p_text text, p_parts jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_theme uuid; v_game uuid;
begin
  insert into public.themes (seed, generator_version, text, parts)
    values (p_seed, p_version, p_text, p_parts)
    on conflict (seed, generator_version) do nothing;
  select id into v_theme from public.themes where seed = p_seed and generator_version = p_version;

  insert into public.weekly_games (iso_year, iso_week, theme_id)
    values (p_iso_year, p_iso_week, v_theme)
    on conflict (iso_year, iso_week) where not is_private do nothing;
  select id into v_game from public.weekly_games
    where iso_year = p_iso_year and iso_week = p_iso_week and not is_private;
  return v_game;
end $$;

-- Place un joueur dans sa salle pour la partie (existante, première avec une place, sinon nouvelle).
create function public.join_game(p_game uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare p_user uuid := auth.uid(); v_room uuid; v_number int;
begin
  if p_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not exists (select 1 from public.weekly_games where id = p_game) then raise exception 'GAME_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('join:' || p_game::text, 0));

  select room_id into v_room from public.room_members where game_id = p_game and user_id = p_user;
  if v_room is not null then return v_room; end if;

  select r.id into v_room from public.rooms r
    where r.game_id = p_game
      and (select count(*) from public.room_members m where m.room_id = r.id) < r.capacity
    order by r.number limit 1;

  if v_room is null then
    select coalesce(max(number), 0) + 1 into v_number from public.rooms where game_id = p_game;
    insert into public.rooms (game_id, number) values (p_game, v_number) returning id into v_room;
  end if;

  insert into public.room_members (room_id, game_id, user_id) values (v_room, p_game, p_user);
  return v_room;
end $$;

-- Publication atomique. Pas de phase, pas de limite quotidienne: seulement
--  * l'interdiction de continuer sa propre case (vérifiée ici ET par trigger),
--  * la fin de branche en case 4,
--  * le thème actif pour une nouvelle case 1,
--  * la capacité de la salle,
--  * un débit maximal anti-abus.
-- Deux publications simultanées sur le même parent produisent deux lignes distinctes.
create function public.publish_contribution(
  p_room uuid, p_parent uuid, p_project uuid, p_preview uuid,
  p_max_per_window int default 60, p_window interval default interval '1 hour'
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  p_user uuid := auth.uid();
  v_parent public.contributions;
  v_room uuid; v_game uuid; v_case smallint; v_id uuid;
  v_game_row public.weekly_games;
  v_now timestamp := now() at time zone 'Europe/Paris';
begin
  if p_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  -- Le projet et l'aperçu doivent appartenir à l'appelant et ne pas avoir déjà été publiés.
  if not exists (select 1 from public.drawing_projects where id = p_project and owner_id = p_user and status = 'draft')
     or not exists (select 1 from public.drawing_assets where id = p_preview and project_id = p_project and kind = 'preview') then
    raise exception 'INVALID_PROJECT';
  end if;
  -- Sérialise les publications d'un même joueur: le débit est mesuré sans course.
  perform pg_advisory_xact_lock(hashtextextended('publish:' || p_user::text, 0));
  if (select count(*) from public.contributions
        where author_id = p_user and published_at > now() - p_window) >= p_max_per_window then
    raise exception 'RATE_LIMITED';
  end if;

  if p_parent is not null then
    -- "for share" empêche un masquage concurrent du parent pendant l'insertion.
    select * into v_parent from public.contributions
      where id = p_parent and status = 'published' for share;
    if not found then raise exception 'PARENT_NOT_FOUND'; end if;
    if v_parent.case_number >= 4 then raise exception 'PARENT_IS_FINAL'; end if;
    if v_parent.author_id = p_user then raise exception 'CANNOT_CONTINUE_OWN'; end if;
    v_room := v_parent.room_id; v_game := v_parent.game_id; v_case := v_parent.case_number + 1;
  else
    select g.* into v_game_row from public.weekly_games g
      join public.rooms r on r.game_id = g.id
      where r.id = p_room;
    if v_game_row.id is null then raise exception 'ROOM_NOT_FOUND'; end if;
    if not v_game_row.is_private and (
         v_game_row.iso_year <> extract(isoyear from v_now) or v_game_row.iso_week <> extract(week from v_now)
       ) then
      raise exception 'GAME_NOT_ACTIVE';
    end if;
    v_room := p_room; v_game := v_game_row.id; v_case := 1;
  end if;

  if not exists (select 1 from public.room_members where room_id = v_room and user_id = p_user) then
    perform 1 from public.rooms where id = v_room for update;   -- verrou: la capacité ne peut pas être dépassée
    if (select count(*) from public.room_members where room_id = v_room)
         >= (select capacity from public.rooms where id = v_room) then
      raise exception 'ROOM_FULL';
    end if;
    insert into public.room_members (room_id, game_id, user_id) values (v_room, v_game, p_user)
      on conflict do nothing;
  end if;

  insert into public.contributions
    (game_id, room_id, author_id, case_number, parent_id, project_id, preview_asset)
  values (v_game, v_room, p_user, v_case, p_parent, p_project, p_preview)
  returning id into v_id;

  update public.drawing_projects set status = 'published', updated_at = now() where id = p_project;
  return v_id;
end $$;

revoke all on function public.publish_contribution, public.join_game, public.ensure_weekly_game
  from public, anon, authenticated;
grant execute on function public.join_game, public.publish_contribution to authenticated;
grant execute on function public.ensure_weekly_game to service_role;

-- ───────────── Notifications Web Push ─────────────
-- Événements: new_theme, continuation, new_branch, story_completed. Aucun rappel quotidien.
create table public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  new_theme    boolean not null default false,   -- désactivé par défaut: consentement explicite
  social       boolean not null default false,   -- continuation, nouvelle branche, histoire terminée
  quiet_start  smallint check (quiet_start between 0 and 23),
  quiet_end    smallint check (quiet_end between 0 and 23),
  created_at   timestamptz not null default now()
);
create index push_subscriptions_user on public.push_subscriptions (user_id);

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('new_theme', 'continuation', 'new_branch', 'story_completed')),
  group_key   text not null,                     -- regroupe les événements répétitifs
  payload     jsonb not null,                    -- inclut l'URL cible exacte
  count       int not null default 1,
  created_at  timestamptz not null default now(),
  send_after  timestamptz not null default now(),
  sent_at     timestamptz
);
-- Un seul envoi en attente par (joueur, groupe): 40 suites => 1 notification "40 personnes…".
create unique index notifications_pending_group on public.notifications (user_id, group_key) where sent_at is null;

-- ───────────── Signalements ─────────────
create table public.reports (
  id               uuid primary key default gen_random_uuid(),
  contribution_id  uuid not null references public.contributions (id) on delete cascade,
  reporter_id      uuid not null references public.profiles (id) on delete cascade,
  reason           text not null check (char_length(reason) <= 500),
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  unique (contribution_id, reporter_id)
);

-- ───────────── Row Level Security ─────────────
alter table public.profiles          enable row level security;
alter table public.themes            enable row level security;
alter table public.weekly_games      enable row level security;
alter table public.rooms             enable row level security;
alter table public.room_members      enable row level security;
alter table public.drawing_projects  enable row level security;
alter table public.drawing_assets    enable row level security;
alter table public.contributions     enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notifications     enable row level security;
alter table public.reports           enable row level security;

create policy profiles_read   on public.profiles for select to authenticated using (true);
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy themes_read  on public.themes       for select to authenticated using (true);
create policy games_read   on public.weekly_games for select to authenticated using (true);
create policy rooms_read   on public.rooms         for select to authenticated using (true);
create policy members_read on public.room_members for select to authenticated using (true);

-- Contributions publiques en lecture seule; l'écriture passe exclusivement par publish_contribution.
create policy contributions_read on public.contributions for select to authenticated using (status = 'published');

-- Un projet n'est modifiable que tant qu'il est brouillon; la publication le fige.
create policy projects_insert on public.drawing_projects for insert to authenticated
  with check (owner_id = auth.uid() and status = 'draft');
create policy projects_owner_read on public.drawing_projects for select to authenticated
  using (owner_id = auth.uid());
create policy projects_public_read on public.drawing_projects for select to authenticated
  using (status = 'published');
create policy projects_update_draft on public.drawing_projects for update to authenticated
  using (owner_id = auth.uid() and status = 'draft') with check (owner_id = auth.uid() and status = 'draft');
create policy projects_delete_draft on public.drawing_projects for delete to authenticated
  using (owner_id = auth.uid() and status = 'draft');

create policy assets_owner_insert on public.drawing_assets for insert to authenticated
  with check (exists (select 1 from public.drawing_projects p
    where p.id = project_id and p.owner_id = auth.uid() and p.status = 'draft'));
create policy assets_owner_read on public.drawing_assets for select to authenticated
  using (exists (select 1 from public.drawing_projects p where p.id = project_id and p.owner_id = auth.uid()));
create policy assets_public_read on public.drawing_assets for select to authenticated
  using (exists (select 1 from public.drawing_projects p where p.id = project_id and p.status = 'published'));
create policy assets_delete_draft on public.drawing_assets for delete to authenticated
  using (exists (select 1 from public.drawing_projects p
    where p.id = project_id and p.owner_id = auth.uid() and p.status = 'draft'));

create policy push_owner on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_owner on public.notifications for select to authenticated using (user_id = auth.uid());

create policy reports_insert on public.reports for insert to authenticated with check (reporter_id = auth.uid());
