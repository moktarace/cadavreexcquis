import { useState } from 'react';
import type { Card } from '../domain/cards';
import { cardAlt } from '../domain/moderation';

interface ThreadPeekProps {
  /** Cases de la racine jusqu'à la dernière, dans l'ordre. */
  cards: readonly Card[];
}

/** Le fil d'une histoire: la dernière case en grand, les précédentes à un tap. */
export function ThreadPeek({ cards }: ThreadPeekProps) {
  const last = cards[cards.length - 1];
  const [shownId, setShownId] = useState(last.id);
  const shown = cards.find((c) => c.id === shownId) ?? last;
  return (
    <div className="thread">
      {cards.length > 1 && (
        <div className="thread__strip" role="group" aria-label="Cases précédentes">
          {cards.map((c) => (
            <button
              key={c.id}
              type="button"
              className="thread__step"
              aria-pressed={c.id === shown.id}
              aria-label={`Voir la case ${c.caseNumber} de ${c.authorName}`}
              onClick={() => setShownId(c.id)}
            >
              <img src={c.previewUrl} width={320} height={240} loading="lazy" alt="" />
              <b>{c.caseNumber}</b>
            </button>
          ))}
        </div>
      )}
      <img className="drawing" src={shown.previewUrl} width={320} height={240} alt={cardAlt(shown)} />
      <p className="thread__caption">
        Case {shown.caseNumber} · {shown.authorName}
        {shown.id === last.id && cards.length > 1 ? ' (la plus récente)' : ''}
      </p>
    </div>
  );
}
