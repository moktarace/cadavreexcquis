import { describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/client', () => ({ supabase: null }));
vi.mock('../../backend/api', () => ({
  ApiError: class ApiError extends Error {},
  ensureSession: async () => ({ userId: 'u', isAnonymous: true, email: null }),
}));
const { IMAGE_HINTS, RENEW_AFTER_MS, UrlCache, voteEnabled } = await import('./images');

const signer = () => {
  let n = 0;
  return vi.fn(async (paths: string[]) => Object.fromEntries(paths.map((p) => [p, `https://signed/${p}?t=${++n}`])));
};

describe('votes et chargement des images', () => {
  it('seule une image effectivement affichée autorise le vote', () => {
    expect(voteEnabled('ready')).toBe(true);
    expect(voteEnabled('loading')).toBe(false);
    expect(voteEnabled('error')).toBe(false);
    expect(voteEnabled(undefined)).toBe(false);
  });

  it('chaque état non prêt explique quoi faire, sans promettre de perdre des votes', () => {
    expect(IMAGE_HINTS.loading).toMatch(/dès qu’il s’affiche/);
    expect(IMAGE_HINTS.error).toMatch(/conservés/);
    expect(IMAGE_HINTS.ready).toBe('');
  });
});

describe('cache des URL signées', () => {
  it('demande les chemins une seule fois par lot et réutilise les URL valides', async () => {
    const sign = signer();
    let now = 1_000;
    const c = new UrlCache(sign, () => now);
    await c.ensure(['a', 'b', 'a']);
    await c.ensure(['a', 'b']);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith(['a', 'b']);
    expect(c.urls.get('a')!.url).toContain('a?t=');
    now += RENEW_AFTER_MS - 1;
    expect(await c.ensure(['a'])).toBe(false);
  });

  it('renouvelle les URL proches de leur expiration', async () => {
    const sign = signer();
    let now = 0;
    const c = new UrlCache(sign, () => now);
    await c.ensure(['a']);
    const first = c.urls.get('a')!.url;
    now = RENEW_AFTER_MS + 1;
    expect(c.isStale('a')).toBe(true);
    await c.ensure(['a']);
    expect(c.urls.get('a')!.url).not.toBe(first);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('un nouvel essai manuel redemande une URL même si l’ancienne semble valide', async () => {
    const sign = signer();
    const c = new UrlCache(sign, () => 0);
    await c.ensure(['a']);
    const first = c.urls.get('a')!.url;
    await c.ensure(['a'], true);
    expect(c.urls.get('a')!.url).not.toBe(first);
  });

  it('un chemin refusé ou une panne réseau marque un échec sans lever d’exception ni boucler', async () => {
    const sign = vi.fn(async () => ({}) as Record<string, string>);
    const c = new UrlCache(sign, () => 0);
    await c.ensure(['denied']);
    expect(c.failed.has('denied')).toBe(true);
    expect(c.urls.has('denied')).toBe(false);
    await expect(c.ensure(['x'])).resolves.toBe(true);
    expect(sign).toHaveBeenCalledTimes(2); // pas de relance automatique: une demande par appel

    const down = new UrlCache(async () => Promise.reject(new Error('réseau')), () => 0);
    await expect(down.ensure(['a'])).resolves.toBe(true);
    expect(down.failed.has('a')).toBe(true);
  });

  it('un échec est levé par un renouvellement réussi', async () => {
    let ok = false;
    const c = new UrlCache(async (p) => (ok ? { [p[0]]: 'u' } : {}), () => 0);
    await c.ensure(['a']);
    expect(c.failed.has('a')).toBe(true);
    ok = true;
    await c.ensure(['a'], true);
    expect(c.failed.has('a')).toBe(false);
    expect(c.urls.get('a')!.url).toBe('u');
  });

  it('deux demandes simultanées du même chemin ne le signent qu’une fois', async () => {
    const sign = signer();
    const c = new UrlCache(sign, () => 0);
    const [a, b] = await Promise.all([c.ensure(['a']), c.ensure(['a'])]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});
