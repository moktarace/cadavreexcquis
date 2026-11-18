import { useEffect, useId, useRef, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { PixelIcon } from './PixelIcon';
import type { IconName } from './sprites';

// ───────────── ToySpinner ─────────────

/** Chargement: quatre pixels qui tournent par à-coups, comme un curseur de console. */
export function ToySpinner({ label = 'Chargement' }: { label?: string }) {
  return (
    <span className="toy-spinner" role="status" aria-label={label}>
      <i /><i /><i /><i />
    </span>
  );
}

// ───────────── ToyButton ─────────────

export type ToyVariant = 'primary' | 'secondary' | 'soft' | 'success' | 'danger' | 'ghost';

interface ToyButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ToyVariant;
  size?: 's' | 'm' | 'l' | 'xl';
  icon?: IconName;
  iconRight?: IconName;
  /** État « sélectionné » (outil actif, bascule activée). */
  selected?: boolean;
  loading?: boolean;
  block?: boolean;
  /** Rend un lien au lieu d'un bouton, avec la même apparence. */
  href?: string;
  /** Bouton carré réduit à son icône: `aria-label` obligatoire. */
  iconOnly?: boolean;
  children?: ReactNode;
}

const ICON_PX = { s: 18, m: 24, l: 30, xl: 36 } as const;

export function ToyButton({
  variant = 'soft',
  size = 'm',
  icon,
  iconRight,
  selected,
  loading,
  block,
  href,
  iconOnly,
  className,
  children,
  disabled,
  onClick,
  type = 'button',
  ...rest
}: ToyButtonProps) {
  const isDisabled = disabled || loading;
  const cls = [
    'toy-btn',
    `toy-btn--${variant}`,
    `toy-btn--${size}`,
    selected && 'is-selected',
    loading && 'is-loading',
    block && 'toy-btn--block',
    iconOnly && 'toy-btn--icon',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const px = ICON_PX[size];
  const content = (
    <>
      {loading ? <ToySpinner label="" /> : icon && <PixelIcon name={icon} size={px} />}
      {children !== undefined && children !== null && <span className="toy-btn__label">{children}</span>}
      {iconRight && !loading && <PixelIcon name={iconRight} size={px} />}
    </>
  );

  if (href !== undefined) {
    const guard = (e: MouseEvent<HTMLAnchorElement>) => {
      if (isDisabled) e.preventDefault();
    };
    return (
      <a
        className={cls}
        href={isDisabled ? undefined : href}
        aria-disabled={isDisabled || undefined}
        aria-busy={loading || undefined}
        aria-label={rest['aria-label']}
        aria-pressed={selected}
        title={rest.title}
        onClick={guard}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      {...rest}
      type={type}
      className={cls}
      disabled={isDisabled}
      aria-pressed={selected}
      aria-busy={loading || undefined}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

// ───────────── ToyCard ─────────────

export type ToyTone = 'plain' | 'yellow' | 'pink' | 'lavender' | 'green' | 'error';

interface ToyCardProps {
  tone?: ToyTone;
  title?: ReactNode;
  icon?: IconName;
  /** Contenu secondaire à droite du titre. */
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
  role?: string;
}

export function ToyCard({ tone = 'plain', title, icon, aside, children, className, role }: ToyCardProps) {
  return (
    <section className={`toy-card toy-card--${tone} ${className ?? ''}`} role={role ?? (tone === 'error' ? 'alert' : undefined)}>
      {(title || aside) && (
        <header className="toy-card__head">
          {icon && <PixelIcon name={icon} size={24} />}
          {title && <h3>{title}</h3>}
          {aside && <div className="toy-card__aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** État vide chaleureux, avec une mascotte facultative et une action. */
export function EmptyState({ title, children, action, mascot }: { title: string; children?: ReactNode; action?: ReactNode; mascot?: ReactNode }) {
  return (
    <ToyCard tone="lavender" className="empty-state">
      {mascot}
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action}
    </ToyCard>
  );
}

// ───────────── ToyTabs ─────────────

export interface TabDef {
  id: string;
  label: string;
  icon?: IconName;
}

interface ToyTabsProps {
  tabs: readonly TabDef[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** Un second appui sur l'onglet actif le referme (panneaux repliables de l'éditeur). */
  collapsible?: boolean;
  label: string;
  idPrefix?: string;
}

/** Onglets en forme de classeur, comme les menus d'une console portable. */
export function ToyTabs({ tabs, value, onChange, collapsible, label, idPrefix = 'tab' }: ToyTabsProps) {
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    onChange(tabs[next].id);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="toy-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            id={`${idPrefix}-${t.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={active || (value === null && i === 0) ? 0 : -1}
            className={`toy-tab ${active ? 'is-active' : ''}`}
            onClick={() => onChange(active && collapsible ? null : t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.icon && <PixelIcon name={t.icon} size={18} />}
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ───────────── ColorSwatch ─────────────

interface ColorSwatchProps {
  color: string;
  label: string;
  selected?: boolean;
  size?: 's' | 'm' | 'l';
  /** Petit repère (ex.: numéro d'emplacement). */
  badge?: string;
  disabled?: boolean;
  onClick?: () => void;
}

export function ColorSwatch({ color, label, selected, size = 'm', badge, disabled, onClick }: ColorSwatchProps) {
  return (
    <button
      type="button"
      className={`swatch swatch--${size} ${selected ? 'is-selected' : ''}`}
      style={{ ['--swatch' as string]: color }}
      aria-label={label}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      {selected && <PixelIcon name="check" size={size === 's' ? 14 : 20} className="swatch__check" />}
      {badge && <b className="swatch__badge">{badge}</b>}
    </button>
  );
}

// ───────────── ToyDialog ─────────────

interface ToyDialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  tone?: 'plain' | 'error';
  /** Fermeture impossible (ex.: envoi en cours). */
  locked?: boolean;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Fenêtre modale: feuille en bas sur téléphone, carte centrée sur grand écran. */
export function ToyDialog({ open, title, onClose, children, actions, tone = 'plain', locked }: ToyDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    (node.querySelector<HTMLElement>(FOCUSABLE) ?? node).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) onClose();
      if (e.key !== 'Tab') return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnTo.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return (
    <div className="toy-dialog-backdrop" onClick={() => !locked && onClose()}>
      <div
        ref={ref}
        className={`toy-dialog toy-dialog--${tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="toy-dialog__head">
          <h2 id={titleId}>{title}</h2>
          {!locked && (
            <ToyButton variant="ghost" size="s" iconOnly icon="close" aria-label="Fermer" onClick={onClose} />
          )}
        </header>
        <div className="toy-dialog__body">{children}</div>
        {actions && <footer className="toy-dialog__actions">{actions}</footer>}
      </div>
    </div>
  );
}

// ───────────── ToyToggle ─────────────

interface ToyToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  hint?: string;
}

/** Interrupteur vert: le libellé et l'état restent lisibles sans couleur (« oui / non »). */
export function ToyToggle({ checked, onChange, children, disabled, hint }: ToyToggleProps) {
  return (
    <label className={`toy-toggle ${disabled ? 'is-disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toy-toggle__track" aria-hidden="true"><i>{checked ? 'oui' : 'non'}</i></span>
      <span className="toy-toggle__text">
        {children}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}
