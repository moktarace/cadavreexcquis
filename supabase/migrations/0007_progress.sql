-- Ce que les autres ont fait d'un dessin: pour « Mes dessins » (suites, histoire complète).
-- Une seule requête pour une page de dessins (100 identifiants au plus), lecture seule.
create function public.contribution_progress(p_ids uuid[])
returns table (id uuid, descendants int, finished int, finished_leaf uuid)
language sql stable security invoker as $$
  with recursive walk as (
    select c.id as root, c.id as node, c.case_number, c.published_at
    from public.contributions c
    where c.id = any (p_ids[1:100]) and c.status = 'published'
    union all
    select w.root, c.id, c.case_number, c.published_at
    from walk w join public.contributions c on c.parent_id = w.node and c.status = 'published'
  )
  select w.root,
         (count(*) - 1)::int,
         (count(*) filter (where w.case_number = 4))::int,
         (array_agg(w.node order by w.published_at desc, w.node desc) filter (where w.case_number = 4))[1]
  from walk w
  group by w.root;
$$;

grant execute on function public.contribution_progress to authenticated;
