import { useMemo } from 'react';
import { gameTheme, type WeekSummary } from '../backend/api';
import { hrefOf } from '../app/router';
import type { Card } from '../domain/cards';
import { expiryNotice, expiryPhase, formatExpiryDate, gameWindow } from '../domain/expiry';
import { ToyCard } from '../ui';
import { useAsync } from './shared';

/** Phrase discrète sur la disparition des dessins d'un thème. */
export function ExpiryHint({ isoYear, isoWeek }: { isoYear: number; isoWeek: number }) {
  return <p className="hint expiry-hint">{expiryNotice(gameWindow(isoYear, isoWeek).expiresMs)}</p>;
}

/** Dans « Mes dessins »: seulement quand l'échéance approche (le thème est devenu un ancien thème). */
export function MineExpiry({ cards }: { cards: readonly Card[] }) {
  const gameIds = useMemo(() => [...new Set(cards.map((c) => c.gameId))].slice(0, 6), [cards]);
  const key = gameIds.join();
  const weeks = useAsync<WeekSummary[]>(() => Promise.all(gameIds.map((id) => gameTheme(id))).catch(() => []), [key]);
  const now = Date.now();
  const soon = (weeks.data ?? []).filter((w) => expiryPhase(now, gameWindow(w.isoYear, w.isoWeek)) === 'previous');
  if (soon.length === 0) return null;
  return (
    <ToyCard tone="lavender" className="expiry-card">
      {soon.map((w) => (
        <p key={w.gameId} className="plain-text">
          Tes dessins du thème « {w.themeText} » disparaîtront le <strong>{formatExpiryDate(gameWindow(w.isoYear, w.isoWeek).expiresMs)}</strong>.
        </p>
      ))}
      <p className="hint">Pour garder une BD terminée, ouvre-la depuis « Lire l’histoire » et exporte-la en image.</p>
      <a className="expiry-card__link" href={hrefOf({ name: 'read' })}>Retrouver les histoires</a>
    </ToyCard>
  );
}
