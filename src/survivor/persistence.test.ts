import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SurvivorGame } from './game';
import { SAVE_MESSAGES, beginRun, loadRun, persistRun, readRun } from './storage';
import { SAVE_BEFORE_BUY, soloPurchase } from './shop/solo';

vi.mock('../backend/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
const { ApiError } = await import('../backend/api');

function seeded(seed = 1) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 2 ** 32;
  };
}

/** localStorage simulé dont on peut casser l'écriture ou la lecture. */
const store = new Map<string, string>();
const mode = { write: 'ok' as 'ok' | 'quota' | 'blocked' | 'drop', read: 'ok' as 'ok' | 'blocked' };
beforeEach(() => {
  store.clear();
  mode.write = 'ok';
  mode.read = 'ok';
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => {
      if (mode.read === 'blocked') throw new DOMException('refusé', 'SecurityError');
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (mode.write === 'quota') throw new DOMException('plein', 'QuotaExceededError');
      if (mode.write === 'blocked') throw new DOMException('refusé', 'SecurityError');
      if (mode.write === 'drop') return;
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

const rawSave = () => [...store.values()][0];

describe('persistance Solo: échecs d’écriture', () => {
  it('stockage plein: échec explicite, dernière sauvegarde valide intacte', () => {
    const g = SurvivorGame.start(seeded(3));
    expect(persistRun(g)).toEqual({ ok: true });
    const before = rawSave();
    g.state.reserve = 12;
    mode.write = 'quota';
    expect(persistRun(g)).toEqual({ ok: false, reason: 'quota' });
    expect(rawSave()).toBe(before);
    expect(loadRun()!.state.reserve).not.toBe(12);
  });

  it('stockage bloqué: raison distincte', () => {
    mode.write = 'blocked';
    expect(persistRun(SurvivorGame.start(seeded(3)))).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('écriture acceptée mais non conservée: jamais confirmée', () => {
    mode.write = 'drop';
    expect(persistRun(SurvivorGame.start(seeded(3)))).toEqual({ ok: false, reason: 'error' });
  });

  it('chaque échec a un message compréhensible qui dit que rien n’est enregistré', () => {
    for (const m of Object.values(SAVE_MESSAGES)) expect(m).toMatch(/n’est pas enregistrée/);
  });
});

describe('persistance Solo: lecture', () => {
  it('distingue aucune sauvegarde, sauvegarde lisible et sauvegarde illisible', () => {
    expect(readRun()).toEqual({ kind: 'none' });
    persistRun(SurvivorGame.start(seeded(3)));
    expect(readRun().kind).toBe('ok');
    mode.read = 'blocked';
    expect(readRun()).toEqual({ kind: 'unreadable', reason: 'unavailable' });
    expect(loadRun()).toBeNull();
  });

  it('données endommagées: signalées, jamais effacées ni prises pour une absence', () => {
    store.set('cl.survivor.v1', '{pas du json');
    expect(readRun()).toEqual({ kind: 'unreadable', reason: 'corrupt' });
    expect(store.get('cl.survivor.v1')).toBe('{pas du json');
    store.set('cl.survivor.v1', JSON.stringify({ state: { version: 9 }, cases: [] }));
    expect(readRun()).toEqual({ kind: 'unreadable', reason: 'corrupt' });
  });
});

describe('nouvelle partie', () => {
  it('ne remplace jamais une partie en cours si la nouvelle ne peut pas être écrite', () => {
    const old = SurvivorGame.start(seeded(3));
    persistRun(old);
    const before = rawSave();
    mode.write = 'quota';
    expect(beginRun(old, seeded(4))).toEqual({ started: false, reason: 'quota' });
    expect(rawSave()).toBe(before);
    expect(loadRun()!.gameId).toBe(old.gameId);
  });

  it('démarre quand rien n’est à protéger (aucune partie, ou partie terminée), en prévenant', () => {
    mode.write = 'blocked';
    const fresh = beginRun(null, seeded(4));
    expect(fresh).toMatchObject({ started: true, save: { ok: false, reason: 'unavailable' } });
    const done = SurvivorGame.start(seeded(5));
    done.state.phase = 'finished';
    expect(beginRun(done, seeded(4)).started).toBe(true);
  });

  it('remplace l’ancienne partie quand l’écriture réussit', () => {
    const old = SurvivorGame.start(seeded(3));
    persistRun(old);
    const r = beginRun(old, seeded(4));
    expect(r).toMatchObject({ started: true, save: { ok: true } });
    if (r.started) expect(loadRun()!.gameId).toBe(r.game.gameId);
  });
});

describe('achat Solo et sauvegarde', () => {
  const setup = () => {
    const g = SurvivorGame.start(seeded(3));
    g.state.reserve = 30;
    persistRun(g);
    return g;
  };
  const persist = (g: SurvivorGame) => persistRun(g).ok;

  it('sans trace durable de l’achat, aucun débit n’est demandé', async () => {
    const g = setup();
    mode.write = 'quota';
    const buy = vi.fn();
    await expect(soloPurchase(g, 'refill', 'p1', { persist, buy })).rejects.toMatchObject({ code: 'SAVE', message: SAVE_BEFORE_BUY });
    expect(buy).not.toHaveBeenCalled();
    expect(g.shop.pending).toBeNull();
    expect(g.state.reserve).toBe(30);
  });

  it('l’achat en cours et l’identifiant de partie sont écrits avant le débit', async () => {
    const g = setup();
    let seenAtDebit: unknown = null;
    await soloPurchase(g, 'refill', 'p1', {
      persist,
      buy: async () => {
        const saved = JSON.parse(rawSave());
        seenAtDebit = { pending: saved.state.shop.pending, gameId: saved.state.gameId };
        return { purchase: 'p1', effect: 20 };
      },
    });
    expect(seenAtDebit).toEqual({ pending: { id: 'p1', item: 'refill' }, gameId: g.gameId });
    expect(g.state.reserve).toBe(50);
    expect(g.shop.pending).toBeNull();
  });

  it('erreur réseau: l’achat reste en cours, la relance garde le même identifiant, effet appliqué une seule fois', async () => {
    const g = setup();
    const net = new ApiError('SERVER', 'Pas de connexion au serveur.');
    await expect(soloPurchase(g, 'refill', 'p1', { persist, buy: async () => Promise.reject(net) })).rejects.toBe(net);
    expect(g.shop.pending).toEqual({ id: 'p1', item: 'refill' });
    expect(g.state.reserve).toBe(30);
    const buy = vi.fn(async () => ({ purchase: 'p1', effect: 20 }));
    await soloPurchase(g, 'refill', 'p1', { persist, buy });
    await soloPurchase(g, 'refill', 'p1', { persist, buy });
    expect(g.state.reserve).toBe(50);
    expect(g.shop.applied).toEqual(['p1']);
  });

  it('refus définitif du serveur: l’attente est libérée et enregistrée', async () => {
    const g = setup();
    await expect(soloPurchase(g, 'refill', 'p1', { persist, buy: async () => Promise.reject(new ApiError('INSUFFICIENT_FUNDS', 'non')) })).rejects.toBeInstanceOf(ApiError);
    expect(g.shop.pending).toBeNull();
    expect(JSON.parse(rawSave()).state.shop.pending).toBeNull();
  });

  it('débit confirmé mais sauvegarde échouée puis application fermée: le reçu se retrouve et s’applique une seule fois', async () => {
    const g = setup();
    await soloPurchase(g, 'refill', 'p1', {
      persist,
      buy: async () => {
        mode.write = 'quota'; // l'écriture qui suit le débit échoue
        return { purchase: 'p1', effect: 20 };
      },
    });
    expect(g.state.reserve).toBe(50); // en mémoire seulement
    // Fermeture puis rechargement: la sauvegarde durable est celle d'avant le reçu, avec l'achat en cours.
    mode.write = 'ok';
    const back = loadRun()!;
    expect(back.shop.pending).toEqual({ id: 'p1', item: 'refill' });
    expect(back.state.reserve).toBe(30);
    // survivor_buy_check renvoie le reçu: appliqué, puis rejoué sans effet.
    expect(back.applyPurchase({ purchase: 'p1', item: 'refill', effect: 20 })).toBe(true);
    expect(back.applyPurchase({ purchase: 'p1', item: 'refill', effect: 20 })).toBe(false);
    expect(back.state.reserve).toBe(50);
    expect(back.shop.pending).toBeNull();
  });

  it('aucune case en cours n’est jamais écrite: seules les cases terminées et les décisions le sont', () => {
    setup();
    const raw = rawSave();
    expect(raw).not.toMatch(/pixels|draft|brouillon/i);
    expect(JSON.parse(raw).cases).toEqual([]);
  });
});
