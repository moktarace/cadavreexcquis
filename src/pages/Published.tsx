import { cardPath, deckCount } from '../backend/api';
import { go, hrefOf } from '../app/router';
import { useGame } from '../app/game';
import type { Card } from '../domain/cards';
import { publishedCopy } from '../domain/play';
import { ToyButton } from '../ui';
import { Async, useAsync } from './shared';
import { ShareButton } from './ShareButton';

interface ViewProps {
  /** L'histoire de la première case à celle qui vient d'être publiée. */
  cards: readonly Card[];
  /** Existe-t-il une autre histoire que ce joueur peut continuer maintenant? */
  othersAvailable: boolean;
}

/** La nouvelle case apparaît à la suite des précédentes, une à une, la sienne en dernier. */
export function PublishedView({ cards, othersAvailable }: ViewProps) {
  const mine = cards[cards.length - 1];
  const copy = publishedCopy(mine.caseNumber);
  const complete = mine.caseNumber === 4;
  return (
    <div className="reveal">
      <h1 className="reveal__title">{copy.title}</h1>
      <p className="reveal__text">{copy.text}</p>
      <div className="reveal__board" role="list" aria-label="L’histoire jusqu’à ta case">
        {[1, 2, 3, 4].map((n) => {
          const c = cards.find((x) => x.caseNumber === n);
          if (!c) {
            return (
              <div key={n} className="reveal__cell reveal__cell--empty" role="listitem" aria-label={`Case ${n}, pas encore dessinée`}>
                {n}
              </div>
            );
          }
          const isMine = c.id === mine.id;
          return (
            <figure
              key={c.id}
              role="listitem"
              className={`reveal__cell ${isMine ? 'reveal__cell--mine' : ''}`}
              style={{ ['--i' as string]: n - 1 }}
              aria-label={`Case ${n} de ${c.authorName}${isMine ? ', la tienne' : ''}`}
            >
              <img src={c.previewUrl} width={320} height={240} alt="" />
              <span className="reveal__num" aria-hidden="true">{n}</span>
              <span className="reveal__author">{isMine ? 'Toi' : c.authorName}</span>
            </figure>
          );
        })}
      </div>
      <div className="reveal__actions">
        {othersAvailable ? (
          <ToyButton variant="primary" size="l" icon="play" href={hrefOf({ name: 'play', startId: null })}>Jouer à nouveau</ToyButton>
        ) : (
          <>
            <p className="hint">Il n’y a pas d’autre histoire à continuer pour le moment : d’autres joueurs doivent d’abord dessiner.</p>
            <ToyButton variant="primary" size="l" icon="pencil" onClick={() => go({ name: 'draw', parentId: null })}>Commencer une histoire</ToyButton>
            {!complete && <ShareButton cardId={mine.id} label="Inviter quelqu’un à continuer" />}
          </>
        )}
        <ToyButton variant="ghost" href={hrefOf(complete ? { name: 'story', id: mine.id } : { name: 'case', id: mine.id })}>Voir mon histoire</ToyButton>
      </div>
    </div>
  );
}

export function PublishedPage({ id }: { id: string }) {
  const { game, me } = useGame();
  const roomId = game?.roomId;
  const userId = me?.userId ?? null;
  const state = useAsync(async () => {
    if (!roomId) return null;
    const [cards, others] = await Promise.all([cardPath(id), deckCount({ roomId, userId, depth: null, onlyOpen: false })]);
    return { cards, othersAvailable: others > 0 };
  }, [id, roomId, userId]);
  return (
    <div className="screen">
      <Async state={state}>
        {(data) => (data.cards.length > 0 ? <PublishedView cards={data.cards} othersAvailable={data.othersAvailable} /> : <p className="hint">Case introuvable.</p>)}
      </Async>
    </div>
  );
}
