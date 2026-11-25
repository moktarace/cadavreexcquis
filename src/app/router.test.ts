import { describe, expect, it } from 'vitest';
import { hrefOf, parseHash, type Route } from './router';

describe('routeur par hash', () => {
  it.each<[string, Route]>([
    ['', { name: 'home' }],
    ['#/', { name: 'home' }],
    ['#/play', { name: 'play', startId: null }],
    ['#/play/c9', { name: 'play', startId: 'c9' }],
    ['#/continue/c9', { name: 'play', startId: 'c9' }],
    ['#/read', { name: 'read' }],
    ['#/browse', { name: 'browse' }],
    ['#/published/p1', { name: 'published', id: 'p1' }],
    ['#/case/abc-123', { name: 'case', id: 'abc-123' }],
    ['#/reply/r-1', { name: 'reply', id: 'r-1' }],
    ['#/finished/f-1', { name: 'finished', id: 'f-1' }],
    ['#/story/xyz', { name: 'story', id: 'xyz' }],
    ['#/draw', { name: 'draw', parentId: null }],
    ['#/draw/d1', { name: 'draw', parentId: 'd1' }],
    ['#/week/g1', { name: 'week', id: 'g1' }],
    ['#/archives', { name: 'archives' }],
    ['#/admin', { name: 'admin' }],
    ['#/lab/survivor', { name: 'survivor' }],
    ['#/lab/survivor/invite/abc123', { name: 'survivor', invite: 'abc123' }],
    ['#/lab/survivor/invite', { name: 'survivor' }],
    ['#/lab/survivor/autre/abc', { name: 'survivor' }],
  ])('analyse %s', (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });

  it('retombe sur l’accueil pour une route inconnue ou un identifiant invalide', () => {
    expect(parseHash('#/nimporte')).toEqual({ name: 'home' });
    expect(parseHash('#/case/')).toEqual({ name: 'home' });
    expect(parseHash('#/case/<script>')).toEqual({ name: 'home' });
    expect(parseHash('#/week/%20')).toEqual({ name: 'archives' });
    expect(parseHash('#/published')).toEqual({ name: 'home' });
    expect(parseHash('#/reply')).toEqual({ name: 'mine' });
    expect(parseHash('#/lab')).toEqual({ name: 'home' });
    expect(parseHash('#/lab/autre')).toEqual({ name: 'home' });
    expect(parseHash('#/survivor')).toEqual({ name: 'home' });
  });

  it('produit des liens qui se relisent à l’identique', () => {
    const routes: Route[] = [
      { name: 'home' },
      { name: 'mine' },
      { name: 'tree', id: 'a1' },
      { name: 'draw', parentId: 'd-2' },
      { name: 'draw', parentId: null },
      { name: 'play', startId: 'c1' },
      { name: 'play', startId: null },
      { name: 'read' },
      { name: 'browse' },
      { name: 'published', id: 'p2' },
      { name: 'reply', id: 'r2' },
      { name: 'finished', id: 'f2' },
      { name: 'survivor' },
      { name: 'survivor', invite: 'a1b2' },
    ];
    for (const r of routes) expect(parseHash(hrefOf(r))).toEqual(r);
  });
});
