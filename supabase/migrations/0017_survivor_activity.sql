-- Survivor, étape 5: flux d'activité et compteurs d'accueil. Migration isolée et non destructive (une table, trois fonctions).
-- Les événements sont DÉRIVÉS des tables existantes (parties, arbitrages, votes, registre): rien n'est copié, donc rien ne
-- peut être généré deux fois ni diverger de l'historique. Seul l'état « lu » est stocké (un repère par joueur).
-- Jamais exposés: identité des arbitres, dessins ou votes protégés d'un Duel en cours, activité des autres joueurs.
-- NON DÉPLOYÉ: à valider avec `npm run db:check` puis sur une base de test.

create table public.survivor_activity_reads (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  read_until timestamptz not null
);
alter table public.survivor_activity_reads enable row level security;
revoke all on public.survivor_activity_reads from anon, authenticated;

-- Événements des 30 derniers jours (les demandes de consentement en attente restent tant qu'elles le sont), les plus récents d'abord.
create function public.survivor_activity() returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_now timestamptz := now(); v_since timestamptz := now() - interval '30 days';
  v_read timestamptz; v_events jsonb; v_unread int;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'activity', 60, 60);
  perform public.survivor_expire_due();
  select read_until into v_read from public.survivor_activity_reads where user_id = v_uid;
  v_read := coalesce(v_read, 'epoch'::timestamptz);

  with ev (key, kind, at, game_id, bd_id, mode, theme, amount, count, ups, result) as (
    -- Adversaire trouvé / invitation acceptée: seulement pour celui qui a créé le défi.
    select 'game:' || g.id || ':match', case when g.visibility = 'invite' then 'invite_accepted' else 'match_found' end, g.active_at, g.id, null::uuid, g.mode, g.theme, null::int, null::int, null::int, null::text
      from public.survivor_games g
     where g.created_by = v_uid and g.mode in ('duel', 'battle') and g.active_at is not null and g.active_at > v_since
    union all
    -- Nouveau tour de Battle (un seul événement par partie: le tour courant).
    select 'game:' || g.id || ':turn', 'turn', coalesce(g.last_case_at, g.active_at), g.id, null, g.mode, g.theme, null, null, null, null
      from public.survivor_games g
     where g.mode = 'battle' and g.status = 'active' and g.turn_player = v_uid and coalesce(g.last_case_at, g.active_at) > v_since
    union all
    -- Partie terminée (victoire, défaite, forfait, expiration, BD collective): l'issue vient de survivor_view, comme « Mes parties ».
    select 'game:' || g.id || ':done', 'game_done', g.finished_at, g.id, null, g.mode, g.theme, null, null, null, public.survivor_view(g.id, v_uid) ->> 'result'
      from public.survivor_games g join public.survivor_players p on p.game_id = g.id and p.user_id = v_uid
     where g.status in ('finished', 'abandoned') and g.finished_at > v_since
    union all
    -- Résultat narratif d'un Duel, dès qu'il est décidé (même règle que survivor_duel_verdict).
    select 'duel:' || gr.id, 'duel_verdict', gr.decided_at, gr.game_id, null, 'duel', g.theme, null, null, null,
           case when gr.verdict = 'tie' then 'tie' when gr.winner = v_uid then 'win' else 'loss' end
      from public.survivor_bd_groups gr join public.survivor_games g on g.id = gr.game_id
     where gr.verdict is not null and gr.decided_at > v_since
       and exists (select 1 from public.survivor_players p where p.game_id = gr.game_id and p.user_id = v_uid)
       and not exists (select 1 from public.survivor_bds b where b.game_id = gr.game_id and b.group_id is null)
    union all
    -- Demande de consentement à l'arbitrage (tant qu'elle attend).
    select 'consent:' || b.id, 'consent_request', b.created_at, null, b.id, b.source, b.theme, null, null, null, null
      from public.survivor_consents c join public.survivor_bds b on b.id = c.bd_id
     where c.user_id = v_uid and c.decision is null and b.status = 'pending'
    union all
    -- Arbitrages reçus sur mes BD, regroupés par BD: nombre, upvotes et encre bonus gagnée sur mes cases (jamais l'identité des arbitres).
    select 'bd:' || b.id, 'bd_judged', j.last_at, b.game_id, b.id, b.source, b.theme,
           coalesce((select sum(l.amount)::int from public.survivor_ink_ledger l join public.survivor_bd_cases c on c.id = l.case_id
                      where c.bd_id = b.id and l.user_id = v_uid and l.reason = 'vote_received'), 0),
           j.n,
           (select count(*)::int from public.survivor_votes v join public.survivor_bd_cases c on c.id = v.case_id
              join public.survivor_arbitrations a on a.id = v.arbitration_id
             where c.bd_id = b.id and c.author_id = v_uid and v.vote = 'up' and a.status = 'completed'),
           null
      from public.survivor_bds b
      join lateral (select count(*)::int as n, max(a.completed_at) as last_at
                      from public.survivor_arbitration_bds ab join public.survivor_arbitrations a on a.id = ab.arbitration_id
                     where ab.bd_id = b.id and a.status = 'completed') j on j.n > 0
     where b.status <> 'draft' and j.last_at > v_since
       and (b.owner_id = v_uid or exists (select 1 from public.survivor_bd_authors x where x.bd_id = b.id and x.user_id = v_uid))
    union all
    -- Encre bonus obtenue en arbitrant.
    select 'arb:' || a.id, 'arbitration_done', a.completed_at, null, null, 'arbiter',
           (select b.theme from public.survivor_arbitration_bds ab join public.survivor_bds b on b.id = ab.bd_id where ab.arbitration_id = a.id order by ab.slot limit 1),
           a.reward_total, null, null, null
      from public.survivor_arbitrations a
     where a.arbiter_id = v_uid and a.status = 'completed' and a.completed_at > v_since and a.reward_total > 0
  ), top as (select * from ev order by at desc, key limit 60)
  select coalesce(jsonb_agg(to_jsonb(t) order by t.at desc, t.key), '[]'::jsonb), (count(*) filter (where t.at > v_read))::int
    into v_events, v_unread from top t;

  return jsonb_build_object('now', v_now, 'read_until', v_read, 'unread', coalesce(v_unread, 0), 'events', v_events,
    -- Combien d'activités attendent un joueur, tout de suite (comptes seulement).
    'open', jsonb_build_object(
      'relay', (select count(*) from (select g.id from public.survivor_games g
                  where g.mode = 'relay' and g.status = 'active' and g.cases_done < g.total_cases
                  order by g.cases_done desc, coalesce(g.last_case_at, g.created_at) limit 100) c where public.survivor_relay_ok(c.id, v_uid)),
      'duel', (select count(*) from public.survivor_games where mode = 'duel' and status = 'searching' and visibility = 'open' and created_by <> v_uid),
      'battle', (select count(*) from public.survivor_games where mode = 'battle' and status = 'searching' and visibility = 'open' and created_by <> v_uid)));
end $$;

-- « Tout marquer comme lu »: seulement ce que le joueur a vu (le repère renvoyé par survivor_activity), jamais en arrière.
create function public.survivor_activity_read(p_until timestamptz default null) returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'activity', 60, 60);
  insert into public.survivor_activity_reads as r (user_id, read_until) values (v_uid, least(coalesce(p_until, now()), now()))
  on conflict (user_id) do update set read_until = greatest(r.read_until, excluded.read_until);
end $$;

-- Miniature (première case lisible) de chaque partie demandée, par les règles de lecture existantes (survivor_can_read_case):
-- en Duel en cours, seulement sa propre BD; jamais celle de l'adversaire. Les images se lisent ensuite par URL signée.
create function public.survivor_game_thumbs(p_games uuid[]) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('game_id', t.game_id, 'image_path', t.image_path)) from (
    select distinct on (c.game_id) c.game_id, c.image_path
      from public.survivor_cases c
     where c.game_id = any (p_games[1:40]) and public.survivor_can_read_case(c.game_id, c.bd_owner)
     order by c.game_id, (c.bd_owner is not distinct from v_uid) desc, c.position) t), '[]'::jsonb);
end $$;

revoke all on function public.survivor_activity(), public.survivor_activity_read(timestamptz), public.survivor_game_thumbs(uuid[]) from public, anon, authenticated;
grant execute on function public.survivor_activity(), public.survivor_activity_read(timestamptz), public.survivor_game_thumbs(uuid[]) to authenticated;
