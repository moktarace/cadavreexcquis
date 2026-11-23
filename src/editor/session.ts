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
import { MIMO_DEFAULT, MIMO_LIMIT, FX_DURATION, clampCenter, clampSize, drawMimo, type MimoAxis, type MimoState } from './mimo/mimo';
import { MIMO_DESIGNS, MIMO_EMOTIONS, MIMO_POSES } from './mimo/art';
import { REWARD_CONFIG, TRANSPARENT, parseArt, scaleSprite, stickerById, type Sprite } from '../domain/stickers';

export type Tool = 'pen' | 'eraser' | 'fill' | 'rect' | 'lasso' | 'move' | 'hand' | 'stamp';

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
  /** Tampon en cours de placement (aperçu mobile, fusionné à la validation). */
  stamp?: { id: string; scale: number; sprite: Sprite };
}

const HISTORY_LIMIT = 100;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
  /** Mimo en cours de placement (modifiable jusqu'à « Placer » ou « Annuler »). */
  mimo: MimoState | null = null;
  /** Préférence système: pas d'animation des Mimo. */
  reducedMotion = false;
  /** Nombre de tampons posés au plus sur une case (réglage, jamais une contrainte de dessin). */
  maxStamps: number = REWARD_CONFIG.maxStampsPerCase;
  /** Dernière taille choisie: le tampon suivant démarre avec elle. */
  stampScale: number = REWARD_CONFIG.defaultStampScale;

  private history: Project[] = [];
  private future: Project[] = [];
  private listeners = new Set<() => void>();
  private stroke: { pixels: Uint8Array; last: Point; changed: boolean; value: number; live: Project } | null = null;
  private selecting: { kind: 'rect' | 'lasso'; start: Point; points: Point[] } | null = null;
  private dragging: { start: Point; startDx: number; startDy: number } | null = null;
  private floatView: Project | null = null;
  private mimoView: Project | null = null;

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
    if (this.mimo) return (this.mimoView ??= this.buildMimoView());
    if (this.floating) return (this.floatView ??= this.buildFloatView());
    return this.project;
  }

  private buildMimoView(): Project {
    const pixels = this.project.pixels.slice();
    drawMimo(pixels, this.mimo!, true);
    return { pixels };
  }

  private buildFloatView(): Project {
    const f = this.floating!;
    const pixels = this.project.pixels.slice();
    pasteContent(pixels, f.content, f.dx, f.dy, !!f.stamp);
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
    return this.mimo !== null || this.floating !== null || this.history.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  private commit(next: Project) {
    if (next.stamps === undefined) next = { ...next, stamps: this.project.stamps };
    if (next.mimos === undefined) next = { ...next, mimos: this.project.mimos };
    this.history.push(this.project);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
    this.project = next;
    this.afterProjectChange();
  }

  private afterProjectChange() {
    this.floatView = null;
    this.mimoView = null;
    this.notify();
  }

  undo() {
    if (this.mimo) {
      this.cancelMimo();
      return;
    }
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
    if (this.stroke || this.floating || this.mimo) return;
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.project);
    this.project = next;
    this.selection = null;
    this.afterProjectChange();
  }

  // ───────────── Entrées pointeur (coordonnées logiques 320×240, flottantes) ─────────────

  pointerDown(x: number, y: number, pressure = 1) {
    if (this.mimo) return; // un Mimo en cours de placement ne laisse rien dessiner
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
      case 'stamp':
        this.stampDown(p);
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
    this.project = { pixels, stamps: base.stamps, mimos: base.mimos };
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
    pasteContent(pixels, f.content, f.dx, f.dy, !!f.stamp);
    const placed = f.stamp ? null : this.outline()!;
    this.floating = null;
    this.dragging = null;
    this.history.push(f.base);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
    this.project = { pixels, stamps: (f.base.stamps ?? 0) + (f.stamp ? 1 : 0), mimos: f.base.mimos };
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

  // ───────────── Tampons ─────────────

  /** Tampons déjà posés sur le dessin actuel (annuler en libère un). */
  get stampsPlaced() {
    return (this.floating?.base ?? this.project).stamps ?? 0;
  }

  get canStamp() {
    return this.stampsPlaced < this.maxStamps;
  }

  /** Soulève un tampon au centre de la toile: il reste mobile jusqu'à « OK » ou « Annuler ». */
  beginStamp(id: string, scale: number = this.stampScale): boolean {
    const def = stickerById(id);
    if (!def || this.mimo) return false;
    this.commitFloating();
    if (!this.canStamp) return false;
    const sprite = cropSprite(parseArt(def.art));
    this.floating = { content: stampContent(sprite, scale, WIDTH / 2, HEIGHT / 2), dx: 0, dy: 0, base: this.project, stamp: { id, scale, sprite } };
    this.dragging = null;
    this.floatView = null;
    this.selection = null;
    this.tool = 'stamp';
    this.notify();
    return true;
  }

  /** Change la taille (multiples entiers, sans flou) en gardant le centre du tampon. */
  setStampScale(scale: number) {
    const f = this.floating;
    if (!f?.stamp || !REWARD_CONFIG.stampScales.includes(scale)) return;
    const cx = f.content.x + f.dx + f.content.w / 2;
    const cy = f.content.y + f.dy + f.content.h / 2;
    this.stampScale = scale;
    f.stamp = { ...f.stamp, scale };
    f.content = stampContent(f.stamp.sprite, scale, Math.min(WIDTH, Math.max(0, cx)), Math.min(HEIGHT, Math.max(0, cy)));
    f.dx = 0;
    f.dy = 0;
    this.floatView = null;
    this.notify();
  }

  /** Posé dans le tampon: on le tire; posé à côté: il saute sous le stylet ou le curseur, puis suit. */
  private stampDown(p: Point) {
    const f = this.floating;
    if (!f?.stamp) return;
    const left = f.content.x + f.dx;
    const top = f.content.y + f.dy;
    const slack = 12;
    const inside = p.x >= left - slack && p.x <= left + f.content.w + slack && p.y >= top - slack && p.y <= top + f.content.h + slack;
    if (!inside) {
      f.dx = Math.round(p.x - f.content.w / 2) - f.content.x;
      f.dy = Math.round(p.y - f.content.h / 2) - f.content.y;
      this.floatView = null;
    }
    this.dragging = { start: p, startDx: f.dx, startDy: f.dy };
    this.notify();
  }


  // ───────────── Mimo ─────────────

  /** Mimo déjà placés sur le dessin actuel (annuler le placement en libère un). */
  get mimosPlaced() {
    return (this.floating?.base ?? this.project).mimos ?? 0;
  }

  get canMimo() {
    return this.mimosPlaced < MIMO_LIMIT;
  }

  /** Pose un Mimo au centre de la toile: il reste modifiable jusqu'à « Placer » ou « Annuler ». */
  beginMimo(): boolean {
    if (this.mimo) return false;
    this.commitFloating();
    if (!this.canMimo) return false;
    this.selection = null;
    this.mimo = { spec: { design: 0, emotion: 0, pose: 0 }, cx: WIDTH / 2, cy: HEIGHT / 2, size: MIMO_DEFAULT, fx: null };
    this.mimoView = null;
    this.notify();
    return true;
  }

  /** Passe à la pose, l'émotion ou le style suivant (ou précédent), en boucle. */
  mimoStep(axis: MimoAxis, dir: 1 | -1 = 1, now: number = clock()) {
    const m = this.mimo;
    if (!m) return;
    const count = { pose: MIMO_POSES, emotion: MIMO_EMOTIONS, design: MIMO_DESIGNS }[axis];
    m.spec = { ...m.spec, [axis]: (m.spec[axis] + dir + count) % count };
    m.fx = this.reducedMotion ? null : { kind: axis, t0: now, t: 0 };
    this.mimoView = null;
    this.notify();
  }

  mimoMoveTo(x: number, y: number) {
    const m = this.mimo;
    if (!m) return;
    Object.assign(m, clampCenter(x, y));
    this.mimoView = null;
    this.notify();
  }

  mimoResize(size: number) {
    const m = this.mimo;
    if (!m) return;
    m.size = clampSize(size);
    this.mimoView = null;
    this.notify();
  }

  /** Avance l'animation en cours; faux quand elle est terminée. */
  mimoFrame(now: number = clock()): boolean {
    const fx = this.mimo?.fx;
    if (!fx) return false;
    fx.t = Math.min(1, (now - fx.t0) / FX_DURATION[fx.kind]);
    if (fx.t >= 1) this.mimo!.fx = null;
    this.mimoView = null;
    this.notify();
    return this.mimo!.fx !== null;
  }

  /** Dessine le Mimo sur la toile (une entrée d'historique, comme un trait) et rend la main au crayon. */
  placeMimo(): boolean {
    const m = this.mimo;
    if (!m) return false;
    const pixels = this.project.pixels.slice();
    drawMimo(pixels, m, false);
    this.mimo = null;
    this.commit({ pixels, mimos: (this.project.mimos ?? 0) + 1 });
    return true;
  }

  cancelMimo() {
    if (!this.mimo) return;
    this.mimo = null;
    this.mimoView = null;
    this.notify();
  }

  // ───────────── Réglages d'outils ─────────────

  setTool(tool: Tool) {
    if (this.mimo) return;
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

/** Recadre un tampon sur ses pixels opaques: les marges transparentes ne comptent pas dans son emprise. */
function cropSprite(s: Sprite): Sprite {
  let x0 = s.w, y0 = s.h, x1 = -1, y1 = -1;
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      if (s.pixels[y * s.w + x] === TRANSPARENT) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return s;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = s.pixels[(y0 + y) * s.w + x0 + x];
  return { w, h, pixels };
}

/** Contenu flottant d'un tampon agrandi, centré en (cx, cy). */
function stampContent(sprite: Sprite, scale: number, cx: number, cy: number): Content {
  const big = scaleSprite(sprite, scale);
  const pixels = new Uint8Array(big.w * big.h);
  const mask = new Uint8Array(big.w * big.h);
  for (let i = 0; i < pixels.length; i++) {
    if (big.pixels[i] === TRANSPARENT) continue;
    pixels[i] = big.pixels[i];
    mask[i] = 1;
  }
  return { w: big.w, h: big.h, x: Math.round(cx - big.w / 2), y: Math.round(cy - big.h / 2), pixels, mask };
}
