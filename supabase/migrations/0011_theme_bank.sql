-- Banque de thèmes de match d'improvisation, tirée comme un barillet.
-- À appliquer après 0010. Remplace la génération « personnage + trait + situation » (0003): les thèmes sont des
-- titres courts choisis dans une banque modifiable côté serveur (espace /admin), sans redéploiement.
--
-- Principes:
--  * un thème est « utilisé » dès que la semaine qui le porte a commencé (ou pour une partie privée): il ne bouge
--    plus jamais, ni son texte ni sa semaine;
--  * les semaines qui n'ont pas commencé sont (re)tirées de façon déterministe à chaque changement de la banque:
--    aucun thème ne revient avant que tous les autres soient passés, puis un nouveau tour commence;
--  * le thème de la semaine active et ceux déjà passés ne sont jamais modifiés par ce système.

alter table public.themes
  add column in_bank    boolean not null default false,
  add column source     text not null default 'generated' check (source in ('generated', 'original', 'imported', 'referee')),
  add column note       text check (char_length(note) <= 200),
  add column bank_key   text,
  add column retired_at timestamptz;

-- Les thèmes de l'ancien générateur restent tels quels (historique des semaines passées), hors banque.
create unique index themes_bank_key on public.themes (bank_key) where in_bank and retired_at is null;

-- Clé de comparaison: minuscules, sans accents, ponctuation ni articles (même calcul que src/domain/themeBank.ts).
create function public.theme_key(p text) returns text
language sql immutable as $$
  with n as (
    select string_to_array(btrim(regexp_replace(
      lower(translate(replace(replace(p, 'œ', 'oe'), 'æ', 'ae'),
        'àâäáãåéèêëíìîïóòôöõúùûüýÿçñÀÂÄÁÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÝŸÇÑ',
        'aaaaaaeeeeiiiiooooouuuuyycnaaaaaaeeeeiiiiooooouuuuyycn')),
      '[^a-z0-9]+', ' ', 'g')), ' ') as w
  )
  select coalesce(
    nullif(array_to_string(array(select x from unnest(n.w) x
      where x <> '' and x <> all ('{le,la,les,l,un,une,des,de,du,d,et,a,au,aux,en,ce,cet,cette,ses,son,sa,mes,ma,mon}'::text[])), ' '), ''),
    array_to_string(array(select x from unnest(n.w) x where x <> ''), ' '))
  from n;
$$;

-- Un thème est utilisé quand une partie qui le porte a commencé (ou est privée).
create function public.theme_is_used(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.weekly_games g where g.theme_id = p_id and (g.is_private or g.starts_at <= now()));
$$;

-- Immuabilité: l'ancien générateur et tout thème utilisé sont figés; un thème de la banque jamais utilisé se corrige.
drop trigger themes_immutable on public.themes;
create function public.themes_guard() returns trigger language plpgsql as $$
begin
  if not old.in_bank then raise exception 'Table immuable: thèmes de l''ancien générateur'; end if;
  if public.theme_is_used(old.id) then raise exception 'THEME_USED'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger themes_guard before update or delete on public.themes
  for each row execute function public.themes_guard();

-- Les thèmes à venir restent secrets: on ne lit que ceux d'une semaine commencée (ou d'une partie privée).
drop policy themes_read on public.themes;
create policy themes_read on public.themes for select to authenticated
  using (exists (select 1 from public.weekly_games g where g.theme_id = themes.id and (g.starts_at is null or g.starts_at <= now())));

-- L'ancien secours de génération n'a plus d'objet.
drop function public.ensure_weekly_game(smallint, smallint, text, text, text, jsonb);

-- ───────────── Import (sans contrôle d'accès: réservé à la base et aux fonctions d'administration) ─────────────
create function public.bank_import(p_items jsonb, p_source text default 'original') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  it jsonb; v_text text; v_key text; v_src text; v_added int := 0; v_skipped jsonb := '[]'::jsonb; v_ins int;
begin
  if p_source not in ('original', 'imported', 'referee') then raise exception 'INVALID_SOURCE'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_text := btrim(regexp_replace(coalesce(it->>'text', ''), '\s+', ' ', 'g'));
    v_src := coalesce(nullif(it->>'source', ''), p_source);
    if v_src not in ('original', 'imported', 'referee') then v_src := p_source; end if;
    v_key := public.theme_key(v_text);
    if char_length(v_text) < 3 or char_length(v_text) > 60 or v_key = '' then
      v_skipped := v_skipped || jsonb_build_object('text', v_text, 'reason', 'invalid');
      continue;
    end if;
    insert into public.themes (seed, generator_version, text, parts, in_bank, source, note, bank_key)
    values ('bank/' || v_key, 'bank-1', v_text, '{}'::jsonb, true, v_src, nullif(left(it->>'note', 200), ''), v_key)
    on conflict do nothing;
    get diagnostics v_ins = row_count;
    if v_ins = 1 then v_added := v_added + 1;
    else v_skipped := v_skipped || jsonb_build_object('text', v_text, 'reason', 'duplicate');
    end if;
  end loop;
  return jsonb_build_object('added', v_added, 'skipped', v_skipped);
end $$;

-- ───────────── Calendrier: semaines à l'avance et tirage ─────────────
-- Crée les semaines publiques manquantes jusqu'à p_weeks semaines à partir de la semaine courante (≈ dix ans).
create function public.ensure_schedule_weeks(p_weeks int default 520) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_theme uuid; v_monday date := date_trunc('week', now() at time zone 'Europe/Paris')::date; v_d date; v_n int := 0; v_ins int;
begin
  select id into v_theme from public.themes where in_bank and retired_at is null order by id limit 1;
  if v_theme is null then return 0; end if;
  for i in 0 .. p_weeks - 1 loop
    v_d := v_monday + i * 7;
    insert into public.weekly_games (iso_year, iso_week, theme_id)
    values (extract(isoyear from v_d)::smallint, extract(week from v_d)::smallint, v_theme)
    on conflict (iso_year, iso_week) where not is_private do nothing;
    get diagnostics v_ins = row_count;
    v_n := v_n + v_ins;
  end loop;
  return v_n;
end $$;

-- Le barillet: pour chaque semaine qui n'a pas commencé, on retient parmi les thèmes les moins utilisés celui dont
-- l'empreinte md5 (graine + titre + semaine) est la plus petite. Déterministe, sans coût, sans IA.
-- Figés: les semaines commencées, et celles qui commencent dans les 7 jours dès lors qu'un thème de la banque les
-- porte déjà (le « carton » de la semaine prochaine est sorti, il ne change plus).
create function public.redraw_theme_schedule() returns int
language plpgsql security definer set search_path = public as $$
declare
  g record; v_pick uuid; v_assigned int := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('theme-schedule', 0));
  perform public.ensure_schedule_weeks(520);

  create temp table if not exists _barillet (theme_id uuid primary key, key text not null, n int not null) on commit drop;
  truncate _barillet;
  insert into _barillet
  select t.id, t.bank_key,
         (select count(*)::int from public.weekly_games x
           where x.theme_id = t.id and not x.is_private and x.starts_at <= now())
  from public.themes t where t.in_bank and t.retired_at is null;
  if not exists (select 1 from _barillet) then return 0; end if;

  for g in
    select w.id, w.iso_year, w.iso_week, w.theme_id, w.starts_at,
           (select t.in_bank and t.retired_at is null from public.themes t where t.id = w.theme_id) as drawn
    from public.weekly_games w where not w.is_private and w.starts_at > now() order by w.starts_at
  loop
    if g.drawn and g.starts_at <= now() + interval '7 days' then
      update _barillet set n = n + 1 where theme_id = g.theme_id;
      continue;
    end if;
    select b.theme_id into v_pick from _barillet b
    order by b.n, md5('barillet/v1:' || b.key || ':' || (g.iso_year * 100 + g.iso_week)::text), b.key limit 1;
    if v_pick is distinct from g.theme_id then
      update public.weekly_games set theme_id = v_pick where id = g.id;
      v_assigned := v_assigned + 1;
    end if;
    update _barillet set n = n + 1 where theme_id = v_pick;
  end loop;
  return v_assigned;
end $$;

-- Import « base de données »: pour themes.json et les feuilles de match (npm run db:themes), sans redéploiement.
create function public.import_theme_bank(p_items jsonb, p_source text default 'original') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  r := public.bank_import(p_items, p_source);
  perform public.redraw_theme_schedule();
  return r;
end $$;

-- ───────────── Administration de la banque ─────────────
create function public.admin_theme_bank(
  p_status text default null, p_search text default null, p_limit int default 50, p_offset int default 0
) returns table (
  id uuid, text text, source text, note text, in_bank boolean, uses int, scheduled int,
  last_used timestamptz, next_at timestamptz, status text, total bigint
) language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.assert_admin();
  return query
  with usage as (
    select t.id as tid,
           count(g.id) filter (where g.is_private or g.starts_at <= now())::int as uses,
           count(g.id) filter (where not g.is_private and g.starts_at > now())::int as scheduled,
           max(g.starts_at) filter (where g.is_private or g.starts_at <= now()) as last_used,
           min(g.starts_at) filter (where not g.is_private and g.starts_at > now()) as next_at
    from public.themes t left join public.weekly_games g on g.theme_id = t.id
    group by t.id
  ), lst as (
    select t.id, t.text, t.source, t.note, t.in_bank, u.uses, u.scheduled, u.last_used, u.next_at,
           case when u.uses > 0 then 'used' when u.scheduled > 0 then 'scheduled' else 'unused' end as status
    from public.themes t join usage u on u.tid = t.id
    where (t.in_bank or u.uses > 0)
      and (nullif(btrim(p_search), '') is null or public.theme_key(t.text) like '%' || public.theme_key(p_search) || '%')
  )
  select r.id, r.text, r.source, r.note, r.in_bank, r.uses, r.scheduled, r.last_used, r.next_at, r.status, count(*) over ()
  from lst r
  where p_status is null or p_status = 'all' or r.status = p_status
  order by r.next_at nulls last, r.last_used desc nulls last, r.text
  limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
end $$;

-- Semaine active, semaines passées encore visibles et prochains cartons, dans l'ordre.
create function public.admin_theme_schedule(p_weeks int default 12)
returns table (iso_year smallint, iso_week smallint, starts_at timestamptz, theme_id uuid, text text, source text, frozen boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.assert_admin();
  return query
  select g.iso_year, g.iso_week, g.starts_at, t.id, t.text, t.source,
         (g.starts_at <= now() or (t.in_bank and g.starts_at <= now() + interval '7 days'))
  from public.weekly_games g join public.themes t on t.id = g.theme_id
  where not g.is_private and (g.expires_at is null or g.expires_at > now()) and g.starts_at <= now() + least(greatest(p_weeks, 1), 104) * interval '7 days'
  order by g.starts_at;
end $$;

create function public.admin_theme_add(p_text text, p_source text default 'original', p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare r jsonb; v_id uuid;
begin
  perform public.assert_admin();
  r := public.bank_import(jsonb_build_array(jsonb_build_object('text', p_text, 'note', p_note)), p_source);
  if (r->>'added')::int = 0 then
    raise exception '%', case when r->'skipped'->0->>'reason' = 'duplicate' then 'THEME_DUPLICATE' else 'THEME_INVALID' end;
  end if;
  select id into v_id from public.themes where in_bank and bank_key = public.theme_key(p_text) and retired_at is null;
  perform public.redraw_theme_schedule();
  return v_id;
end $$;

create function public.admin_theme_import(p_items jsonb, p_source text default 'imported') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  perform public.assert_admin();
  r := public.bank_import(p_items, p_source);
  if (r->>'added')::int > 0 then perform public.redraw_theme_schedule(); end if;
  return r;
end $$;

create function public.admin_theme_update(p_id uuid, p_text text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_text text; v_key text;
begin
  perform public.assert_admin();
  v_text := btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'));
  v_key := public.theme_key(v_text);
  if char_length(v_text) < 3 or char_length(v_text) > 60 or v_key = '' then raise exception 'THEME_INVALID'; end if;
  if not exists (select 1 from public.themes where id = p_id and in_bank) then raise exception 'THEME_NOT_FOUND'; end if;
  if public.theme_is_used(p_id) then raise exception 'THEME_USED'; end if;
  if exists (select 1 from public.themes where in_bank and retired_at is null and bank_key = v_key and id <> p_id) then
    raise exception 'THEME_DUPLICATE';
  end if;
  update public.themes set text = v_text, bank_key = v_key, seed = 'bank/' || v_key, note = nullif(left(coalesce(p_note, ''), 200), '')
  where id = p_id;
  perform public.redraw_theme_schedule();
end $$;

-- Retire un thème jamais utilisé: ses semaines à venir sont retirées au sort, puis la ligne disparaît.
create function public.admin_theme_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_admin();
  if not exists (select 1 from public.themes where id = p_id and in_bank) then raise exception 'THEME_NOT_FOUND'; end if;
  if public.theme_is_used(p_id) then raise exception 'THEME_USED'; end if;
  update public.themes set retired_at = now() where id = p_id;
  perform public.redraw_theme_schedule();
  delete from public.themes where id = p_id;
end $$;

-- ───────────── Droits d'exécution ─────────────
revoke all on function
  public.theme_key, public.theme_is_used, public.bank_import, public.ensure_schedule_weeks, public.redraw_theme_schedule,
  public.import_theme_bank, public.admin_theme_bank, public.admin_theme_schedule, public.admin_theme_add,
  public.admin_theme_import, public.admin_theme_update, public.admin_theme_remove
  from public, anon, authenticated;

grant execute on function
  public.admin_theme_bank, public.admin_theme_schedule, public.admin_theme_add, public.admin_theme_import,
  public.admin_theme_update, public.admin_theme_remove
  to authenticated;

grant execute on function public.import_theme_bank, public.redraw_theme_schedule, public.ensure_schedule_weeks to service_role;
