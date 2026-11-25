import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ICONS } from '../../ui/sprites';
import { BD_STATUS_LABELS, REASON_LABELS, SOURCE_LABELS } from './types';

const rpcMock = vi.fn();
const uploadMock = vi.fn();
vi.mock('../../backend/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), storage: { from: (b: string) => ({ upload: (...a: unknown[]) => uploadMock(b, ...a) }) } },
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
  ensureSession: async () => ({ userId: 'u1', isAnonymous: true, email: null }),
}));
vi.mock('../../editor/export', () => ({ previewPng: async () => new Uint8Array([137, 80, 78, 71]) }));

const pixels = () => new Uint8Array(320 * 240);

describe('appels d’arbitrage', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    uploadMock.mockReset();
    rpcMock.mockResolvedValue({ data: {}, error: null });
    uploadMock.mockResolvedValue({ error: null });
  });

  it('appelle les RPC d’arbitrage; le client n’envoie jamais un montant d’encre', async () => {
    const api = await import('./api');
    await api.fetchHub();
    await api.fetchWallet();
    await api.arbitrateNext();
    await api.currentArbitration();
    await api.castVote('a', 'c', 'up');
    await api.castVote('a', 'c', null);
    await api.finishArbitration('a');
    await api.abandonArbitration('a');
    await api.flagArbitration('a', 2, 'inappropriate');
    await api.submitGameBd('g');
    await api.answerConsent('b', false);
    await api.duelVerdict('g');
    expect(rpcMock.mock.calls).toEqual([
      ['survivor_hub', undefined],
      ['survivor_wallet', undefined],
      ['survivor_arbitrate_next', undefined],
      ['survivor_arbitration_current', undefined],
      ['survivor_vote', { p_arb: 'a', p_case: 'c', p_vote: 'up' }],
      ['survivor_vote', { p_arb: 'a', p_case: 'c', p_vote: null }],
      ['survivor_arbitration_finish', { p_arb: 'a' }],
      ['survivor_arbitration_abandon', { p_arb: 'a' }],
      ['survivor_arbitration_flag', { p_arb: 'a', p_slot: 2, p_category: 'inappropriate' }],
      ['survivor_submit_game_bd', { p_game: 'g' }],
      ['survivor_consent', { p_bd: 'b', p_accept: false }],
      ['survivor_duel_verdict', { p_game: 'g' }],
    ]);
    expect(JSON.stringify(rpcMock.mock.calls)).not.toMatch(/reward|amount|balance|ink/);
  });

  it('traduit les erreurs d’arbitrage', async () => {
    const api = await import('./api');
    for (const [code, text] of [['DAILY_LIMIT', /limite d’arbitrages/], ['OWN_CASE', /propres créations/], ['INCOMPLETE', /cases à juger/], ['CONSENT_FINAL', /définitive/]] as const) {
      rpcMock.mockResolvedValue({ data: null, error: { message: code } });
      await expect(api.arbitrateNext()).rejects.toMatchObject({ code, message: expect.stringMatching(text) });
    }
  });

  it('soumet une BD Solo: brouillon, images sous <joueur>/<bd>/<uuid>.png, puis les cases et la déclaration du client', async () => {
    const api = await import('./api');
    const up = api.newSoloUpload();
    await api.submitSolo(up, [pixels(), pixels(), pixels(), pixels()], ['16', '31', '11', '21'], 'Thème', { outcome: 'defeat' });
    expect(rpcMock.mock.calls[0]).toEqual(['survivor_solo_begin', { p_bd: up.bd, p_theme: 'Thème' }]);
    expect(uploadMock).toHaveBeenCalledTimes(4);
    const re = new RegExp(`^u1/${up.bd}/[0-9a-f-]{36}\\.png$`);
    for (const c of uploadMock.mock.calls) expect(c[1]).toMatch(re);
    const [name, args] = rpcMock.mock.calls[1];
    expect(name).toBe('survivor_solo_submit');
    expect(args.p_cases.map((c: { position: number; constraint_id: string }) => [c.position, c.constraint_id])).toEqual([[1, '16'], [2, '31'], [3, '11'], [4, '21']]);
    expect(args.p_claimed).toEqual({ outcome: 'defeat' });
  });

  it('une relance reprend où l’envoi s’est arrêté, sans recréer le brouillon ni renvoyer les images', async () => {
    const api = await import('./api');
    const up = api.newSoloUpload();
    uploadMock.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: null }).mockResolvedValue({ error: { message: 'Failed to fetch' } });
    await expect(api.submitSolo(up, [pixels(), pixels(), pixels(), pixels()], ['16', '31', '11', '21'], 'T', {})).rejects.toMatchObject({ message: 'Pas de connexion au serveur.' });
    expect(up.uploaded).toHaveLength(2);
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({ error: null });
    rpcMock.mockClear();
    await api.submitSolo(up, [pixels(), pixels(), pixels(), pixels()], ['16', '31', '11', '21'], 'T', {});
    expect(uploadMock).toHaveBeenCalledTimes(2);
    expect(rpcMock.mock.calls.map((c) => c[0])).toEqual(['survivor_solo_submit']);
  });

  it('refuse sans réseau une BD de moins de quatre cases', async () => {
    const api = await import('./api');
    await expect(api.submitSolo(api.newSoloUpload(), [pixels()], ['16'], 'T', {})).rejects.toMatchObject({ code: 'TOO_SHORT' });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('présentation', () => {
  it('icônes de pouce levé et baissé dans le style des autres icônes (12 × 12)', () => {
    for (const name of ['thumbUp', 'thumbDown'] as const) {
      expect(ICONS[name].h).toBe(12);
      expect(ICONS[name].rows.every((r) => r.length === 12)).toBe(true);
    }
    expect(ICONS.thumbDown.rows.filter((r) => r.trim() !== '.'.repeat(12))).toEqual([...ICONS.thumbUp.rows.filter((r) => r.trim() !== '.'.repeat(12))].reverse());
  });

  it('libellés pour chaque source, état et raison', () => {
    expect(Object.keys(SOURCE_LABELS).sort()).toEqual(['battle', 'duel', 'relay', 'solo']);
    expect(Object.keys(BD_STATUS_LABELS)).toHaveLength(4);
    expect(Object.keys(REASON_LABELS).sort()).toEqual(['arbiter_complete', 'arbiter_vote', 'purchase', 'vote_received']);
  });
});

describe('cohérence avec la migration d’arbitrage', () => {
  const sql = readFileSync(new URL('../../../supabase/migrations/0015_survivor_arbiter.sql', import.meta.url), 'utf8');

  it('les montants et limites provisoires sont ceux de la spécification, définis une seule fois côté serveur', () => {
    const rules = /survivor_arbitration_rules\(\)[\s\S]*?\$\$;/.exec(sql)![0];
    for (const frag of ["'min_cases', 4", "'max_arbitrations', 3", "'duel_arbitrations', 3", "'daily_limit', 5", "'vote_given', 2", "'upvote_received', 5", "'complete_bonus', 10"]) {
      expect(rules).toContain(frag);
    }
    // Aucune récompense chiffrée ailleurs que dans cette fonction.
    expect(sql.replace(rules, '')).not.toMatch(/amount\s*[:=]\s*\d|values \([^)]*, (2|5|10),/);
  });

  it('le client ne peut ni écrire dans le registre ni lire les tables d’arbitrage', () => {
    expect(sql).toMatch(/revoke all on public\.survivor_bd_groups[\s\S]*public\.survivor_wallets from anon, authenticated/);
    expect(sql).toContain('grant select on public.survivor_ink_ledger, public.survivor_wallets to authenticated');
    expect(sql).not.toMatch(/create policy [^;]*on public\.survivor_(bds|bd_cases|votes|arbitrations|consents|flags)\b/);
  });
});
