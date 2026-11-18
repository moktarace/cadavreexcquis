-- Application: profil automatique, vues de lecture, partie courante, fichiers.
-- NON DÉPLOYÉ: à appliquer après 0001 (voir README).

-- ───────────── Profil créé automatiquement pour chaque compte (anonyme compris) ─────────────
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nickname) values (new.id, 'Joueur ' || substr(new.id::text, 1, 4))
    on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────── Vue de lecture: une carte par contribution publiée ─────────────
-- security_invoker: les politiques RLS de l'appelant s'appliquent aux tables sous-jacentes.
create view public.contribution_cards with (security_invoker = true) as
select
  c.id, c.game_id, c.room_id, c.author_id, p.nickname as author_nickname,
  c.case_number, c.parent_id, a.path as preview_path, c.published_at,
  (select count(*) from public.contributions k where k.parent_id = c.id and k.status = 'published')::int as child_count
from public.contributions c
join public.profiles p on p.id = c.author_id
join public.drawing_assets a on a.id = c.preview_asset
where c.status = 'published';

grant select on public.contribution_cards to authenticated;

-- Chemin racine → case donnée (les cases partagées ne sont jamais dupliquées).
create function public.contribution_path(leaf uuid)
returns setof public.contribution_cards language sql stable security invoker as $$
  with recursive up as (
    select c.id, c.parent_id from public.contributions c where c.id = leaf and c.status = 'published'
    union all
    select c.id, c.parent_id from public.contributions c join up u on c.id = u.parent_id where c.status = 'published'
  )
  select cc.* from up join public.contribution_cards cc on cc.id = up.id order by cc.case_number;
$$;

-- Toutes les cases en dessous d'une case (arbre de ses suites).
create function public.contribution_subtree(root uuid)
returns setof public.contribution_cards language sql stable security invoker as $$
  with recursive tree as (
    select c.id from public.contributions c where c.parent_id = root and c.status = 'published'
    union all
    select c.id from public.contributions c join tree t on c.parent_id = t.id where c.status = 'published'
  )
  select cc.* from tree join public.contribution_cards cc on cc.id = tree.id order by cc.case_number, cc.published_at;
$$;

-- ───────────── Partie courante: le serveur fait autorité sur la semaine et l'heure ─────────────
create function public.current_game()
returns table (
  game_id uuid, iso_year smallint, iso_week smallint,
  theme_text text, theme_seed text, generator_version text,
  next_theme_at timestamptz, server_now timestamptz
) language sql stable security invoker as $$
  with p as (select now() at time zone 'Europe/Paris' as local)
  select g.id, g.iso_year, g.iso_week, t.text, t.seed, t.generator_version,
         (date_trunc('week', p.local) + interval '7 days') at time zone 'Europe/Paris',
         now()
  from p
  join public.weekly_games g
    on g.iso_year = extract(isoyear from p.local) and g.iso_week = extract(week from p.local) and not g.is_private
  join public.themes t on t.id = g.theme_id;
$$;

grant execute on function public.contribution_path, public.contribution_subtree, public.current_game to authenticated;

-- ───────────── Stockage: aperçus publics (PNG), projets éditables privés (JSON) ─────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('previews', 'previews', true, 262144, array['image/png']),
  ('projects', 'projects', false, 1048576, array['application/json'])
on conflict (id) do nothing;

-- Chaque fichier vit sous un dossier portant l'identifiant de son auteur.
create policy storage_previews_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'previews' and (storage.foldername(name))[1] = auth.uid()::text);
create policy storage_projects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'projects' and (storage.foldername(name))[1] = auth.uid()::text);
create policy storage_projects_read on storage.objects for select to authenticated
  using (bucket_id = 'projects' and (storage.foldername(name))[1] = auth.uid()::text);
