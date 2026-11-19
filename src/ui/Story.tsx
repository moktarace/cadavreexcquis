import type { ReactNode } from 'react';
import { siblingLabel, type Card } from '../domain/cards';
import { Mascot, PixelIcon } from './PixelIcon';
import { ToyButton, ToyCard, ToySpinner } from './Toy';
import { cardAlt } from '../domain/moderation';

// ───────────── StoryThumbnail ─────────────

interface StoryThumbnailProps {
  /** Une case (aperçu simple) ou les cases d'une histoire (petit yonkoma 2×2). */
  cards: readonly Card[];
  href: string;
  caption?: ReactNode;
  badge?: ReactNode;
}

export function StoryThumbnail({ cards, href, caption, badge }: StoryThumbnailProps) {
  const multi = cards.length > 1;
  return (
    <a className="story-thumb" href={href}>
      <span className={`story-thumb__frame ${multi ? 'is-multi' : ''}`}>
        {cards.slice(0, 4).map((c) => (
          <img key={c.id} src={c.previewUrl} width={320} height={240} loading="lazy" alt={cardAlt(c)} />
        ))}
        {badge && <span className="story-thumb__badge">{badge}</span>}
      </span>
      {caption && <span className="story-thumb__caption">{caption}</span>}
    </a>
  );
}

// ───────────── BranchNode ─────────────

interface BranchNodeProps {
  card: Card;
  /** Rang parmi les alternatives (0 = A). Absent quand la case est seule. */
  siblingIndex?: number;
  state: 'idle' | 'path' | 'selected';
  eligible: boolean;
  own: boolean;
  onSelect: () => void;
}

export function BranchNode({ card, siblingIndex, state, eligible, own, onSelect }: BranchNodeProps) {
  const label = `Case ${card.caseNumber}${siblingIndex !== undefined ? siblingLabel(siblingIndex) : ''}`;
  const suites = card.childCount > 0 ? `, ${card.childCount} suite${card.childCount > 1 ? 's' : ''}` : '';
  return (
    <button
      type="button"
      className={`branch-node is-${state} ${eligible ? 'is-eligible' : ''} ${own ? 'is-own' : ''}`}
      aria-pressed={state !== 'idle'}
      aria-label={`${label} de ${card.authorName}${suites}${own ? ', ton dessin' : ''}${card.caseNumber === 4 ? ', fin' : ''}`}
      onClick={onSelect}
    >
      <span className="branch-node__frame">
        <img src={card.previewUrl} width={320} height={240} loading="lazy" alt="" />
        {card.caseNumber === 4 && <span className="branch-node__tag branch-node__tag--end">Fin</span>}
        {own && <span className="branch-node__tag branch-node__tag--own"><PixelIcon name="lock" size={14} /></span>}
        {eligible && !own && <span className="branch-node__tag branch-node__tag--go"><PixelIcon name="plus" size={14} /></span>}
        {card.childCount > 0 && <span className="branch-node__count">{card.childCount}</span>}
      </span>
      <span className="branch-node__label">{label}</span>
      <span className="branch-node__author">{card.authorName}</span>
    </button>
  );
}

// ───────────── WeeklyThemeCard ─────────────

/** « 6 j 12 h 35 min »: pas de secondes, ce n'est pas une échéance mais une attente tranquille. */
export function formatDelay(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d} j ${h} h ${String(m).padStart(2, '0')} min`;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min`;
}

interface WeeklyThemeCardProps {
  status: 'loading' | 'ready' | 'error' | 'unconfigured';
  themeText?: string;
  weekLabel?: string;
  remaining?: string;
  stale?: boolean;
  error?: string | null;
  /** « Les dessins de ce thème disparaîtront le lundi … » */
  expiryNote?: string;
  onRetry?: () => void;
}

export function WeeklyThemeCard({ status, themeText, weekLabel, remaining, stale, error, expiryNote, onRetry }: WeeklyThemeCardProps) {
  if (!themeText && status === 'unconfigured') {
    return (
      <ToyCard tone="error" title="Serveur non configuré">
        <p>Renseigne VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY dans .env.local.</p>
      </ToyCard>
    );
  }
  if (!themeText && status === 'error') {
    return (
      <ToyCard tone="error" title="Impossible de charger le thème">
        <p>{error}</p>
        {onRetry && <ToyButton variant="primary" size="s" icon="redo" onClick={onRetry}>Réessayer</ToyButton>}
      </ToyCard>
    );
  }
  return (
    <section className="theme-card" aria-live="polite">
      <span className="theme-card__ribbon">Thème de la semaine</span>
      <div className="theme-card__stage">
        <Mascot size={70} className="theme-card__mascot" />
        <div className="theme-card__text">
          {themeText ? <p className="theme-card__theme">{themeText}</p> : <ToySpinner />}
        </div>
        <PixelIcon name="star" size={22} className="theme-card__star theme-card__star--a" />
        <PixelIcon name="star" size={16} className="theme-card__star theme-card__star--b" />
      </div>
      <p className="theme-card__meta">
        <PixelIcon name="clock" size={16} />
        <span>
          {weekLabel ? `${weekLabel} · ` : ''}
          {remaining ? <>nouveau thème dans <b>{remaining}</b></> : 'calcul du prochain thème…'}
          {stale ? ' · hors connexion' : ''}
        </span>
      </p>
      {expiryNote && themeText && <p className="theme-card__expiry">{expiryNote}</p>}
    </section>
  );
}
