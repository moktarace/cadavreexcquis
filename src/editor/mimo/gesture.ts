import { mimoRect, type MimoState } from './mimo';

/** Ce dont la reconnaissance des gestes a besoin de l'éditeur. */
export interface MimoTarget {
  mimo: MimoState | null;
  mimoStep(axis: 'pose'): void;
  mimoMoveTo(x: number, y: number): void;
  mimoResize(size: number): void;
}

/** Glissement (px écran) au-delà duquel un appui devient un déplacement. */
export const TAP_SLOP = 8;
/** Un appui plus long n'est pas un « tap » (évite de changer de pose en posant le doigt pour viser). */
export const TAP_MAX_MS = 400;
/** Zone de prise minimale (px de la toile) autour d'un petit Mimo. */
const MIN_REACH = 30;

type Mode = 'none' | 'press' | 'drag' | 'pinch' | 'ignore';

interface Pointer {
  x: number;
  y: number;
}

/**
 * Un doigt sur le Mimo: tap = pose suivante, glissement = déplacement (jamais l'un à la place de l'autre).
 * Deux doigts: taille seulement. Un doigt hors du Mimo, ou resté après un pincement, ne fait rien.
 * Émotion et style passent par leurs zones dédiées: un geste de déplacement ne peut pas les déclencher.
 */
export class MimoGesture {
  private mode: Mode = 'none';
  private pointers = new Map<number, Pointer>();
  private press: { id: number; x: number; y: number; t0: number } | null = null;
  private grab = { dx: 0, dy: 0 };
  private pinch = { dist: 1, size: 1 };

  constructor(
    private readonly target: MimoTarget,
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
    const m = this.target.mimo;
    if (!m) return false;
    const r = mimoRect({ ...m, fx: null });
    const cx = r.left + r.w / 2;
    const cy = r.top + r.h / 2;
    return Math.abs(x - cx) <= Math.max(r.w / 2, MIN_REACH) && Math.abs(y - cy) <= Math.max(r.h / 2, MIN_REACH);
  }

  private pair(): [Pointer, Pointer] | null {
    const [a, b] = [...this.pointers.values()];
    return a && b ? [a, b] : null;
  }

  down(id: number, x: number, y: number, now: number) {
    const m = this.target.mimo;
    if (!m) return;
    this.pointers.set(id, { x, y });
    if (this.pointers.size >= 2) {
      const [a, b] = this.pair()!;
      this.press = null;
      this.mode = 'pinch';
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, size: m.size };
      return;
    }
    const p = this.toCanvas(x, y);
    if (!this.hits(p.x, p.y)) {
      this.mode = 'ignore';
      return;
    }
    this.mode = 'press';
    this.press = { id, x, y, t0: now };
  }

  move(id: number, x: number, y: number) {
    const known = this.pointers.get(id);
    const m = this.target.mimo;
    if (!known || !m) return;
    known.x = x;
    known.y = y;
    if (this.mode === 'press' && this.press?.id === id) {
      if (Math.hypot(x - this.press.x, y - this.press.y) < TAP_SLOP) return;
      // Le déplacement part d'ici: pas de saut au moment où le geste est reconnu.
      const p = this.toCanvas(x, y);
      this.grab = { dx: m.cx - p.x, dy: m.cy - p.y };
      this.mode = 'drag';
      this.press = null;
    }
    if (this.mode === 'drag') {
      const p = this.toCanvas(x, y);
      this.target.mimoMoveTo(p.x + this.grab.dx, p.y + this.grab.dy);
    } else if (this.mode === 'pinch') {
      const pr = this.pair();
      if (!pr) return;
      this.target.mimoResize((this.pinch.size * (Math.hypot(pr[0].x - pr[1].x, pr[0].y - pr[1].y) || 1)) / this.pinch.dist);
    }
  }

  up(id: number, now: number, cancelled = false) {
    if (!this.pointers.has(id)) return;
    this.pointers.delete(id);
    if (this.mode === 'press' && this.press?.id === id) {
      if (!cancelled && now - this.press.t0 <= TAP_MAX_MS) this.target.mimoStep('pose');
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
