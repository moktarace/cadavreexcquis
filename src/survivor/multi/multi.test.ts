import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeGame, formatRemaining, inviteLink, tokenFrom, type GameView } from './types';

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

const view = (over: Partial<GameView> = {}): GameView => ({
  id: 'g',
  mode: 'duel',
  status: 'active',
  visibility: 'open',
  theme: 'Thème',
  total_cases: 16,
  cases_done: 0,
  created_at: '2026-01-01T00:00:00Z',
  deadline_at: null,
  ended_reason: null,
  seconds_left: null,
  bucket: 'mine',
  can_play: true,
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

describe('délais', () => {
  it('formate le temps restant, arrondi vers le bas, jamais négatif', () => {
    expect(formatRemaining(72 * 3600)).toBe('3 j 0 h');
    expect(formatRemaining(2 * 86400 + 3 * 3600 + 59)).toBe('2 j 3 h');
    expect(formatRemaining(23 * 3600 + 10 * 60)).toBe('23 h 10 min');
    expect(formatRemaining(14 * 60 + 59)).toBe('14 min');
    expect(formatRemaining(30)).toBe('moins d’une minute');
    expect(formatRemaining(-5)).toBe('moins d’une minute');
  });
});

describe('états affichés (calculés par le serveur, seulement traduits ici)', () => {
  it('Duel', () => {
    expect(describeGame(view({ status: 'searching' }))).toMatch(/tu peux déjà commencer/);
    expect(describeGame(view({ status: 'searching', can_play: false }))).toBe('En attente d’un adversaire');
    expect(describeGame(view())).toBe('À toi de dessiner');
    expect(describeGame(view({ my_status: 'done', bucket: 'waiting' }))).toMatch(/l’adversaire dessine encore/);
  });
  it('Battle', () => {
    expect(describeGame(view({ mode: 'battle', turn_is_mine: true }))).toBe('À toi de jouer');
    expect(describeGame(view({ mode: 'battle' }))).toBe('Tour de l’adversaire');
  });
  it('Relay', () => {
    expect(describeGame(view({ mode: 'relay', reservation_until: '2026-01-01T00:15:00Z' }))).toBe('Case réservée pour toi');
    expect(describeGame(view({ mode: 'relay' }))).toBe('Case disponible');
    expect(describeGame(view({ mode: 'relay', can_play: false }))).toBe('En attente du prochain relais');
  });
  it('fins de partie', () => {
    expect(describeGame(view({ status: 'finished' }))).toBe('Terminée');
    expect(describeGame(view({ status: 'cancelled' }))).toBe('Défi annulé');
    expect(describeGame(view({ status: 'abandoned', ended_reason: 'expired' }))).toMatch(/Délai dépassé/);
    expect(describeGame(view({ status: 'abandoned', ended_reason: 'forfeit', forfeit_by_me: true }))).toMatch(/par toi/);
    expect(describeGame(view({ status: 'abandoned', ended_reason: 'forfeit' }))).toBe('Forfait de l’adversaire');
  });
});

describe('invitations', () => {
  const token = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
  it('construit un lien qui ne contient que le jeton opaque', () => {
    expect(inviteLink(token, 'https://x.test/app/')).toBe(`https://x.test/app/#/lab/survivor/invite/${token}`);
  });
  it('extrait le jeton d’un lien ou d’un code collé', () => {
    expect(tokenFrom(`https://x.test/app/#/lab/survivor/invite/${token}`)).toBe(token);
    expect(tokenFrom(`  ${token.toUpperCase()} `)).toBe(token);
    expect(tokenFrom('trop court')).toBeNull();
    expect(tokenFrom('')).toBeNull();
  });
});

describe('appels au serveur', () => {
  beforeEach(() => rpcMock.mockReset());

  it('appelle les RPC survivor_* avec les bons paramètres', async () => {
    const api = await import('./api');
    rpcMock.mockResolvedValue({ data: { outcome: 'created', game: view() }, error: null });
    await api.matchmake('duel');
    await api.createChallenge('battle', 'invite');
    await api.acceptInvite('tok');
    await api.cancelChallenge('g1');
    await api.abandonGame('g2');
    await api.submitCase({ gameId: 'g3', constraintId: '31', imagePath: 'u/1.png', inkSpent: 4, inkReward: 20 });
    expect(rpcMock.mock.calls).toEqual([
      ['survivor_matchmake', { p_mode: 'duel' }],
      ['survivor_create_challenge', { p_mode: 'battle', p_visibility: 'invite' }],
      ['survivor_accept_invite', { p_token: 'tok' }],
      ['survivor_cancel', { p_game: 'g1' }],
      ['survivor_abandon', { p_game: 'g2' }],
      ['survivor_submit_case', { p_game: 'g3', p_constraint: '31', p_image: 'u/1.png', p_ink_spent: 4, p_ink_reward: 20 }],
    ]);
  });

  it('traduit les erreurs du serveur et ne simule jamais un résultat', async () => {
    const api = await import('./api');
    rpcMock.mockResolvedValue({ data: null, error: { message: 'DUEL_LIMIT' } });
    await expect(api.matchmake('duel')).rejects.toMatchObject({ code: 'DUEL_LIMIT', message: expect.stringMatching(/trop de Duels/) });
    rpcMock.mockResolvedValue({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    await expect(api.myGames()).rejects.toMatchObject({ message: 'Pas de connexion au serveur.' });
    rpcMock.mockResolvedValue({ data: null, error: { message: 'INVITE_TAKEN' } });
    await expect(api.acceptInvite('t')).rejects.toMatchObject({ code: 'INVITE_TAKEN' });
  });

  it('liste vide quand le serveur ne renvoie rien', async () => {
    const api = await import('./api');
    rpcMock.mockResolvedValue({ data: null, error: null });
    expect(await api.myGames()).toEqual([]);
  });
});
