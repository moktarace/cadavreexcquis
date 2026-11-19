import { useState } from 'react';
import { cardChildren, cardPath, cardSubtree, gameTheme } from '../backend/api';
import { go, hrefOf } from '../app/router';
import { useGame } from '../app/game';
import { useMarkReplyRead } from '../app/replies';
import { buildTree, cannotContinue, type Card, type TreeNode } from '../domain/cards';
import { drawLabel } from '../domain/play';
import { exportYonkoma, shareYonkoma } from '../editor/export';
import { StoryThumbnail, Swiper, ThreadPeek, ToyButton, ToyCard, ToyTabs, ToyToggle, type TabDef } from '../ui';
import { BranchExplorer } from './BranchExplorer';
import { Async, CardLink, PageFrame, plural, useAsync } from './shared';
import { ExpiryHint } from './Expiry';
import { ReportButton } from './ReportButton';
import { ShareButton } from './ShareButton';
import { cardAlt } from '../domain/moderation';

// ───────────── Case ─────────────

export function CasePage({ id }: { id: string }) {
  const { me } = useGame();
  const path = useAsync(() => cardPath(id), [id]);
  useMarkReplyRead(path.data);
  const kids = useAsync(() => cardChildren(id), [id]);

  const startContinuation = () => go({ name: 'draw', parentId: id });

  return (
    <Async state={path}>
      {(cards) => {
        const card = cards[cards.length - 1];
        if (!card) {
          return (
            <PageFrame title="Case introuvable" backHref={hrefOf({ name: 'read' })}>
              <ToyCard tone="error" title="Cette case est introuvable." icon="alert" />
            </PageFrame>
          );
        }
        const blocked = cannotContinue(card, me?.userId ?? null);
        return (
          <PageFrame title={`Case ${card.caseNumber}`} subtitle={card.authorName} backHref={hrefOf({ name: 'read' })} tone="lavender">
            <section className="stack">
              <ThreadPeek key={card.id} cards={cards} />
              <div className="row-buttons">
                <ToyButton variant="primary" icon="pencil" disabled={blocked !== null} onClick={startContinuation}>
                  {drawLabel(card.caseNumber)}
                </ToyButton>
                {card.caseNumber === 4 && <ToyButton variant="success" icon="book" href={hrefOf({ name: 'story', id: card.id })}>Lire l’histoire</ToyButton>}
                <ToyButton variant="soft" icon="tree" href={hrefOf({ name: 'tree', id: card.id })}>Toutes les suites</ToyButton>
                {card.authorId === me?.userId && card.caseNumber < 4 && <ShareButton cardId={card.id} />}
                <ReportButton card={card} onDone={path.reload} />
              </div>
              {blocked && <p className="hint">{blocked}</p>}
            </section>
            <Async state={kids}>
              {(children) => (
                <section className="stack">
                  <h2 className="section-title">
                    <span>{children.length === 0 ? 'Personne n’a encore imaginé de suite' : children.length === 1 ? 'Une suite imaginée' : `${children.length} suites imaginées`}</span>
                  </h2>
                  {children.length > 0 && (
                    <div className="grid">
                      {children.map((c) => (
                        <CardLink key={c.id} card={c} label={c.caseNumber === 4 ? 'fin' : undefined} />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </Async>
          </PageFrame>
        );
      }}
    </Async>
  );
}

// ───────────── Lecture ─────────────

const READ_TABS: readonly TabDef[] = [
  { id: 'flip', label: 'Feuilleter', icon: 'book' },
  { id: 'board', label: 'Planche', icon: 'pages' },
];

function ThemeBanner({ gameId }: { gameId: string }) {
  const info = useAsync(() => gameTheme(gameId), [gameId]);
  return info.data ? (
    <>
      <p className="theme-banner">{info.data.themeText}</p>
      <ExpiryHint isoYear={info.data.isoYear} isoWeek={info.data.isoWeek} />
    </>
  ) : null;
}

/** Les autres versions d'une même case: un tap pour revenir à l'embranchement. */
export function BranchSwitch({ alternates, final = false }: { alternates: readonly Card[]; final?: boolean }) {
  const [open, setOpen] = useState(false);
  if (alternates.length === 0) return null;
  return (
    <div className="branch-switch">
      <ToyButton variant="soft" size="s" icon="tree" selected={open} onClick={() => setOpen(!open)}>
        {final
          ? alternates.length === 1 ? 'Découvrir une autre fin' : `Découvrir les ${alternates.length} autres fins`
          : alternates.length === 1 ? 'Voir une autre suite' : `Voir les ${alternates.length} autres suites`}
      </ToyButton>
      {open && (
        <p className="hint">
          Et si l’histoire continuait autrement ? Plusieurs joueurs peuvent imaginer {final ? 'des fins' : 'des suites'} différentes à partir des mêmes cases.
        </p>
      )}
      {open && (
        <div className="branch-switch__row">
          {alternates.map((c) => (
            <StoryThumbnail
              key={c.id}
              cards={[c]}
              href={hrefOf({ name: c.caseNumber === 4 ? 'story' : 'case', id: c.id })}
              caption={c.authorName}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Alternates({ card, parentId }: { card: Card; parentId: string }) {
  const siblings = useAsync(() => cardChildren(parentId), [parentId]);
  return <BranchSwitch final={card.caseNumber === 4} alternates={(siblings.data ?? []).filter((c) => c.id !== card.id)} />;
}

/** Feuilletage case par case, au doigt; les autres continuations sont sous chaque case. */
export function StoryFlip({ cards, withAlternates = true }: { cards: readonly Card[]; withAlternates?: boolean }) {
  const [index, setIndex] = useState(0);
  return (
    <div className="stack">
      <Swiper count={cards.length} index={index} onIndexChange={setIndex} label="Cases de l’histoire">
        {cards.map((c, i) => (
          <figure key={c.id} className="swiper__slide reader__slide">
            <div className="reader__frame">
              <img className="drawing" src={c.previewUrl} width={320} height={240} alt={cardAlt(c)} />
              <span className="reader__num" aria-hidden="true">{c.caseNumber}</span>
            </div>
            <figcaption className="thread__caption">Case {c.caseNumber} · {c.authorName}</figcaption>
            {withAlternates && i > 0 && <Alternates card={c} parentId={cards[i - 1].id} />}
            <ReportButton card={c} />
          </figure>
        ))}
      </Swiper>
      <div className="pager">
        <ToyButton variant="soft" iconOnly icon="back" aria-label="Case précédente" disabled={index === 0} onClick={() => setIndex(index - 1)} />
        <span className="pager__count" role="status">{index + 1} / {cards.length}</span>
        <ToyButton variant="soft" iconOnly icon="play" aria-label="Case suivante" disabled={index >= cards.length - 1} onClick={() => setIndex(index + 1)} />
      </div>
      {index > 0 && <ToyButton variant="ghost" size="s" icon="back" onClick={() => setIndex(0)}>Revenir au début</ToyButton>}
    </div>
  );
}

export function StoryBoard({ cards }: { cards: readonly Card[] }) {
  return (
    <div className="yonkoma" id="read-panel" role="tabpanel" aria-labelledby="read-board">
      {cards.map((c) => (
        <a key={c.id} className="yonkoma__cell" href={hrefOf({ name: 'case', id: c.id })}>
          <img src={c.previewUrl} width={320} height={240} alt={cardAlt(c)} />
          <span className="yonkoma__num" aria-hidden="true">{c.caseNumber}</span>
          <span className="yonkoma__author">{c.authorName}</span>
        </a>
      ))}
    </div>
  );
}

const isNarrow = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches;

export function StoryPage({ id }: { id: string }) {
  const { me } = useGame();
  const path = useAsync(() => cardPath(id), [id]);
  useMarkReplyRead(path.data);
  const [mode, setMode] = useState(isNarrow() ? 'flip' : 'board');
  const [showAlt, setShowAlt] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const parentId = path.data && path.data.length > 1 ? path.data[path.data.length - 2].id : null;
  const siblings = useAsync(() => (parentId ? cardChildren(parentId) : Promise.resolve([])), [parentId]);

  return (
    <Async state={path}>
      {(cards) => {
        const complete = cards.length === 4;
        const authors = [...new Set(cards.map((c) => c.authorName))];
        return (
          <PageFrame
            title={complete ? 'Histoire terminée' : 'Histoire inachevée'}
            backHref={hrefOf({ name: 'case', id })}
            tone="pink"
            right={<ToyButton variant="soft" size="s" iconOnly icon="home" href={hrefOf({ name: 'home' })} aria-label="Accueil" />}
          >
            <ThemeBanner gameId={cards[0].gameId} />
            <div className="read-layout">
              <div className="stack">
                <ToyTabs tabs={READ_TABS} value={mode} onChange={(t) => t && setMode(t)} label="Mode de lecture" idPrefix="read" />
                {mode === 'board' ? <StoryBoard cards={cards} /> : <div id="read-panel" role="tabpanel" aria-labelledby="read-flip"><StoryFlip cards={cards} /></div>}
              </div>
              <aside className="stack">
                <p className="hint">Auteurs : {authors.join(', ')}.</p>
                <div className="row-buttons">
                  {!complete && cannotContinue(cards[cards.length - 1], me?.userId ?? null) === null && (
                    <ToyButton variant="primary" icon="pencil" onClick={() => go({ name: 'draw', parentId: cards[cards.length - 1].id })}>{drawLabel(cards[cards.length - 1].caseNumber)}</ToyButton>
                  )}
                  {complete && cards.length > 2 && cannotContinue(cards[cards.length - 2], me?.userId ?? null) === null && (
                    <ToyButton variant="secondary" icon="pencil" onClick={() => go({ name: 'draw', parentId: cards[cards.length - 2].id })}>Inventer une autre fin</ToyButton>
                  )}
                  <ToyButton variant="soft" icon="tree" href={hrefOf({ name: 'tree', id })}>Toutes les suites</ToyButton>
                  <ToyButton
                    variant="soft"
                    icon="download"
                    onClick={() => exportYonkoma(cards).catch((e) => setMessage(e instanceof Error ? e.message : 'Export impossible'))}
                  >
                    Exporter en PNG
                  </ToyButton>
                  {typeof navigator.share === 'function' && (
                    <ToyButton variant="soft" icon="share" onClick={() => shareYonkoma(cards).catch(() => setMessage('Partage annulé ou impossible.'))}>Partager</ToyButton>
                  )}
                </div>
                {message && <ToyCard tone="error"><p>{message}</p></ToyCard>}
                {mode === 'board' && (
                  <Async state={siblings}>
                    {(others) => {
                      const alt = others.filter((c) => c.id !== id);
                      if (alt.length === 0) return null;
                      return (
                        <section className="read-options">
                          <ToyToggle checked={showAlt} onChange={setShowAlt} hint={plural(alt.length, 'autre possibilité', 'autres possibilités')}>
                            {complete ? 'Découvrir une autre fin' : 'Voir une autre suite'}
                          </ToyToggle>
                          {showAlt && (
                            <div className="recent__row">
                              {alt.map((c) => (
                                <StoryThumbnail
                                  key={c.id}
                                  cards={[c]}
                                  href={hrefOf({ name: c.caseNumber === 4 ? 'story' : 'case', id: c.id })}
                                  caption={c.authorName}
                                />
                              ))}
                            </div>
                          )}
                        </section>
                      );
                    }}
                  </Async>
                )}
              </aside>
            </div>
          </PageFrame>
        );
      }}
    </Async>
  );
}

// ───────────── Arbre d'une histoire ─────────────

export function TreePage({ id }: { id: string }) {
  const { me } = useGame();
  const tree = useAsync<TreeNode | false>(async () => {
    const root = (await cardPath(id))[0];
    if (!root) return false;
    return buildTree(root, await cardSubtree(root.id));
  }, [id]);

  return (
    <PageFrame title="Toutes les suites" backHref={hrefOf({ name: 'case', id })} tone="lavender">
      <Async state={tree}>
        {(root) =>
          root ? (
            <BranchExplorer root={root} userId={me?.userId ?? null} initialId={id} />
          ) : (
            <ToyCard tone="error" title="Cette histoire est introuvable." icon="alert" />
          )
        }
      </Async>
    </PageFrame>
  );
}
