import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHub } from '../arbiter/api';
import type { Hub } from '../arbiter/types';
import { fetchRules, myGames } from '../multi/api';
import type { GameView, Rules } from '../multi/types';
import { hasSession } from '../shop/api';
import { fetchActivity, markActivityRead } from './api';
import type { Activity } from './types';

/** Pas de rafraîchissement automatique plus fréquent: pas de sondage, seulement des événements (ouverture, retour au premier plan). */
export const MIN_REFRESH_MS = 10_000;

export interface LiveData {
  games: GameView[] | null;
  hub: Hub | null;
  activity: Activity | null;
  rules: Rules | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : 'Serveur inaccessible.');

/**
 * Fusionne les résultats d'un rafraîchissement: une requête qui échoue ne fait pas perdre les données valides des autres
 * (ni les anciennes données de celle qui a échoué); le premier message d'erreur est conservé pour l'affichage.
 */
export function mergeLive(prev: LiveData, res: { games: PromiseSettledResult<GameView[]>; hub: PromiseSettledResult<Hub>; activity: PromiseSettledResult<Activity>; rules: PromiseSettledResult<Rules | null> }): { next: LiveData; error: string | null; allOk: boolean } {
  const next: LiveData = {
    games: res.games.status === 'fulfilled' ? res.games.value : prev.games,
    hub: res.hub.status === 'fulfilled' ? res.hub.value : prev.hub,
    activity: res.activity.status === 'fulfilled' ? res.activity.value : prev.activity,
    rules: res.rules.status === 'fulfilled' && res.rules.value ? res.rules.value : prev.rules,
  };
  const failed = [res.games, res.hub, res.activity, res.rules].find((r): r is PromiseRejectedResult => r.status === 'rejected');
  return { next, error: failed ? message(failed.reason) : null, allOk: !failed };
}

export interface Live {
  games: GameView[] | null;
  hub: Hub | null;
  activity: Activity | null;
  rules: Rules | null;
  /** Un compte existe déjà: seul cas où l'on interroge le serveur sans geste du joueur. */
  signedIn: boolean;
  loading: boolean;
  error: string | null;
  /** `force`: à la demande du joueur ou après une action; sinon limité à une fois par MIN_REFRESH_MS. */
  refresh: (force?: boolean) => Promise<void>;
  markRead: () => Promise<void>;
}

/**
 * Données serveur de l'accueil, de « Mes parties » et de « Activité ». Ne crée jamais de compte (le Solo reste hors ligne),
 * partage une seule requête en vol et n'en relance pas d'identique pendant MIN_REFRESH_MS.
 */
export function useLive(): Live {
  const [games, setGames] = useState<GameView[] | null>(null);
  const [hub, setHub] = useState<Hub | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const last = useRef(0);
  const rulesLoaded = useRef(false);
  const data = useRef<LiveData>({ games: null, hub: null, activity: null, rules: null });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (inflight.current) return inflight.current;
    if (!force && Date.now() - last.current < MIN_REFRESH_MS) return;
    const run = (async () => {
      setLoading(true);
      try {
        if (!(await hasSession())) {
          if (alive.current) setSignedIn(false);
          return;
        }
        const [games, hub, activity, rules] = await Promise.allSettled([myGames(), fetchHub(), fetchActivity(), rulesLoaded.current ? Promise.resolve(null) : fetchRules()]);
        if (!alive.current) return;
        const m = mergeLive(data.current, { games, hub, activity, rules });
        data.current = m.next;
        setSignedIn(true);
        setGames(m.next.games);
        setHub(m.next.hub);
        setActivity(m.next.activity);
        setRules(m.next.rules);
        if (rules.status === 'fulfilled' && rules.value) rulesLoaded.current = true;
        setError(m.error);
        last.current = Date.now();
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : 'Serveur inaccessible.');
      } finally {
        inflight.current = null;
        if (alive.current) setLoading(false);
      }
    })();
    inflight.current = run;
    return run;
  }, []);

  useEffect(() => {
    void refresh(true);
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const markRead = useCallback(async () => {
    if (!activity) return;
    try {
      await markActivityRead(activity.now);
      setActivity({ ...activity, unread: 0, read_until: activity.now });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Serveur inaccessible.');
    }
  }, [activity]);

  return { games, hub, activity, rules, signedIn, loading, error, refresh, markRead };
}
