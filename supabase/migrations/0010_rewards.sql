-- Récompenses collectives: histoires terminées, histoires inspirées, tampons à débloquer.
-- À appliquer après 0009. Les compteurs et les déblocages sont calculés côté serveur, dans la transaction de
-- publication de la case 4; rien n'est reçu du client. Les tables de récompenses ne référencent PAS les
-- contributions (aucune clé étrangère): elles survivent donc à l'expiration des thèmes.

-- ───────────── Réglages centralisés (synchronisés depuis src/domain/stickers.ts, voir README) ─────────────
create table public.reward_config (
  id                 boolean primary key default true check (id),
  inspired_milestones int[] not null default '{3,5,10}'
);
insert into public.reward_config default values;
alter table public.reward_config enable row level security;
create policy reward_config_read on public.reward_config for select to authenticated using (true);

create table public.sticker_rules (
  sticker_id text primary key,
  family     text not null check (family in ('collective', 'inspired')),
  threshold  int not null check (threshold > 0)
);
alter table public.sticker_rules enable row level security;
create policy sticker_rules_read on public.sticker_rules for select to authenticated using (true);
insert into public.sticker_rules (sticker_id, family, threshold) values
  ('explosion', 'collective', 1), ('speed', 'collective', 3), ('smoke', 'collective', 5), ('ghost', 'collective', 10),
  ('mustache', 'inspired', 1), ('glasses', 'inspired', 3), ('hat', 'inspired', 5), ('mask', 'inspired', 10);

-- ───────────── Crédits: une ligne par (histoire terminée, joueur, nature) ─────────────
-- end_id = la case 4 qui termine le chemin: c'est la clé d'unicité d'une histoire terminée.
-- participant: le joueur a dessiné l'une des quatre cases. inspired: le joueur a dessiné la case 1.
create table public.story_credits (
  end_id     uuid not null,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('participant', 'inspired')),
  root_id    uuid not null,
  created_at timestamptz not null default now(),
  primary key (end_id, user_id, kind)
);
create index story_credits_user on public.story_credits (user_id, kind);
create index story_credits_root on public.story_credits (root_id) where kind = 'inspired';
alter table public.story_credits enable row level security;
create policy story_credits_own on public.story_credits for select to authenticated using (user_id = auth.uid());

-- Histoires dont l'administration a retiré les récompenses (abus): jamais recréditées.
create table public.story_revocations (
  end_id     uuid primary key,
  revoked_at timestamptz not null default now(),
  revoked_by uuid references public.profiles (id) on delete set null
);
alter table public.story_revocations enable row level security;

create table public.sticker_unlocks (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  sticker_id  text not null,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, sticker_id)
);
alter table public.sticker_unlocks enable row level security;
create policy sticker_unlocks_own on public.sticker_unlocks for select to authenticated using (user_id = auth.uid());

-- Nouveautés à découvrir dans « Mes dessins » (notifications internes, sans push).
create table public.reward_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('story_done', 'inspired', 'sticker')),
  end_id     uuid,
  root_id    uuid,
  ref        text,
  n          int,
  dedupe_key text not null,
  expired    boolean not null default false,
  created_at timestamptz not null default now(),
  seen_at    timestamptz,
  unique (user_id, dedupe_key)
);
create index reward_events_unseen on public.reward_events (user_id, created_at desc) where seen_at is null;
create index reward_events_end on public.reward_events (end_id) where end_id is not null;
create index reward_events_root on public.reward_events (root_id) where root_id is not null;
alter table public.reward_events enable row level security;
create policy reward_events_own on public.reward_events for select to authenticated using (user_id = auth.uid());

-- Quand une contribution disparaît (expiration, nettoyage), les nouveautés qui y renvoyaient sont marquées
-- « disparues » pour ne conduire à aucune page inexistante; les récompenses, elles, restent acquises.
create function public.expire_reward_events() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.reward_events set expired = true
  where not expired and (end_id in (select id from gone) or root_id in (select id from gone));
  return null;
end $$;
create trigger contributions_expire_rewards after delete on public.contributions
  referencing old table as gone for each statement execute function public.expire_reward_events();

-- ───────────── Déblocage des tampons ─────────────
create function public.evaluate_unlocks(p_user uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_collective int; v_inspired int; r record; v_new int := 0; v_ins int;
begin
  select count(*) filter (where kind = 'participant'), count(*) filter (where kind = 'inspired')
    into v_collective, v_inspired from public.story_credits where user_id = p_user;
  for r in
    select sticker_id from public.sticker_rules
    where (family = 'collective' and threshold <= v_collective) or (family = 'inspired' and threshold <= v_inspired)
  loop
    insert into public.sticker_unlocks (user_id, sticker_id) values (p_user, r.sticker_id) on conflict do nothing;
    get diagnostics v_ins = row_count;
    if v_ins = 1 then
      insert into public.reward_events (user_id, kind, ref, dedupe_key)
      values (p_user, 'sticker', r.sticker_id, 'sticker:' || r.sticker_id) on conflict do nothing;
      v_new := v_new + 1;
    end if;
  end loop;
  return v_new;
end $$;

-- ───────────── Crédit d'une histoire terminée ─────────────
-- Idempotent (clé primaire sur la case 4), sûr en cas de publications simultanées (chaque fin est une ligne
-- distincte, `on conflict do nothing`), et sans effet si l'histoire contient une case masquée ou retirée.
-- p_silent: pas de nouveauté « histoire terminée » (rattrapage des histoires antérieures); les tampons
-- débloqués, eux, sont toujours annoncés.
create function public.credit_story(p_end uuid, p_silent boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare
  c public.contributions;
  v_total int; v_blocked boolean; v_root uuid; v_root_author uuid;
  r record; v_ins int; v_credited int := 0; v_users uuid[] := '{}'; v_n int; v_milestones int[];
begin
  select * into c from public.contributions where id = p_end;
  if not found or c.case_number <> 4 or c.status <> 'published' then return 0; end if;
  if exists (select 1 from public.story_revocations where end_id = p_end) then return 0; end if;

  with recursive up as (
    select id, parent_id, author_id, status from public.contributions where id = p_end
    union all
    select x.id, x.parent_id, x.author_id, x.status from public.contributions x join up on x.id = up.parent_id
  )
  select count(*), bool_or(status <> 'published'),
         (array_agg(id) filter (where parent_id is null))[1],
         (array_agg(author_id) filter (where parent_id is null))[1]
    into v_total, v_blocked, v_root, v_root_author from up;
  if v_total <> 4 or v_blocked or v_root is null then return 0; end if;

  for r in
    with recursive up as (
      select id, parent_id, author_id from public.contributions where id = p_end
      union all
      select x.id, x.parent_id, x.author_id from public.contributions x join up on x.id = up.parent_id
    ) select distinct author_id as uid from up
  loop
    insert into public.story_credits (end_id, user_id, kind, root_id) values (p_end, r.uid, 'participant', v_root)
      on conflict do nothing;
    get diagnostics v_ins = row_count;
    if v_ins = 1 then
      v_credited := v_credited + 1;
      v_users := v_users || r.uid;
      if not p_silent then
        insert into public.reward_events (user_id, kind, end_id, root_id, dedupe_key)
        values (r.uid, 'story_done', p_end, v_root, 'story:' || p_end) on conflict do nothing;
      end if;
    end if;
  end loop;

  insert into public.story_credits (end_id, user_id, kind, root_id) values (p_end, v_root_author, 'inspired', v_root)
    on conflict do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 1 then
    v_credited := v_credited + 1;
    if not (v_root_author = any (v_users)) then v_users := v_users || v_root_author; end if;
    select count(*)::int into v_n from public.story_credits where kind = 'inspired' and root_id = v_root;
    select inspired_milestones into v_milestones from public.reward_config;
    if not p_silent and v_n = any (v_milestones) then
      insert into public.reward_events (user_id, kind, end_id, root_id, n, dedupe_key)
      values (v_root_author, 'inspired', p_end, v_root, v_n, 'inspired:' || v_root || ':' || v_n) on conflict do nothing;
    end if;
  end if;

  for r in select unnest(v_users) as uid loop
    perform public.evaluate_unlocks(r.uid);
  end loop;
  return v_credited;
end $$;

-- Crédite les fins qui descendent de cases rétablies après un masquage (récompenses jusque-là suspendues).
create function public.credit_descendant_ends(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare r record; v_total int := 0;
begin
  for r in
    with recursive d as (
      select id, case_number from public.contributions where id = any (p_ids)
      union
      select k.id, k.case_number from public.contributions k join d on k.parent_id = d.id
    ) select id from d where case_number = 4
  loop
    v_total := v_total + public.credit_story(r.id);
  end loop;
  return v_total;
end $$;

-- Rattrapage des histoires publiées avant ce déploiement: sans nouveauté d'histoire, sans double comptage
-- (clé primaire), relançable à volonté.
create function public.backfill_story_credits() returns int
language plpgsql security definer set search_path = public as $$
declare r record; v_total int := 0;
begin
  for r in select id from public.contributions where case_number = 4 and status = 'published' order by published_at loop
    v_total := v_total + public.credit_story(r.id, true);
  end loop;
  return v_total;
end $$;

-- Applique une nouvelle configuration (voir `npm run db:stickers`): seuils des tampons et paliers d'inspiration,
-- puis réévalue tous les joueurs. Un tampon déjà débloqué n'est jamais retiré, même si son seuil est relevé.
create function public.sync_reward_rules(p_rules jsonb, p_milestones int[]) returns int
language plpgsql security definer set search_path = public as $$
declare r record; v_new int := 0;
begin
  insert into public.sticker_rules (sticker_id, family, threshold)
  select x->>'id', x->>'family', (x->>'threshold')::int from jsonb_array_elements(p_rules) x
  on conflict (sticker_id) do update set family = excluded.family, threshold = excluded.threshold;
  update public.reward_config set inspired_milestones = p_milestones;
  for r in select distinct user_id from public.story_credits loop
    v_new := v_new + public.evaluate_unlocks(r.user_id);
  end loop;
  return v_new;
end $$;

-- Retire les récompenses d'une histoire abusive (administration). Les tampons déjà débloqués restent acquis.
create function public.admin_revoke_story(p_end uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform public.assert_admin();
  insert into public.story_revocations (end_id, revoked_by) values (p_end, auth.uid()) on conflict do nothing;
  delete from public.story_credits where end_id = p_end;
  get diagnostics v_n = row_count;
  delete from public.reward_events where end_id = p_end;
  return v_n;
end $$;

-- ───────────── Lecture par le joueur ─────────────
create function public.my_progress() returns table (completed int, inspired int, stickers text[])
language sql stable security invoker as $$
  select count(*) filter (where kind = 'participant')::int, count(*) filter (where kind = 'inspired')::int,
         coalesce((select array_agg(sticker_id order by unlocked_at, sticker_id) from public.sticker_unlocks
                   where user_id = auth.uid()), '{}')
  from public.story_credits where user_id = auth.uid();
$$;

-- Nouveautés non découvertes (p_unseen) ou dernières histoires terminées, vues ou non (p_kind = 'story_done').
create function public.my_reward_events(p_unseen boolean default true, p_kind text default null, p_limit int default 50)
returns table (id uuid, kind text, end_id uuid, root_id uuid, ref text, n int, expired boolean, created_at timestamptz, seen boolean)
language sql stable security invoker as $$
  select e.id, e.kind, e.end_id, e.root_id, e.ref, e.n, e.expired, e.created_at, e.seen_at is not null
  from public.reward_events e
  where e.user_id = auth.uid() and (not p_unseen or e.seen_at is null) and (p_kind is null or e.kind = p_kind)
    and (p_unseen or not e.expired)
  order by e.created_at desc, e.id desc
  limit least(greatest(p_limit, 1), 100);
$$;

-- Marque des nouveautés comme découvertes (idempotent; seulement les siennes).
create function public.mark_reward_events_seen(p_ids uuid[]) returns int
language sql security definer set search_path = public as $$
  with done as (
    update public.reward_events set seen_at = now()
    where user_id = auth.uid() and id = any (p_ids) and seen_at is null returning 1
  ) select count(*)::int from done;
$$;

-- ───────────── Branchement sur la publication et la modération ─────────────
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
  if v_case = 4 then perform public.credit_story(v_id); end if;
  return v_id;
end $$;

-- Un dessin rétabli après modération redevient éligible: les histoires terminées qui en dépendent sont créditées.
create or replace function public.admin_set_hidden(p_ids uuid[], p_hide boolean) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform public.assert_admin();
  if p_hide then
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
    perform public.credit_descendant_ends(p_ids);
  end if;
  return v_n;
end $$;

create or replace function public.admin_review_report(p_report uuid, p_status text, p_block boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare r public.reports; v_restored int;
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
    get diagnostics v_restored = row_count;
    if v_restored > 0 then perform public.credit_descendant_ends(array[r.contribution_id]); end if;
  end if;
end $$;

-- Histoires déjà terminées avant ce déploiement.
select public.backfill_story_credits();

-- ───────────── Droits d'exécution ─────────────
revoke all on function
  public.evaluate_unlocks, public.credit_story, public.credit_descendant_ends, public.backfill_story_credits,
  public.sync_reward_rules, public.admin_revoke_story, public.my_progress, public.my_reward_events,
  public.mark_reward_events_seen, public.expire_reward_events
  from public, anon, authenticated;
revoke all on function public.admin_set_hidden, public.admin_review_report from public, anon;
grant execute on function public.admin_set_hidden, public.admin_review_report to authenticated;
grant execute on function public.my_progress, public.my_reward_events, public.mark_reward_events_seen, public.admin_revoke_story to authenticated;
grant execute on function public.sync_reward_rules, public.backfill_story_credits to service_role;
