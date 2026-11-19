import { archiveHighlights, cardPath, deckPage, finishedCards, type ArchiveCard } from '../backend/api';
import { hrefOf } from '../app/router';
import { useGame } from '../app/game';
import type { Card } from '../domain/cards';
import { showArchives } from '../domain/discovery';
import { StoryThumbnail, ToyButton, ToyCard, ToySpinner } from '../ui';
import { ArchiveShelf } from './Home';
import { ExpiryHint } from './Expiry';
import { PageFrame, useAsync } from './shared';

export interface ReadStory {
  /** Cases de la première à la dernière connue. */
  path: readonly Card[];
}

interface ReadViewProps {
  finished: readonly ReadStory[];
  ongoing: readonly ReadStory[];
  archive: readonly ArchiveCard[];
  weekHref: string;
}

const last = (s: ReadStory) => s.path[s.path.length - 1];

/** Lire: les histoires de la semaine, terminées d'abord, et la porte vers les semaines passées. */
export function ReadView({ finished, ongoing, archive, weekHref }: ReadViewProps) {
  const empty = finished.length === 0 && ongoing.length === 0;
  return (
    <>
      <p className="hint">Feuillette les histoires, et découvre comment elles auraient pu continuer autrement.</p>
      {empty && (
        <ToyCard tone="lavender">
          <p className="plain-text"><strong>Aucune histoire à lire pour l’instant cette semaine.</strong></p>
        </ToyCard>
      )}
      {finished.length > 0 && (
        <section className="feed" aria-labelledby="finished-title">
          <h2 className="feed__title" id="finished-title">Histoires terminées</h2>
          <div className="recent__row recent__row--lg">
            {finished.map((s) => (
              <StoryThumbnail key={last(s).id} cards={s.path} href={hrefOf({ name: 'story', id: last(s).id })} badge="Terminée" caption={s.path.map((c) => c.authorName).join(', ')} />
            ))}
          </div>
        </section>
      )}
      {ongoing.length > 0 && (
        <section className="feed" aria-labelledby="ongoing-title">
          <h2 className="feed__title" id="ongoing-title">Histoires en cours</h2>
          <div className="recent__row recent__row--lg">
            {ongoing.map((s) => (
              <StoryThumbnail key={last(s).id} cards={s.path} href={hrefOf({ name: 'story', id: last(s).id })} caption={`${s.path.length} case${s.path.length > 1 ? 's' : ''} sur 4`} />
            ))}
          </div>
        </section>
      )}
      {showArchives(empty ? 0 : 1, archive.length) && <ArchiveShelf archive={archive} />}
      <div className="row-buttons">
        <ToyButton variant="soft" size="s" icon="pages" href={weekHref}>Toutes les histoires de la semaine</ToyButton>
        <ToyButton variant="soft" size="s" icon="archive" href={hrefOf({ name: 'archives' })}>Semaines précédentes</ToyButton>
      </div>
    </>
  );
}

const COUNT = 8;

export function ReadPage() {
  const { game } = useGame();
  const roomId = game?.roomId;
  const gameId = game?.gameId;
  const state = useAsync(async () => {
    if (!roomId || !gameId) return null;
    const [fin, open] = await Promise.all([finishedCards(roomId, COUNT), deckPage({ roomId, userId: null, depth: null, onlyOpen: true }, 0, COUNT)]);
    const withPath = (cards: readonly Card[]) => Promise.all(cards.map(async (c): Promise<ReadStory> => ({ path: await cardPath(c.id).catch(() => [c]) })));
    const [finished, ongoing] = await Promise.all([withPath(fin), withPath(open.cards)]);
    const archive = finished.length + ongoing.length === 0 ? await archiveHighlights(gameId, 8).catch(() => []) : [];
    return { finished, ongoing, archive };
  }, [roomId, gameId]);

  return (
    <PageFrame title="Lire" tone="pink" backHref={hrefOf({ name: 'home' })}>
      {game && <ExpiryHint isoYear={game.isoYear} isoWeek={game.isoWeek} />}
      {state.error && <p className="error-text" role="alert">{state.error}</p>}
      {!state.error && (state.data === null || !gameId ? <ToySpinner label="Chargement des histoires" /> : <ReadView {...state.data} weekHref={hrefOf({ name: 'week', id: gameId })} />)}
    </PageFrame>
  );
}
