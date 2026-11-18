import { describe, expect, it } from 'vitest';
import { dispatch, timingSafeEqual, type Claimed, type Deps } from './dispatch.ts';

const row = (n: string, s: string, over: Partial<Claimed> = {}): Claimed => ({
  notification_id: n,
  kind: 'continuation',
  count: 1,
  payload: { url: '/#/case/x' },
  attempts: 1,
  subscription_id: s,
  endpoint: `https://push.example/${s}`,
  p256dh: 'k',
  auth: 'a',
  ...over,
});

function harness(rows: Claimed[], statuses: Record<string, number | Error>) {
  const log = { sent: [] as string[], removed: [] as string[], released: [] as string[] };
  const deps: Deps = {
    claim: async () => rows,
    buildBody: (r) => `body:${r.notification_id}`,
    send: async (sub) => {
      const s = statuses[sub.endpoint.split('/').pop()!] ?? 201;
      if (s instanceof Error) throw s;
      log.sent.push(sub.endpoint);
      return { status: s };
    },
    removeSubscription: async (id) => void log.removed.push(id),
    release: async (id) => void log.released.push(id),
  };
  return { deps, log };
}

describe('envoi des notifications', () => {
  it('envoie une notification par appareil abonné', async () => {
    const { deps, log } = harness([row('n1', 's1'), row('n1', 's2')], {});
    const r = await dispatch(deps);
    expect(r).toEqual({ notifications: 1, sent: 2, removedSubscriptions: 0, retried: 0 });
    expect(log.sent).toHaveLength(2);
  });

  it('supprime un abonnement expiré (410) sans relancer la notification', async () => {
    const { deps, log } = harness([row('n1', 's1')], { s1: 410 });
    const r = await dispatch(deps);
    expect(log.removed).toEqual(['s1']);
    expect(r.retried).toBe(0);
    expect(log.released).toEqual([]);
  });

  it('remet en attente après une panne temporaire (5xx, 429, réseau)', async () => {
    for (const failure of [503, 429, new Error('ECONNRESET')]) {
      const { deps, log } = harness([row('n1', 's1')], { s1: failure });
      const r = await dispatch(deps);
      expect(r.retried).toBe(1);
      expect(log.released).toEqual(['n1']);
    }
  });

  it('ne relance pas si un appareil a reçu la notification', async () => {
    const { deps, log } = harness([row('n1', 's1'), row('n1', 's2')], { s1: 500 });
    const r = await dispatch(deps);
    expect(r.sent).toBe(1);
    expect(log.released).toEqual([]);
  });

  it('traite plusieurs notifications indépendamment', async () => {
    const { deps, log } = harness([row('n1', 's1'), row('n2', 's2')], { s2: 503 });
    const r = await dispatch(deps);
    expect(r).toMatchObject({ notifications: 2, sent: 1, retried: 1 });
    expect(log.released).toEqual(['n2']);
  });

  it('ne fait rien sans notification à envoyer', async () => {
    const { deps } = harness([], {});
    expect(await dispatch(deps)).toEqual({ notifications: 0, sent: 0, removedSubscriptions: 0, retried: 0 });
  });
});

describe('secret partagé', () => {
  it('compare en temps constant', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abd', 'abc')).toBe(false);
    expect(timingSafeEqual('ab', 'abc')).toBe(false);
    expect(timingSafeEqual(null, 'abc')).toBe(false);
  });
});
