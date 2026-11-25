-- Survivor, étape 4: dépenses d'encre bonus (quatre consommables). Complète 0013 à 0015 sans les réécrire.
-- Le serveur est la seule source des prix, des effets, des modes autorisés et des limites: le client ne transmet
-- qu'un identifiant d'achat (clé d'idempotence). Un achat est une transaction unique: vérifications, verrous,
-- débit du registre, effet, enregistrement; tout échoue ensemble. Ordre des verrous (jamais inversé):
-- partie → run → portefeuille (Relay), partie Solo → portefeuille (Solo). L'arbitrage ne verrouille que BD → portefeuille.
-- NON DÉPLOYÉ: à valider avec `npm run db:check` puis sur une base de test.

-- ───────────── Catalogue (paramètres provisoires, source unique) ─────────────
create function public.survivor_shop_rules() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'items', jsonb_build_object(
      'refill',           jsonb_build_object('price', 40, 'effect', 20, 'min_missing', 20, 'modes', jsonb_build_array('solo', 'relay')),
      'constraint_reroll', jsonb_build_object('price', 30, 'modes', jsonb_build_array('solo', 'relay')),
      'upgrade_reroll',   jsonb_build_object('price', 25, 'modes', jsonb_build_array('solo', 'relay')),
      'emergency_refill', jsonb_build_object('price', 60, 'effect', 25, 'modes', jsonb_build_array('solo', 'relay'))),
    -- Duel et Battle n'y figurent pas: aucun achat, mêmes conditions pour les deux joueurs.
    'modes', jsonb_build_object('solo', jsonb_build_object('max_purchases', 2), 'relay', jsonb_build_object('max_purchases', 3)),
    'per_type_per_game', 1
  )
$$;

-- ───────────── Registre: accepte maintenant les dépenses (historique conservé) ─────────────
alter table public.survivor_ink_ledger drop constraint survivor_ink_ledger_amount_check;
alter table public.survivor_ink_ledger drop constraint survivor_ink_ledger_reason_check;
alter table public.survivor_ink_ledger add column item text;
alter table public.survivor_ink_ledger add column game_id uuid;
alter table public.survivor_ink_ledger add constraint survivor_ink_ledger_amount_check check (amount <> 0);
alter table public.survivor_ink_ledger add constraint survivor_ink_ledger_reason_check
  check (reason in ('arbiter_vote', 'arbiter_complete', 'vote_received', 'purchase'));
-- Une dépense est toujours négative et nomme son consommable et sa partie; un gain est toujours positif.
alter table public.survivor_ink_ledger add constraint survivor_ink_ledger_purchase_shape
  check ((reason = 'purchase') = (amount < 0) and (reason <> 'purchase' or (item is not null and game_id is not null)));
-- Le solde reste protégé deux fois: par la vérification de l'achat et par survivor_wallets.balance >= 0.

-- Le trigger de solde passe par un UPDATE: un INSERT ... ON CONFLICT vérifie la ligne proposée (donc un montant négatif) avant de détecter le conflit.
create or replace function public.survivor_ledger_apply() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.survivor_wallets (user_id) values (new.user_id) on conflict do nothing;
  update public.survivor_wallets set balance = balance + new.amount, updated_at = now() where user_id = new.user_id;
  return new;
end $$;

-- ───────────── Parties Solo et achats ─────────────
-- Une partie Solo reste locale: le serveur ne connaît que son identifiant stable (pour les limites d'achat).
create table public.survivor_solo_games (
  id         uuid primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.survivor_purchases (
  id         uuid primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  scope      text not null check (scope in ('solo', 'game')),
  game_id    uuid not null,
  item       text not null check (item in ('refill', 'constraint_reroll', 'upgrade_reroll', 'emergency_refill')),
  price      int not null check (price > 0),
  effect     int,
  ledger_id  uuid not null unique references public.survivor_ink_ledger (id),
  created_at timestamptz not null default now()
);
create unique index survivor_purchases_once on public.survivor_purchases (scope, game_id, item);
create index survivor_purchases_game on public.survivor_purchases (scope, game_id);
create trigger survivor_purchases_immutable before update on public.survivor_purchases
  for each row execute function public.forbid_update();

alter table public.survivor_solo_games enable row level security;
alter table public.survivor_purchases enable row level security;
revoke all on public.survivor_solo_games, public.survivor_purchases from anon, authenticated;

-- ───────────── Outils internes ─────────────
-- Trois nouvelles propositions d'amélioration, tirage indépendant (sel propre), sans les propositions actuelles.
create function public.survivor_draw_offer_salt(p_seed bigint, p_owned jsonb, p_salt text, p_exclude jsonb) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(s.id order by s.h, s.id), '[]'::jsonb) from (
    select d.id, hashtextextended(p_seed::text || ':u:' || p_salt || ':' || d.id, 0) as h
    from public.survivor_upgrade_defs d
    where coalesce((p_owned ->> d.id)::int, 0) < d.max_stacks and not (p_exclude @> to_jsonb(d.id))
    order by 2, 1 limit (public.survivor_economy() ->> 'offer_size')::int
  ) s
$$;

create function public.survivor_receipt(pur public.survivor_purchases, p_replay boolean, p_uid uuid) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object('purchase', pur.id, 'item', pur.item, 'scope', pur.scope, 'game', pur.game_id, 'price', pur.price,
    'effect', pur.effect, 'replay', p_replay,
    'balance', coalesce((select balance from public.survivor_wallets where user_id = p_uid), 0),
    'state', case when pur.scope = 'game' then public.survivor_state_json(pur.game_id, p_uid) end);
end $$;

-- ───────────── RPC publiques ─────────────

-- Prix, effets, limites du mode et solde du joueur (jamais celui des autres); sert l'interface sans dupliquer les valeurs.
create function public.survivor_shop(p_scope text, p_game uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); rules jsonb := public.survivor_shop_rules(); v_mode text := 'solo'; v_max int;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'shop', 60, 60);
  if p_scope = 'game' then
    select mode into v_mode from public.survivor_games where id = p_game
     and (exists (select 1 from public.survivor_players where game_id = p_game and user_id = v_uid)
          or exists (select 1 from public.survivor_reservations where game_id = p_game and user_id = v_uid and not completed and expires_at > now()));
    if v_mode is null then raise exception 'GAME_NOT_FOUND'; end if;
  elsif p_scope <> 'solo' then raise exception 'INVALID_PURCHASE';
  end if;
  v_max := (rules -> 'modes' -> v_mode ->> 'max_purchases')::int;
  return jsonb_build_object('rules', rules, 'mode', v_mode, 'allowed', v_max is not null,
    'balance', coalesce((select balance from public.survivor_wallets where user_id = v_uid), 0),
    'purchased', coalesce((select jsonb_agg(item order by created_at) from public.survivor_purchases where scope = p_scope and game_id = p_game), '[]'::jsonb),
    'remaining', greatest(0, coalesce(v_max, 0) - (select count(*) from public.survivor_purchases where scope = p_scope and game_id = p_game)::int));
end $$;

-- Achète un consommable. p_purchase est choisi par le client et sert de clé d'idempotence: rejouer le même achat
-- (double clic, réponse perdue) renvoie le reçu initial sans nouveau débit ni nouvel effet.
create function public.survivor_buy(p_scope text, p_game uuid, p_item text, p_purchase uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); rules jsonb := public.survivor_shop_rules(); it jsonb; pur public.survivor_purchases; g public.survivor_games; r public.survivor_runs;
  v_mode text; v_max int; v_price int; v_effect int; v_balance bigint; v_ledger uuid; v_offer jsonb := null;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'buy', 20, 60);
  if p_scope not in ('solo', 'game') or p_purchase is null or p_game is null then raise exception 'INVALID_PURCHASE'; end if;
  it := rules -> 'items' -> p_item;
  if it is null then raise exception 'UNKNOWN_ITEM'; end if;

  select * into pur from public.survivor_purchases where id = p_purchase;
  if found then
    if pur.user_id <> v_uid or pur.item <> p_item or pur.game_id <> p_game or pur.scope <> p_scope then raise exception 'INVALID_PURCHASE'; end if;
    return public.survivor_receipt(pur, true, v_uid);
  end if;

  -- Verrous: partie (puis run) avant portefeuille, toujours dans cet ordre.
  if p_scope = 'game' then
    r := public.survivor_enter(p_game, 'act');
    select * into g from public.survivor_games where id = p_game;
    v_mode := g.mode;
  else
    v_mode := 'solo';
    insert into public.survivor_solo_games (id, user_id) values (p_game, v_uid) on conflict do nothing;
    perform 1 from public.survivor_solo_games where id = p_game and user_id = v_uid for update;
    if not found then raise exception 'GAME_NOT_FOUND'; end if;
  end if;
  select * into pur from public.survivor_purchases where id = p_purchase;
  if found then return public.survivor_receipt(pur, true, v_uid); end if;

  v_max := (rules -> 'modes' -> v_mode ->> 'max_purchases')::int;
  if v_max is null or not ((it -> 'modes') @> to_jsonb(v_mode)) then raise exception 'SHOP_NOT_ALLOWED'; end if;
  if exists (select 1 from public.survivor_purchases where scope = p_scope and game_id = p_game and item = p_item) then raise exception 'ALREADY_BOUGHT'; end if;
  if (select count(*) from public.survivor_purchases where scope = p_scope and game_id = p_game) >= v_max then raise exception 'PURCHASE_LIMIT'; end if;

  v_price := (it ->> 'price')::int;
  v_effect := (it ->> 'effect')::int;
  if p_scope = 'game' then
    -- Seul le joueur qui peut agir maintenant, à l'étape concernée; les conditions locales (dessin) ne sont pas vérifiables.
    perform public.survivor_require_acting(p_game, r);
    if p_item = 'refill' and not (r.step = 'choosing' and r.pick is null and r.capacity - r.reserve >= (it ->> 'min_missing')::numeric) then raise exception 'NOT_AVAILABLE'; end if;
    if p_item = 'constraint_reroll' and not (r.step = 'choosing' and r.pick is null) then raise exception 'NOT_AVAILABLE'; end if;
    if p_item = 'emergency_refill' and not (r.step = 'choosing' and r.pick is not null and r.emergency = 0) then raise exception 'NOT_AVAILABLE'; end if;
    if p_item = 'upgrade_reroll' then
      if r.step <> 'upgrade' then raise exception 'NOT_AVAILABLE'; end if;
      v_offer := public.survivor_draw_offer_salt(g.seed, r.upgrades, 'r1', r.offer);
      if jsonb_array_length(v_offer) < (public.survivor_economy() ->> 'offer_size')::int then raise exception 'NO_NEW_OFFER'; end if;
    end if;
  end if;

  insert into public.survivor_wallets (user_id) values (v_uid) on conflict do nothing;
  select balance into v_balance from public.survivor_wallets where user_id = v_uid for update;
  if v_balance < v_price then raise exception 'INSUFFICIENT_FUNDS'; end if;
  insert into public.survivor_ink_ledger (user_id, amount, reason, item, game_id, idempotency_key)
  values (v_uid, -v_price, 'purchase', p_item, p_game, 'buy:' || p_purchase) returning id into v_ledger;

  if p_scope = 'game' then
    if p_item = 'refill' then update public.survivor_runs set reserve = least(capacity, reserve + v_effect) where id = r.id;
    elsif p_item = 'emergency_refill' then update public.survivor_runs set reserve = reserve + v_effect where id = r.id;
    elsif p_item = 'constraint_reroll' then
      update public.survivor_runs set proposals = public.survivor_proposals_for(g, r, array(select jsonb_array_elements_text(r.proposals)), 'q1') where id = r.id;
    else update public.survivor_runs set offer = v_offer where id = r.id;
    end if;
  end if;
  insert into public.survivor_purchases (id, user_id, scope, game_id, item, price, effect, ledger_id)
  values (p_purchase, v_uid, p_scope, p_game, p_item, v_price, v_effect, v_ledger) returning * into pur;
  return public.survivor_receipt(pur, false, v_uid);
end $$;

-- Un achat confirmé dont la réponse s'est perdue: le reçu, ou rien si le serveur n'a jamais reçu la demande.
create function public.survivor_buy_check(p_scope text, p_game uuid, p_purchase uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); pur public.survivor_purchases;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public.survivor_hit(v_uid, 'shop', 60, 60);
  select * into pur from public.survivor_purchases where id = p_purchase and user_id = v_uid and scope = p_scope and game_id = p_game;
  return case when found then public.survivor_receipt(pur, true, v_uid) end;
end $$;

-- Solde et historique personnels, gains et dépenses (la dépense nomme son consommable).
create or replace function public.survivor_wallet() returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  return jsonb_build_object('balance', coalesce((select balance from public.survivor_wallets where user_id = v_uid), 0),
    'history', coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'reason', reason, 'item', item, 'at', created_at) order by created_at desc, id)
                           from (select * from public.survivor_ink_ledger where user_id = v_uid order by created_at desc limit 50) h), '[]'::jsonb));
end $$;

-- ───────────── Droits d'exécution (nouvelles fonctions seulement; les précédentes gardent les leurs) ─────────────
revoke all on function public.survivor_shop_rules(), public.survivor_shop(text, uuid), public.survivor_buy(text, uuid, text, uuid),
  public.survivor_buy_check(text, uuid, uuid), public.survivor_draw_offer_salt(bigint, jsonb, text, jsonb),
  public.survivor_receipt(public.survivor_purchases, boolean, uuid) from public, anon, authenticated;
grant execute on function public.survivor_shop_rules(), public.survivor_shop(text, uuid), public.survivor_buy(text, uuid, text, uuid),
  public.survivor_buy_check(text, uuid, uuid) to authenticated;
