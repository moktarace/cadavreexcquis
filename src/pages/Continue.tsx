import { useCallback, useEffect, useRef, useState } from 'react';
import { cardPath, deckCount, deckPage, explain, type DeckQuery } from '../backend/api';
import { go, hrefOf } from '../app/router';
import { useGame } from '../app/game';
import type { Card } from '../domain/cards';
import { DEPTHS, appendUnique, isNear, planRandom, shouldLoadMore, type Depth } from '../domain/discovery';
import { EmptyState, Mascot, Swiper, ThreadPeek, ToySpinner, ToyButton } from '../ui';
import { PageFrame } from './shared';

type PathCache = Map<string, Card[]>;

/** Le fil d'une case, chargé à la demande; en attendant (ou en cas d'échec) la case seule s'affiche. */
function Slide({ card, cache }: { card: Card; cache: PathCache }) {
  const [path, setPath] = useState<Card[] | undefined>(cache.get(card.id));
  useEffect(() => {
    if (cache.has(card.id)) return;
    let alive = true;
    cardPath(card.id).then(
      (p) => {
        cache.set(card.id, p);
        if (alive) setPath(p);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [card.id, cache]);
  return <ThreadPeek cards={path && path.length > 0 ? path : [card]} />;
}

interface DeckProps {
  roomId: string;
  userId: string | null;
  /** Case à montrer en premier (depuis l'accueil). */
  startCard?: Card | null;
}

/** Une histoire à la fois, par pages: seules les cases voisines de celle affichée sont chargées et rendues. */
export function ContinueDeck({ roomId, userId, startCard }: DeckProps) {
  const [depth, setDepth] = useState<Depth | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [index, setIndex] = useState(0);
  const [deckKey, setDeckKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomEmpty, setRoomEmpty] = useState(false);
  const fetched = useRef(0);
  const generation = useRef(0);
  const cache = useRef<PathCache>(new Map()).current;
  const query = useCallback((d: Depth | null, onlyOpen = false): DeckQuery => ({ roomId, userId, depth: d, onlyOpen }), [roomId, userId]);

  const loadFirst = useCallback(
    async (d: Depth | null) => {
      const mine = ++generation.current;
      setBusy(true);
      setError(null);
      try {
        const page = await deckPage(query(d), 0);
        if (mine !== generation.current) return;
        const first = startCard && (d === null || startCard.caseNumber === d) ? startCard : null;
        fetched.current = page.cards.length;
        setCards(first ? appendUnique([first], page.cards) : page.cards);
        setTotal(Math.max(page.total, first ? 1 : 0));
        setIndex(0);
        setDeckKey((k) => k + 1);
        if (page.total === 0 && !first && d === null) setRoomEmpty((await deckCount({ roomId, userId: null, depth: null, onlyOpen: false })) === 0);
      } catch (e) {
        if (mine === generation.current) setError(explain(e));
      } finally {
        if (mine === generation.current) setBusy(false);
      }
    },
    [query, roomId, startCard],
  );

  useEffect(() => {
    void loadFirst(depth);
  }, [depth, loadFirst]);

  // Charge la page suivante en approchant de la fin de ce qui est déjà là.
  useEffect(() => {
    if (busy || total === null || !shouldLoadMore(index, cards.length, total)) return;
    const mine = generation.current;
    setBusy(true);
    deckPage(query(depth), fetched.current)
      .then(
        (page) => {
          if (mine !== generation.current) return;
          fetched.current += page.cards.length;
          setCards((list) => appendUnique(list, page.cards));
          setTotal(page.total);
        },
        (e) => {
          if (mine === generation.current) setError(explain(e));
        },
      )
      .finally(() => {
        if (mine === generation.current) setBusy(false);
      });
  }, [index, cards.length, total, busy, depth, query]);

  const surprise = async () => {
    const mine = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const [open, all] = await Promise.all([deckCount(query(depth, true)), deckCount(query(depth))]);
      const plan = planRandom(open, all);
      if (!plan || mine !== generation.current) return;
      const page = await deckPage(query(depth, plan.onlyOpen), plan.offset, 1);
      if (mine !== generation.current || page.cards.length === 0) return;
      setCards((list) => appendUnique(page.cards, list));
      setIndex(0);
      setDeckKey((k) => k + 1);
    } catch (e) {
      if (mine === generation.current) setError(explain(e));
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  };

  const filters = (
    <div className="deck__filters">
      <div className="chips" role="group" aria-label="Case à continuer">
        <ToyButton variant="soft" size="s" selected={depth === null} onClick={() => setDepth(null)}>Toutes</ToyButton>
        {DEPTHS.map((d) => (
          <ToyButton key={d} variant="soft" size="s" selected={depth === d} onClick={() => setDepth(d)}>Case {d}</ToyButton>
        ))}
      </div>
      <ToyButton variant="soft" size="s" icon="star" disabled={busy || total === 0} onClick={surprise}>Au hasard</ToyButton>
    </div>
  );

  if (total === null && !error) return <div className="deck">{filters}<ToySpinner label="Chargement des histoires" /></div>;

  if (total === 0 && cards.length === 0) {
    return (
      <div className="deck">
        {filters}
        <EmptyState
          title={depth === null ? 'Rien à continuer pour l’instant' : `Aucune case ${depth} à continuer`}
          mascot={<Mascot size={84} />}
          action={
            depth === null ? (
              <ToyButton variant="primary" icon="pencil" onClick={() => go({ name: 'draw', parentId: null })}>Créer une case 1</ToyButton>
            ) : (
              <ToyButton variant="primary" onClick={() => setDepth(null)}>Voir toutes les cases</ToyButton>
            )
          }
        >
          {depth !== null
            ? 'Essaie un autre niveau.'
            : roomEmpty
              ? 'Personne n’a encore dessiné. Lance la première case !'
              : 'Tes propres dessins sont exclus : lance une nouvelle histoire.'}
        </EmptyState>
      </div>
    );
  }

  const current = cards[Math.min(index, cards.length - 1)];
  const shownTotal = Math.max(total ?? 0, cards.length);
  return (
    <div className="deck">
      {filters}
      {error && <p className="error-text" role="alert">{error}</p>}
      {current && (
        <>
          <Swiper key={deckKey} count={cards.length} index={index} onIndexChange={setIndex} label="Histoires à continuer">
            {cards.map((c, i) => (
              <div key={c.id} className="swiper__slide">
                {isNear(i, index) ? <Slide card={c} cache={cache} /> : null}
              </div>
            ))}
          </Swiper>
          <div className="pager">
            <ToyButton variant="soft" iconOnly icon="back" aria-label="Histoire précédente" disabled={index === 0} onClick={() => setIndex(index - 1)} />
            <span className="pager__count" role="status">{index + 1} / {shownTotal}</span>
            <ToyButton variant="soft" iconOnly icon="play" aria-label="Histoire suivante" disabled={index >= cards.length - 1} onClick={() => setIndex(index + 1)} />
          </div>
          <ToyButton className="deck__cta" variant="primary" size="xl" icon="pencil" onClick={() => go({ name: 'draw', parentId: current.id })}>
            Dessiner la suite
          </ToyButton>
        </>
      )}
    </div>
  );
}

/** Autre façon de découvrir les cases à continuer: par niveau, au hasard, en feuilletant. */
export function BrowsePage() {
  const { game, me } = useGame();
  return (
    <PageFrame title="Parcourir les cases" subtitle={game?.themeText} backHref={hrefOf({ name: 'play', startId: null })} tone="lavender">
      {game ? <ContinueDeck roomId={game.roomId} userId={me?.userId ?? null} /> : <ToySpinner label="Chargement" />}
    </PageFrame>
  );
}
