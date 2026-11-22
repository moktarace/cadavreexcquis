import type { ReactNode } from 'react';
import { PixelIcon } from './PixelIcon';
import type { IconName } from './sprites';
import { ToyButton } from './Toy';

// ───────────── Logo ─────────────

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <div className={`logo ${compact ? 'logo--compact' : ''}`} role="img" aria-label="Cadavre Exquis">
      <PixelIcon name="star" size={compact ? 14 : 22} className="logo__star logo__star--l" />
      <span className="logo__text" aria-hidden="true">
        <span>Cadavre</span>
        <span>Exquis</span>
      </span>
      <PixelIcon name="star" size={compact ? 14 : 22} className="logo__star logo__star--r" />
    </div>
  );
}

// ───────────── ScreenHeader ─────────────

interface ScreenHeaderProps {
  title: string;
  /** Lien de retour; sans lui, pas de flèche. */
  backHref?: string;
  right?: ReactNode;
  subtitle?: string;
  tone?: 'yellow' | 'lavender' | 'pink';
}

export function ScreenHeader({ title, backHref, right, subtitle, tone = 'yellow' }: ScreenHeaderProps) {
  return (
    <header className={`screen-header screen-header--${tone}`}>
      {backHref ? (
        <ToyButton variant="soft" size="s" iconOnly icon="back" href={backHref} aria-label="Retour" />
      ) : (
        <span className="screen-header__spacer" />
      )}
      <div className="screen-header__titles">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="screen-header__right">{right ?? <span className="screen-header__spacer" />}</div>
    </header>
  );
}

// ───────────── Dock (navigation principale) ─────────────

export interface DockItem {
  id: string;
  label: string;
  icon: IconName;
  href: string;
  active: boolean;
  /** Pastille sans chiffre: quelque chose de nouveau attend dans cet onglet. */
  badge?: boolean;
}

interface DockProps {
  items: readonly DockItem[];
  /** Bouton central, toujours à portée de pouce: l'action principale du jeu. */
  center: DockItem;
}

export function Dock({ items, center }: DockProps) {
  const half = Math.ceil(items.length / 2);
  const render = (it: DockItem) => (
    <a key={it.id} className={`dock__item ${it.active ? 'is-active' : ''}`} href={it.href} aria-current={it.active ? 'page' : undefined}>
      <span className="dock__icon">
        <PixelIcon name={it.icon} size={24} />
        {it.badge && <span className="dock__badge" aria-hidden="true" />}
      </span>
      <span>{it.label}{it.badge && <span className="sr-only"> : nouveautés à découvrir</span>}</span>
    </a>
  );
  return (
    <nav className="dock" aria-label="Navigation principale">
      <div className="dock__side">{items.slice(0, half).map(render)}</div>
      <a className={`dock__draw ${center.active ? 'is-active' : ''}`} href={center.href} aria-current={center.active ? 'page' : undefined}>
        <PixelIcon name={center.icon} size={36} />
        <span>{center.label}</span>
      </a>
      <div className="dock__side">{items.slice(half).map(render)}</div>
    </nav>
  );
}
