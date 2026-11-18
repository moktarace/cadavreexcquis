import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { currentGame, ensureSession, explain, getNickname, setNickname as saveNickname, type CurrentGame, type Me } from '../backend/api';
import { supabase } from '../backend/client';
import { syncSubscription } from '../push/client';

export interface GameState {
  status: 'loading' | 'ready' | 'error' | 'unconfigured';
  me: Me | null;
  nickname: string;
  game: CurrentGame | null;
  /** Vrai quand `game` vient du cache local faute de réseau. */
  stale: boolean;
  error: string | null;
  reload: () => void;
  rename: (nickname: string) => Promise<void>;
  /** Heure du serveur, corrigée de l'écart d'horloge mesuré au chargement. */
  serverNow: (deviceNow: number) => number;
}

const CACHE_KEY = 'cl.lastGame.v1';
const Ctx = createContext<GameState | null>(null);

export function useGame(): GameState {
  const v = useContext(Ctx);
  if (!v) throw new Error('GameProvider manquant');
  return v;
}

export function GameProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Pick<GameState, 'status' | 'me' | 'nickname' | 'game' | 'stale' | 'error'>>({
    status: supabase ? 'loading' : 'unconfigured',
    me: null,
    nickname: '',
    game: null,
    stale: false,
    error: null,
  });
  const [tick, setTick] = useState(0);
  const offset = useRef(0);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    (async () => {
      try {
        const me = await ensureSession();
        const [game, nickname] = await Promise.all([currentGame(), getNickname(me.userId)]);
        if (!alive) return;
        offset.current = game.serverOffsetMs;
        localStorage.setItem(CACHE_KEY, JSON.stringify(game));
        void syncSubscription(me.userId).catch(() => undefined);
        setState({ status: 'ready', me, nickname, game, stale: false, error: null });
      } catch (e) {
        if (!alive) return;
        let cached: CurrentGame | null = null;
        try {
          cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
        } catch {
          cached = null;
        }
        setState((s) => ({ ...s, status: 'error', error: explain(e), game: cached, stale: !!cached }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  // Le thème change tout seul: on recharge dès que le serveur annonce le prochain lundi.
  useEffect(() => {
    if (state.status !== 'ready' || !state.game) return;
    const delay = state.game.nextThemeAtMs - (Date.now() + offset.current) + 1000;
    const id = window.setTimeout(() => setTick((t) => t + 1), Math.min(Math.max(delay, 1000), 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [state.status, state.game]);

  // Retour de connexion: on retente le chargement.
  useEffect(() => {
    const online = () => setTick((t) => t + 1);
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, []);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const rename = useCallback(
    async (nickname: string) => {
      if (!state.me) return;
      await saveNickname(state.me.userId, nickname);
      setState((s) => ({ ...s, nickname: nickname.trim() }));
    },
    [state.me],
  );

  const value = useMemo<GameState>(
    () => ({ ...state, reload, rename, serverNow: (now) => now + offset.current }),
    [state, reload, rename],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
