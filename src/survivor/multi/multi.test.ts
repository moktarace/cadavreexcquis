import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeGame, formatRemaining, inviteLink, tokenFrom, casePath, type GameView, type MpResult } from './types';
import { SQL_BEGIN, SQL_END, survivorSqlData } from './sqlData';
import { stuckNow } from '../game';

const rpcMock = vi.fn();
const uploadMock = vi.fn();
const signedMock = vi.fn();
vi.mock('../../backend/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), storage: { from: (b: string) => ({ upload: (...a: unknown[]) => uploadMock(b, ...a), createSignedUrls: (...a: unknown[]) => signedMock(b, ...a) }) } },
}));
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
  result: null,
  reserve: null,
  capacity: null,
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
    await api.submitCase({ gameId: 'g3', position: 2, submissionId: 'sub', constraintId: '31', imagePath: 'u/g3/sub.png', inkSpent: 4 });
    expect(rpcMock.mock.calls).toEqual([
      ['survivor_matchmake', { p_mode: 'duel' }],
      ['survivor_create_challenge', { p_mode: 'battle', p_visibility: 'invite' }],
      ['survivor_accept_invite', { p_token: 'tok' }],
      ['survivor_cancel', { p_game: 'g1' }],
      ['survivor_abandon', { p_game: 'g2' }],
      ['survivor_submit_case', { p_game: 'g3', p_position: 2, p_submission: 'sub', p_constraint: '31', p_image: 'u/g3/sub.png', p_ink_spent: 4 }],
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

describe('actions de jeu (le serveur calcule récompenses, améliorations et tours)', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    uploadMock.mockReset();
    signedMock.mockReset();
  });

  it('appelle les RPC de jeu; le client n’envoie jamais de récompense', async () => {
    const api = await import('./api');
    rpcMock.mockResolvedValue({ data: { outcome: 'picked', game: view(), state: {} as MpResult['state'] }, error: null });
    await api.fetchState('g');
    await api.pickConstraint('g', '31');
    await api.playJoker('g', 1);
    await api.playEmergency('g', 0);
    await api.chooseUpgrade('g', 'joker');
    await api.setDemands('g', ['16', '31', '11']);
    await api.declareStuck('g');
    expect(rpcMock.mock.calls).toEqual([
      ['survivor_state', { p_game: 'g' }],
      ['survivor_pick', { p_game: 'g', p_constraint: '31' }],
      ['survivor_joker', { p_game: 'g', p_uses: 1 }],
      ['survivor_use_emergency', { p_game: 'g', p_uses: 0 }],
      ['survivor_choose_upgrade', { p_game: 'g', p_upgrade: 'joker' }],
      ['survivor_set_demands', { p_game: 'g', p_ids: ['16', '31', '11'] }],
      ['survivor_declare_stuck', { p_game: 'g' }],
    ]);
    const sent = JSON.stringify(rpcMock.mock.calls);
    expect(sent).not.toMatch(/reward|p_ink_reward/);
  });

  it('traduit les erreurs de jeu', async () => {
    const api = await import('./api');
    rpcMock.mockResolvedValue({ data: null, error: { message: 'STALE_POSITION' } });
    await expect(api.submitCase({ gameId: 'g', position: 1, submissionId: 's', constraintId: '11', imagePath: 'p', inkSpent: 0 })).rejects.toMatchObject({ code: 'STALE_POSITION' });
    rpcMock.mockResolvedValue({ data: null, error: { message: 'RATE_LIMITED' } });
    await expect(api.fetchState('g')).rejects.toMatchObject({ message: expect.stringMatching(/Trop d’actions/) });
  });

  it('envoie le PNG dans le bucket privé, sous le dossier du joueur; une relance n’est pas une erreur', async () => {
    const api = await import('./api');
    uploadMock.mockResolvedValue({ error: null });
    const path = await api.uploadCaseImage('game', 'sub', new Uint8Array([1]));
    expect(path).toBe('u/game/sub.png');
    expect(uploadMock).toHaveBeenCalledWith('survivor', 'u/game/sub.png', expect.any(Uint8Array), { contentType: 'image/png', upsert: false });
    uploadMock.mockResolvedValue({ error: { message: 'The resource already exists' } });
    await expect(api.uploadCaseImage('game', 'sub', new Uint8Array([1]))).resolves.toBe('u/game/sub.png');
    uploadMock.mockResolvedValue({ error: { message: 'TypeError: Failed to fetch' } });
    await expect(api.uploadCaseImage('game', 'sub', new Uint8Array([1]))).rejects.toMatchObject({ message: 'Pas de connexion au serveur.' });
  });

  it('demande des adresses signées pour les seuls chemins fournis', async () => {
    const api = await import('./api');
    signedMock.mockResolvedValue({ data: [{ path: 'a', signedUrl: 'https://x/a' }, { path: 'b', signedUrl: null }], error: null });
    expect(await api.signedUrls(['a', 'b'])).toEqual({ a: 'https://x/a' });
    expect(await api.signedUrls([])).toEqual({});
  });
});

describe('cohérence SQL ↔ TypeScript', () => {
  const migration = readFileSync(new URL('../../../supabase/migrations/0014_survivor_gameplay.sql', import.meta.url), 'utf8');

  it('le bloc de règles de la migration est celui généré depuis la configuration (npx vite-node scripts/survivor-sql.ts)', () => {
    const start = migration.indexOf(SQL_BEGIN);
    const end = migration.indexOf(SQL_END) + SQL_END.length;
    expect(start).toBeGreaterThan(-1);
    expect(migration.slice(start, end)).toBe(survivorSqlData());
  });

  it('le chemin d’image envoyé respecte la politique de stockage SQL', () => {
    const rx = /name !~ '(\^\[0-9a-f-\]\{36\}[^']+)'/.exec(migration);
    expect(rx).not.toBeNull();
    const re = new RegExp(rx![1].replace(/\\\./g, '\\.'));
    const id = () => crypto.randomUUID();
    expect(re.test(casePath(id(), id(), id()))).toBe(true);
    expect(re.test('x/y/z.png')).toBe(false);
  });

  it('la panne d’encre se déclare comme en Solo (même fonction)', () => {
    const base = { inkLeft: 0, freeMimoLeft: false, emergency: 0, terminable: false };
    expect(stuckNow(base)).toBe(true);
    expect(stuckNow({ ...base, inkLeft: 5 })).toBe(false);
    expect(stuckNow({ ...base, freeMimoLeft: true })).toBe(false);
    expect(stuckNow({ ...base, emergency: 1 })).toBe(false);
    expect(stuckNow({ ...base, terminable: true })).toBe(false);
  });
});

describe('issues affichées', () => {
  it('Battle et Relay terminés', () => {
    expect(describeGame(view({ status: 'finished', mode: 'relay', result: 'victory' }))).toMatch(/Victoire collective/);
    expect(describeGame(view({ status: 'finished', mode: 'relay', result: 'defeat' }))).toMatch(/Défaite/);
    expect(describeGame(view({ status: 'finished', mode: 'battle', result: 'draw' }))).toMatch(/Égalité provisoire/);
    expect(describeGame(view({ status: 'finished', mode: 'battle', result: 'win' }))).toMatch(/Victoire/);
    expect(describeGame(view({ status: 'finished', mode: 'duel', result: 'completed' }))).toBe('Terminée');
  });
});

