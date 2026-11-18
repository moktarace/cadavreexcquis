import {
  clearMask,
  extract,
  fill,
  fullMask,
  lassoMask,
  pasteContent,
  rectMask,
  stamp,
  strokeLine,
  type Brush,
  type Content,
  type Texture,
} from './raster';
import { HEIGHT, PIXELS, WIDTH } from './palette';
import { newProject, type Project } from './project';

export type Tool = 'pen' | 'eraser' | 'fill' | 'rect' | 'lasso' | 'move' | 'hand';

/** Le tiroir d'outils se referme au premier trait; avec les outils de sélection, ses actions restent à portée. */
export const closesDrawerOnDraw = (tool: Tool) => tool === 'pen' || tool === 'eraser';

interface Point {
  x: number;
  y: number;
  pressure: number;
}

interface Floating {
  content: Content;
  dx: number;
  dy: number;
  /** Projet avant la levée: restauré par « annuler », empilé dans l'historique à la validation. */
  base: Project;
}

const HISTORY_LIMIT = 100;

export class EditorSession {
  project: Project;
  /** Indice de palette du stylo et du pot de peinture. */
  color = 1;
  tool: Tool = 'pen';
  pen: Brush = { size: 3, shape: 'round', texture: 'solid' };
  eraserSize = 8;
  fillTexture: Texture = 'solid';
  /** Le doigt déplace la vue au lieu de dessiner (confort avec Apple Pencil ou stylet Android). */
  penOnly = false;
  selection: Uint8Array | null = null;
  clipboard: Content | null = null;
  floating: Floating | null = null;
  version = 0;

  private history: Project[] = [];
  private future: Project[] = [];
  private listeners = new Set<() => void>();
  private stroke: { pixels: Uint8Array; last: Point; changed: boolean; value: number; live: Project } | null = null;
  private selecting: { kind: 'rect' | 'lasso'; start: Point; points: Point[] } | null = null;
  private dragging: { start: Point; startDx: number; startDy: number } | null = null;
  private floatView: Project | null = null;

  constructor(project: Project = newProject()) {
    this.project = project;
  }

  // ───────────── Observation ─────────────

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  private notify() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** Projet à afficher: trait en cours et sélection flottante inclus. */
  current(): Project {
    if (this.stroke) return this.stroke.live;
    if (this.floating) return (this.floatView ??= this.buildFloatView());
    return this.project;
  }

  private buildFloatView(): Project {
    const f = this.floating!;
    const pixels = this.project.pixels.slice();
    pasteContent(pixels, f.content, f.dx, f.dy);
    return { pixels };
  }

  /** Masque à dessiner autour de la sélection (flottante comprise). */
  outline(): Uint8Array | null {
    const f = this.floating;
    if (!f) return this.selection;
    const mask = new Uint8Array(PIXELS);
    for (let y = 0; y < f.content.h; y++) {
      for (let x = 0; x < f.content.w; x++) {
        if (!f.content.mask[y * f.content.w + x]) continue;
        const tx = f.content.x + f.dx + x;
        const ty = f.content.y + f.dy + y;
        if (tx >= 0 && ty >= 0 && tx < WIDTH && ty < HEIGHT) mask[ty * WIDTH + tx] = 1;
      }
    }
    return mask;
  }

  // ───────────── Historique ─────────────

  get canUndo() {
    return this.floating !== null || this.history.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  private commit(next: Project) {
    this.history.push(this.project);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
    this.project = next;
    this.afterProjectChange();
  }

  private afterProjectChange() {
    this.floatView = null;
    this.notify();
  }

  undo() {
    if (this.stroke) return;
    if (this.floating) {
      this.cancelFloating();
      return;
    }
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(this.project);
    this.project = prev;
    this.selection = null;
    this.afterProjectChange();
  }

  redo() {
    if (this.stroke || this.floating) return;
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.project);
    this.project = next;
    this.selection = null;
    this.afterProjectChange();
  }

  // ───────────── Entrées pointeur (coordonnées logiques 320×240, flottantes) ─────────────

  pointerDown(x: number, y: number, pressure = 1) {
    const p = { x, y, pressure };
    switch (this.tool) {
      case 'pen':
      case 'eraser':
        this.commitFloating();
        this.beginStroke(p);
        break;
      case 'fill':
        this.commitFloating();
        this.fillAt(p);
        break;
      case 'rect':
      case 'lasso':
        this.commitFloating();
        this.selecting = { kind: this.tool, start: p, points: [p] };
        this.selection = null;
        this.notify();
        break;
      case 'move':
        this.beginMove(p);
        break;
      case 'hand':
        break;
    }
  }

  pointerMove(x: number, y: number, pressure = 1) {
    const p = { x, y, pressure };
    if (this.stroke) {
      const s = this.stroke;
      if (strokeLine(s.pixels, s.last, p, this.currentBrush(), s.value)) s.changed = true;
      s.last = p;
      this.notify();
    } else if (this.selecting) {
      const sel = this.selecting;
      sel.points.push(p);
      const ix = (v: number) => Math.round(v);
      this.selection =
        sel.kind === 'rect'
          ? rectMask(ix(sel.start.x), ix(sel.start.y), ix(p.x), ix(p.y))
          : lassoMask(sel.points);
      this.notify();
    } else if (this.dragging && this.floating) {
      const d = this.dragging;
      this.floating.dx = d.startDx + Math.round(x - d.start.x);
      this.floating.dy = d.startDy + Math.round(y - d.start.y);
      this.floatView = null;
      this.notify();
    }
  }

  pointerUp() {
    if (this.stroke) {
      const s = this.stroke;
      this.stroke = null;
      if (s.changed) this.commit({ pixels: s.pixels });
      else this.notify();
    } else if (this.selecting) {
      const sel = this.selecting;
      this.selecting = null;
      if (this.selection && !this.selection.some(Boolean)) this.selection = null;
      // Un simple appui avec le rectangle ne sélectionne rien de significatif
      if (sel.points.length < 2) this.selection = null;
      this.notify();
    } else if (this.dragging) {
      this.dragging = null;
      this.notify();
    }
  }

  /** Abandonne le trait ou le geste en cours (ex.: second doigt posé pour zoomer). */
  pointerCancel() {
    if (this.stroke) this.stroke = null;
    this.selecting = null;
    this.dragging = null;
    this.notify();
  }

  private currentBrush(): Brush {
    return this.tool === 'eraser' ? { size: this.eraserSize, shape: 'round', texture: 'solid' } : this.pen;
  }

  private beginStroke(p: Point) {
    const pixels = this.project.pixels.slice();
    const value = this.tool === 'eraser' ? 0 : this.color;
    const brush = this.currentBrush();
    const size = Math.max(1, Math.round(brush.size * (0.35 + 0.65 * p.pressure)));
    const changed = stamp(pixels, Math.round(p.x), Math.round(p.y), { ...brush, size }, value);
    this.stroke = { pixels, last: p, changed, value, live: { pixels } };
    this.notify();
  }

  private fillAt(p: Point) {
    const pixels = this.project.pixels.slice();
    if (fill(pixels, Math.floor(p.x), Math.floor(p.y), this.color, this.fillTexture)) this.commit({ pixels });
  }

  // ───────────── Sélection, déplacement, presse-papiers ─────────────

  private beginMove(p: Point) {
    if (!this.floating && !this.lift()) return;
    this.dragging = { start: p, startDx: this.floating!.dx, startDy: this.floating!.dy };
    this.notify();
  }

  /** Soulève la sélection (ou tout le dessin) pour la déplacer ou la transformer. */
  private lift(): boolean {
    const mask = this.selection ?? fullMask();
    const content = extract(this.project.pixels, mask);
    if (!content) return false;
    const pixels = this.project.pixels.slice();
    clearMask(pixels, mask);
    const base = this.project;
    this.project = { pixels };
    this.floating = { content, dx: 0, dy: 0, base };
    this.floatView = null;
    return true;
  }

  /** Retourne la sélection flottante (ou soulève d'abord la sélection courante). */
  flip(axis: 'h' | 'v') {
    if (!this.floating && !this.lift()) return;
    const f = this.floating!;
    const { w, h } = f.content;
    const pixels = new Uint8Array(w * h);
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = axis === 'h' ? w - 1 - x : x;
        const sy = axis === 'v' ? h - 1 - y : y;
        pixels[y * w + x] = f.content.pixels[sy * w + sx];
        mask[y * w + x] = f.content.mask[sy * w + sx];
      }
    }
    f.content = { ...f.content, pixels, mask };
    this.floatView = null;
    this.tool = 'move';
    this.notify();
  }

  /** Rotation d'un quart de tour dans le sens horaire, autour du centre de la sélection. */
  rotate() {
    if (!this.floating && !this.lift()) return;
    const f = this.floating!;
    const { w, h } = f.content;
    const pixels = new Uint8Array(w * h);
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = h - 1 - y;
        const ny = x;
        pixels[ny * h + nx] = f.content.pixels[y * w + x];
        mask[ny * h + nx] = f.content.mask[y * w + x];
      }
    }
    const cx = f.content.x + f.dx + w / 2;
    const cy = f.content.y + f.dy + h / 2;
    const nextX = Math.round(cx - h / 2);
    const nextY = Math.round(cy - w / 2);
    f.content = { ...f.content, w: h, h: w, pixels, mask, x: nextX - f.dx, y: nextY - f.dy };
    this.floatView = null;
    this.tool = 'move';
    this.notify();
  }

  /** Dépose la sélection flottante sur le dessin (une entrée d'historique). */
  commitFloating() {
    const f = this.floating;
    if (!f) return;
    const pixels = this.project.pixels.slice();
    pasteContent(pixels, f.content, f.dx, f.dy);
    const placed = this.outline()!;
    this.floating = null;
    this.dragging = null;
    this.history.push(f.base);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
    this.project = { pixels };
    this.selection = placed;
    this.afterProjectChange();
  }

  cancelFloating() {
    const f = this.floating;
    if (!f) return;
    this.project = f.base;
    this.floating = null;
    this.dragging = null;
    this.afterProjectChange();
  }

  selectAll() {
    this.commitFloating();
    this.selection = fullMask();
    this.notify();
  }

  clearSelection() {
    this.commitFloating();
    this.selection = null;
    this.notify();
  }

  copy() {
    this.commitFloating();
    const content = extract(this.project.pixels, this.selection ?? fullMask());
    if (content) this.clipboard = content;
    this.notify();
  }

  cut() {
    this.commitFloating();
    const mask = this.selection ?? fullMask();
    const content = extract(this.project.pixels, mask);
    if (!content) return;
    this.clipboard = content;
    this.deleteSelection();
  }

  deleteSelection() {
    this.commitFloating();
    const mask = this.selection ?? fullMask();
    const pixels = this.project.pixels.slice();
    clearMask(pixels, mask);
    this.commit({ pixels });
  }

  paste() {
    this.commitFloating();
    if (!this.clipboard) return;
    this.floating = { content: this.clipboard, dx: 8, dy: 8, base: this.project };
    this.floatView = null;
    this.tool = 'move';
    this.notify();
  }

  // ───────────── Réglages d'outils ─────────────

  setTool(tool: Tool) {
    if (tool !== 'move') this.commitFloating();
    this.tool = tool;
    this.notify();
  }

  update(patch: Partial<Pick<EditorSession, 'color' | 'eraserSize' | 'fillTexture' | 'pen' | 'penOnly'>>) {
    Object.assign(this, patch);
    this.notify();
  }

  /** À appeler quand la page passe en arrière-plan: termine proprement le geste en cours. */
  flush() {
    if (this.stroke) this.pointerUp();
    this.selecting = null;
    this.dragging = null;
    this.commitFloating();
  }
}
