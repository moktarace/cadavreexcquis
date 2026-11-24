import { decorRect, type DecorState } from '../decor/decor';
import { textRect, textSizeOf, type TextState } from '../text/text';
import { HEIGHT, WIDTH } from '../palette';
import { mimoRect, type MimoState } from './mimo';

/** Un objet en cours de placement (Mimo ou texte): ce que les gestes ont besoin de lui demander. */
export interface Placeable {
  /** Rectangle occupé, en pixels de la toile; null si rien n'est encore à manipuler (texte vide). */
  rect(): { left: number; top: number; w: number; h: number } | null;
  center(): { x: number; y: number };
  size(): number;
  moveTo(x: number, y: number): void;
  resize(size: number): void;
  /** Appui bref sur l'objet (Mimo: pose suivante; texte: rouvrir la saisie; décor en mode Gommer: retire un élément). `at` = point touché, en pixels de la toile. */
  tap(at: { x: number; y: number }): void;
  /** Poignée de taille (par défaut le coin bas droit); null si l'objet ne se redimensionne pas pour l'instant. */
  handle?(): { x: number; y: number } | null;
}

export function decorPlaceable(s: {
  decor: DecorState | null;
  decorMoveTo(x: number, y: number): void;
  decorResize(width: number): void;
  decorRemoveAt(x: number, y: number): boolean;
  decorChange(): void;
}): Placeable {
  return {
    rect: () => (s.decor ? decorRect(s.decor, false) : null),
    center: () => ({ x: s.decor?.cx ?? 0, y: s.decor?.cy ?? 0 }),
    size: () => s.decor?.width ?? 1,
    moveTo: (x, y) => s.decorMoveTo(x, y),
    resize: (w) => s.decorResize(w),
    // Comme la pose d'un Mimo: un tap change de lieu (« Change ! »); en mode Gommer, il retire l'élément touché.
    tap: (at) => {
      if (!s.decor) return;
      if (s.decor.erasing) s.decorRemoveAt(at.x, at.y);
      else s.decorChange();
    },
    // Un grand décor déborde de la toile: la poignée reste toujours atteignable, dans la toile.
    handle: () => {
      if (!s.decor || s.decor.erasing) return null;
      const r = decorRect(s.decor, false);
      return { x: Math.min(r.left + r.w, WIDTH - 10), y: Math.min(r.top + r.h, HEIGHT - 10) };
    },
  };
}

export function mimoPlaceable(s: { mimo: MimoState | null; mimoStep(axis: 'pose'): void; mimoMoveTo(x: number, y: number): void; mimoResize(size: number): void }): Placeable {
  return {
    rect: () => (s.mimo ? mimoRect({ ...s.mimo, fx: null }) : null),
    center: () => ({ x: s.mimo?.cx ?? 0, y: s.mimo?.cy ?? 0 }),
    size: () => s.mimo?.size ?? 1,
    moveTo: (x, y) => s.mimoMoveTo(x, y),
    resize: (size) => s.mimoResize(size),
    tap: () => s.mimoStep('pose'),
  };
}

export function textPlaceable(
  s: { text: TextState | null; textMoveTo(x: number, y: number): void; textResize(size: number): void },
  onTap: () => void,
): Placeable {
  return {
    rect: () => {
      if (!s.text) return null;
      const r = textRect(s.text);
      return r.w ? r : null;
    },
    center: () => ({ x: s.text?.cx ?? 0, y: s.text?.cy ?? 0 }),
    size: () => (s.text ? textSizeOf(s.text) : 1),
    moveTo: (x, y) => s.textMoveTo(x, y),
    resize: (size) => s.textResize(size),
    tap: onTap,
  };
}

/** Glissement (px écran) au-delà duquel un appui devient un déplacement. */
export const TAP_SLOP = 8;
/** Un appui plus long n'est pas un « tap » (évite d'agir en posant le doigt pour viser). */
export const TAP_MAX_MS = 400;
/** Zone de prise minimale (px de la toile) autour d'un petit objet. */
const MIN_REACH = 30;
/** Rayon (px de la toile) de la poignée de taille, au coin bas droit. */
export const HANDLE_REACH = 16;

type Mode = 'none' | 'press' | 'drag' | 'pinch' | 'handle' | 'ignore';

interface Pointer {
  x: number;
  y: number;
}

/**
 * Un pointeur sur l'objet: appui bref = action de l'objet, glissement = déplacement (jamais l'un à la place de l'autre).
 * Deux doigts, ou la poignée du coin (souris, stylet, doigt): taille seulement, proportions conservées.
 * Un pointeur hors de l'objet, ou resté après un pincement, ne fait rien.
 */
export class ObjectGesture {
  private mode: Mode = 'none';
  private pointers = new Map<number, Pointer>();
  private press: { id: number; x: number; y: number; t0: number } | null = null;
  private grab = { dx: 0, dy: 0 };
  private pinch = { dist: 1, size: 1 };
  private handle = { id: -1, dist: 1, size: 1 };

  constructor(
    private readonly target: Placeable,
    /** Conversion d'un point écran en pixels de la toile. */
    private readonly toCanvas: (x: number, y: number) => { x: number; y: number },
  ) {}

  /** Un geste est en cours: les événements d'un autre outil doivent être ignorés. */
  get active() {
    return this.pointers.size > 0;
  }

  get state(): Mode {
    return this.mode;
  }

  private hits(x: number, y: number): boolean {
    const r = this.target.rect();
    if (!r) return false;
    const cx = r.left + r.w / 2;
    const cy = r.top + r.h / 2;
    return Math.abs(x - cx) <= Math.max(r.w / 2, MIN_REACH) && Math.abs(y - cy) <= Math.max(r.h / 2, MIN_REACH);
  }

  private onHandle(x: number, y: number): boolean {
    const r = this.target.rect();
    if (!r) return false;
    const h = this.target.handle ? this.target.handle() : { x: r.left + r.w, y: r.top + r.h };
    return !!h && Math.hypot(x - h.x, y - h.y) <= HANDLE_REACH;
  }

  private pair(): [Pointer, Pointer] | null {
    const [a, b] = [...this.pointers.values()];
    return a && b ? [a, b] : null;
  }

  down(id: number, x: number, y: number, now: number) {
    if (!this.target.rect()) return;
    this.pointers.set(id, { x, y });
    if (this.pointers.size >= 2) {
      const [a, b] = this.pair()!;
      this.press = null;
      this.mode = 'pinch';
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, size: this.target.size() };
      return;
    }
    const p = this.toCanvas(x, y);
    if (this.onHandle(p.x, p.y)) {
      const c = this.target.center();
      this.mode = 'handle';
      this.press = { id, x, y, t0: now }; // un simple appui sur la poignée vaut un tap
      this.handle = { id, dist: Math.max(4, Math.hypot(p.x - c.x, p.y - c.y)), size: this.target.size() };
    } else if (this.hits(p.x, p.y)) {
      this.mode = 'press';
      this.press = { id, x, y, t0: now };
    } else this.mode = 'ignore';
  }

  move(id: number, x: number, y: number) {
    const known = this.pointers.get(id);
    if (!known || !this.target.rect()) return;
    known.x = x;
    known.y = y;
    if (this.mode === 'press' && this.press?.id === id) {
      if (Math.hypot(x - this.press.x, y - this.press.y) < TAP_SLOP) return;
      // Le déplacement part d'ici: pas de saut au moment où le geste est reconnu.
      const p = this.toCanvas(x, y);
      const c = this.target.center();
      this.grab = { dx: c.x - p.x, dy: c.y - p.y };
      this.mode = 'drag';
      this.press = null;
    }
    if (this.mode === 'drag') {
      const p = this.toCanvas(x, y);
      this.target.moveTo(p.x + this.grab.dx, p.y + this.grab.dy);
    } else if (this.mode === 'handle' && this.handle.id === id) {
      if (this.press && Math.hypot(x - this.press.x, y - this.press.y) < TAP_SLOP) return;
      this.press = null;
      const p = this.toCanvas(x, y);
      const c = this.target.center();
      this.target.resize((this.handle.size * Math.hypot(p.x - c.x, p.y - c.y)) / this.handle.dist);
    } else if (this.mode === 'pinch') {
      const pr = this.pair();
      if (!pr) return;
      this.target.resize((this.pinch.size * (Math.hypot(pr[0].x - pr[1].x, pr[0].y - pr[1].y) || 1)) / this.pinch.dist);
    }
  }

  up(id: number, now: number, cancelled = false) {
    if (!this.pointers.has(id)) return;
    this.pointers.delete(id);
    if ((this.mode === 'press' || this.mode === 'handle') && this.press?.id === id) {
      if (!cancelled && now - this.press.t0 <= TAP_MAX_MS) this.target.tap(this.toCanvas(this.press.x, this.press.y));
      this.press = null;
    }
    if (this.mode === 'pinch' && this.pointers.size < 2) this.mode = 'ignore';
    if (this.pointers.size === 0) this.mode = 'none';
  }

  /** Interruption (rotation, perte de focus): plus aucun geste, rien n'est validé. */
  reset() {
    this.pointers.clear();
    this.press = null;
    this.mode = 'none';
  }
}
