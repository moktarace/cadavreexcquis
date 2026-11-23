import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HEIGHT, WIDTH } from '../palette';
import { indexedToRgba } from '../render';
import type { EditorSession } from '../session';
import { ObjectGesture, mimoPlaceable, textPlaceable } from '../mimo/gesture';
import { mimoRect } from '../mimo/mimo';
import { textRect } from '../text/text';

interface View {
  zoom: number;
  x: number;
  y: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 10;
const FIT: View = { zoom: 1, x: 0, y: 0 };

export interface StageHandle {
  zoomBy(factor: number): void;
  fit(): void;
}

interface Props {
  session: EditorSession;
  version: number;
  handleRef?: React.MutableRefObject<StageHandle | null>;
  /** Appui bref sur le texte en cours de placement (rouvre la saisie). */
  onTextTap?: () => void;
}

export function Stage({ session, version, handleRef, onTextTap }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 320, h: 240 });
  const [view, setView] = useState<View>(FIT);
  const viewRef = useRef(view);
  viewRef.current = view;

  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  const mode = useRef<'none' | 'draw' | 'gesture' | 'pan' | 'ignore'>('none');
  const drawingId = useRef<number | null>(null);
  const penDown = useRef(false);
  const lastPan = useRef({ x: 0, y: 0 });
  const gesture = useRef({ dist: 1, cx: 0, cy: 0 });
  const spaceHeld = useRef(false);
  const mimoGesture = useRef<ObjectGesture | null>(null);
  const textGesture = useRef<ObjectGesture | null>(null);
  const tapRef = useRef(onTextTap);
  // Le focus (donc le clavier) se prend dans l'événement « click »: sur iOS, c'est le seul endroit où il est accordé après un tap.
  const tapPending = useRef(false);
  tapRef.current = onTextTap;

  // Taille du plateau: le plus grand agrandissement qui tient dans la zone, marge comprise.
  const fit = Math.max(0.5, Math.min((size.w - 8) / WIDTH, (size.h - 8) / HEIGHT));
  const bw = WIDTH * fit;
  const bh = HEIGHT * fit;

  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const clamp = (v: View): View => {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom));
    const slackX = Math.max(0, (bw * zoom - bw) / 2 + bw * 0.25);
    const slackY = Math.max(0, (bh * zoom - bh) / 2 + bh * 0.25);
    return { zoom, x: Math.min(slackX, Math.max(-slackX, v.x)), y: Math.min(slackY, Math.max(-slackY, v.y)) };
  };

  // Zoom autour d'un point de l'écran.
  const zoomAt = (clientX: number, clientY: number, nextZoom: number) => {
    const rect = canvas.current!.getBoundingClientRect();
    const v = viewRef.current;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    const bx = (clientX - rect.left) / v.zoom;
    const by = (clientY - rect.top) / v.zoom;
    const boxRect = box.current!.getBoundingClientRect();
    const baseLeft = boxRect.left + (size.w - bw) / 2;
    const baseTop = boxRect.top + (size.h - bh) / 2;
    setView(clamp({ zoom: z, x: clientX - baseLeft - bx * z, y: clientY - baseTop - by * z }));
  };

  useEffect(() => {
    if (handleRef) {
      handleRef.current = {
        zoomBy: (f) => {
          const r = box.current!.getBoundingClientRect();
          zoomAt(r.left + r.width / 2, r.top + r.height / 2, viewRef.current.zoom * f);
        },
        fit: () => setView(FIT),
      };
    }
  });

  // Rendu des pixels: toujours 320×240, agrandi par le navigateur sans lissage.
  useLayoutEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    const rgba = indexedToRgba(session.current().pixels);
    ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, WIDTH, HEIGHT), 0, 0);

    const o = overlay.current!.getContext('2d')!;
    o.clearRect(0, 0, WIDTH, HEIGHT);
    if (session.mimo) drawFrame(o, mimoRect({ ...session.mimo, fx: null }));
    else if (session.text) {
      const r = textRect(session.text);
      if (r.w) drawFrame(o, r);
    }
    const mask = session.outline();
    if (mask) {
      o.fillStyle = '#000';
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          if (!mask[y * WIDTH + x]) continue;
          const edge =
            x === 0 || y === 0 || x === WIDTH - 1 || y === HEIGHT - 1 ||
            !mask[y * WIDTH + x - 1] || !mask[y * WIDTH + x + 1] || !mask[(y - 1) * WIDTH + x] || !mask[(y + 1) * WIDTH + x];
          if (!edge) continue;
          o.fillStyle = ((x >> 1) + (y >> 1)) % 2 ? '#fff' : '#000';
          o.fillRect(x, y, 1, 1);
        }
      }
    }
  }, [session, version]);

  const toLogical = (clientX: number, clientY: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * WIDTH, y: ((clientY - r.top) / r.height) * HEIGHT };
  };

  const pressureOf = (e: PointerEvent | React.PointerEvent) => {
    if (e.pointerType === 'pen') return e.pressure > 0 ? e.pressure : 0.5;
    return 1;
  };

  const startGesture = () => {
    const pts = [...pointers.current.values()].filter((p) => p.type === 'touch').slice(0, 2);
    if (pts.length < 2) return;
    gesture.current = {
      dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
      cx: (pts[0].x + pts[1].x) / 2,
      cy: (pts[0].y + pts[1].y) / 2,
    };
  };

  /** Geste de l'objet en cours de placement (Mimo ou texte), créé à la demande. */
  const placing = (): ObjectGesture | null => {
    if (session.text) return (textGesture.current ??= new ObjectGesture(textPlaceable(session, () => { tapPending.current = true; }), (x, y) => toLogical(x, y)));
    if (session.mimo) return (mimoGesture.current ??= new ObjectGesture(mimoPlaceable(session), (x, y) => toLogical(x, y)));
    return null;
  };
  const gestureActive = () => !!(mimoGesture.current?.active || textGesture.current?.active);
  const resetGestures = () => {
    mimoGesture.current?.reset();
    textGesture.current?.reset();
  };

  // Animation très courte d'un changement de pose, d'émotion ou de style.
  const fxStart = session.mimo?.fx?.t0;
  useEffect(() => {
    if (fxStart === undefined) return;
    let raf = 0;
    const step = () => {
      if (session.mimoFrame()) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [session, fxStart]);

  // Rotation ou perte de focus: le geste en cours est abandonné, rien n'est validé.
  useEffect(() => {
    const reset = () => resetGestures();
    window.addEventListener('blur', reset);
    window.addEventListener('orientationchange', reset);
    return () => {
      window.removeEventListener('blur', reset);
      window.removeEventListener('orientationchange', reset);
    };
  }, []);

  const onDown = (e: React.PointerEvent) => {
    if (session.mimo || session.text || gestureActive()) {
      // Un Mimo ou un texte en cours de placement: ces gestes ne dessinent jamais.
      // Pas d'événements souris « de compatibilité »: ils retireraient le focus (et le clavier) du champ de saisie.
      e.preventDefault();
      tapPending.current = false;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // pointeur déjà terminé
      }
      placing()?.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
      return;
    }
    if (e.pointerType === 'touch' && penDown.current) return; // rejet de la paume
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // pointeur déjà terminé: le geste continue sans capture
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (e.pointerType === 'pen') penDown.current = true;

    const touches = [...pointers.current.values()].filter((p) => p.type === 'touch').length;
    if (touches >= 2) {
      if (mode.current === 'draw') session.pointerCancel();
      mode.current = 'gesture';
      drawingId.current = null;
      startGesture();
      return;
    }
    if (mode.current === 'gesture' || mode.current === 'ignore') return;

    if (session.tool === 'hand' || e.button === 1 || spaceHeld.current || (session.penOnly && e.pointerType === 'touch')) {
      mode.current = 'pan';
      lastPan.current = { x: e.clientX, y: e.clientY };
      return;
    }
    const p = toLogical(e.clientX, e.clientY);
    mode.current = 'draw';
    drawingId.current = e.pointerId;
    session.pointerDown(p.x, p.y, pressureOf(e));
  };

  const onMove = (e: React.PointerEvent) => {
    if (gestureActive()) {
      mimoGesture.current?.move(e.pointerId, e.clientX, e.clientY);
      textGesture.current?.move(e.pointerId, e.clientX, e.clientY);
      return;
    }
    const known = pointers.current.get(e.pointerId);
    if (!known) return;
    known.x = e.clientX;
    known.y = e.clientY;

    if (mode.current === 'draw' && e.pointerId === drawingId.current) {
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const ev of events.length ? events : [e.nativeEvent]) {
        const p = toLogical(ev.clientX, ev.clientY);
        session.pointerMove(p.x, p.y, pressureOf(ev));
      }
    } else if (mode.current === 'pan') {
      const v = viewRef.current;
      setView(clamp({ ...v, x: v.x + e.clientX - lastPan.current.x, y: v.y + e.clientY - lastPan.current.y }));
      lastPan.current = { x: e.clientX, y: e.clientY };
    } else if (mode.current === 'gesture') {
      const pts = [...pointers.current.values()].filter((p) => p.type === 'touch').slice(0, 2);
      if (pts.length < 2) return;
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      const g = gesture.current;
      const v = viewRef.current;
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * (dist / g.dist)));
      zoomAt(cx, cy, nextZoom);
      setView((cur) => clamp({ ...cur, x: cur.x + (cx - g.cx), y: cur.y + (cy - g.cy) }));
      gesture.current = { dist, cx, cy };
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (gestureActive()) {
      mimoGesture.current?.up(e.pointerId, e.timeStamp, e.type === 'pointercancel');
      textGesture.current?.up(e.pointerId, e.timeStamp, e.type === 'pointercancel');
      return;
    }
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    if (e.pointerType === 'pen') penDown.current = false;
    if (mode.current === 'draw' && e.pointerId === drawingId.current) {
      if (e.type === 'pointercancel') session.pointerCancel();
      else session.pointerUp();
      drawingId.current = null;
    }
    const touches = [...pointers.current.values()].filter((p) => p.type === 'touch').length;
    if (pointers.current.size === 0) mode.current = 'none';
    else if (mode.current === 'gesture' && touches < 2) mode.current = 'ignore';
    else if (mode.current === 'pan') mode.current = 'none';
  };

  useEffect(() => {
    const el = box.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const object = session.text ? textPlaceable(session, () => {}) : session.mimo ? mimoPlaceable(session) : null;
      if (object) object.resize(object.size() * Math.exp(-e.deltaY * 0.0025)); // molette: taille de l'objet en cours de placement
      else if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, viewRef.current.zoom * Math.exp(-e.deltaY * 0.01));
      else setView((v) => clamp({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) spaceHeld.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld.current = false;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    // Safari iOS: empêche le zoom de la page par pincement, que touch-action ne bloque pas partout.
    const noGesture = (e: Event) => e.preventDefault();
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) el.addEventListener(type, noGesture, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) el.removeEventListener(type, noGesture);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  });

  const cursor = session.mimo || session.text ? 'move' : session.tool === 'hand' ? 'grab' : 'crosshair';

  return (
    <div
      ref={box}
      className="stage"
      style={{ cursor }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onClick={() => {
        if (!tapPending.current) return;
        tapPending.current = false;
        tapRef.current?.();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={board}
        className="board"
        style={{
          width: bw,
          height: bh,
          left: (size.w - bw) / 2,
          top: (size.h - bh) / 2,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
        }}
      >
        <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-label="Zone de dessin 320 par 240" />
        <canvas ref={overlay} width={WIDTH} height={HEIGHT} className="overlay" />
      </div>
    </div>
  );
}

/** Cadre de l'objet en cours de placement: coins et poignée de taille, noirs cerclés de blanc, visibles sur tout fond (jamais dans le dessin). */
function drawFrame(o: CanvasRenderingContext2D, r: { left: number; top: number; w: number; h: number }) {
  const len = Math.max(6, Math.min(14, Math.round(Math.min(r.w, r.h) / 4)));
  const right = r.left + r.w;
  const bottom = r.top + r.h;
  const corners: [number, number, number, number][] = [
    [r.left, r.top, 1, 1],
    [right, r.top, -1, 1],
    [r.left, bottom, 1, -1],
    [right, bottom, -1, -1],
  ];
  for (const [color, grow] of [['#fff', 2], ['#141414', 0]] as const) {
    o.fillStyle = color;
    for (const [x, y, dx, dy] of corners) {
      const t = 2 + grow * 2;
      o.fillRect(dx > 0 ? x - grow : x - len - grow, dy > 0 ? y - grow : y - t + grow, len + grow * 2, t);
      o.fillRect(dx > 0 ? x - grow : x - t + grow, dy > 0 ? y - grow : y - len - grow, t, len + grow * 2);
    }
  }
  // Poignée de taille au coin bas droit.
  o.fillStyle = '#fff';
  o.fillRect(right - 4, bottom - 4, 9, 9);
  o.fillStyle = '#141414';
  o.fillRect(right - 3, bottom - 3, 7, 7);
  o.fillStyle = '#fff';
  o.fillRect(right - 1, bottom - 1, 3, 3);
}
