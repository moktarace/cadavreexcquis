-- Survivor, chantier A: atomicité du matchmaking Duel/Battle. Remplace survivor_matchmake et survivor_create_challenge (0013) sans
-- toucher aux migrations précédentes; la branche Relay de survivor_matchmake est reprise telle quelle.
--
-- Problème (déduit du code de 0013, non reproduit en conditions réelles): le verrou de survivor_matchmake porte sur (joueur, mode).
-- Deux joueurs différents lançant ensemble une recherche dans une file vide ne se sérialisent pas: chacun ne voit aucun défi,
-- chacun en crée un, et chacun reste en attente (la branche « défi déjà ouvert » renvoyait son propre défi sans regarder les autres).
--
-- Correctif: la décision « rejoindre ou créer » est sérialisée par file (verrou consultatif par mode). Ordre des verrous, jamais inversé:
-- joueur → file → lignes de parties (for update skip locked). Un défi déjà en attente rattrape aussi les défis ouverts compatibles
-- laissés en attente: si son défi est encore vierge (aucune case dessinée), il est annulé et son créateur rejoint l'autre; sinon l'autre
-- défi, s'il est vierge, est annulé et son créateur rejoint celui-ci. Rien de ce qui a été dessiné n'est jamais supprimé.
-- NON DÉPLOYÉ: à valider avec `npm run db:check`, puis par `scripts/check-concurrency.mjs` sur une base de test.

create or replace function public.survivor_matchmake(p_mode text) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); c record; g public.survivor_games; v_id uuid; own public.survivor_games; v_own_empty boolean; v_other_empty boolean;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_mode not in ('relay', 'duel', 'battle') then raise exception 'INVALID_MODE'; end if;
  perform public.survivor_lock_user(v_uid, p_mode);
  perform public.survivor_expire_due();

  if p_mode = 'relay' then
    select r.game_id into v_id from public.survivor_reservations r
     where r.user_id = v_uid and not r.completed and r.expires_at > now() order by r.reserved_at desc limit 1;
    if v_id is not null then return public.survivor_result('reserved', v_id, v_uid); end if;
    -- Proches de leur conclusion d'abord, puis les plus anciennes, puis les plus longtemps sans contribution.
    for c in select id from public.survivor_games
              where mode = 'relay' and status = 'active' and cases_done < total_cases
              order by cases_done desc, coalesce(last_case_at, created_at), created_at limit 100 loop
      select * into g from public.survivor_games where id = c.id for update skip locked;
      if found and public.survivor_relay_ok(g.id, v_uid) then
        perform public.survivor_reserve_locked(v_uid, g.id);
        return public.survivor_result('reserved', g.id, v_uid);
      end if;
    end loop;
    v_id := public.survivor_new_game(v_uid, 'relay', 'open');
    perform public.survivor_reserve_locked(v_uid, v_id);
    return public.survivor_result('created', v_id, v_uid);
  end if;

  -- File publique (défis ouverts seulement; jamais les invitations): une seule décision à la fois par mode.
  perform pg_advisory_xact_lock(hashtextextended('survivor:queue:' || p_mode, 0));

  select * into own from public.survivor_games
   where mode = p_mode and status = 'searching' and visibility = 'open' and created_by = v_uid
   order by created_at, id limit 1 for update;
  if found then
    v_own_empty := not exists (select 1 from public.survivor_cases where game_id = own.id);
    for c in select id from public.survivor_games
              where mode = p_mode and status = 'searching' and visibility = 'open' and created_by <> v_uid
              order by created_at, id limit 20 loop
      select * into g from public.survivor_games where id = c.id for update skip locked;
      if not found or g.status <> 'searching' then continue; end if;
      if v_own_empty then
        update public.survivor_games set status = 'cancelled', ended_reason = 'cancelled', finished_at = now() where id = own.id;
        perform public.survivor_join(v_uid, g.id);
        return public.survivor_result('joined', g.id, v_uid);
      end if;
      v_other_empty := not exists (select 1 from public.survivor_cases where game_id = g.id);
      if v_other_empty then
        -- Le défi de l'autre est vierge: il est annulé et son créateur est placé dans celui-ci (sous-transaction: une limite atteinte ne bloque pas).
        begin
          update public.survivor_games set status = 'cancelled', ended_reason = 'cancelled', finished_at = now() where id = g.id;
          perform public.survivor_join(g.created_by, own.id);
          return public.survivor_result('joined', own.id, v_uid);
        exception when others then
          null;
        end;
      end if;
    end loop;
    return public.survivor_result('searching', own.id, v_uid);
  end if;

  perform public.survivor_check_limit(v_uid, p_mode);
  for c in select id from public.survivor_games
            where mode = p_mode and status = 'searching' and visibility = 'open' and created_by <> v_uid
            order by created_at, id limit 20 loop
    select * into g from public.survivor_games where id = c.id for update skip locked;
    if found and g.status = 'searching' then
      perform public.survivor_join(v_uid, g.id);
      return public.survivor_result('joined', g.id, v_uid);
    end if;
  end loop;
  v_id := public.survivor_new_game(v_uid, p_mode, 'open');
  return public.survivor_result('created', v_id, v_uid);
end $$;

-- Un défi ouvert s'ajoute à la file sous le même verrou que la décision de survivor_matchmake (la limite est comptée sous ce verrou).
create or replace function public.survivor_create_challenge(p_mode text, p_visibility text default 'open') returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_mode not in ('duel', 'battle') or p_visibility not in ('open', 'invite') then raise exception 'INVALID_MODE'; end if;
  perform public.survivor_lock_user(v_uid, p_mode);
  if p_visibility = 'open' then perform pg_advisory_xact_lock(hashtextextended('survivor:queue:' || p_mode, 0)); end if;
  perform public.survivor_expire_due();
  perform public.survivor_check_limit(v_uid, p_mode);
  v_id := public.survivor_new_game(v_uid, p_mode, p_visibility);
  return public.survivor_result('created', v_id, v_uid);
end $$;

revoke all on function public.survivor_matchmake(text), public.survivor_create_challenge(text, text) from public, anon;
grant execute on function public.survivor_matchmake(text), public.survivor_create_challenge(text, text) to authenticated;
