import { useEffect, useRef, useState } from 'react';
import { archives, contributionProgress, gameCards, gameTheme, myCards } from '../backend/api';
import { go, hrefOf } from '../app/router';
import { useGame } from '../app/game';
import { loadSeen, markSeen } from '../app/seen';
import { completeStories, unfinished, type Card } from '../domain/cards';
import { progressMessage, type Progress } from '../domain/play';
import { EmptyState, Mascot, StoryThumbnail, ToyButton, ToySpinner } from '../ui';
import { Async, CardLink, PageFrame, plural, useAsync } from './shared';
import { ShareButton } from './ShareButton';

/** Un dessin du joueur, ce que les autres en ont fait, et la suite à voir. */
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
        <p className="mine-card__status"><strong>{progressMessage(card.caseNumber, card.childCount, progress)}</strong></p>
        <div className="row-buttons">
          {leaf || card.caseNumber === 4 ? (
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

const PAGE = 10;

export function MinePage() {
  const { me } = useGame();
  const state = useAsync(() => (me ? myCards(me.userId) : Promise.resolve([])), [me?.userId]);
  const [shown, setShown] = useState(PAGE);
  const seenAtOpen = useRef(loadSeen());
  const visible = (state.data ?? []).slice(0, shown);
  const ids = visible.map((c) => c.id).join();
  const progress = useAsync(() => contributionProgress(visible.map((c) => c.id)), [ids]);

  // Les suites affichées ici sont considérées comme vues à la prochaine visite.
  useEffect(() => {
    if (state.data) markSeen(visible);
  }, [state.data, shown]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PageFrame title="Mes dessins" tone="pink" backHref={hrefOf({ name: 'home' })}>
      <Async state={state}>
        {(cards) =>
          cards.length === 0 ? (
            <EmptyState
              title="Tu n’as encore rien dessiné"
              mascot={<Mascot size={84} />}
              action={
                <>
                  <ToyButton variant="primary" size="l" icon="play" href={hrefOf({ name: 'play', startId: null })}>Jouer</ToyButton>
                  <ToyButton variant="soft" size="s" icon="pencil" onClick={() => go({ name: 'draw', parentId: null })}>Commencer une histoire</ToyButton>
                </>
              }
            >
              Tes dessins apparaîtront ici, avec ce que les autres en feront.
            </EmptyState>
          ) : (
            <div className="stack">
              {visible.map((c) => (
                <MineItem key={c.id} card={c} progress={progress.data?.get(c.id)} isNew={c.childCount > (seenAtOpen.current[c.id] ?? 0)} />
              ))}
              {progress.loading && <ToySpinner label="Chargement des suites" />}
              {cards.length > shown && (
                <ToyButton variant="soft" icon="plus" onClick={() => setShown(shown + PAGE)}>Voir plus de dessins</ToyButton>
              )}
            </div>
          )
        }
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
