import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { explain, markRewardEventsSeen, myProgress, myRewardEvents } from '../backend/api';
import { withoutSeen, type RewardEvent, type RewardProgress } from '../domain/rewards';
import { useGame } from './game';

export interface RewardsState {
  /** Compteurs et tampons débloqués (dernier état connu si le serveur ne répond pas). */
  progress: RewardProgress;
  /** Nouveautés non découvertes: histoires terminées, paliers d'inspiration, tampons. */
  news: readonly RewardEvent[];
  hasNews: boolean;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  markSeen: (ids: readonly string[]) => Promise<void>;
}

const KEY = 'cl.rewards.v1';
const REFRESH_MS = 60_000;
const EMPTY: RewardProgress = { completed: 0, inspired: 0, stickers: [] };
const Ctx = createContext<RewardsState | null>(null);

export function useRewards(): RewardsState {
  const v = useContext(Ctx);
  if (!v) throw new Error('RewardsProvider manquant');
  return v;
}

interface Cache {
  userId: string;
  progress: RewardProgress;
  news: boolean;
}

function readCache(userId: string): Cache | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return raw?.userId === userId ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Les récompenses vivent sur le serveur. Ce fournisseur n'en garde qu'un reflet: les tampons restent utilisables
 * hors connexion grâce au dernier état connu, et une erreur réseau ne fait disparaître aucune nouveauté.
 */
export function RewardsProvider({ children }: { children: ReactNode }) {
  const { me } = useGame();
  const userId = me?.userId ?? null;
  const [progress, setProgress] = useState<RewardProgress>(EMPTY);
  const [news, setNews] = useState<RewardEvent[] | null>(null);
  const [cachedNews, setCachedNews] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenHere = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const sequence = useRef(0);

  useEffect(() => {
    seenHere.current.clear();
    pending.current.clear();
    setNews(null);
    setError(null);
    const cached = userId ? readCache(userId) : null;
    setProgress(cached?.progress ?? EMPTY);
    setCachedNews(!!cached?.news);
  }, [userId]);

  useEffect(() => {
    if (!userId || news === null) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ userId, progress, news: news.length > 0 } satisfies Cache));
    } catch {
      // stockage refusé: le serveur reste la référence
    }
  }, [userId, progress, news]);

  const flush = useCallback(async () => {
    if (pending.current.size === 0) return;
    const ids = [...pending.current];
    try {
      await markRewardEventsSeen(ids);
      for (const id of ids) pending.current.delete(id);
    } catch {
      // renvoyé au prochain rafraîchissement
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const mine = ++sequence.current;
    try {
      await flush();
      const [p, events] = await Promise.all([myProgress(), myRewardEvents({ unseen: true })]);
      if (mine !== sequence.current) return;
      setProgress(p);
      setNews(withoutSeen(events, seenHere.current));
      setError(null);
    } catch (e) {
      if (mine === sequence.current) setError(explain(e));
    }
  }, [userId, flush]);

  const markSeen = useCallback(
    async (ids: readonly string[]) => {
      const fresh = ids.filter((id) => !seenHere.current.has(id));
      if (!userId || fresh.length === 0) return;
      for (const id of fresh) {
        seenHere.current.add(id);
        pending.current.add(id);
      }
      setNews((cur) => (cur ? cur.filter((e) => !fresh.includes(e.id)) : cur));
      try {
        await markRewardEventsSeen(fresh);
        for (const id of fresh) pending.current.delete(id);
      } catch {
        // la découverte est déjà prise en compte ici; l'enregistrement sera réessayé
      }
    },
    [userId],
  );

  useEffect(() => {
    if (!userId) return;
    void refresh();
    const again = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = window.setInterval(again, REFRESH_MS);
    document.addEventListener('visibilitychange', again);
    window.addEventListener('focus', again);
    window.addEventListener('online', again);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', again);
      window.removeEventListener('focus', again);
      window.removeEventListener('online', again);
    };
  }, [userId, refresh]);

  const value = useMemo<RewardsState>(
    () => ({
      progress,
      news: news ?? [],
      hasNews: news ? news.length > 0 : cachedNews,
      loaded: news !== null,
      error,
      refresh,
      markSeen,
    }),
    [progress, news, cachedNews, error, refresh, markSeen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
