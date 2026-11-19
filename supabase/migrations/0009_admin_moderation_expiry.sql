-- Administration, modération par signalement et expiration automatique des dessins.
-- À appliquer après 0008. Rien n'est supprimé par cette migration: la purge est DÉSARMÉE tant que
-- `select public.enable_expiry_purge();` n'a pas été exécuté à la main (voir README, « Expiration »).

-- ───────────── Administrateurs ─────────────
-- Aucune politique: la table n'est lisible ni modifiable par un joueur. On y ajoute son compte à la main
-- (éditeur SQL): `insert into public.admins (user_id) values ('<uuid du compte>');`
create table public.admins (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create function public.assert_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
end $$;

-- ───────────── Fenêtre de vie d'un thème ─────────────
-- Début = lundi 00:00 (Paris) de la semaine ISO; fin = deux lundis plus tard, 00:00 Paris. Calculé en dates
-- civiles: jamais « 14 × 24 h », donc exact autour des changements d'heure.
alter table public.weekly_games
  add column starts_at  timestamptz,
  add column expires_at timestamptz,
  add column purged_at  timestamptz;

create function public.game_window(p_year int, p_week int)
returns table (starts_at timestamptz, expires_at timestamptz)
language sql stable as $$
  with m as (select to_date(lpad(p_year::text, 4, '0') || lpad(p_week::text, 2, '0') || '1', 'IYYYIWID') as d)
  select (m.d::timestamp) at time zone 'Europe/Paris', ((m.d + 14)::timestamp) at time zone 'Europe/Paris' from m;
$$;

create function public.weekly_games_window() returns trigger language plpgsql as $$
begin
  if not new.is_private and new.starts_at is null then
    select w.starts_at, w.expires_at into new.starts_at, new.expires_at
    from public.game_window(new.iso_year, new.iso_week) w;
  end if;
  return new;
end $$;
create trigger weekly_games_window before insert on public.weekly_games
  for each row execute function public.weekly_games_window();

-- Les parties privées ou de test n'expirent jamais d'elles-mêmes (starts_at/expires_at restent nuls).
update public.weekly_games g
set starts_at  = (select w.starts_at  from public.game_window(g.iso_year, g.iso_week) w),
    expires_at = (select w.expires_at from public.game_window(g.iso_year, g.iso_week) w)
where not g.is_private and g.starts_at is null;

create index weekly_games_expiry on public.weekly_games (expires_at) where purged_at is null;

-- Vrai tant que le thème peut recevoir des contributions. `clock_timestamp()` (et non `now()`): une
-- transaction ouverte avant l'échéance ne doit pas pouvoir publier après.
create function public.game_is_open(p_game uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from public.weekly_games g
    where g.id = p_game and g.expires_at is not null and (clock_timestamp() >= g.expires_at or g.purged_at is not null)
  );
$$;

-- ───────────── Garde-fou: la purge n'agit qu'une fois armée ─────────────
create table public.purge_state (
  id         boolean primary key default true check (id),
  enabled    boolean not null default false,
  enabled_at timestamptz
);
insert into public.purge_state default values;
alter table public.purge_state enable row level security;

create function public.enable_expiry_purge(p_enabled boolean default true) returns void
language sql security definer set search_path = public as $$
  update public.purge_state set enabled = p_enabled, enabled_at = case when p_enabled then now() end;
$$;

-- ───────────── Contributions masquées ─────────────
-- review: masquée après un signalement, en attente d'examen. removed: retrait confirmé (réversible).
-- deleted: fichier supprimé définitivement, la case reste comme emplacement neutre (des suites en dépendent).
alter table public.contributions
  add column hidden_kind text check (hidden_kind in ('review', 'removed', 'deleted')),
  add column hidden_at   timestamptz,
  add column restored_at timestamptz,
  alter column project_id drop not null,
  alter column preview_asset drop not null;

update public.contributions set hidden_kind = 'review', hidden_at = now() where status = 'hidden';
alter table public.contributions add check ((status = 'published') = (hidden_kind is null));
create index contributions_preview_asset on public.contributions (preview_asset);

create or replace function public.check_contribution_parent() returns trigger language plpgsql as $$
declare p public.contributions;
begin
  if new.parent_id is null then return new; end if;
  select * into p from public.contributions where id = new.parent_id;
  if p.id is null or p.status not in ('published', 'hidden') then raise exception 'PARENT_NOT_FOUND'; end if;
  if p.status = 'hidden' then raise exception 'PARENT_HIDDEN'; end if;
  if p.case_number >= 4 then raise exception 'PARENT_IS_FINAL'; end if;
  if p.author_id = new.author_id then raise exception 'CANNOT_CONTINUE_OWN'; end if;
  if p.room_id <> new.room_id or p.game_id <> new.game_id or p.case_number <> new.case_number - 1 then
    raise exception 'Parent invalide pour la contribution';
  end if;
  return new;
end $$;

-- Les cases masquées restent dans la structure (sans image); les thèmes expirés disparaissent de la lecture
-- à l'instant de l'échéance, même si la purge physique passe quelques minutes plus tard.
drop policy contributions_read on public.contributions;
create policy contributions_read on public.contributions for select to authenticated
  using (status in ('published', 'hidden'));

drop policy assets_public_read on public.drawing_assets;
create policy assets_public_read on public.drawing_assets for select to authenticated
  using (
    exists (select 1 from public.drawing_projects p where p.id = project_id and p.status = 'published')
    and not exists (select 1 from public.contributions c where c.preview_asset = drawing_assets.id and c.status <> 'published')
  );

create or replace view public.contribution_cards with (security_invoker = true) as
select
  c.id, c.game_id, c.room_id, c.author_id, p.nickname as author_nickname,
  c.case_number, c.parent_id,
  case when c.status = 'published' then a.path end as preview_path,
  c.published_at,
  (select count(*) from public.contributions k where k.parent_id = c.id and k.status = 'published')::int as child_count,
  (c.status <> 'published') as hidden,
  c.hidden_kind
from public.contributions c
join public.profiles p on p.id = c.author_id
join public.weekly_games g on g.id = c.game_id
left join public.drawing_assets a on a.id = c.preview_asset
where c.status in ('published', 'hidden') and (g.expires_at is null or g.expires_at > now());

drop function public.contribution_path(uuid);
drop function public.contribution_subtree(uuid);

create function public.contribution_path(leaf uuid)
returns setof public.contribution_cards language sql stable security invoker as $$
  with recursive up as (
    select c.id, c.parent_id from public.contributions c where c.id = leaf and c.status in ('published', 'hidden')
    union all
    select c.id, c.parent_id from public.contributions c join up u on c.id = u.parent_id where c.status in ('published', 'hidden')
  )
  select cc.* from up join public.contribution_cards cc on cc.id = up.id order by cc.case_number;
$$;

create function public.contribution_subtree(root uuid)
returns setof public.contribution_cards language sql stable security invoker as $$
  with recursive tree as (
    select c.id from public.contributions c where c.parent_id = root and c.status in ('published', 'hidden')
    union all
    select c.id from public.contributions c join tree t on c.parent_id = t.id where c.status in ('published', 'hidden')
  )
  select cc.* from tree join public.contribution_cards cc on cc.id = tree.id order by cc.case_number, cc.published_at, cc.id;
$$;

grant execute on function public.contribution_path, public.contribution_subtree to authenticated;

-- Archives: jamais une case masquée, jamais un thème expiré.
create or replace function public.archive_highlights(p_game uuid, p_limit int default 8)
returns table (
  id uuid, game_id uuid, room_id uuid, author_id uuid, author_nickname text, case_number smallint,
  parent_id uuid, preview_path text, published_at timestamptz, child_count int,
  iso_year smallint, iso_week smallint, theme_text text
) language sql stable security invoker as $$
  select cc.id, cc.game_id, cc.room_id, cc.author_id, cc.author_nickname, cc.case_number,
         cc.parent_id, cc.preview_path, cc.published_at, cc.child_count,
         g.iso_year, g.iso_week, t.text
  from public.contribution_cards cc
  join public.weekly_games g on g.id = cc.game_id and not g.is_private
  join public.themes t on t.id = g.theme_id
  where cc.game_id <> p_game and not cc.hidden
  order by (cc.case_number = 4) desc, cc.published_at desc, cc.id desc
  limit least(greatest(p_limit, 1), 24);
$$;

create or replace function public.archive_weeks()
returns table (game_id uuid, iso_year smallint, iso_week smallint, theme_text text)
language sql stable security invoker as $$
  select g.id, g.iso_year, g.iso_week, t.text
  from public.weekly_games g
  join public.themes t on t.id = g.theme_id
  where not g.is_private
    and (g.expires_at is null or g.expires_at > now())
    and exists (select 1 from public.contributions c where c.game_id = g.id and c.status = 'published')
  order by g.iso_year desc, g.iso_week desc;
$$;

-- ───────────── Signalements ─────────────
alter table public.reports
  add column category text,
  add column details  text check (char_length(details) <= 300),
  add column status   text not null default 'open' check (status in ('open', 'upheld', 'dismissed', 'abusive')),
  add column handled_by uuid references public.profiles (id) on delete set null;
update public.reports set category = 'other' where category is null;
alter table public.reports alter column category set not null;
alter table public.reports add check (category in ('offensive', 'hateful', 'sexual', 'spam', 'other'));
update public.reports set status = 'dismissed' where resolved_at is not null;
create index reports_open on public.reports (contribution_id) where status = 'open';
create index reports_reporter on public.reports (reporter_id, created_at desc);

-- Plus d'insertion directe: tout passe par report_contribution (règles et limites côté serveur).
drop policy reports_insert on public.reports;

create table public.report_blocks (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  blocked_at timestamptz not null default now()
);
alter table public.report_blocks enable row level security;

-- Premier signalement valide = masquage immédiat, jamais de suppression. Un dessin rétabli par
-- l'administrateur n'est pas remasqué par d'anciens signalements: seuls trois nouveaux signalements ouverts,
-- postérieurs au rétablissement, le masquent de nouveau. Les signalements d'un compte bloqué sont enregistrés
-- mais sans effet.
create function public.report_contribution(p_contribution uuid, p_category text, p_details text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  c public.contributions;
  v_blocked boolean;
  v_hide boolean := false;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_category is null or p_category not in ('offensive', 'hateful', 'sexual', 'spam', 'other') then
    raise exception 'INVALID_CATEGORY';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('report:' || v_user::text, 0));

  select * into c from public.contributions where id = p_contribution for update;
  if not found or c.status not in ('published', 'hidden') or not public.game_is_open(c.game_id) then
    raise exception 'CONTRIBUTION_NOT_FOUND';
  end if;
  if c.author_id = v_user then raise exception 'CANNOT_REPORT_OWN'; end if;
  if exists (select 1 from public.reports where contribution_id = c.id and reporter_id = v_user) then
    raise exception 'ALREADY_REPORTED';
  end if;
  if (select count(*) from public.reports where reporter_id = v_user and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'REPORT_RATE_LIMITED';
  end if;

  v_blocked := exists (select 1 from public.report_blocks where user_id = v_user);
  insert into public.reports (contribution_id, reporter_id, reason, category, details, status)
  values (c.id, v_user, p_category, p_category, nullif(left(btrim(coalesce(p_details, '')), 300), ''),
          case when v_blocked then 'abusive' else 'open' end);

  if not v_blocked and c.status = 'published' then
    v_hide := c.restored_at is null
      or (select count(*) from public.reports r
          where r.contribution_id = c.id and r.status = 'open' and r.created_at > c.restored_at) >= 3;
    if v_hide then
      update public.contributions set status = 'hidden', hidden_kind = 'review', hidden_at = now() where id = c.id;
    end if;
  end if;
  return case when v_hide then 'hidden' else 'recorded' end;
end $$;

-- ───────────── Journal et file de suppression des fichiers ─────────────
create table public.purge_log (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('expiry', 'cleanup', 'drafts', 'orphans')),
  game_id    uuid references public.weekly_games (id) on delete set null,
  actor      uuid references public.profiles (id) on delete set null,
  status     text not null check (status in ('ok', 'error')),
  details    jsonb,
  error      text,
  created_at timestamptz not null default now()
);
alter table public.purge_log enable row level security;

-- Fichiers à retirer de Supabase Storage (par l'Edge Function `purge`, seule à pouvoir le faire). Une ligne reste
-- en attente jusqu'à confirmation de la suppression: une interruption ne perd rien et le travail est repris.
create table public.storage_deletions (
  id         uuid primary key default gen_random_uuid(),
  bucket     text not null default 'previews',
  path       text not null,
  reason     text not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  attempts   int not null default 0,
  last_error text,
  deleted_at timestamptz,
  unique (bucket, path)
);
alter table public.storage_deletions enable row level security;
create index storage_deletions_pending on public.storage_deletions (created_at) where deleted_at is null;

create function public.claim_storage_deletions(p_limit int default 100)
returns table (id uuid, bucket text, path text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select s.id from public.storage_deletions s
    where s.deleted_at is null and s.attempts < 10
      and (s.claimed_at is null or s.claimed_at < now() - interval '10 minutes')
    order by s.created_at limit least(greatest(p_limit, 1), 500)
    for update skip locked
  )
  update public.storage_deletions s set claimed_at = now(), attempts = s.attempts + 1
  from due where s.id = due.id
  returning s.id, s.bucket, s.path;
end $$;

create function public.complete_storage_deletions(p_ids uuid[]) returns int
language sql security definer set search_path = public as $$
  with done as (
    update public.storage_deletions set deleted_at = now(), claimed_at = null, last_error = null
    where id = any (p_ids) and deleted_at is null returning 1
  ) select count(*)::int from done;
$$;

create function public.fail_storage_deletion(p_id uuid, p_error text) returns void
language sql security definer set search_path = public as $$
  update public.storage_deletions set claimed_at = null, last_error = left(p_error, 300)
  where id = p_id and deleted_at is null;
$$;

-- Notifications (non envoyées ou non) qui pointent vers des contributions supprimées.
create function public.purge_notifications_for(p_ids uuid[]) returns int
language sql security definer set search_path = public as $$
  with gone as (
    delete from public.notifications n
    where n.kind <> 'new_theme'
      and substring(n.payload->>'url' from '([0-9a-fA-F-]{36})$') in (select x::text from unnest(p_ids) x)
    returning 1
  ) select count(*)::int from gone;
$$;

-- ───────────── Expiration automatique ─────────────
-- Un thème expire (toutes ses contributions, quelle que soit leur date de publication) le deuxième lundi
-- 00:00 Europe/Paris après son début. Chaque thème est purgé dans une transaction à part: tout ou rien, donc
-- relançable sans effet de bord. Le verrou sur la partie sérialise avec publish_contribution.
create function public.purge_expired_games(p_now timestamptz default clock_timestamp()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g record;
  v_ids uuid[]; v_projects uuid[]; v_files int; v_rows int;
  v_purged int := 0; v_errors int := 0;
begin
  if not coalesce((select enabled from public.purge_state), false) then
    return jsonb_build_object('enabled', false, 'purged', 0, 'errors', 0);
  end if;
  for g in
    select w.id from public.weekly_games w
    where not w.is_private and w.expires_at <= p_now
      and (exists (select 1 from public.contributions c where c.game_id = w.id)
           or exists (select 1 from public.rooms r where r.game_id = w.id))
    order by w.expires_at
  loop
    begin
      perform 1 from public.weekly_games where id = g.id for update;
      select coalesce(array_agg(c.id), '{}'), coalesce(array_agg(c.project_id) filter (where c.project_id is not null), '{}')
        into v_ids, v_projects from public.contributions c where c.game_id = g.id;

      insert into public.storage_deletions (bucket, path, reason)
      select 'previews', a.path, 'expiry' from public.drawing_assets a where a.project_id = any (v_projects)
      on conflict (bucket, path) do nothing;
      get diagnostics v_files = row_count;

      perform public.purge_notifications_for(v_ids);
      delete from public.contributions where game_id = g.id;
      get diagnostics v_rows = row_count;
      delete from public.drawing_projects where id = any (v_projects);
      delete from public.rooms where game_id = g.id;
      update public.weekly_games set purged_at = coalesce(purged_at, p_now) where id = g.id;

      insert into public.purge_log (kind, game_id, status, details)
      values ('expiry', g.id, 'ok', jsonb_build_object('contributions', v_rows, 'files_queued', v_files));
      v_purged := v_purged + 1;
    exception when others then
      insert into public.purge_log (kind, game_id, status, error) values ('expiry', g.id, 'error', left(sqlerrm, 300));
      v_errors := v_errors + 1;
    end;
  end loop;
  return jsonb_build_object('enabled', true, 'purged', v_purged, 'errors', v_errors);
end $$;

-- Brouillons techniques abandonnés (envoi interrompu avant publication) et leurs fichiers.
create function public.purge_stale_drafts(p_older interval default interval '1 day') returns int
language plpgsql security definer set search_path = public as $$
declare v_projects uuid[]; v_files int; v_n int;
begin
  if not coalesce((select enabled from public.purge_state), false) then return 0; end if;
  select coalesce(array_agg(id), '{}') into v_projects from public.drawing_projects
    where status = 'draft' and created_at < now() - p_older;
  if cardinality(v_projects) = 0 then return 0; end if;
  insert into public.storage_deletions (bucket, path, reason)
  select 'previews', a.path, 'draft' from public.drawing_assets a where a.project_id = any (v_projects)
  on conflict (bucket, path) do nothing;
  get diagnostics v_files = row_count;
  delete from public.drawing_projects where id = any (v_projects);
  get diagnostics v_n = row_count;
  insert into public.purge_log (kind, status, details) values ('drafts', 'ok', jsonb_build_object('projects', v_n, 'files_queued', v_files));
  return v_n;
end $$;

-- Fichiers d'aperçu que plus aucune ligne ne référence (publication interrompue après l'envoi).
create function public.queue_orphan_previews(p_older interval default interval '1 day') returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not coalesce((select enabled from public.purge_state), false) then return 0; end if;
  insert into public.storage_deletions (bucket, path, reason)
  select o.bucket_id, o.name, 'orphan' from storage.objects o
  where o.bucket_id = 'previews' and o.created_at < now() - p_older
    and not exists (select 1 from public.drawing_assets a where a.path = o.name)
  on conflict (bucket, path) do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.purge_log (kind, status, details) values ('orphans', 'ok', jsonb_build_object('files_queued', v_n));
  end if;
  return v_n;
end $$;

-- Planification (à exécuter une fois, avec l'URL de la fonction `purge` et le secret partagé).
create function public.schedule_expiry(p_function_url text, p_secret text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform cron.schedule('cl-expire', '*/5 * * * *', 'select public.purge_expired_games(); select public.purge_stale_drafts()');
  perform cron.schedule('cl-orphans', '17 3 * * *', 'select public.queue_orphan_previews()');
  perform cron.schedule('cl-storage', '*/5 * * * *', format(
    $cmd$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', %L), body := '{}'::jsonb)
         where exists (select 1 from public.storage_deletions where deleted_at is null)$cmd$,
    p_function_url, p_secret));
end $$;

-- ───────────── Publication et participation: thème expiré, case masquée ─────────────
create or replace function public.join_game(p_game uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare p_user uuid := auth.uid(); v_room uuid; v_number int;
begin
  if p_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not exists (select 1 from public.weekly_games where id = p_game) then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.game_is_open(p_game) then raise exception 'GAME_EXPIRED'; end if;
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

-- L'ordre des verrous est toujours: partie, puis case parent. La purge prend le verrou de la partie en
-- écriture avant de supprimer: une publication déjà acceptée est supprimée avec le reste, une publication
-- qui arrive après l'échéance est refusée (GAME_EXPIRED).
create or replace function public.publish_contribution(
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
  if not exists (select 1 from public.drawing_projects where id = p_project and owner_id = p_user and status = 'draft')
     or not exists (select 1 from public.drawing_assets where id = p_preview and project_id = p_project and kind = 'preview') then
    raise exception 'INVALID_PROJECT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('publish:' || p_user::text, 0));
  if (select count(*) from public.contributions
        where author_id = p_user and published_at > now() - p_window) >= p_max_per_window then
    raise exception 'RATE_LIMITED';
  end if;

  if p_parent is not null then
    select c.game_id into v_game from public.contributions c where c.id = p_parent;
    if v_game is null then raise exception 'PARENT_NOT_FOUND'; end if;
    select * into v_game_row from public.weekly_games where id = v_game for share;
    if v_game_row.expires_at is not null and (clock_timestamp() >= v_game_row.expires_at or v_game_row.purged_at is not null) then
      raise exception 'GAME_EXPIRED';
    end if;
    select * into v_parent from public.contributions where id = p_parent for share;
    if not found or v_parent.status not in ('published', 'hidden') then raise exception 'PARENT_NOT_FOUND'; end if;
    if v_parent.status = 'hidden' then raise exception 'PARENT_HIDDEN'; end if;
    if v_parent.case_number >= 4 then raise exception 'PARENT_IS_FINAL'; end if;
    if v_parent.author_id = p_user then raise exception 'CANNOT_CONTINUE_OWN'; end if;
    v_room := v_parent.room_id; v_game := v_parent.game_id; v_case := v_parent.case_number + 1;
  else
    select g.* into v_game_row from public.weekly_games g
      join public.rooms r on r.game_id = g.id
      where r.id = p_room
      for share of g;
    if v_game_row.id is null then raise exception 'ROOM_NOT_FOUND'; end if;
    if not v_game_row.is_private and (
         v_game_row.iso_year <> extract(isoyear from v_now) or v_game_row.iso_week <> extract(week from v_now)
       ) then
      raise exception 'GAME_NOT_ACTIVE';
    end if;
    if v_game_row.expires_at is not null and (clock_timestamp() >= v_game_row.expires_at or v_game_row.purged_at is not null) then
      raise exception 'GAME_EXPIRED';
    end if;
    v_room := p_room; v_game := v_game_row.id; v_case := 1;
  end if;

  if not exists (select 1 from public.room_members where room_id = v_room and user_id = p_user) then
    perform 1 from public.rooms where id = v_room for update;
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
  perform public.notify_publication(v_id);
  return v_id;
end $$;

-- ───────────── Administration (toutes les fonctions vérifient is_admin() côté serveur) ─────────────
create function public.admin_games()
returns table (
  game_id uuid, iso_year smallint, iso_week smallint, theme_text text, is_private boolean,
  starts_at timestamptz, expires_at timestamptz, purged_at timestamptz, contributions int
) language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.assert_admin();
  return query
  select g.id, g.iso_year, g.iso_week, t.text, g.is_private, g.starts_at, g.expires_at, g.purged_at,
         (select count(*) from public.contributions c where c.game_id = g.id)::int
  from public.weekly_games g join public.themes t on t.id = g.theme_id
  where exists (select 1 from public.contributions c where c.game_id = g.id)
     or (g.starts_at <= now() and g.expires_at > now())
  order by g.iso_year desc, g.iso_week desc, g.is_private;
end $$;

create function public.admin_contributions(
  p_game uuid default null, p_author uuid default null, p_status text default null, p_search text default null,
  p_limit int default 40, p_offset int default 0
) returns table (
  id uuid, game_id uuid, iso_year smallint, iso_week smallint, theme_text text,
  author_id uuid, author_nickname text, case_number smallint, parent_id uuid, preview_path text,
  status text, hidden_kind text, published_at timestamptz, expires_at timestamptz,
  child_count int, open_reports int, total bigint
) language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.assert_admin();
  return query
  select c.id, c.game_id, g.iso_year, g.iso_week, t.text, c.author_id, p.nickname, c.case_number, c.parent_id, a.path,
         c.status, c.hidden_kind, c.published_at, g.expires_at,
         (select count(*) from public.contributions k where k.parent_id = c.id)::int,
         (select count(*) from public.reports r where r.contribution_id = c.id and r.status = 'open')::int,
         count(*) over ()
  from public.contributions c
  join public.weekly_games g on g.id = c.game_id
  join public.themes t on t.id = g.theme_id
  join public.profiles p on p.id = c.author_id
  left join public.drawing_assets a on a.id = c.preview_asset
  where (p_game is null or c.game_id = p_game)
    and (p_author is null or c.author_id = p_author)
    and (p_status is null or case p_status
           when 'published' then c.status = 'published'
           when 'review' then c.hidden_kind = 'review'
           when 'removed' then c.hidden_kind = 'removed'
           when 'deleted' then c.hidden_kind = 'deleted'
           when 'reported' then exists (select 1 from public.reports r where r.contribution_id = c.id and r.status = 'open')
           else false end)
    and (nullif(btrim(p_search), '') is null
         or c.id::text like lower(btrim(p_search)) || '%'
         or p.nickname ilike '%' || btrim(p_search) || '%'
         or t.text ilike '%' || btrim(p_search) || '%')
  order by c.published_at desc, c.id desc
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
end $$;

create function public.admin_reports(p_status text default 'open', p_limit int default 40, p_offset int default 0)
returns table (
  report_id uuid, contribution_id uuid, category text, details text, status text,
  created_at timestamptz, resolved_at timestamptz,
  reporter_id uuid, reporter_nickname text, reporter_blocked boolean, reporter_reports int,
  contribution_status text, hidden_kind text, preview_path text, case_number smallint,
  author_nickname text, theme_text text, total bigint
) language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.assert_admin();
  return query
  select r.id, r.contribution_id, r.category, r.details, r.status, r.created_at, r.resolved_at,
         r.reporter_id, rp.nickname,
         exists (select 1 from public.report_blocks b where b.user_id = r.reporter_id),
         (select count(*) from public.reports x where x.reporter_id = r.reporter_id)::int,
         c.status, c.hidden_kind, a.path, c.case_number, ap.nickname, t.text,
         count(*) over ()
  from public.reports r
  join public.contributions c on c.id = r.contribution_id
  join public.weekly_games g on g.id = c.game_id
  join public.themes t on t.id = g.theme_id
  join public.profiles rp on rp.id = r.reporter_id
  join public.profiles ap on ap.id = c.author_id
  left join public.drawing_assets a on a.id = c.preview_asset
  where p_status is null or r.status = p_status
  order by r.created_at desc, r.id desc
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
end $$;

-- Masquer (retrait confirmé) ou rétablir. Les signalements ouverts sont clos en conséquence.
create function public.admin_set_hidden(p_ids uuid[], p_hide boolean) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform public.assert_admin();
  if p_hide then
    -- un masquage « en attente d'examen » devient un retrait confirmé
    update public.contributions
      set status = 'hidden', hidden_kind = 'removed', hidden_at = coalesce(hidden_at, now())
    where id = any (p_ids) and (status = 'published' or hidden_kind = 'review');
    get diagnostics v_n = row_count;
    update public.reports set status = 'upheld', resolved_at = now(), handled_by = auth.uid()
    where contribution_id = any (p_ids) and status = 'open';
  else
    update public.contributions set status = 'published', hidden_kind = null, hidden_at = null, restored_at = now()
    where id = any (p_ids) and status = 'hidden' and hidden_kind in ('review', 'removed');
    get diagnostics v_n = row_count;
    update public.reports set status = 'dismissed', resolved_at = now(), handled_by = auth.uid()
    where contribution_id = any (p_ids) and status = 'open';
  end if;
  return v_n;
end $$;

-- Écarte un signalement sans toucher au dessin; « abusif » peut bloquer le signaleur. Si plus aucun signalement
-- ouvert ne concerne un dessin masqué en attente d'examen, il est rétabli.
create function public.admin_review_report(p_report uuid, p_status text, p_block boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare r public.reports;
begin
  perform public.assert_admin();
  if p_status not in ('dismissed', 'abusive', 'upheld') then raise exception 'INVALID_STATUS'; end if;
  update public.reports set status = p_status, resolved_at = now(), handled_by = auth.uid()
  where id = p_report returning * into r;
  if r.id is null then raise exception 'REPORT_NOT_FOUND'; end if;
  if p_status = 'abusive' and p_block then
    insert into public.report_blocks (user_id) values (r.reporter_id) on conflict do nothing;
  end if;
  if p_status <> 'upheld' and not exists (
       select 1 from public.reports where contribution_id = r.contribution_id and status = 'open') then
    update public.contributions set status = 'published', hidden_kind = null, hidden_at = null, restored_at = now()
    where id = r.contribution_id and hidden_kind = 'review';
  end if;
end $$;

create function public.admin_unblock_reporter(p_user uuid) returns void
language sql security definer set search_path = public as $$
  select public.assert_admin();
  delete from public.report_blocks where user_id = p_user;
$$;

-- ───────────── Nettoyage manuel: aperçu, puis suppression confirmée ─────────────
-- mode « selection »: seules les cases choisies disparaissent; une case qui a encore des suites d'autres
-- joueurs devient un emplacement neutre (fichier supprimé, structure conservée).
-- mode « story »: la case choisie ET toutes ses suites sont supprimées (histoire entière si c'est une case 1).
create function public.cleanup_plan(p_ids uuid[], p_mode text) returns table (id uuid, action text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if p_mode = 'story' then
    return query
    with recursive t as (
      select c.id from public.contributions c where c.id = any (p_ids)
      union
      select k.id from public.contributions k join t on k.parent_id = t.id
    ) select t.id, 'delete'::text from t;
  elsif p_mode = 'selection' then
    return query
    with recursive sel as (select c.id from public.contributions c where c.id = any (p_ids)),
    sub as (
      select s.id as root, k.id as node from sel s join public.contributions k on k.parent_id = s.id
      union
      select sub.root, k.id from sub join public.contributions k on k.parent_id = sub.node
    )
    select s.id, case when exists (select 1 from sub where sub.root = s.id and sub.node not in (select x.id from sel x))
                      then 'tombstone' else 'delete' end
    from sel s;
  else
    raise exception 'INVALID_MODE';
  end if;
end $$;

create function public.contribution_root(p_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  with recursive up as (
    select c.id, c.parent_id from public.contributions c where c.id = p_id
    union all
    select c.id, c.parent_id from public.contributions c join up on c.id = up.parent_id
  ) select id from up where parent_id is null;
$$;

create function public.admin_cleanup_preview(p_ids uuid[], p_mode text default 'selection') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_admin();
  with plan as (select * from public.cleanup_plan(p_ids, p_mode)),
  pl_rows as (
    select pl.id, pl.action, c.case_number, c.author_id, p.nickname, c.project_id, c.game_id, c.published_at,
           a.path, public.contribution_root(c.id) as root, (c.id = any (p_ids)) as chosen
    from plan pl
    join public.contributions c on c.id = pl.id
    join public.profiles p on p.id = c.author_id
    left join public.drawing_assets a on a.id = c.preview_asset
  )
  select jsonb_build_object(
    'mode', p_mode,
    'selected', (select count(*) from pl_rows where chosen),
    'delete_rows', (select count(*) from pl_rows where action = 'delete'),
    'tombstone_rows', (select count(*) from pl_rows where action = 'tombstone'),
    'cascaded_rows', (select count(*) from pl_rows where not chosen),
    'stories', (select count(distinct root) from pl_rows),
    'authors', (select count(distinct author_id) from pl_rows),
    'files', (select count(*) from public.drawing_assets x where x.project_id in (select project_id from pl_rows)),
    'reports', (select count(*) from public.reports r where r.contribution_id in (select id from pl_rows)),
    'reads', (select count(*) from public.reply_reads r where r.reply_id in (select id from pl_rows)),
    'notifications', (select count(*) from public.notifications n
                      where n.kind <> 'new_theme'
                        and substring(n.payload->>'url' from '([0-9a-fA-F-]{36})$') in (select id::text from pl_rows)),
    'children_kept', (select count(*) from public.contributions k
                      where k.parent_id in (select id from pl_rows where action = 'tombstone') and k.id not in (select id from pl_rows)),
    'signature', coalesce(md5((select string_agg(id::text || action, ',' order by id::text) from pl_rows)), ''),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'action', action, 'case_number', case_number, 'author', nickname, 'path', path, 'chosen', chosen)
        order by case_number, published_at) from (select * from pl_rows order by case_number, published_at limit 200) r), '[]'::jsonb)
  ) into v;
  return v;
end $$;

create function public.admin_cleanup_execute(p_ids uuid[], p_mode text, p_signature text, p_confirm text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_preview jsonb; v_del uuid[]; v_tomb uuid[]; v_all uuid[]; v_projects uuid[];
  v_pruned int := 0; v_step int; v_files int;
begin
  perform public.assert_admin();
  if p_confirm is distinct from 'SUPPRIMER' then raise exception 'CONFIRMATION_REQUIRED'; end if;
  perform 1 from public.contributions where id = any (p_ids) order by id for update;
  v_preview := public.admin_cleanup_preview(p_ids, p_mode);
  if (v_preview->>'signature') is distinct from p_signature or (v_preview->>'signature') = '' then
    raise exception 'PLAN_CHANGED';
  end if;

  select coalesce(array_agg(id) filter (where action = 'delete'), '{}'),
         coalesce(array_agg(id) filter (where action = 'tombstone'), '{}')
    into v_del, v_tomb from public.cleanup_plan(p_ids, p_mode);
  v_all := v_del || v_tomb;
  select coalesce(array_agg(project_id) filter (where project_id is not null), '{}') into v_projects
    from public.contributions where id = any (v_all);

  insert into public.storage_deletions (bucket, path, reason)
  select 'previews', a.path, 'cleanup' from public.drawing_assets a where a.project_id = any (v_projects)
  on conflict (bucket, path) do nothing;
  get diagnostics v_files = row_count;

  perform public.purge_notifications_for(v_all);
  delete from public.reports where contribution_id = any (v_tomb);
  update public.contributions
    set status = 'hidden', hidden_kind = 'deleted', hidden_at = now(), preview_asset = null, project_id = null
    where id = any (v_tomb);
  delete from public.contributions where id = any (v_del);
  delete from public.drawing_projects where id = any (v_projects);

  -- un emplacement neutre sans aucune suite n'a plus de raison d'exister
  loop
    delete from public.contributions c
    where c.hidden_kind = 'deleted' and not exists (select 1 from public.contributions k where k.parent_id = c.id);
    get diagnostics v_step = row_count;
    exit when v_step = 0;
    v_pruned := v_pruned + v_step;
  end loop;

  insert into public.purge_log (kind, actor, status, details)
  values ('cleanup', auth.uid(), 'ok', v_preview - 'items' || jsonb_build_object('files_queued', v_files, 'pruned', v_pruned));
  return v_preview - 'items' || jsonb_build_object('files_queued', v_files, 'pruned', v_pruned);
end $$;

create function public.admin_purge_log(p_limit int default 30)
returns table (id uuid, kind text, game_id uuid, status text, details jsonb, error text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.assert_admin();
  return query
  select l.id, l.kind, l.game_id, l.status, l.details, l.error, l.created_at
  from public.purge_log l order by l.created_at desc limit least(greatest(p_limit, 1), 100);
end $$;

create function public.admin_storage_backlog() returns table (pending int, failing int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_admin();
  return query select count(*) filter (where deleted_at is null)::int,
                      count(*) filter (where deleted_at is null and last_error is not null)::int
               from public.storage_deletions;
end $$;

create function public.admin_purge_armed() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_admin();
  return coalesce((select enabled from public.purge_state), false);
end $$;

-- ───────────── Droits d'exécution ─────────────
revoke all on function
  public.is_admin, public.assert_admin, public.game_is_open, public.game_window,
  public.report_contribution, public.cleanup_plan, public.contribution_root, public.purge_notifications_for,
  public.admin_games, public.admin_contributions, public.admin_reports, public.admin_set_hidden,
  public.admin_review_report, public.admin_unblock_reporter, public.admin_cleanup_preview,
  public.admin_cleanup_execute, public.admin_purge_log, public.admin_storage_backlog, public.admin_purge_armed,
  public.purge_expired_games, public.purge_stale_drafts, public.queue_orphan_previews, public.schedule_expiry,
  public.enable_expiry_purge, public.claim_storage_deletions, public.complete_storage_deletions,
  public.fail_storage_deletion
  from public, anon, authenticated;

grant execute on function
  public.is_admin, public.report_contribution,
  public.admin_games, public.admin_contributions, public.admin_reports, public.admin_set_hidden,
  public.admin_review_report, public.admin_unblock_reporter, public.admin_cleanup_preview,
  public.admin_cleanup_execute, public.admin_purge_log, public.admin_storage_backlog, public.admin_purge_armed
  to authenticated;

grant execute on function
  public.claim_storage_deletions, public.complete_storage_deletions, public.fail_storage_deletion,
  public.purge_expired_games, public.purge_stale_drafts, public.queue_orphan_previews
  to service_role;
