import { useEffect, useState, type ReactNode } from 'react';
import { explain } from '../backend/api';
import type { Card } from '../domain/cards';
import { hrefOf } from '../app/router';
import { ScreenHeader, StoryThumbnail, ToyButton, ToyCard, ToySpinner } from '../ui';
import { cardAlt } from '../domain/moderation';

export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e) => alive && setState({ data: null, error: explain(e), loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="loading-block">
      <ToySpinner label={label} />
      <p className="muted">{label}</p>
    </div>
  );
}

export function Async<T>({
  state,
  children,
}: {
  state: { data: T | null; error: string | null; loading: boolean; reload: () => void };
  children: (data: T) => ReactNode;
}) {
  if (state.error) {
    return (
      <ToyCard tone="error" title="Oups, ça n’a pas marché" icon="alert">
        <p>{state.error}</p>
        <div className="row-buttons">
          <ToyButton variant="primary" size="s" icon="redo" onClick={state.reload}>Réessayer</ToyButton>
        </div>
      </ToyCard>
    );
  }
  if (state.data === null) return <Loading />;
  return <>{children(state.data)}</>;
}

export function CardImage({ card, size = 'm' }: { card: Card; size?: 's' | 'm' | 'l' }) {
  return (
    <img
      className={`drawing drawing-${size}`}
      src={card.previewUrl}
      width={320}
      height={240}
      loading="lazy"
      alt={cardAlt(card)}
    />
  );
}

export function CardLink({ card, label }: { card: Card; label?: ReactNode }) {
  return (
    <StoryThumbnail
      cards={[card]}
      href={hrefOf({ name: 'case', id: card.id })}
      caption={
        <>
          Case {card.caseNumber} · {card.authorName}
          {label ? <><br />{label}</> : null}
        </>
      }
    />
  );
}

export function plural(n: number, one: string, many: string) {
  return `${n} ${n > 1 ? many : one}`;
}

interface PageFrameProps {
  title: string;
  subtitle?: string;
  backHref?: string;
  tone?: 'yellow' | 'lavender' | 'pink';
  /** Remplace le bouton Réglages affiché par défaut sur les écrans de premier niveau. */
  right?: ReactNode;
  children: ReactNode;
}

/** En-tête de console + contenu; les écrans de premier niveau y reçoivent l'accès aux réglages. */
export function PageFrame({ title, subtitle, backHref, tone, right, children }: PageFrameProps) {
  const gear = right ?? (backHref ? undefined : <ToyButton variant="soft" size="s" iconOnly icon="gear" href={hrefOf({ name: 'settings' })} aria-label="Réglages" />);
  return (
    <>
      <ScreenHeader title={title} subtitle={subtitle} backHref={backHref} tone={tone} right={gear} />
      <div className="screen">{children}</div>
    </>
  );
}
