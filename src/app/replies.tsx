import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { explain, markRepliesRead, unreadReplies } from '../backend/api';
import type { Card } from '../domain/cards';
import { isReplyTo, type UnreadReply } from '../domain/discoveries';
import { useGame } from './game';
import { loadUnreadFlag, saveUnreadFlag } from './unread';

export interface RepliesState {
  /** Réponses directes à mes cases pas encore ouvertes, les plus récentes d'abord. */
  unread: readonly UnreadReply[];
  /** Vrai dès qu'une nouveauté est connue, y compris avant la réponse du serveur (dernier état mémorisé). */
  hasUnread: boolean;
  /** Faux tant que le serveur n'a jamais répondu pour ce joueur. */
  loaded: boolean;
  /** Dernière erreur de synchronisation; la liste connue est conservée. */
  error: string | null;
  refresh: () => Promise<void>;
  markRead: (replyId: string) => Promise<void>;
}

const REFRESH_MS = 45_000;
const Ctx = createContext<RepliesState | null>(null);

export function useReplies(): RepliesState {
  const v = useContext(Ctx);
  if (!v) throw new Error('RepliesProvider manquant');
  return v;
}

/** L'état « lu » vit sur le serveur (par joueur et par réponse): il suit le compte sur tous ses appareils. */
export function RepliesProvider({ children }: { children: ReactNode }) {
  const { me } = useGame();
  const userId = me?.userId ?? null;
  const [unread, setUnread] = useState<UnreadReply[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cachedFlag, setCachedFlag] = useState(false);
  // Réponses ouvertes depuis le lancement: filtrées des listes reçues, même d'une requête partie avant l'ouverture.
  const openedHere = useRef(new Set<string>());
  // Ouvertes mais pas encore enregistrées (réseau coupé): renvoyées au prochain rafraîchissement.
  const pending = useRef(new Set<string>());
  const sequence = useRef(0);

  useEffect(() => {
    openedHere.current.clear();
    pending.current.clear();
    setUnread(null);
    setError(null);
    setCachedFlag(userId ? loadUnreadFlag(userId) : false);
  }, [userId]);

  useEffect(() => {
    if (userId && unread) saveUnreadFlag(userId, unread.length);
  }, [userId, unread]);

  const flush = useCallback(async () => {
    if (!userId || pending.current.size === 0) return;
    const ids = [...pending.current];
    try {
      await markRepliesRead(userId, ids);
      for (const id of ids) pending.current.delete(id);
    } catch {
      // réessayé au prochain rafraîchissement
    }
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const mine = ++sequence.current;
    try {
      await flush();
      const rows = await unreadReplies();
      if (mine !== sequence.current) return; // une demande plus récente a pris le relais
      setUnread(rows.filter((r) => !openedHere.current.has(r.replyId)));
      setError(null);
    } catch (e) {
      // on garde la liste connue: une erreur réseau ne fait jamais disparaître une nouveauté
      if (mine === sequence.current) setError(explain(e));
    }
  }, [userId, flush]);

  const markRead = useCallback(
    async (replyId: string) => {
      if (!userId || openedHere.current.has(replyId)) return;
      openedHere.current.add(replyId);
      pending.current.add(replyId);
      setUnread((cur) => (cur ? cur.filter((r) => r.replyId !== replyId) : cur));
      try {
        await markRepliesRead(userId, [replyId]);
        pending.current.delete(replyId);
      } catch {
        // reste en attente: l'ouverture est déjà prise en compte sur cet appareil
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

  const value = useMemo<RepliesState>(
    () => ({
      unread: unread ?? [],
      hasUnread: unread ? unread.length > 0 : cachedFlag,
      loaded: unread !== null,
      error,
      refresh,
      markRead,
    }),
    [unread, cachedFlag, error, refresh, markRead],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** À l'ouverture d'une réponse directe à l'une de mes cases (par quelque chemin que ce soit), elle devient lue. */
export function useMarkReplyRead(path: readonly Card[] | null | undefined) {
  const { me } = useGame();
  const { markRead } = useReplies();
  const reply = path?.[path.length - 1];
  const original = path?.[path.length - 2];
  const id = reply && original && isReplyTo(original, reply, me?.userId ?? null) ? reply.id : null;
  useEffect(() => {
    if (id) void markRead(id);
  }, [id, markRead]);
}
