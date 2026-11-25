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
import { MIMO_DEFAULT, FX_DURATION, clampCenter, clampSize, drawMimo, mimoRect, type MimoAxis, type MimoState } from './mimo/mimo';
import { TEXT_DEFAULT, TEXT_MAX, TEXT_MIN, clampTextCenter, drawText, limitText, textDims, textRect, textSizeOf, type TextState } from './text/text';
import { TEXTURE_DENSITY, type InkRules } from './ink';
import { DECOR_DEFAULT, DECOR_FX_MS, clampDecorCenter, clampDecorSize, drawDecor, nextPlace, pickElement, type DecorState } from './decor/decor';
import { protect } from './shield';
import { rasterMimo } from './mimo/raster';
import { rasterText } from './text/text';
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
  /** Texte en cours de placement (modifiable jusqu'à « Placer » ou « Annuler »). */
  text: TextState | null = null;
  /** Décor en cours de placement (jamais au-dessus du dessin existant). */
  decor: DecorState | null = null;
  /** Préférence système: pas d'animation des Mimo. */
  reducedMotion = false;
  /** Règles de coût en encre (mode Survivor); null = jeu classique, tout est gratuit. */
  ink: InkRules | null = null;
  /** Encre disponible au début de cette case. */
  inkBudget = 0;
  /** Nombre de tampons posés au plus sur une case (réglage, jamais une contrainte de dessin). */
  maxStamps: number = REWARD_CONFIG.maxStampsPerCase;
  /** Dernière taille choisie: le tampon suivant démarre avec elle. */
  stampScale: number = REWARD_CONFIG.defaultStampScale;

  private history: Project[] = [];
  private future: Project[] = [];
  private listeners = new Set<() => void>();
  private stroke: { pixels: Uint8Array; last: Point; changed: boolean; value: number; live: Project; spent: number; exhausted: boolean } | null = null;
  private selecting: { kind: 'rect' | 'lasso'; start: Point; points: Point[] } | null = null;
  private dragging: { start: Point; startDx: number; startDy: number } | null = null;
  private floatView: Project | null = null;
  private mimoView: Project | null = null;
  private textView: Project | null = null;
  private decorView: Project | null = null;

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

  /** Un trait est en cours (le pointeur est posé). */
  get stroking(): boolean {
    return this.stroke !== null;
  }

  /** Projet à afficher: trait en cours et sélection flottante inclus. */
  current(): Project {
    if (this.stroke) return this.stroke.live;
    if (this.mimo) return (this.mimoView ??= this.buildMimoView());
    if (this.text) return (this.textView ??= this.buildTextView());
    if (this.decor) return (this.decorView ??= this.buildDecorView());
    if (this.floating) return (this.floatView ??= this.buildFloatView());
    return this.project;
  }

  private buildDecorView(): Project {
    const pixels = this.project.pixels.slice();
    drawDecor(pixels, this.project.shield, this.decor!, true);
    return { pixels };
  }

  private buildTextView(): Project {
    const pixels = this.project.pixels.slice();
    drawText(pixels, this.text!);
    return { pixels };
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
    return this.mimo !== null || this.text !== null || this.decor !== null || this.floating !== null || this.history.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  private commit(next: Project) {
    if (next.stamps === undefined) next = { ...next, stamps: this.project.stamps };
    if (next.shield === undefined) next = { ...next, shield: this.project.shield };
    if (next.ink === undefined) next = { ...next, ink: this.project.ink };
    this.history.push(this.project);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
    this.project = next;
    this.afterProjectChange();
  }

  private afterProjectChange() {
    this.floatView = null;
    this.mimoView = null;
    this.textView = null;
    this.decorView = null;
    this.notify();
  }

  undo() {
    if (this.mimo || this.text || this.decor) {
      this.cancelMimo();
      this.cancelText();
      this.cancelDecor();
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
    if (this.stroke || this.floating || this.mimo || this.text || this.decor) return;
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.project);
    this.project = next;
    this.selection = null;
    this.afterProjectChange();
  }

  // ───────────── Entrées pointeur (coordonnées logiques 320×240, flottantes) ─────────────

  pointerDown(x: number, y: number, pressure = 1) {
    if (this.mimo || this.text || this.decor) return; // un objet en cours de placement ne laisse rien dessiner
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
      if (s.exhausted) return; // plus d'encre: le trait s'arrête là
      let to = p;
      if (this.ink && this.tool === 'pen') {
        const cost = this.ink.stroke(Math.hypot(p.x - s.last.x, p.y - s.last.y), this.strokeSize(this.currentBrush()));
        const left = this.inkLeft;
        if (cost > left) {
          // On ne dessine que ce que la réserve permet.
          const f = cost > 0 ? Math.max(0, left) / cost : 0;
          to = { x: s.last.x + (p.x - s.last.x) * f, y: s.last.y + (p.y - s.last.y) * f, pressure: p.pressure };
          s.spent += Math.max(0, left);
          s.exhausted = true;
        } else s.spent += cost;
      }
      if (strokeLine(s.pixels, s.last, to, this.currentBrush(), s.value)) s.changed = true;
      s.last = to;
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
      if (s.changed) {
        let delta = s.spent;
        if (this.ink && this.tool === 'eraser') {
          let erased = 0;
          const before = this.project.pixels;
          for (let i = 0; i < before.length; i++) if (before[i] !== 0 && s.pixels[i] === 0) erased++;
          delta -= this.ink.refund(erased);
        }
        this.commit(this.ink ? { pixels: s.pixels, ink: this.chargeInk(this.project, delta) } : { pixels: s.pixels });
      } else this.notify();
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
    let spent = 0;
    if (this.ink && this.tool === 'pen') {
      const cost = this.ink.stroke(1, this.strokeSize(brush));
      if (cost > this.inkLeft) return; // plus d'encre: le crayon ne trace plus
      spent = cost;
    }
    const changed = stamp(pixels, Math.round(p.x), Math.round(p.y), { ...brush, size }, value);
    this.stroke = { pixels, last: p, changed, value, live: { pixels }, spent, exhausted: false };
    this.notify();
  }

  /** Épaisseur « payante » d'un trait: la taille du pinceau, allégée pour les textures qui noircissent moins. */
  private strokeSize(brush: Brush) {
    return brush.size * (TEXTURE_DENSITY[brush.texture] ?? 1);
  }

  private fillAt(p: Point) {
    const pixels = this.project.pixels.slice();
    if (!fill(pixels, Math.floor(p.x), Math.floor(p.y), this.color, this.fillTexture)) return;
    if (!this.ink) return this.commit({ pixels });
    let changed = 0;
    for (let i = 0; i < pixels.length; i++) if (pixels[i] !== this.project.pixels[i]) changed++;
    const cost = this.ink.fill(changed);
    if (cost > this.inkLeft) return; // trop grand pour la réserve
    this.commit({ pixels, ink: this.chargeInk(this.project, cost) });
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
    this.project = { pixels, stamps: base.stamps, shield: base.shield, ink: base.ink };
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
    this.project = { pixels, stamps: (f.base.stamps ?? 0) + (f.stamp ? 1 : 0), shield: f.base.shield, ink: f.stamp ? this.chargeInk(f.base, this.ink?.stamp() ?? 0) : f.base.ink };
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
    if (!def || this.mimo || this.text || this.decor || !this.canAfford('stamp')) return false;
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


  // ───────────── Encre (mode Survivor) ─────────────

  /** Encre restante, trait en cours compris; infinie dans le jeu classique. */
  get inkLeft(): number {
    if (!this.ink) return Infinity;
    return this.inkBudget - (this.project.ink?.spent ?? 0) - (this.stroke?.spent ?? 0);
  }

  /** Version du compteur d'encre après une dépense (ou, si négatif, un remboursement): jamais sous zéro. */
  private chargeInk(base: Project, delta: number, freeMimo = false) {
    return { spent: Math.max(0, (base.ink?.spent ?? 0) + delta), freeMimos: (base.ink?.freeMimos ?? 0) + (freeMimo ? 1 : 0) };
  }

  /** Mimo offert (reste-t-il un Mimo gratuit sur cette case ?). */
  get freeMimoLeft(): boolean {
    return !!this.ink && (this.project.ink?.freeMimos ?? 0) < this.ink.freeMimos;
  }

  /** Coût en encre de poser cet objet maintenant. */
  costOf(kind: 'mimo' | 'text' | 'decor' | 'stamp'): number {
    if (!this.ink) return 0;
    if (kind === 'mimo') return this.freeMimoLeft ? 0 : this.ink.mimo();
    return this.ink[kind]();
  }

  canAfford(kind: 'mimo' | 'text' | 'decor' | 'stamp'): boolean {
    return this.costOf(kind) <= this.inkLeft;
  }

  /** Coût de l'objet en cours de placement (0 s'il n'y en a pas): sert à la jauge. */
  get pendingCost(): number {
    if (this.mimo) return this.costOf('mimo');
    if (this.text) return this.costOf('text');
    if (this.decor) return this.costOf('decor');
    return 0;
  }

  get canPlacePending(): boolean {
    return this.pendingCost <= this.inkLeft;
  }

  // ───────────── Mimo ─────────────

  /** Pose un Mimo au centre de la toile: il reste modifiable jusqu'à « Placer » ou « Annuler ». */
  beginMimo(): boolean {
    if (this.mimo || this.text || this.decor) return false;
    this.commitFloating();
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
    const r = mimoRect({ ...m, fx: null });
    const shield = protect(this.project.shield, rasterMimo(m.spec, r.w, r.h).mask, r.w, r.h, r.left, r.top, 2, true);
    const cost = this.costOf('mimo');
    if (cost > this.inkLeft) return false;
    const free = this.freeMimoLeft;
    this.mimo = null;
    this.commit(this.ink ? { pixels, shield, ink: this.chargeInk(this.project, cost, free) } : { pixels, shield });
    return true;
  }

  cancelMimo() {
    if (!this.mimo) return;
    this.mimo = null;
    this.mimoView = null;
    this.notify();
  }

  // ───────────── Texte libre ─────────────

  /** Ouvre un texte vide au centre de la toile: il apparaît en noir dès qu'on écrit, et reste mobile jusqu'à « Placer ». */
  beginText(): boolean {
    if (this.mimo || this.text || this.decor) return false;
    this.commitFloating();
    this.selection = null;
    this.text = { value: '', cx: WIDTH / 2, cy: HEIGHT / 2, size: TEXT_DEFAULT };
    this.textView = null;
    this.notify();
    return true;
  }

  private refitText() {
    const t = this.text!;
    Object.assign(t, clampTextCenter(t.value, textSizeOf(t), t.cx, t.cy));
    this.textView = null;
    this.notify();
  }

  textSet(value: string) {
    if (!this.text) return;
    this.text.value = limitText(value);
    this.refitText();
  }

  textMoveTo(x: number, y: number) {
    if (!this.text) return;
    this.text.cx = x;
    this.text.cy = y;
    this.refitText();
  }

  textResize(size: number) {
    if (!this.text) return;
    this.text.size = Math.min(TEXT_MAX, Math.max(TEXT_MIN, Math.round(size)));
    this.refitText();
  }

  /** Vrai si le texte contient au moins une lettre que la police sait dessiner. */
  get textReady() {
    return !!this.text && textDims(this.text.value, textSizeOf(this.text)).w > 0;
  }

  /** Écrit le texte sur la toile (une entrée d'historique, comme un trait) et rend la main au crayon. */
  placeText(): boolean {
    const t = this.text;
    if (!t || !this.textReady) return false;
    const pixels = this.project.pixels.slice();
    drawText(pixels, t);
    const size = textSizeOf(t);
    const r = textRect(t);
    const halo = Math.max(2, Math.round(size * 0.2));
    const shield = protect(this.project.shield, rasterText(t.value, size).mask, r.w, r.h, r.left, r.top, halo, false);
    const cost = this.costOf('text');
    if (cost > this.inkLeft) return false;
    this.text = null;
    this.commit(this.ink ? { pixels, shield, ink: this.chargeInk(this.project, cost) } : { pixels, shield });
    return true;
  }

  cancelText() {
    if (!this.text) return;
    this.text = null;
    this.textView = null;
    this.notify();
  }

  // ───────────── Décor ─────────────

  /** Générateur de hasard du « Change ! » (remplaçable dans les tests). */
  random: () => number = Math.random;

  /** Pose un lieu tiré au hasard, derrière le dessin: déplaçable, redimensionnable, éléments retirables jusqu'à « Placer ». */
  beginDecor(): boolean {
    if (this.mimo || this.text || this.decor) return false;
    this.commitFloating();
    this.selection = null;
    this.decor = { place: nextPlace(null, this.random), cx: WIDTH / 2, cy: HEIGHT / 2, width: DECOR_DEFAULT, removed: [], erasing: false, fx: null };
    this.decorView = null;
    this.notify();
    return true;
  }

  /** « Change ! »: un autre lieu au hasard (jamais le même), mêmes position et taille, éléments retirés remis. */
  decorChange(now: number = clock()) {
    const d = this.decor;
    if (!d) return;
    d.place = nextPlace(d.place, this.random);
    d.removed = [];
    d.fx = this.reducedMotion ? null : { t0: now, t: 0 };
    this.decorView = null;
    this.notify();
  }

  decorMoveTo(x: number, y: number) {
    const d = this.decor;
    if (!d || d.erasing) return;
    Object.assign(d, clampDecorCenter(x, y));
    this.decorView = null;
    this.notify();
  }

  decorResize(width: number) {
    const d = this.decor;
    if (!d || d.erasing) return;
    d.width = clampDecorSize(width);
    this.decorView = null;
    this.notify();
  }

  decorSetErasing(on: boolean) {
    if (!this.decor) return;
    this.decor.erasing = on;
    this.notify();
  }

  /** Mode « Gommer »: retire d'un toucher l'élément entier le plus proche; rien si le toucher tombe dans le vide. */
  decorRemoveAt(x: number, y: number): boolean {
    const d = this.decor;
    if (!d) return false;
    const id = pickElement(d, x, y);
    if (!id) return false;
    d.removed = [...d.removed, id];
    this.decorView = null;
    this.notify();
    return true;
  }

  /** Remet le dernier élément retiré. */
  decorRestore() {
    const d = this.decor;
    if (!d || !d.removed.length) return;
    d.removed = d.removed.slice(0, -1);
    this.decorView = null;
    this.notify();
  }

  decorFrame(now: number = clock()): boolean {
    const fx = this.decor?.fx;
    if (!fx) return false;
    fx.t = Math.min(1, (now - fx.t0) / DECOR_FX_MS);
    if (fx.t >= 1) this.decor!.fx = null;
    this.decorView = null;
    this.notify();
    return this.decor!.fx !== null;
  }

  /** Fusionne le décor derrière le dessin (une entrée d'historique): aucun pixel déjà dessiné n'est modifié. */
  placeDecor(): boolean {
    const d = this.decor;
    if (!d) return false;
    const pixels = this.project.pixels.slice();
    drawDecor(pixels, this.project.shield, d, false);
    const cost = this.costOf('decor');
    if (cost > this.inkLeft) return false;
    this.decor = null;
    this.commit(this.ink ? { pixels, ink: this.chargeInk(this.project, cost) } : { pixels });
    return true;
  }

  cancelDecor() {
    if (!this.decor) return;
    this.decor = null;
    this.decorView = null;
    this.notify();
  }

  // ───────────── Réglages d'outils ─────────────

  setTool(tool: Tool) {
    if (this.mimo || this.text || this.decor) return;
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
