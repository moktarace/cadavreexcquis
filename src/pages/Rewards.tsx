import { useEffect, useMemo, useRef, useState } from 'react';
import { cardPath, cardSubtree, myRewardEvents } from '../backend/api';
import { useRewards } from '../app/rewards';
import { hrefOf } from '../app/router';
import type { Card } from '../domain/cards';
import {
  FINISHED_SUBTITLE, FINISHED_TITLE, distinctAuthors, groupRewardEvents, hasRewardNews, inspiredMessage,
  storiesDoneMessage, type RewardEvent,
} from '../domain/rewards';
import { STICKERS, unlockCondition, unlockedSet, type StickerDef } from '../domain/stickers';
import { Confetti, StickerArt, StoryThumbnail, ToyButton, ToyCard, ToyDialog } from '../ui';
import { Async, PageFrame, useAsync } from './shared';

const authorsLine = (cards: readonly Card[]) => {
  const names = distinctAuthors(cards).map((a) => a.authorName);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`;
};

/** Les quatre cases dans leur ordre, révélées une à une, la dernière mise en valeur. L'animation se passe d'un tap. */
export function StoryCelebration({ cards, children }: { cards: readonly Card[]; children?: React.ReactNode }) {
  const [skipped, setSkipped] = useState(false);
  return (
    <div className={`reveal celebration ${skipped ? 'is-skipped' : ''}`}>
      <Confetti />
      <h1 className="reveal__title">{FINISHED_TITLE}</h1>
      <p className="reveal__text">{FINISHED_SUBTITLE}</p>
      <div className="reveal__board" role="list" aria-label="Les quatre cases de l’histoire">
        {cards.map((c) => (
          <figure
            key={c.id}
            role="listitem"
            className={`reveal__cell ${c.caseNumber === 4 ? 'reveal__cell--mine' : ''}`}
            style={{ ['--i' as string]: c.caseNumber - 1 }}
            aria-label={`Case ${c.caseNumber} de ${c.authorName}`}
          >
            <img src={c.previewUrl} width={320} height={240} alt="" />
            <span className="reveal__num" aria-hidden="true">{c.caseNumber}</span>
            <span className="reveal__author">{c.authorName}</span>
          </figure>
        ))}
      </div>
      <p className="hint">Par {authorsLine(cards)}.</p>
      {!skipped && <ToyButton variant="ghost" size="s" onClick={() => setSkipped(true)}>Passer l’animation</ToyButton>}
      {children}
    </div>
  );
}

/** Un participant revient: ouvre une histoire terminée en son absence. */
export function FinishedPage({ id }: { id: string }) {
  const { news, markSeen, loaded } = useRewards();
  const path = useAsync(() => cardPath(id), [id]);
  const event = news.find((e) => e.kind === 'story_done' && e.endId === id);

  useEffect(() => {
    if (event && path.data) void markSeen([event.id]);
  }, [event, path.data, markSeen]);

  return (
    <Async state={path}>
      {(cards) =>
        cards.length === 4 ? (
          <div className="screen">
            <StoryCelebration cards={cards}>
              <div className="reveal__actions">
                <ToyButton variant="primary" size="l" icon="book" href={hrefOf({ name: 'story', id })}>Lire l’histoire</ToyButton>
                <ToyButton variant="soft" icon="back" href={hrefOf({ name: 'mine' })}>Retour à Mes dessins</ToyButton>
              </div>
            </StoryCelebration>
          </div>
        ) : (
          <PageFrame title="Histoire terminée" tone="pink" backHref={hrefOf({ name: 'mine' })}>
            <ToyCard tone="lavender">
              <p className="plain-text"><strong>Cette histoire a disparu avec son thème.</strong> Ta récompense, elle, reste acquise !</p>
              {!loaded && <p className="hint">Chargement…</p>}
            </ToyCard>
          </PageFrame>
        )
      }
    </Async>
  );
}

// ───────────── Tampon débloqué ─────────────

/** « Nouveau tampon débloqué ! » Plusieurs déblocages simultanés tiennent dans la même fenêtre. */
export function UnlockDialog({ stickers, onDone, onClose }: { stickers: readonly StickerDef[]; onDone: () => void; onClose: () => void }) {
  const [first, ...others] = stickers;
  if (!first) return null;
  return (
    <ToyDialog
      open
      title="Nouveau tampon débloqué !"
      onClose={onClose}
      actions={<ToyButton variant="primary" size="l" icon="star" onClick={onDone}>Découvrir mon tampon</ToyButton>}
    >
      <div className="unlock">
        <div className="unlock__stage" aria-hidden="true">
          <StickerArt def={first} size={9} className="unlock__art" />
        </div>
        <p className="unlock__name">{first.name} !</p>
        <p className="plain-text">{first.blurb}</p>
        {others.length > 0 && (
          <div className="unlock__more">
            <p className="hint">Et aussi :</p>
            <ul>
              {others.map((s) => (
                <li key={s.id}><StickerArt def={s} size={2} /><span>{s.name}</span></li>
              ))}
            </ul>
          </div>
        )}
        <p className="hint">Tu le retrouveras dans l’éditeur, dans Outils &gt; Tampons.</p>
      </div>
    </ToyDialog>
  );
}

// ───────────── Mes dessins ─────────────

function StoryRow({ event, onSeen }: { event: RewardEvent; onSeen: (id: string) => void }) {
  const path = useAsync(() => (event.endId && !event.expired ? cardPath(event.endId) : Promise.resolve([] as Card[])), [event.endId, event.expired]);
  return (
    <Async state={path}>
      {(cards) =>
        cards.length === 4 && event.endId ? (
          <StoryThumbnail cards={cards} href={hrefOf({ name: 'finished', id: event.endId })} badge="Nouveau" caption={authorsLine(cards)} />
        ) : (
          <div className="story-gone">
            <p className="hint">Les dessins de cette histoire ont disparu avec leur thème.</p>
            <ToyButton variant="soft" size="s" onClick={() => onSeen(event.id)}>OK</ToyButton>
          </div>
        )
      }
    </Async>
  );
}

function InspiredCard({ event, onSeen }: { event: RewardEvent; onSeen: (id: string) => void }) {
  const ends = useAsync(async () => {
    if (!event.rootId || event.expired) return [] as Card[];
    return (await cardSubtree(event.rootId)).filter((c) => c.caseNumber === 4 && !c.hidden);
  }, [event.rootId, event.expired]);
  return (
    <ToyCard tone="yellow" className="celebrate-card">
      <p className="plain-text"><strong>{inspiredMessage(event.n ?? 1)}</strong></p>
      {(ends.data?.length ?? 0) > 0 && (
        <div className="recent__row">
          {ends.data!.slice(0, 6).map((c) => (
            <StoryThumbnail key={c.id} cards={[c]} href={hrefOf({ name: 'story', id: c.id })} caption={`Fin de ${c.authorName}`} />
          ))}
        </div>
      )}
      <ToyButton variant="success" size="s" icon="check" onClick={() => onSeen(event.id)}>Super !</ToyButton>
    </ToyCard>
  );
}

const SESSION_KEY = 'cl.unlockShown.v1';

/** Nouveautés de récompense, regroupées: jamais une file d'animations à subir. */
export function RewardNewsSection() {
  const { news, markSeen } = useRewards();
  const grouped = useMemo(() => groupRewardEvents(news), [news]);
  const [dialog, setDialog] = useState(false);
  const [shown, setShown] = useState(3);
  const autoOpened = useRef(false);

  // Une seule ouverture automatique par session et par lot de tampons; ensuite, la bannière reste là.
  useEffect(() => {
    if (autoOpened.current || grouped.stickers.length === 0) return;
    const key = grouped.stickers.map((s) => s.event.id).sort().join();
    try {
      if (sessionStorage.getItem(SESSION_KEY) === key) return;
      sessionStorage.setItem(SESSION_KEY, key);
    } catch {
      // stockage de session indisponible: on ouvre quand même une fois
    }
    autoOpened.current = true;
    setDialog(true);
  }, [grouped.stickers]);

  if (!hasRewardNews(grouped)) return null;
  const openable = grouped.stories.filter((e) => !e.expired && e.endId);
  const gone = grouped.stories.filter((e) => e.expired || !e.endId);
  const seen = (id: string) => void markSeen([id]);
  const discover = () => {
    void markSeen(grouped.stickers.map((s) => s.event.id));
    setDialog(false);
  };

  return (
    <section className="discover" aria-labelledby="rewards-title">
      <h2 className="section-title" id="rewards-title"><span>À fêter</span></h2>
      {grouped.stories.length > 0 && (
        <ToyCard tone="green" className="celebrate-card">
          <p className="plain-text"><strong>{storiesDoneMessage(grouped.stories.length)}</strong></p>
          {openable.length > 0 && (
            <div className="recent__row">
              {openable.slice(0, shown).map((e) => <StoryRow key={e.id} event={e} onSeen={seen} />)}
            </div>
          )}
          {openable.length > shown && <ToyButton variant="soft" size="s" icon="plus" onClick={() => setShown(shown + 3)}>Voir les {openable.length - shown} autres</ToyButton>}
          {gone.length > 0 && (
            <>
              <p className="hint">{gone.length > 1 ? 'Les dessins de ces histoires ont' : 'Les dessins de cette histoire ont'} disparu avec leur thème, mais ta récompense reste acquise.</p>
              <ToyButton variant="soft" size="s" icon="check" onClick={() => void markSeen(gone.map((e) => e.id))}>OK</ToyButton>
            </>
          )}
        </ToyCard>
      )}
      {grouped.inspired.map((e) => <InspiredCard key={e.id} event={e} onSeen={seen} />)}
      {grouped.stickers.length > 0 && (
        <ToyCard tone="yellow" className="celebrate-card">
          <div className="unlock-banner">
            <StickerArt def={grouped.stickers[0].def} size={3} />
            <p className="plain-text"><strong>{grouped.stickers.length > 1 ? `${grouped.stickers.length} nouveaux tampons débloqués !` : 'Nouveau tampon débloqué !'}</strong></p>
          </div>
          <ToyButton variant="primary" size="s" icon="star" onClick={() => setDialog(true)}>Découvrir mon tampon</ToyButton>
        </ToyCard>
      )}
      {dialog && <UnlockDialog stickers={grouped.stickers.map((s) => s.def)} onDone={discover} onClose={() => setDialog(false)} />}
    </section>
  );
}

/** Compteurs et collection de tampons: discrets, sans classement. */
export function CollectionCard() {
  const { progress } = useRewards();
  const unlocked = unlockedSet(progress.stickers);
  const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
  return (
    <details className="collection">
      <summary>
        <span className="collection__stats">
          <strong>{plural(progress.completed, 'histoire terminée', 'histoires terminées')}</strong> à plusieurs ·{' '}
          <strong>{plural(progress.inspired, 'histoire inspirée', 'histoires inspirées')}</strong>
        </span>
        <span className="collection__count">Mes tampons : {unlocked.size}/{STICKERS.length}</span>
      </summary>
      <ul className="sticker-grid">
        {STICKERS.map((def) => {
          const open = unlocked.has(def.id);
          return (
            <li key={def.id} className={open ? '' : 'is-locked'}>
              <StickerArt def={def} size={2} locked={!open} />
              <span>{open ? def.name : unlockCondition(def)}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Dernières histoires terminées encore lisibles (celles déjà découvertes; les nouvelles sont dans « À fêter »). */
export function FinishedShelf() {
  const { news } = useRewards();
  const list = useAsync(() => myRewardEvents({ unseen: false, kind: 'story_done', limit: 6 }), [news.length]);
  const fresh = new Set(news.map((e) => e.id));
  const events = (list.data ?? []).filter((e) => !fresh.has(e.id) && e.endId);
  if (events.length === 0) return null;
  return (
    <section className="stack" aria-labelledby="finished-title">
      <h2 className="section-title" id="finished-title"><span>Mes histoires terminées</span></h2>
      <div className="recent__row">
        {events.map((e) => <StoryRow key={e.id} event={e} onSeen={() => undefined} />)}
      </div>
    </section>
  );
}


/** Pour l'auteur de la case 4: la félicitation arrive tout de suite, sur l'écran de publication. */
export function PublishedRewards({ cards }: { cards: readonly Card[] }) {
  const { news, markSeen, refresh } = useRewards();
  const end = cards[cards.length - 1];
  const [celebrated, setCelebrated] = useState<{ done: boolean; inspired: number | null }>({ done: false, inspired: null });
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mine = news.filter((e) => e.endId === end.id);
  const done = mine.find((e) => e.kind === 'story_done');
  const inspired = mine.find((e) => e.kind === 'inspired');
  useEffect(() => {
    if (!done && !inspired) return;
    setCelebrated((c) => ({ done: c.done || !!done, inspired: inspired?.n ?? c.inspired }));
    void markSeen([done?.id, inspired?.id].filter((x): x is string => !!x));
  }, [done, inspired, markSeen]);

  const stickers = groupRewardEvents(news).stickers;
  return (
    <div className="stack published-rewards">
      {celebrated.done && <p className="published-rewards__line"><strong>+1 histoire collective terminée</strong></p>}
      {celebrated.inspired !== null && <p className="published-rewards__line"><strong>{inspiredMessage(celebrated.inspired)}</strong></p>}
      {stickers.length > 0 && (
        <ToyButton variant="soft" size="s" icon="star" onClick={() => setDialog(true)}>Nouveau tampon débloqué !</ToyButton>
      )}
      {dialog && (
        <UnlockDialog
          stickers={stickers.map((s) => s.def)}
          onClose={() => setDialog(false)}
          onDone={() => {
            void markSeen(stickers.map((s) => s.event.id));
            setDialog(false);
          }}
        />
      )}
    </div>
  );
}

export { authorsLine };
