import { useEffect, useMemo, useRef, useState } from 'react';
import { archives, cardsByIds, contributionProgress, gameCards, gameTheme, myCards } from '../backend/api';
import { go, hrefOf } from '../app/router';
import { useGame } from '../app/game';
import { useReplies } from '../app/replies';
import { completeStories, unfinished, type Card } from '../domain/cards';
import { mineMood, missingCardIds, pairDiscoveries, parentsWithNews, suiteLabel, type Discovery } from '../domain/discoveries';
import type { Progress } from '../domain/play';
import { EmptyState, Mascot, PixelIcon, StoryThumbnail, ToyButton, ToyCard, ToySpinner } from '../ui';
import { Async, CardLink, Loading, PageFrame, plural, useAsync } from './shared';
import { ExpiryHint, MineExpiry } from './Expiry';
import { ShareButton } from './ShareButton';
import { cardAlt } from '../domain/moderation';

/** Un dessin du joueur: combien de suites il a reçues, et de quoi les lire. */
export function MineItem({ card, progress, isNew }: { card: Card; progress?: Progress; isNew: boolean }) {
  const leaf = progress?.finishedLeaf ?? null;
  return (
    <article className="mine-card">
      <a className="mine-card__thumb" href={hrefOf({ name: 'case', id: card.id })} aria-label={`Ta case ${card.caseNumber}`}>
        <img src={card.previewUrl} width={320} height={240} loading="lazy" alt={`Ta case ${card.caseNumber}`} />
        {isNew && <span className="mine-card__new">Nouveau</span>}
      </a>
      <div className="mine-card__body">
        <p className="mine-card__where">Ta case {card.caseNumber}</p>
        <p className="mine-card__status"><strong>{suiteLabel(card)}</strong></p>
        {card.caseNumber < 4 && (progress?.finished ?? 0) > 0 && <p className="hint">Une histoire complète est née de ton dessin !</p>}
        <div className="row-buttons">
          {card.hidden ? null : leaf || card.caseNumber === 4 ? (
            <ToyButton variant="success" size="s" icon="book" href={hrefOf({ name: 'story', id: leaf ?? card.id })}>Lire l’histoire</ToyButton>
          ) : card.childCount > 0 ? (
            <ToyButton variant="primary" size="s" icon="eye" href={hrefOf({ name: 'case', id: card.id })}>Voir les suites</ToyButton>
          ) : (
            <ShareButton cardId={card.id} />
          )}
        </div>
      </div>
    </article>
  );
}

/** Ma case et, à côté, ce qu'un autre joueur en a fait: la surprise se comprend sans rien ouvrir. */
function DiscoveryPair({ discovery }: { discovery: Discovery }) {
  const { original, reply } = discovery;
  return (
    <a className="discovery" href={hrefOf({ name: 'reply', id: reply.id })}>
      <div className="discovery__pair">
        <figure>
          <img src={original.previewUrl} width={320} height={240} loading="lazy" alt={`Ta case ${original.caseNumber}`} />
          <figcaption>Ton dessin</figcaption>
        </figure>
        <PixelIcon name="play" size={24} className="discovery__arrow" />
        <figure>
          <img src={reply.previewUrl} width={320} height={240} loading="lazy" alt={cardAlt(reply)} />
          <figcaption>{reply.authorName}</figcaption>
        </figure>
      </div>
      <p className="discovery__text">
        <span className="new-dot">Nouveau</span>
        <strong>Quelqu’un a continué ton dessin !</strong>
        <small>{reply.caseNumber === 4 ? 'Case 4 : la fin de l’histoire' : `Case ${reply.caseNumber}`}</small>
      </p>
    </a>
  );
}

const PAGE = 10;
const NEWS_PAGE = 8;

export function MinePage() {
  const { me, status, error: sessionError } = useGame();
  const userId = me?.userId ?? null;
  const replies = useReplies();
  const { refresh } = replies;
  const state = useAsync(() => (me ? myCards(me.userId) : Promise.resolve([])), [me?.userId]);
  const [shown, setShown] = useState(PAGE);
  const [shownNews, setShownNews] = useState(NEWS_PAGE);
  const visible = (state.data ?? []).slice(0, shown);
  const ids = visible.map((c) => c.id).join();
  const progress = useAsync(() => contributionProgress(visible.map((c) => c.id)), [ids]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Une réponse arrivée pendant que l'écran est ouvert: elle apparaît, et les compteurs de suites se mettent à jour.
  const knownReplies = useRef<Set<string> | null>(null);
  const unreadKey = replies.unread.map((r) => r.replyId).join();
  useEffect(() => {
    if (!replies.loaded) return;
    const current = new Set(replies.unread.map((r) => r.replyId));
    if (knownReplies.current && [...current].some((id) => !knownReplies.current!.has(id))) state.reload();
    knownReplies.current = current;
  }, [unreadKey, replies.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cases des paires affichées: les miennes sont déjà chargées, on ne va chercher que ce qui manque.
  const [fetched, setFetched] = useState<ReadonlyMap<string, Card>>(new Map());
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [retry, setRetry] = useState(0);
  const attempted = useRef(new Set<string>());
  const news = replies.unread.slice(0, shownNews);
  const known = useMemo(() => {
    const m = new Map<string, Card>(fetched);
    for (const c of state.data ?? []) m.set(c.id, c);
    return m;
  }, [fetched, state.data]);
  const missing = state.data ? missingCardIds(news, known).filter((id) => !attempted.current.has(id)) : [];
  const missingKey = missing.join();
  useEffect(() => {
    if (missing.length === 0) return;
    for (const id of missing) attempted.current.add(id);
    setFetching(true);
    cardsByIds(missing)
      .then((cards) => {
        setFetched((cur) => new Map([...cur, ...cards.map((c) => [c.id, c] as const)]));
        setFetchError(null);
      })
      .catch((e) => {
        for (const id of missing) attempted.current.delete(id);
        setFetchError(e instanceof Error ? e.message : 'Chargement impossible.');
      })
      .finally(() => setFetching(false));
  }, [missingKey, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  const pairs = pairDiscoveries(news, known, userId);
  const withNews = useMemo(() => parentsWithNews(replies.unread), [replies.unread]);
  const retryNews = () => {
    setFetchError(null);
    setRetry((n) => n + 1);
    void refresh();
  };

  if (!me) {
    return (
      <PageFrame title="Mes dessins" tone="pink" backHref={hrefOf({ name: 'home' })}>
        {status === 'loading' ? (
          <Loading />
        ) : (
          <ToyCard tone="error" title="Connexion impossible" icon="alert"><p>{sessionError ?? 'Reconnecte-toi pour retrouver tes dessins.'}</p></ToyCard>
        )}
      </PageFrame>
    );
  }

  return (
    <PageFrame title="Mes dessins" tone="pink" backHref={hrefOf({ name: 'home' })}>
      <Async state={state}>
        {(cards) => {
          if (cards.length === 0) {
            return (
              <EmptyState
                title="Tu n’as pas encore dessiné !"
                mascot={<Mascot size={84} />}
                action={
                  <>
                    <ToyButton variant="primary" size="l" icon="play" href={hrefOf({ name: 'play', startId: null })}>Continuer une histoire</ToyButton>
                    <ToyButton variant="soft" size="s" icon="pencil" onClick={() => go({ name: 'draw', parentId: null })}>Commencer une histoire</ToyButton>
                  </>
                }
              >
                Commence une histoire ou continue celle de quelqu’un.
              </EmptyState>
            );
          }
          const mood = replies.loaded ? mineMood(cards, replies.unread.length) : replies.hasUnread ? 'discover' : 'pending';
          return (
            <div className="stack">
              {replies.error && (
                <div className="stack">
                  <p className="hint" role="status">Impossible de vérifier les nouvelles suites pour le moment{replies.hasUnread ? ' (celles déjà connues restent signalées)' : ''}.</p>
                  <ToyButton variant="soft" size="s" icon="redo" onClick={retryNews}>Réessayer</ToyButton>
                </div>
              )}
              <MineExpiry cards={cards} />
              {mood === 'discover' && (replies.loaded || !replies.error) && (
                <section className="discover" aria-labelledby="news-title">
                  <h2 className="section-title" id="news-title"><span>À découvrir</span></h2>
                  {pairs.map((d) => (
                    <DiscoveryPair key={d.reply.id} discovery={d} />
                  ))}
                  {(fetching || !replies.loaded) && <ToySpinner label="Chargement des nouvelles suites" />}
                  {fetchError && (
                    <>
                      <p className="hint">Les nouvelles suites n’ont pas pu être chargées : {fetchError}</p>
                      <ToyButton variant="soft" size="s" icon="redo" onClick={retryNews}>Réessayer</ToyButton>
                    </>
                  )}
                  {replies.unread.length > shownNews && (
                    <ToyButton variant="soft" icon="plus" onClick={() => setShownNews(shownNews + NEWS_PAGE)}>Voir plus de nouveautés</ToyButton>
                  )}
                </section>
              )}
              {mood === 'allRead' && <ToyCard tone="green"><p className="plain-text"><strong>Tu as découvert toutes les nouvelles suites !</strong></p></ToyCard>}
              {mood === 'waiting' && <ToyCard tone="lavender"><p className="plain-text"><strong>Tes dessins attendent que d’autres joueurs inventent la suite !</strong></p></ToyCard>}
              <section className="stack" aria-labelledby="all-title">
                <h2 className="section-title" id="all-title"><span>Tous mes dessins</span></h2>
                {visible.map((c) => (
                  <MineItem key={c.id} card={c} progress={progress.data?.get(c.id)} isNew={withNews.has(c.id)} />
                ))}
                {progress.loading && <ToySpinner label="Chargement des suites" />}
                {cards.length > shown && (
                  <ToyButton variant="soft" icon="plus" onClick={() => setShown(shown + PAGE)}>Voir plus de dessins</ToyButton>
                )}
              </section>
            </div>
          );
        }}
      </Async>
    </PageFrame>
  );
}

export function ArchivesPage() {
  const state = useAsync(archives, []);
  return (
    <PageFrame title="Semaines précédentes" tone="lavender" backHref={hrefOf({ name: 'read' })}>
      <Async state={state}>
        {(weeks) =>
          weeks.length === 0 ? (
            <EmptyState title="Pas encore d’archives" mascot={<Mascot size={84} />}>
              Aucune semaine n’a encore reçu de dessin.
            </EmptyState>
          ) : (
            <ul className="toy-list">
              {weeks.map((w) => (
                <li key={w.gameId}>
                  <a className="week-link" href={hrefOf({ name: 'week', id: w.gameId })}>
                    <strong>Semaine {w.isoWeek} · {w.isoYear}</strong>
                    <span>{w.themeText}</span>
                  </a>
                </li>
              ))}
            </ul>
          )
        }
      </Async>
    </PageFrame>
  );
}

export function WeekPage({ id }: { id: string }) {
  const { game } = useGame();
  const info = useAsync(() => gameTheme(id), [id]);
  const cards = useAsync(() => gameCards(id), [id]);
  return (
    <PageFrame
      title={info.data?.themeText ?? 'Semaine'}
      subtitle={info.data ? `Semaine ${info.data.isoWeek} · ${info.data.isoYear}${game?.gameId === id ? ' (thème actif)' : ''}` : undefined}
      backHref={hrefOf({ name: 'archives' })}
      tone="lavender"
    >
      {info.error && <Async state={info}>{() => null}</Async>}
      {info.data && <ExpiryHint isoYear={info.data.isoYear} isoWeek={info.data.isoWeek} />}
      {game?.gameId !== id && <p className="hint">Les histoires inachevées peuvent toujours recevoir une suite.</p>}
      <Async state={cards}>
        {(all) => {
          const stories = completeStories(all);
          const open = unfinished(all);
          return (
            <>
              <section className="stack">
                <h2 className="section-title"><span>{plural(stories.length, 'histoire terminée', 'histoires terminées')}</span></h2>
                <div className="grid">
                  {stories.map((s) => (
                    <StoryThumbnail key={s[3].id} cards={s} href={hrefOf({ name: 'story', id: s[3].id })} caption={s.map((c) => c.authorName).join(', ')} />
                  ))}
                </div>
              </section>
              <section className="stack">
                <h2 className="section-title"><span>{plural(open.length, 'histoire à continuer', 'histoires à continuer')}</span></h2>
                <div className="grid">
                  {open.map((c) => (
                    <CardLink key={c.id} card={c} />
                  ))}
                </div>
              </section>
            </>
          );
        }}
      </Async>
    </PageFrame>
  );
}
