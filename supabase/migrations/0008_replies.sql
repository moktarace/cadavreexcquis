-- Réponses à découvrir: une réponse est la continuation directe, par un autre joueur, d'une case dont on est l'auteur.
-- La table `notifications` est la file d'attente du Web Push (abonnés seulement, regroupée, supprimée à l'envoi):
-- elle ne peut pas servir d'état de lecture. Ici, seul le « lu » est stocké; le « non lu » se déduit des
-- contributions, donc une réponse n'est jamais perdue même sans abonnement push.

create table public.reply_reads (
  user_id  uuid not null references public.profiles (id) on delete cascade,
  reply_id uuid not null references public.contributions (id) on delete cascade,
  read_at  timestamptz not null default now(),
  primary key (user_id, reply_id)
);
alter table public.reply_reads enable row level security;

create policy reply_reads_owner_read on public.reply_reads for select to authenticated
  using (user_id = auth.uid());

-- On ne peut marquer comme lue qu'une réponse directe à l'une de ses propres cases. Aucune modification
-- ni suppression: un état « lu » est définitif, ce qui rend les écritures concurrentes (deux appareils) sans effet.
create policy reply_reads_owner_insert on public.reply_reads for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.contributions r
      join public.contributions p on p.id = r.parent_id
      where r.id = reply_id and p.author_id = auth.uid() and r.author_id <> auth.uid()
    )
  );

revoke update, delete on public.reply_reads from authenticated;

-- Les réponses déjà publiées avant cette migration sont considérées comme connues.
insert into public.reply_reads (user_id, reply_id)
select p.author_id, r.id
from public.contributions r
join public.contributions p on p.id = r.parent_id
where r.author_id <> p.author_id
on conflict do nothing;

-- Réponses non lues du joueur connecté, les plus récentes d'abord. Passe par les index de
-- `contributions` (auteur, parent): le coût dépend de ses propres cases, pas de toutes les contributions.
create function public.unread_replies(p_limit int default 100)
returns table (reply_id uuid, parent_id uuid, replied_at timestamptz)
language sql stable security invoker as $$
  select r.id, r.parent_id, r.published_at
  from public.contributions p
  join public.contributions r on r.parent_id = p.id and r.status = 'published'
  where p.author_id = auth.uid() and p.status = 'published'
    and r.author_id <> auth.uid()
    and not exists (
      select 1 from public.reply_reads x where x.user_id = auth.uid() and x.reply_id = r.id
    )
  order by r.published_at desc, r.id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
$$;

revoke all on function public.unread_replies from public, anon;
grant execute on function public.unread_replies to authenticated;
