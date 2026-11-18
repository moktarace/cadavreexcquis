import { useCallback, useEffect, useRef, useState } from 'react';
import { cardPath, deckCount, deckPage, explain, latestOpenOwn } from '../backend/api';
import { go, hrefOf } from '../app/router';
import { useGame } from '../app/game';
import { cannotContinue, type Card } from '../domain/cards';
import { askLabel, nextProposals, planWindow } from '../domain/play';
import { EmptyState, Mascot, ThreadPeek, ToyButton, ToyCard, ToySpinner } from '../ui';
import { PageFrame } from './shared';
import { ShareButton } from './ShareButton';

const POOL_SIZE = 24;
const startStory = () => go({ name: 'draw', parentId: null });

interface ViewProps {
  card: Card;
  path: readonly Card[] | null;
  canSwitch: boolean;
  busy: boolean;
  onAnother: () => void;
}

/** Une histoire, ce qu'il faut inventer, un bouton pour le faire. */
export function PlayView({ card, path, canSwitch, busy, onAnother }: ViewProps) {
  return (
    <div className="play">
      <h2 className="play__ask">{askLabel(card.caseNumber)}</h2>
      <ThreadPeek key={card.id} cards={path && path.length > 0 ? path : [card]} />
      {canSwitch && (
        <ToyButton className="play__other" variant="soft" icon="redo" loading={busy} onClick={onAnother}>Une autre histoire</ToyButton>
      )}
      <ToyButton className="deck__cta" variant="primary" size="xl" icon="pencil" onClick={() => go({ name: 'draw', parentId: card.id })}>
        Dessiner la suite
      </ToyButton>
      <div className="play__more">
        <ToyButton variant="ghost" size="s" onClick={startStory}>Commencer une histoire</ToyButton>
        <ToyButton variant="ghost" size="s" href={hrefOf({ name: 'browse' })}>Parcourir les cases</ToyButton>
      </div>
    </div>
  );
}

export type EmptyKind = 'nobody' | 'only-mine';

/** Rien à continuer: on propose de commencer, jamais une liste vide ni un joueur simulé. */
export function PlayEmpty({ kind, shareCardId }: { kind: EmptyKind; shareCardId: string | null }) {
  return (
    <EmptyState
      title={kind === 'nobody' ? 'Tu es le premier à jouer !' : 'En attente d’autres joueurs'}
      mascot={<Mascot size={84} />}
      action={
        <>
          <ToyButton variant="primary" size="l" icon="pencil" onClick={startStory}>Commencer une histoire</ToyButton>
          {shareCardId && <ShareButton cardId={shareCardId} label="Inviter quelqu’un à continuer mon dessin" />}
        </>
      }
    >
      {kind === 'nobody'
        ? 'Personne n’a encore dessiné cette semaine. Lance une histoire : les autres pourront imaginer la suite.'
        : 'Tu ne peux pas continuer tes propres dessins : il faut qu’une autre personne joue. En attendant, tu peux commencer une autre histoire.'}
    </EmptyState>
  );
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty'; kind: EmptyKind; shareCardId: string | null }
  | { status: 'ready'; card: Card; path: Card[] | null; canSwitch: boolean };

export function PlayPage({ startId }: { startId: string | null }) {
  const { game, me } = useGame();
  const roomId = game?.roomId;
  const userId = me?.userId ?? null;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const queue = useRef<Card[]>([]);
  const pool = useRef(0);
  const paths = useRef(new Map<string, Card[]>());

  const pathOf = useCallback(async (card: Card) => {
    const known = paths.current.get(card.id);
    if (known) return known;
    const p = await cardPath(card.id).catch(() => [card]);
    paths.current.set(card.id, p);
    return p;
  }, []);

  /** Nouvelle fenêtre de propositions (sans suite d'abord), mélangée, sans la case affichée. */
  const refill = useCallback(
    async (excludeId: string | null) => {
      const q = { roomId: roomId!, userId, depth: null } as const;
      const [open, all] = await Promise.all([deckCount({ ...q, onlyOpen: true }), deckCount({ ...q, onlyOpen: false })]);
      const plan = planWindow(open, all, POOL_SIZE);
      if (!plan) {
        queue.current = [];
        pool.current = 0;
        return;
      }
      const page = await deckPage({ ...q, onlyOpen: plan.onlyOpen }, plan.offset, POOL_SIZE);
      pool.current = plan.onlyOpen ? open : all;
      queue.current = nextProposals(page.cards, excludeId);
    },
    [roomId, userId],
  );

  const show = useCallback(
    async (card: Card) => {
      setState({ status: 'ready', card, path: paths.current.get(card.id) ?? null, canSwitch: queue.current.length > 0 || pool.current > 1 });
      const path = await pathOf(card);
      setState((s) => (s.status === 'ready' && s.card.id === card.id ? { ...s, path } : s));
    },
    [pathOf],
  );

  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    (async () => {
      setState({ status: 'loading' });
      try {
        let first: Card | null = null;
        if (startId) {
          const p = await cardPath(startId);
          const c = p[p.length - 1];
          if (c && c.roomId === roomId && cannotContinue(c, userId) === null) {
            first = c;
            paths.current.set(c.id, p);
          }
        }
        await refill(first?.id ?? null);
        first ??= queue.current.shift() ?? null;
        if (!alive) return;
        if (first) {
          await show(first);
          return;
        }
        const roomEmpty = (await deckCount({ roomId, userId: null, depth: null, onlyOpen: false })) === 0;
        const own = !roomEmpty && userId ? await latestOpenOwn(roomId, userId) : null;
        if (alive) setState({ status: 'empty', kind: roomEmpty ? 'nobody' : 'only-mine', shareCardId: own?.id ?? null });
      } catch (e) {
        if (alive) setState({ status: 'error', message: explain(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [roomId, userId, startId, retry, refill, show]);

  const another = async () => {
    if (state.status !== 'ready') return;
    setBusy(true);
    try {
      if (queue.current.length === 0) await refill(state.card.id);
      const next = queue.current.shift();
      if (next) await show(next);
      else setState({ ...state, canSwitch: false });
    } catch (e) {
      setState({ status: 'error', message: explain(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageFrame title="Jouer" subtitle={game?.themeText} backHref={hrefOf({ name: 'home' })}>
      {state.status === 'loading' && <ToySpinner label="Recherche d’une histoire" />}
      {state.status === 'error' && (
        <ToyCard tone="error" title="Oups, ça n’a pas marché" icon="alert">
          <p>{state.message}</p>
          <ToyButton variant="primary" size="s" icon="redo" onClick={() => setRetry((n) => n + 1)}>Réessayer</ToyButton>
        </ToyCard>
      )}
      {state.status === 'empty' && <PlayEmpty kind={state.kind} shareCardId={state.shareCardId} />}
      {state.status === 'ready' && <PlayView card={state.card} path={state.path} canSwitch={state.canSwitch} busy={busy} onAnother={another} />}
    </PageFrame>
  );
}
