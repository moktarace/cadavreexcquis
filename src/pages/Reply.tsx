import { cardChildren, cardPath, contributionProgress } from '../backend/api';
import { useGame } from '../app/game';
import { useMarkReplyRead, useReplies } from '../app/replies';
import { hrefOf } from '../app/router';
import { isReplyTo } from '../domain/discoveries';
import { PixelIcon, StoryThumbnail, ToyButton, ToyCard } from '../ui';
import { Async, PageFrame, plural, useAsync } from './shared';
import { CasePage } from './Browse';

/** « Voici ce que j'avais dessiné, et voici ce que quelqu'un d'autre en a fait. » */
export function ReplyPage({ id }: { id: string }) {
  const { me } = useGame();
  const { unread } = useReplies();
  const path = useAsync(() => cardPath(id), [id]);
  useMarkReplyRead(path.data);

  const reply = path.data?.[path.data.length - 1];
  const original = path.data?.[path.data.length - 2];
  const mine = !!reply && !!original && isReplyTo(original, reply, me?.userId ?? null);
  const others = useAsync(() => (mine && original ? cardChildren(original.id) : Promise.resolve([])), [mine, original?.id]);
  const progress = useAsync(() => (mine && reply ? contributionProgress([reply.id]) : Promise.resolve(new Map())), [mine, reply?.id]);

  return (
    <Async state={path}>
      {(cards) => {
        // Pas une réponse à l'un de mes dessins: la fiche ordinaire de la case est plus adaptée.
        if (!mine || !reply || !original) return me && cards.length > 0 ? <CasePage id={id} /> : null;
        const info = progress.data?.get(reply.id);
        const alternates = (others.data ?? []).filter((c) => c.id !== reply.id);
        const unreadIds = new Set(unread.map((r) => r.replyId));
        const final = reply.caseNumber === 4;
        const endings = info?.finished ?? 0;
        return (
          <PageFrame title="Une suite à ton dessin" tone="pink" backHref={hrefOf({ name: 'mine' })}>
            <section className="reply">
              <h2 className="reply__title">Voici ce que quelqu’un d’autre a fait de ton dessin !</h2>
              <div className="reply__pair">
                <figure>
                  <img src={original.previewUrl} width={320} height={240} alt={`Ta case ${original.caseNumber}`} />
                  <figcaption className="thread__caption">Ton dessin · case {original.caseNumber}</figcaption>
                </figure>
                <PixelIcon name="play" size={28} className="reply__arrow" />
                <figure>
                  <img src={reply.previewUrl} width={320} height={240} alt={`Case ${reply.caseNumber} de ${reply.authorName}`} />
                  <figcaption className="thread__caption">{final ? 'La fin' : 'Sa suite'} · case {reply.caseNumber} · {reply.authorName}</figcaption>
                </figure>
              </div>
              <div className="row-buttons">
                <ToyButton variant="primary" icon="book" href={hrefOf({ name: 'story', id: info?.finishedLeaf ?? reply.id })}>
                  Lire l’histoire depuis le début
                </ToyButton>
                {!final && endings > 0 && (
                  <ToyButton variant="soft" icon="tree" href={hrefOf({ name: 'tree', id: reply.id })}>
                    {endings === 1 ? 'Découvrir la fin' : `Découvrir les ${endings} fins`}
                  </ToyButton>
                )}
                <ToyButton variant="soft" icon="back" href={hrefOf({ name: 'mine' })}>Retour à Mes dessins</ToyButton>
              </div>
            </section>
            {alternates.length > 0 && (
              <section className="stack">
                <h2 className="section-title">
                  <span>{final
                    ? plural(alternates.length, 'autre fin à ton dessin', 'autres fins à ton dessin')
                    : plural(alternates.length, 'autre réponse à ton dessin', 'autres réponses à ton dessin')}</span>
                </h2>
                <div className="recent__row">
                  {alternates.map((c) => (
                    <StoryThumbnail
                      key={c.id}
                      cards={[c]}
                      href={hrefOf({ name: 'reply', id: c.id })}
                      caption={<>{c.authorName}{unreadIds.has(c.id) ? <> · <strong>nouveau</strong></> : null}</>}
                    />
                  ))}
                </div>
              </section>
            )}
            {others.error && <ToyCard tone="error"><p>Les autres réponses n’ont pas pu être chargées : {others.error}</p></ToyCard>}
          </PageFrame>
        );
      }}
    </Async>
  );
}
