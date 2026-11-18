-- Lecture sans troncature silencieuse et accueil d'une salle vide.

-- Même résultat qu'avant, mais l'ordre est total (id en dernier) pour que la lecture par pages soit déterministe.
create or replace function public.contribution_subtree(root uuid)
returns setof public.contribution_cards language sql stable security invoker as $$
  with recursive tree as (
    select c.id from public.contributions c where c.parent_id = root and c.status = 'published'
    union all
    select c.id from public.contributions c join tree t on c.parent_id = t.id where c.status = 'published'
  )
  select cc.* from tree join public.contribution_cards cc on cc.id = tree.id order by cc.case_number, cc.published_at, cc.id;
$$;

-- Semaines publiques qui ont reçu au moins un dessin (une ligne par semaine, aucune limite arbitraire).
create function public.archive_weeks()
returns table (game_id uuid, iso_year smallint, iso_week smallint, theme_text text)
language sql stable security invoker as $$
  select g.id, g.iso_year, g.iso_week, t.text
  from public.weekly_games g
  join public.themes t on t.id = g.theme_id
  where not g.is_private
    and exists (select 1 from public.contributions c where c.game_id = g.id and c.status = 'published')
  order by g.iso_year desc, g.iso_week desc;
$$;

-- Quelques dessins publiés des autres parties publiques (jamais la partie courante, jamais une partie privée):
-- uniquement pour être lus dans les archives, ils ne rejoignent aucune salle. Histoires terminées d'abord.
create function public.archive_highlights(p_game uuid, p_limit int default 8)
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
  where cc.game_id <> p_game
  order by (cc.case_number = 4) desc, cc.published_at desc, cc.id desc
  limit least(greatest(p_limit, 1), 24);
$$;

grant execute on function public.archive_weeks, public.archive_highlights to authenticated;
