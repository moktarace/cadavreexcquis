import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'play'; startId: string | null }
  | { name: 'read' }
  | { name: 'browse' }
  | { name: 'case'; id: string }
  | { name: 'reply'; id: string }
  | { name: 'finished'; id: string }
  | { name: 'story'; id: string }
  | { name: 'tree'; id: string }
  | { name: 'mine' }
  | { name: 'archives' }
  | { name: 'week'; id: string }
  | { name: 'draw'; parentId: string | null }
  | { name: 'published'; id: string }
  | { name: 'settings' }
  | { name: 'admin' }
  /** Laboratoire (#/lab/survivor): hors navigation, accessible par URL directe seulement. */
  | { name: 'survivor' };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [head, arg] = parts;
  const id = arg && ID.test(arg) ? arg : null;
  switch (head) {
    case 'play':
    case 'continue':
      return { name: 'play', startId: id };
    case 'read':
      return { name: 'read' };
    case 'browse':
      return { name: 'browse' };
    case 'published':
      return id ? { name: 'published', id } : { name: 'home' };
    case 'case':
      return id ? { name: 'case', id } : { name: 'home' };
    case 'reply':
      return id ? { name: 'reply', id } : { name: 'mine' };
    case 'finished':
      return id ? { name: 'finished', id } : { name: 'mine' };
    case 'story':
      return id ? { name: 'story', id } : { name: 'home' };
    case 'tree':
      return id ? { name: 'tree', id } : { name: 'home' };
    case 'mine':
      return { name: 'mine' };
    case 'archives':
      return { name: 'archives' };
    case 'week':
      return id ? { name: 'week', id } : { name: 'archives' };
    case 'draw':
      return { name: 'draw', parentId: id };
    case 'settings':
      return { name: 'settings' };
    case 'admin':
      return { name: 'admin' };
    case 'lab':
      return arg === 'survivor' ? { name: 'survivor' } : { name: 'home' };
    default:
      return { name: 'home' };
  }
}

export function hrefOf(r: Route): string {
  switch (r.name) {
    case 'home':
      return '#/';
    case 'case':
    case 'reply':
    case 'finished':
    case 'story':
    case 'tree':
    case 'week':
    case 'published':
      return `#/${r.name}/${r.id}`;
    case 'play':
      return r.startId ? `#/play/${r.startId}` : '#/play';
    case 'survivor':
      return '#/lab/survivor';
    case 'draw':
      return r.parentId ? `#/draw/${r.parentId}` : '#/draw';
    default:
      return `#/${r.name}`;
  }
}

const subscribe = (fn: () => void) => {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}

export function go(route: Route, replace = false) {
  const href = hrefOf(route);
  if (replace) {
    history.replaceState(null, '', href);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = href;
  }
}
