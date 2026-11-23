import { HEIGHT, WIDTH } from '../editor/palette';

/** Ce que le Télécrayon pilote: l'interface de trait de EditorSession (annulation = trait abandonné). */
export interface PenTarget {
  pointerDown(x: number, y: number, pressure?: number): void;
  pointerMove(x: number, y: number, pressure?: number): void;
  pointerUp(): void;
  pointerCancel(): void;
}

export interface PadSettings {
  /** Pixels logiques par pixel CSS de glissement, à vitesse lente. */
  gain: number;
  /** Multiplicateur atteint à grande vitesse (1 = pas d'accélération). */
  accel: number;
  /** Vitesse (px CSS / ms) à laquelle l'accélération est complète. */
  fullSpeed: number;
  /** Glissement minimal (px CSS) avant que le curseur ne parte après la pose du pouce. */
  slop: number;
  /** Une fois parti: seuil sous lequel les tremblements sont ignorés (et perdus au relevé). */
  jitter: number;
}

export type ProfileId = 'precise' | 'fast';

export const PROFILES: Record<ProfileId, PadSettings> = {
  precise: { gain: 0.3, accel: 1.8, fullSpeed: 1.6, slop: 1.5, jitter: 0.5 },
  fast: { gain: 0.75, accel: 2.6, fullSpeed: 1.6, slop: 1.5, jitter: 0.5 },
};

export const PROFILE_LABELS: Record<ProfileId, string> = { precise: 'Précis', fast: 'Rapide' };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Gain effectif pour une vitesse donnée: lent = précis, rapide = ample, sans palier. */
export function gainAt(speed: number, s: PadSettings): number {
  const t = clamp(speed / s.fullSpeed, 0, 1);
  return s.gain * (1 + (s.accel - 1) * t * t * (3 - 2 * t));
}

/** Un glissement du pouce sur le pavé: mouvement relatif, jamais une position absolue. */
export class PadGesture {
  private lastX: number;
  private lastY: number;
  private lastT: number;
  private pendX = 0;
  private pendY = 0;
  private engaged = false;
  private speed = 0;

  constructor(x: number, y: number, t: number, private readonly settings: () => PadSettings) {
    this.lastX = x;
    this.lastY = y;
    this.lastT = t;
  }

  /** Déplacement logique (x, y) à appliquer au curseur, ou null si rien ne bouge encore. */
  move(x: number, y: number, t: number): { dx: number; dy: number } | null {
    const s = this.settings();
    this.pendX += x - this.lastX;
    this.pendY += y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    const dist = Math.hypot(this.pendX, this.pendY);
    if (dist < (this.engaged ? s.jitter : s.slop)) return null;
    const dt = Math.max(1, t - this.lastT);
    this.speed = this.engaged ? this.speed * 0.5 + (dist / dt) * 0.5 : dist / dt;
    this.engaged = true;
    const g = gainAt(this.speed, s);
    const out = { dx: this.pendX * g, dy: this.pendY * g };
    this.pendX = 0;
    this.pendY = 0;
    this.lastT = t;
    return out;
  }
}

export type StrokeOutcome = 'committed' | 'cancelled';

/**
 * Machine à états du Télécrayon: le pouce gauche (pavé) déplace le curseur, le pouce droit (TRACER) baisse le crayon.
 * Les deux pouces sont suivis par leur pointerId; chacun est indépendant de l'autre.
 */
export class Telecrayon {
  cursor = { x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) };
  private pad: { id: number; gesture: PadGesture } | null = null;
  private trace: { id: number } | null = null;
  private armed = false;
  private lastCell = { x: -1, y: -1 };
  private listeners = new Set<() => void>();

  constructor(
    private readonly target: PenTarget,
    public settings: PadSettings,
    private readonly onStroke: (outcome: StrokeOutcome) => void = () => {},
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }

  get penDown() {
    return this.trace !== null;
  }
  /** Le pouce droit est dans la zone d'annulation: le relâcher abandonne le trait. */
  get cancelArmed() {
    return this.armed;
  }
  get padActive() {
    return this.pad !== null;
  }
  /** Pixel réellement ciblé. */
  get cell() {
    return { x: Math.round(this.cursor.x), y: Math.round(this.cursor.y) };
  }

  // ───────────── Pouce gauche ─────────────

  padDown(id: number, x: number, y: number, t: number) {
    if (this.pad) return;
    this.pad = { id, gesture: new PadGesture(x, y, t, () => this.settings) };
    this.emit();
  }

  padMove(id: number, x: number, y: number, t: number) {
    if (this.pad?.id !== id) return;
    const d = this.pad.gesture.move(x, y, t);
    if (!d) return;
    this.cursor = {
      x: clamp(this.cursor.x + d.dx, 0, WIDTH - 1),
      y: clamp(this.cursor.y + d.dy, 0, HEIGHT - 1),
    };
    const c = this.cell;
    if (this.trace && (c.x !== this.lastCell.x || c.y !== this.lastCell.y)) {
      this.target.pointerMove(c.x, c.y);
      this.lastCell = c;
    }
    this.emit();
  }

  /** Relevé ou interruption du pouce gauche: le curseur reste où il est, le trait en cours continue. */
  padUp(id: number) {
    if (this.pad?.id !== id) return;
    this.pad = null;
    this.emit();
  }

  // ───────────── Pouce droit ─────────────

  traceDown(id: number) {
    if (this.trace) return;
    this.trace = { id };
    this.armed = false;
    const c = this.cell;
    this.lastCell = c;
    this.target.pointerDown(c.x, c.y);
    this.emit();
  }

  /** Le pouce droit est sorti du bouton vers la zone d'annulation (ou en est revenu). */
  setCancelArmed(id: number, armed: boolean) {
    if (this.trace?.id !== id || this.armed === armed) return;
    this.armed = armed;
    this.emit();
  }

  /** Relâchement normal: valide le trait, sauf si le pouce a été relâché dans la zone d'annulation. */
  traceUp(id: number) {
    if (this.trace?.id !== id) return;
    const cancelled = this.armed;
    this.trace = null;
    this.armed = false;
    if (cancelled) this.target.pointerCancel();
    else this.target.pointerUp();
    this.onStroke(cancelled ? 'cancelled' : 'committed');
    this.emit();
  }

  /** Interruption (pointercancel, capture perdue): jamais de validation involontaire. */
  traceAbort(id: number) {
    if (this.trace?.id !== id) return;
    this.abortStroke();
  }

  /** Perte de focus, changement d'orientation, page en arrière-plan: tout s'arrête, le trait en cours est abandonné. */
  interrupt() {
    this.pad = null;
    if (this.trace) this.abortStroke();
    else this.emit();
  }

  private abortStroke() {
    this.trace = null;
    this.armed = false;
    this.target.pointerCancel();
    this.onStroke('cancelled');
    this.emit();
  }
}
