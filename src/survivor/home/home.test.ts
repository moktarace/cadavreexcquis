import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hub } from '../arbiter/types';
import type { GameView } from '../multi/types';
import { fetchActivity, fetchThumbs, markActivityRead } from './api';
import { mergeLive, type LiveData } from './live';
import { forget, markSeen, seen } from './prefs';
import { activityLines, describeEvent, matchState, suggestPlay, turnsByMode, type Activity, type ActivityEvent } from './types';

const rpcMock = vi.fn();
vi.mock('../../backend/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));
vi.mock('../../backend/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  ensureSession: async () => ({ userId: 'u', isAnonymous: true, email: null }),
}));

const game = (over: Partial<GameView> = {}): GameView => ({
  id: 'g1',
  mode: 'duel',
  status: 'active',
  visibility: 'open',
  theme: 'Thème',
  total_cases: 16,
  cases_done: 0,
  created_at: '2026-01-01T00:00:00Z',
  deadline_at: null,
  ended_reason: null,
  result: null,
  reserve: null,
  capacity: null,
  seconds_left: null,
  bucket: 'waiting',
  can_play: false,
  can_cancel: false,
  can_abandon: false,
  my_status: 'playing',
  turn_is_mine: false,
  forfeit_by_me: false,
  reservation_until: null,
  invite_token: null,
  players: [],
  ...over,
});
const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({ key: 'k', kind: 'turn', at: '2026-01-01T00:00:00Z', game_id: 'g1', bd_id: null, mode: 'battle', theme: 'Thème', amount: null, count: null, ups: null, result: null, ...over });

describe('flux d’activité: textes', () => {
  it('regroupe arbitrages, upvotes et encre d’une même BD en une seule ligne', () => {
    const d = describeEvent(ev({ kind: 'bd_judged', game_id: null, bd_id: 'b', mode: 'solo', count: 3, ups: 3, amount: 15 }));
    expect(d.title).toBe('Ta BD « Thème » a reçu 3 arbitrages');
    expect(d.detail).toBe('3 upvotes : +15 encre bonus');
    expect(d.target).toEqual({ to: 'arbiter' });
    const one = describeEvent(ev({ kind: 'bd_judged', count: 1, ups: 1, amount: 5 }));
    expect(one.title).toContain('1 arbitrage');
    expect(one.detail).toBe('1 upvote : +5 encre bonus');
    expect(describeEvent(ev({ kind: 'bd_judged', count: 1, ups: 0, amount: 0 })).detail).toBe('0 upvote');
  });

  it('chaque événement mène à la bonne destination', () => {
    expect(describeEvent(ev({ kind: 'turn' })).target).toEqual({ to: 'game', gameId: 'g1' });
    expect(describeEvent(ev({ kind: 'consent_request', game_id: null, bd_id: 'b' })).target).toEqual({ to: 'arbiter' });
    expect(describeEvent(ev({ kind: 'arbitration_done', game_id: null, amount: 18 }))).toMatchObject({ title: 'Arbitrage terminé : +18 encre bonus', target: { to: 'wallet' } });
    expect(describeEvent(ev({ kind: 'match_found' })).title).toBe('Adversaire trouvé');
    expect(describeEvent(ev({ kind: 'invite_accepted' })).title).toBe('Invitation acceptée');
  });

  it('issues de partie et résultat narratif', () => {
    expect(describeEvent(ev({ kind: 'game_done', result: 'win', mode: 'battle' })).title).toBe('Victoire');
    expect(describeEvent(ev({ kind: 'game_done', result: 'loss' })).title).toBe('Défaite');
    expect(describeEvent(ev({ kind: 'game_done', result: 'victory', mode: 'relay' })).title).toBe('Victoire collective: la BD est terminée');
    expect(describeEvent(ev({ kind: 'game_done', result: 'draw' })).title).toBe('Égalité');
    expect(describeEvent(ev({ kind: 'duel_verdict', result: 'tie', mode: 'duel' })).title).toContain('égalité');
  });
});

describe('états de partie (déduits du serveur)', () => {
  it('recherche, adversaire trouvé, mon tour, tour adverse, terminée', () => {
    expect(matchState(game({ status: 'searching' })).key).toBe('searching');
    expect(matchState(game({ can_play: true, bucket: 'mine', players: [{ seat: 1, nickname: 'a', status: 'playing', cases_done: 0, is_me: true }, { seat: 2, nickname: 'b', status: 'playing', cases_done: 0, is_me: false }] })).key).toBe('found');
    expect(matchState(game({ mode: 'battle', can_play: true, cases_done: 2, turn_is_mine: true })).key).toBe('my_turn');
    expect(matchState(game({ mode: 'battle', can_play: false, cases_done: 2 }))).toEqual({ key: 'their_turn', label: 'Tour de l’adversaire' });
    expect(matchState(game({ status: 'finished' })).key).toBe('done');
    expect(matchState(game({ status: 'cancelled' })).label).toBe('Défi annulé');
    expect(matchState(game({ mode: 'relay', can_play: true, cases_done: 3, reservation_until: '2026-01-01T00:10:00Z' })).label).toBe('Case réservée pour toi');
    expect(matchState(game({ mode: 'duel', my_status: 'done' })).label).toContain('l’adversaire dessine encore');
  });
});

describe('bouton Jouer: ordre de priorité', () => {
  const mine = (id: string, mode: GameView['mode'], over: Partial<GameView> = {}) => game({ id, mode, can_play: true, bucket: 'mine', cases_done: 2, ...over });
  const none = { resumable: false };

  it('Battle, puis Duel, puis Relay, puis Solo, puis nouvelle case Relay, puis choix', () => {
    const all = [mine('r', 'relay'), mine('d', 'duel'), mine('b', 'battle')];
    expect(suggestPlay(all, { resumable: true }, 3)).toMatchObject({ kind: 'game', game: { id: 'b' } });
    expect(suggestPlay(all.slice(0, 2), { resumable: true }, 3)).toMatchObject({ game: { id: 'd' } });
    expect(suggestPlay(all.slice(0, 1), { resumable: true }, 3)).toMatchObject({ game: { id: 'r' } });
    expect(suggestPlay([], { resumable: true }, 3)).toEqual({ kind: 'solo' });
    expect(suggestPlay([], none, 3)).toEqual({ kind: 'relay_new' });
    expect(suggestPlay([], none, 0)).toEqual({ kind: 'choose' });
    expect(suggestPlay(null, none, 0)).toEqual({ kind: 'choose' });
  });

  it('un tour qui expire dans moins d’une heure passe devant, le plus proche d’abord', () => {
    const list = [mine('b', 'battle', { seconds_left: 80_000 }), mine('r', 'relay', { seconds_left: 900, reservation_until: 'x' }), mine('d', 'duel', { seconds_left: 1800 })];
    expect(suggestPlay(list, none, 0)).toMatchObject({ game: { id: 'r' } });
    expect(suggestPlay(list.slice(0, 1), none, 0)).toMatchObject({ game: { id: 'b' } });
  });

  it('une réservation Relay existante passe avant une autre case Relay, et rien ne se lance seul', () => {
    const list = [mine('x', 'relay'), mine('y', 'relay', { reservation_until: 'x' })];
    expect(suggestPlay(list, none, 5)).toMatchObject({ game: { id: 'y' } });
  });

  it('ignore ce qui n’est pas jouable, les parties finies et la partie à exclure', () => {
    const list = [game({ id: 'w', mode: 'battle', can_play: false }), mine('f', 'battle', { status: 'finished' }), mine('e', 'duel')];
    expect(suggestPlay(list, none, 0)).toMatchObject({ game: { id: 'e' } });
    expect(suggestPlay(list, none, 0, 'e')).toEqual({ kind: 'choose' });
  });
});

describe('lignes d’activité de l’accueil', () => {
  const hub = (over: Partial<Hub> = {}) => ({ balance: 0, available: 0, daily_done: 0, daily_limit: 5, rules: {}, active: null, consents: [], submittable: [], mine: [], ...over }) as Hub;
  const activity = (open = { relay: 2, duel: 1, battle: 0 }): Activity => ({ now: 'n', read_until: 'r', unread: 0, events: [], open });

  it('ne donne aucun chiffre sans réponse du serveur', () => {
    const l = activityLines(null, null, null, null, null);
    expect(l.relay.now).toBe('Connexion nécessaire');
    expect(l.arbiter.now).toBe('Connexion nécessaire');
    expect(l.duel.open).toBeNull();
    expect(l.solo.now).toBe('Nouvelle partie');
  });

  it('compte les tours réels et les défis ouverts', () => {
    const games = [game({ id: 'a', mode: 'battle', can_play: true }), game({ id: 'b', mode: 'battle', can_play: true }), game({ id: 'c', mode: 'duel', can_play: true, status: 'finished' })];
    expect(turnsByMode(games)).toEqual({ relay: 0, duel: 0, battle: 2 });
    const l = activityLines(games, activity(), hub({ available: 3, consents: [{ bd_id: 'b', source: 'solo', theme: 't', cases: 4 }] }), { resumable: true, caseNo: 5 }, null);
    expect(l.battle).toEqual({ now: '2 tours à jouer', open: '0 défi ouvert' });
    expect(l.duel.now).toBe('Aucun tour à jouer');
    expect(l.duel.open).toBe('1 défi ouvert');
    expect(l.relay.now).toBe('2 cases à dessiner');
    expect(l.arbiter).toEqual({ now: '3 BD à juger', open: '1 demande à traiter' });
    expect(l.solo.now).toBe('Partie en cours · case 5/16');
    expect(activityLines(games, activity(), hub({ active: { id: 'x', voted: 2, total: 4 } }), null, null).arbiter.now).toBe('Arbitrage à reprendre (2/4)');
  });
});

describe('appels et aides', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: null, error: null });
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('le flux et le repère de lecture ne transportent que ce que le serveur a donné', async () => {
    await fetchActivity();
    await markActivityRead('2026-03-01T10:00:00Z');
    await fetchThumbs(['g1', 'g2']);
    expect(rpcMock.mock.calls).toEqual([
      ['survivor_activity', undefined],
      ['survivor_activity_read', { p_until: '2026-03-01T10:00:00Z' }],
      ['survivor_game_thumbs', { p_games: ['g1', 'g2'] }],
    ]);
  });

  it('une aide vue ne revient pas, et le tutoriel se rejoue après oubli', () => {
    expect(seen('tutorial')).toBe(false);
    markSeen('tutorial');
    expect(seen('tutorial')).toBe(true);
    forget('tutorial');
    expect(seen('tutorial')).toBe(false);
  });

  it('sans stockage, l’aide s’affiche simplement de nouveau', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('refusé'); }, setItem: () => { throw new Error('refusé'); }, removeItem: () => { throw new Error('refusé'); } });
    expect(seen('x')).toBe(false);
    expect(() => markSeen('x')).not.toThrow();
  });
});

describe('migration 0017', () => {
  const sql = readFileSync('supabase/migrations/0017_survivor_activity.sql', 'utf8');
  it('est non destructive et isolée', () => {
    expect(sql).not.toMatch(/drop\s+(table|function|column|constraint)|alter\s+table\s+public\.survivor_(?!activity_reads)|delete\s+from|truncate/i);
  });
  it('couvre exactement les événements que l’interface sait décrire', () => {
    const kinds = [...sql.matchAll(/'(match_found|invite_accepted|turn|game_done|duel_verdict|consent_request|bd_judged|arbitration_done)'/g)].map((m) => m[1]);
    expect(new Set(kinds)).toEqual(new Set(['match_found', 'invite_accepted', 'turn', 'game_done', 'duel_verdict', 'consent_request', 'bd_judged', 'arbitration_done']));
  });
  it('n’expose jamais l’identité d’un arbitre', () => {
    const feed = sql.slice(sql.indexOf('function public.survivor_activity()'), sql.indexOf('function public.survivor_activity_read'));
    expect(feed).not.toMatch(/arbiter_id\s*[,)]\s*(as|from)|a\.arbiter_id,|'arbiter'\s*,\s*a\.arbiter/);
  });
});

describe('rafraîchissement: une requête en échec ne fait pas perdre les autres', () => {
  const ok = <T,>(value: T): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value });
  const ko = (m: string): PromiseRejectedResult => ({ status: 'rejected', reason: new Error(m) });
  const hubV = { balance: 5 } as Hub;
  const act = { now: 'n', read_until: 'r', unread: 2, events: [], open: { relay: 1, duel: 0, battle: 0 } } as Activity;
  const empty: LiveData = { games: null, hub: null, activity: null, rules: null };

  it('conserve les données valides et les anciennes valeurs de ce qui échoue', () => {
    const first = mergeLive(empty, { games: ok([game()]), hub: ok(hubV), activity: ko('activité indisponible'), rules: ok(null) });
    expect(first.next.games).toHaveLength(1);
    expect(first.next.hub).toBe(hubV);
    expect(first.next.activity).toBeNull();
    expect(first.error).toBe('activité indisponible');
    expect(first.allOk).toBe(false);
    // Deuxième passage: les parties échouent, mais celles déjà affichées restent, et l'activité arrive.
    const second = mergeLive(first.next, { games: ko('réseau'), hub: ok(hubV), activity: ok(act), rules: ok(null) });
    expect(second.next.games).toHaveLength(1);
    expect(second.next.activity).toBe(act);
    expect(second.error).toBe('réseau');
  });

  it('tout réussi: aucune erreur; les règles déjà connues ne sont pas écrasées par une absence', () => {
    const rules = { total_cases: 16 } as never;
    const a = mergeLive(empty, { games: ok([]), hub: ok(hubV), activity: ok(act), rules: ok(rules) });
    expect(a).toMatchObject({ error: null, allOk: true });
    const b = mergeLive(a.next, { games: ok([]), hub: ok(hubV), activity: ok(act), rules: ok(null) });
    expect(b.next.rules).toBe(rules);
  });
});
