import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURVIVOR } from '../config';
import { SurvivorGame, type PurchaseReceipt } from '../game';
import { ITEM_USED, REASON_LABELS, historyLabel, signed } from '../arbiter/types';
import { loadRun, saveRun } from '../storage';
import { offerUpgrades } from '../upgrades';
import { ITEMS } from './ShopOffer';
import { buyItem, checkPurchase, fetchShop } from './api';

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

function seeded(seed = 1) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 2 ** 32;
  };
}
const receipt = (id: string, item: PurchaseReceipt['item'], effect: number | null = null): PurchaseReceipt => ({ purchase: id, item, effect });

describe('consommables Solo: application locale d’un reçu du serveur', () => {
  it('Recharge: ajoute l’effet du serveur sans dépasser la capacité, une seule fois par reçu', () => {
    const g = SurvivorGame.start(seeded(3));
    g.state.reserve = 30;
    expect(g.applyPurchase(receipt('p1', 'refill', 20))).toBe(true);
    expect(g.state.reserve).toBe(50);
    expect(g.applyPurchase(receipt('p1', 'refill', 20))).toBe(false);
    expect(g.state.reserve).toBe(50);
    const h = SurvivorGame.start(seeded(3));
    h.state.reserve = g.capacity - 5;
    h.applyPurchase(receipt('p2', 'refill', 20));
    expect(h.state.reserve).toBe(h.capacity);
  });

  it('Recharge: pas d’intérêt quand la jauge est presque pleine, ni une fois achetée', () => {
    const g = SurvivorGame.start(seeded(3));
    g.state.reserve = g.capacity - 5;
    expect(g.canUse('refill')).toBe(false);
    g.state.reserve = g.capacity - 20;
    expect(g.canUse('refill')).toBe(true);
    g.applyPurchase(receipt('p1', 'refill', 20));
    g.state.reserve = 10;
    expect(g.canUse('refill')).toBe(false);
  });

  it('Joker payant: nouvelles demandes, charges de Joker acquises intactes', () => {
    const g = SurvivorGame.start(seeded(5));
    g.state.jokers = 2;
    const before = [...g.state.proposals];
    g.applyPurchase(receipt('p1', 'constraint_reroll'));
    expect(g.state.jokers).toBe(2);
    expect(g.state.proposals).toHaveLength(before.length);
    expect(g.state.proposals).not.toEqual(before);
    g.state.phase = 'drawing';
    expect(g.canUse('constraint_reroll')).toBe(false);
  });

  it('Second choix: remplace les trois propositions, sans en ajouter, et ne reprend aucune déjà vue', () => {
    const g = SurvivorGame.start(seeded(7));
    g.state.phase = 'upgrade';
    g.state.offer = offerUpgrades({}, seeded(2));
    const seen = [...g.state.offer];
    expect(g.canUse('upgrade_reroll')).toBe(true);
    g.applyPurchase(receipt('p1', 'upgrade_reroll'));
    expect(g.state.offer).toHaveLength(SURVIVOR.offerSize);
    for (const id of g.state.offer) expect(seen).not.toContain(id);
    expect(g.canUse('upgrade_reroll')).toBe(false);
  });

  it('Second choix: ne propose jamais plus de choix qu’avant (pool trop petit => offre inchangée)', () => {
    const g = SurvivorGame.start(seeded(7));
    const all = offerUpgrades({}, seeded(1), 99);
    const owned = Object.fromEntries(all.slice(0, all.length - SURVIVOR.offerSize - 1).map((id) => [id, 99]));
    g.state.phase = 'upgrade';
    g.state.upgrades = owned;
    g.state.offer = offerUpgrades(owned, seeded(1));
    const before = [...g.state.offer];
    expect(g.canUse('upgrade_reroll')).toBe(false);
    g.applyPurchase(receipt('p1', 'upgrade_reroll'));
    expect(g.state.offer.length).toBeLessThanOrEqual(before.length);
  });

  it('Dernière chance: ajoute l’encre en dessinant, une fois, et pas si le souffle gratuit reste', () => {
    const g = SurvivorGame.start(seeded(3));
    g.state.phase = 'drawing';
    g.state.reserve = 4;
    expect(g.canUse('emergency_refill')).toBe(true);
    g.applyPurchase(receipt('p1', 'emergency_refill', 25));
    expect(g.state.reserve).toBe(29);
    expect(g.canUse('emergency_refill')).toBe(false);
    const h = SurvivorGame.start(seeded(3));
    h.state.phase = 'drawing';
    h.state.emergency = 1;
    expect(h.canUse('emergency_refill')).toBe(false);
  });

  it('chaque consommable une seule fois par partie, côté client aussi', () => {
    const g = SurvivorGame.start(seeded(3));
    g.applyPurchase(receipt('p1', 'refill', 20));
    expect(g.shop.bought).toEqual(['refill']);
    expect(g.shop.applied).toEqual(['p1']);
  });

  it('un achat en cours survit au rechargement et son reçu s’applique une seule fois', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      const g = SurvivorGame.start(seeded(3));
      g.state.reserve = 30;
      g.beginPurchase('p1', 'refill');
      saveRun(g);
      const back = loadRun()!;
      expect(back.gameId).toBe(g.gameId);
      expect(back.shop.pending).toEqual({ id: 'p1', item: 'refill' });
      // La réponse du serveur s'était perdue: le reçu est retrouvé puis appliqué, même deux fois.
      back.applyPurchase(receipt('p1', 'refill', 20));
      back.applyPurchase(receipt('p1', 'refill', 20));
      expect(back.state.reserve).toBe(50);
      expect(back.shop.pending).toBeNull();
      saveRun(back);
      expect(loadRun()!.shop.applied).toEqual(['p1']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('un achat abandonné (refus définitif) libère l’attente sans rien appliquer', () => {
    const g = SurvivorGame.start(seeded(3));
    g.state.reserve = 30;
    g.beginPurchase('p1', 'refill');
    g.clearPending();
    expect(g.shop.pending).toBeNull();
    expect(g.state.reserve).toBe(30);
    expect(g.shop.bought).toEqual([]);
  });

  it('une ancienne sauvegarde reçoit un identifiant de partie stable et un état d’achats vide', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      const g = SurvivorGame.start(seeded(3));
      saveRun(g);
      const key = [...store.keys()][0];
      const saved = JSON.parse(store.get(key)!);
      delete saved.state.gameId;
      delete saved.state.shop;
      store.set(key, JSON.stringify(saved));
      const a = loadRun()!;
      expect(a.state.gameId).toMatch(/^[0-9a-f-]{36}$/);
      expect(a.shop).toEqual({ applied: [], bought: [], pending: null });
      expect(loadRun()!.gameId).toBe(a.gameId);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('une nouvelle partie a son propre identifiant', () => {
    expect(SurvivorGame.start(seeded(1)).gameId).not.toBe(SurvivorGame.start(seeded(1)).gameId);
  });
});

describe('offerUpgrades: exclusions', () => {
  it('exclut les propositions déjà vues', () => {
    const first = offerUpgrades({}, seeded(4));
    const second = offerUpgrades({}, seeded(9), SURVIVOR.offerSize, first);
    expect(second).toHaveLength(SURVIVOR.offerSize);
    for (const id of second) expect(first).not.toContain(id);
  });
});

describe('appels d’achat', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: {}, error: null });
  });
  afterEach(() => rpcMock.mockReset());

  it('n’envoient que partie, consommable et identifiant d’achat: ni prix, ni effet, ni solde', async () => {
    await buyItem('solo', 'game-1', 'refill', 'purchase-1');
    await buyItem('game', 'game-2', 'emergency_refill', 'purchase-2');
    await checkPurchase('solo', 'game-1', 'purchase-1');
    await fetchShop('game', 'game-2');
    expect(rpcMock.mock.calls).toEqual([
      ['survivor_buy', { p_scope: 'solo', p_game: 'game-1', p_item: 'refill', p_purchase: 'purchase-1' }],
      ['survivor_buy', { p_scope: 'game', p_game: 'game-2', p_item: 'emergency_refill', p_purchase: 'purchase-2' }],
      ['survivor_buy_check', { p_scope: 'solo', p_game: 'game-1', p_purchase: 'purchase-1' }],
      ['survivor_shop', { p_scope: 'game', p_game: 'game-2' }],
    ]);
    expect(JSON.stringify(rpcMock.mock.calls)).not.toMatch(/price|effect|amount|balance|reward/);
  });

  it('un refus du serveur garde son code (solde insuffisant, limite…)', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'INSUFFICIENT_FUNDS' } });
    await expect(buyItem('solo', 'g', 'refill', 'p')).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    rpcMock.mockResolvedValue({ data: null, error: { message: 'PURCHASE_LIMIT' } });
    await expect(buyItem('solo', 'g', 'refill', 'p')).rejects.toMatchObject({ code: 'PURCHASE_LIMIT' });
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });
    await expect(buyItem('solo', 'g', 'refill', 'p')).rejects.toMatchObject({ code: 'SERVER' });
  });
});

describe('catalogue et migration 0016', () => {
  const sql = readFileSync('supabase/migrations/0016_survivor_shop.sql', 'utf8');
  const rules = sql.slice(sql.indexOf('survivor_shop_rules()'), sql.indexOf('$$;'));

  it('les consommables de l’interface sont exactement ceux du serveur', () => {
    const keys = [...rules.matchAll(/'(\w+)',\s+jsonb_build_object\('price'/g)].map((m) => m[1]).sort();
    expect(keys).toEqual(Object.keys(ITEMS).sort());
    expect(Object.keys(ITEM_USED).sort()).toEqual(keys);
  });

  it('prix et effets spécifiés, Solo et Relay seulement', () => {
    expect(rules).toMatch(/'refill',\s+jsonb_build_object\('price', 40, 'effect', 20/);
    expect(rules).toMatch(/'constraint_reroll', jsonb_build_object\('price', 30/);
    expect(rules).toMatch(/'upgrade_reroll',\s+jsonb_build_object\('price', 25/);
    expect(rules).toMatch(/'emergency_refill', jsonb_build_object\('price', 60, 'effect', 25/);
    expect(rules).toMatch(/'solo', jsonb_build_object\('max_purchases', 2\), 'relay', jsonb_build_object\('max_purchases', 3\)/);
    expect(rules).not.toMatch(/'(duel|battle)'/);
    expect(rules).toMatch(/'per_type_per_game', 1/);
  });
});

describe('historique du portefeuille', () => {
  it('distingue gains et dépenses, par consommable', () => {
    expect(signed(10)).toBe('+10');
    expect(signed(-40)).toBe('−40');
    expect(historyLabel({ amount: -40, reason: 'purchase', item: 'refill', at: '' })).toBe('Recharge utilisée');
    expect(historyLabel({ amount: -30, reason: 'purchase', item: 'constraint_reroll', at: '' })).toBe('Joker utilisé');
    expect(historyLabel({ amount: -25, reason: 'purchase', item: null, at: '' })).toBe(REASON_LABELS.purchase);
    expect(historyLabel({ amount: 10, reason: 'vote_received', item: null, at: '' })).toBe(REASON_LABELS.vote_received);
  });
});
