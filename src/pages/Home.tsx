import { useState } from 'react';
import { archiveHighlights, recentRoomCards, type ArchiveCard } from '../backend/api';
import { go, hrefOf } from '../app/router';
import { useGame } from '../app/game';
import { useNow } from '../app/hooks';
import { useReplies } from '../app/replies';
import type { Card } from '../domain/cards';
import { archiveCaption, showArchives } from '../domain/discovery';
import { Logo, StoryThumbnail, ToyButton, ToyCard, ToySpinner, WeeklyThemeCard, formatDelay } from '../ui';
import { useAsync } from './shared';

/** Dessins des semaines passées, à lire: ils ne font pas partie de la partie courante. */
export function ArchiveShelf({ archive }: { archive: readonly ArchiveCard[] }) {
  return (
    <section className="feed" aria-labelledby="archive-title">
      <h2 className="feed__title" id="archive-title">Archives des semaines passées</h2>
      <p className="hint">À lire seulement, hors de cette semaine.</p>
      <div className="recent__row recent__row--lg">
        {archive.map((c) => (
          <StoryThumbnail
            key={c.id}
            cards={[c]}
            href={hrefOf({ name: c.caseNumber === 4 ? 'story' : 'case', id: c.id })}
            badge="Archive"
            caption={archiveCaption(c)}
          />
        ))}
      </div>
      <ToyButton variant="ghost" size="s" href={hrefOf({ name: 'archives' })}>Toutes les archives</ToyButton>
    </section>
  );
}

/** Quelqu'un a continué un dessin du joueur: la première chose à lui dire en revenant. */
export function NewSuitesBanner({ count }: { count: number }) {
  return (
    <ToyCard tone="green" className="banner">
      <p className="plain-text">
        <strong>{count === 1 ? 'Quelqu’un a continué ton dessin !' : `${count} nouvelles suites à découvrir !`}</strong>
      </p>
      <ToyButton variant="success" size="s" icon="eye" href={hrefOf({ name: 'mine' })}>Découvrir</ToyButton>
    </ToyCard>
  );
}

interface FeedProps {
  recent: readonly Card[];
  archive: readonly ArchiveCard[];
}

/** Dessins réels de la salle; si elle est vide, des archives à lire, sans rien inventer. */
export function HomeFeed({ recent, archive }: FeedProps) {
  if (recent.length > 0) {
    return (
      <section className="feed" aria-labelledby="recent-title">
        <h2 className="feed__title" id="recent-title">Derniers dessins</h2>
        <div className="recent__row recent__row--lg">
          {recent.map((c) => (
            <StoryThumbnail
              key={c.id}
              cards={[c]}
              href={hrefOf({ name: c.caseNumber === 4 ? 'story' : 'case', id: c.id })}
              caption={<>Case {c.caseNumber} · {c.authorName}</>}
            />
          ))}
        </div>
      </section>
    );
  }
  return (
    <>
      <ToyCard tone="lavender">
        <p className="plain-text"><strong>Personne n’a encore dessiné cette semaine.</strong> Sois le premier !</p>
      </ToyCard>
      {showArchives(recent.length, archive.length) && <ArchiveShelf archive={archive} />}
    </>
  );
}

const RECENT_COUNT = 10;

export function HomePage() {
  const g = useGame();
  const now = useNow(30_000);
  const roomId = g.game?.roomId;
  const gameId = g.game?.gameId;
  const replies = useReplies();
  const [retry, setRetry] = useState(0);

  const feed = useAsync(async () => {
    if (g.status !== 'ready' || !roomId || !gameId) return null;
    const recent = await recentRoomCards(roomId, RECENT_COUNT);
    const archive = recent.length === 0 ? await archiveHighlights(gameId, 8).catch(() => []) : [];
    return { recent, archive };
  }, [g.status, roomId, gameId, retry]);

  return (
    <div className="screen">
      <div className="home-hero">
        <h1 className="sr-only">Cadavre Exquis</h1>
        <Logo compact />
        <ToyButton variant="soft" size="s" iconOnly icon="gear" href={hrefOf({ name: 'settings' })} aria-label="Réglages" />
      </div>
      <WeeklyThemeCard
        status={g.status}
        themeText={g.game?.themeText}
        weekLabel={g.game ? `Semaine ${g.game.isoWeek} · ${g.game.isoYear}` : undefined}
        remaining={g.game ? formatDelay(g.game.nextThemeAtMs - g.serverNow(now)) : undefined}
        stale={g.stale}
        error={g.error}
        onRetry={g.reload}
      />

      <p className="tagline">À plusieurs, dessinez des histoires en 4 cases. Chacun imagine la suite du dessin d’un autre !</p>

      <div className="home-actions">
        <ToyButton variant="primary" size="xl" icon="play" href={hrefOf({ name: 'play', startId: null })}>
          <span className="btn-stack"><b>Continuer une histoire</b><small>Dessine la suite de quelqu’un !</small></span>
        </ToyButton>
        <ToyButton variant="soft" size="l" icon="pencil" onClick={() => go({ name: 'draw', parentId: null })}>
          <span className="btn-stack"><b>Commencer une histoire</b><small>Imagine la première case !</small></span>
        </ToyButton>
      </div>

      {replies.unread.length > 0 && <NewSuitesBanner count={replies.unread.length} />}

      {g.status === 'ready' && feed.error && (
        <div className="stack">
          <p className="hint">Les dessins n’ont pas pu être chargés : {feed.error}</p>
          <ToyButton variant="soft" size="s" icon="redo" onClick={() => setRetry((n) => n + 1)}>Réessayer</ToyButton>
        </div>
      )}
      {g.status === 'ready' && !feed.error && (feed.data === null ? <ToySpinner label="Chargement des dessins" /> : (
        <>
          <HomeFeed recent={feed.data.recent} archive={feed.data.archive} />
        </>
      ))}
      {g.status !== 'ready' && g.status !== 'loading' && (
        <p className="hint home-summary">Tu peux dessiner hors connexion : la publication demande un accès au serveur.</p>
      )}
    </div>
  );
}
