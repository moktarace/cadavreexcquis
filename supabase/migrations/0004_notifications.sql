-- Notifications Web Push: file d'attente, regroupement, heures de silence, planification.
-- À appliquer après 0003. Les événements sont créés par publish_contribution; l'envoi est fait par
-- l'Edge Function `dispatch` (supabase/functions/dispatch) appelée chaque minute par pg_cron.

alter table public.notifications add column attempts int not null default 0;

-- Parties dont le nouveau thème a déjà été annoncé (une annonce par semaine, jamais deux).
create table public.announced_games (
  game_id      uuid primary key references public.weekly_games (id) on delete cascade,
  announced_at timestamptz not null default now()
);
alter table public.announced_games enable row level security;   -- aucune politique: réservé au serveur

-- Vrai si l'heure de Paris est dans la période de silence [start, end[ (qui peut franchir minuit).
create function public.in_quiet_hours(p_start smallint, p_end smallint, p_ts timestamptz default now())
returns boolean language sql stable as $$
  select case
    when p_start is null or p_end is null or p_start = p_end then false
    when p_start < p_end then extract(hour from p_ts at time zone 'Europe/Paris') >= p_start
                          and extract(hour from p_ts at time zone 'Europe/Paris') < p_end
    else extract(hour from p_ts at time zone 'Europe/Paris') >= p_start
      or extract(hour from p_ts at time zone 'Europe/Paris') < p_end
  end;
$$;

-- Ajoute un événement. Les événements répétés d'un même groupe, tant qu'ils attendent, n'en font qu'un
-- dont le compteur augmente: 40 continuations = 1 notification « 40 personnes ». Les joueurs sans abonnement
-- pour ce type d'événement ne génèrent aucune ligne.
create function public.enqueue_notification(
  p_user uuid, p_kind text, p_group text, p_url text, p_delay interval default interval '2 minutes'
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.push_subscriptions s
    where s.user_id = p_user and ((p_kind = 'new_theme' and s.new_theme) or (p_kind <> 'new_theme' and s.social))
  ) then
    return;
  end if;
  insert into public.notifications (user_id, kind, group_key, payload, send_after)
  values (p_user, p_kind, p_group, jsonb_build_object('url', p_url), now() + p_delay)
  on conflict (user_id, group_key) where sent_at is null
  do update set count = public.notifications.count + 1, payload = excluded.payload;
end $$;

-- Événements d'une publication: terminée > continuation > nouvelle branche, un seul par destinataire.
create function public.notify_publication(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c public.contributions;
  v_root uuid;
  v_siblings boolean;
  r record;
begin
  select * into c from public.contributions where id = p_id;
  if c.parent_id is null then return; end if;

  select exists (select 1 from public.contributions k
    where k.parent_id = c.parent_id and k.id <> c.id and k.status = 'published') into v_siblings;

  select u.id into v_root from (
    with recursive up as (
      select id, parent_id from public.contributions where id = c.parent_id
      union all
      select x.id, x.parent_id from public.contributions x join up on x.id = up.parent_id
    ) select id, parent_id from up
  ) u where u.parent_id is null;

  for r in
    with recursive up as (
      select id, parent_id, author_id from public.contributions where id = c.parent_id
      union all
      select x.id, x.parent_id, x.author_id from public.contributions x join up on x.id = up.parent_id
    )
    select author_id, bool_or(id = c.parent_id) as is_parent from up
    where author_id <> c.author_id group by author_id
  loop
    if c.case_number = 4 then
      perform public.enqueue_notification(r.author_id, 'story_completed', 'done:' || v_root, '/#/story/' || c.id);
    elsif r.is_parent then
      perform public.enqueue_notification(r.author_id, 'continuation', 'cont:' || c.parent_id, '/#/case/' || c.id);
    elsif v_siblings then
      perform public.enqueue_notification(r.author_id, 'new_branch', 'branch:' || c.parent_id, '/#/case/' || c.id);
    end if;
  end loop;
end $$;

-- publish_contribution (0001) + événements de notification après l'insertion.
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

-- Annonce du nouveau thème: le lundi à partir de 08:00 (Paris), une seule fois par partie.
-- Appelée par pg_cron toutes les heures le lundi (06:00–20:00 UTC) pour couvrir l'heure d'été et d'hiver.
create function public.enqueue_new_theme(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_local timestamp := p_now at time zone 'Europe/Paris';
  g record;
  v_first uuid;
  v_count int;
begin
  if extract(isodow from v_local) <> 1 or extract(hour from v_local) < 8 then return 0; end if;
  select * into g from public.current_game() limit 1;
  if g.game_id is null then return 0; end if;

  insert into public.announced_games (game_id) values (g.game_id) on conflict do nothing returning game_id into v_first;
  if v_first is null then return 0; end if;

  insert into public.notifications (user_id, kind, group_key, payload, send_after)
  select distinct s.user_id, 'new_theme', 'theme:' || g.game_id,
         jsonb_build_object('url', '/#/', 'theme', g.theme_text), now()
  from public.push_subscriptions s where s.new_theme
  on conflict (user_id, group_key) where sent_at is null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Réservation atomique des notifications à envoyer (at-most-once). Respecte les préférences et les heures de
-- silence de chaque appareil; une notification en période de silence reste en attente.
create function public.claim_due_notifications(p_limit int default 100)
returns table (
  notification_id uuid, kind text, count int, payload jsonb, attempts int,
  subscription_id uuid, endpoint text, p256dh text, auth text
) language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select n.id from public.notifications n
    where n.sent_at is null and n.send_after <= now()
      and exists (
        select 1 from public.push_subscriptions s
        where s.user_id = n.user_id
          and ((n.kind = 'new_theme' and s.new_theme) or (n.kind <> 'new_theme' and s.social))
          and not public.in_quiet_hours(s.quiet_start, s.quiet_end)
      )
    order by n.created_at limit p_limit
    for update skip locked
  ), claimed as (
    update public.notifications n set sent_at = now(), attempts = n.attempts + 1
    from due where n.id = due.id
    returning n.id, n.user_id, n.kind, n.count, n.payload, n.attempts
  )
  select c.id, c.kind, c.count, c.payload, c.attempts, s.id, s.endpoint, s.p256dh, s.auth
  from claimed c
  join public.push_subscriptions s on s.user_id = c.user_id
    and ((c.kind = 'new_theme' and s.new_theme) or (c.kind <> 'new_theme' and s.social))
    and not public.in_quiet_hours(s.quiet_start, s.quiet_end);
end $$;

-- Remet une notification en attente après un échec temporaire (3 tentatives au plus).
create function public.release_notification(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.notifications set sent_at = null, send_after = now() + interval '5 minutes'
  where id = p_id and attempts < 3;
$$;

-- Planification (à exécuter une fois, avec l'URL de la fonction et le secret partagé).
create function public.schedule_notifications(p_function_url text, p_secret text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform cron.schedule('cl-new-theme', '0 6-20 * * 1', 'select public.enqueue_new_theme()');
  perform cron.schedule('cl-dispatch', '* * * * *', format(
    $cmd$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', %L), body := '{}'::jsonb)
         where exists (select 1 from public.notifications where sent_at is null and send_after <= now())$cmd$,
    p_function_url, p_secret));
end $$;

revoke all on function
  public.enqueue_notification, public.notify_publication, public.enqueue_new_theme,
  public.claim_due_notifications, public.release_notification, public.schedule_notifications
  from public, anon, authenticated;
grant execute on function public.claim_due_notifications, public.release_notification, public.enqueue_new_theme to service_role;
