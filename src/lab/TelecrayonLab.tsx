import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { HEIGHT, PALETTE, WIDTH } from '../editor/palette';
import { indexedToRgba } from '../editor/render';
import { EditorSession } from '../editor/session';
import { ColorSwatch, ToyButton } from '../ui';
import { PROFILES, PROFILE_LABELS, Telecrayon, type PadSettings, type ProfileId, type StrokeOutcome } from './telecrayon';
import './telecrayon.css';

type Mode = 'pad' | 'direct';
type Stats = Record<Mode, { strokes: number; undos: number }>;

const EMPTY_STATS: Stats = { pad: { strokes: 0, undos: 0 }, direct: { strokes: 0, undos: 0 } };

const MODE_LABELS: Record<Mode, string> = { pad: 'Télécrayon', direct: 'Direct' };

/** Laboratoire: aucun appel serveur, aucune publication, aucune persistance. Rien n'est partagé avec l'éditeur du jeu. */
export default function TelecrayonLab() {
  const [session] = useState(() => new EditorSession());
  const [settings, setSettings] = useState<Record<ProfileId, PadSettings>>({ precise: { ...PROFILES.precise }, fast: { ...PROFILES.fast } });
  const [profile, setProfile] = useState<ProfileId>('precise');
  const [mode, setMode] = useState<Mode>('pad');
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [panel, setPanel] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const countStroke = (m: Mode) => {
    setStartedAt((t) => t ?? Date.now());
    setStats((s) => ({ ...s, [m]: { ...s[m], strokes: s[m].strokes + 1 } }));
  };

  const [pen] = useState(
    () => new Telecrayon(session, { ...PROFILES.precise }, (o: StrokeOutcome) => o === 'committed' && countStroke('pad')),
  );
  pen.settings = settings[profile];

  const hist = useSyncExternalStore(session.subscribe, () => `${session.canUndo ? 1 : 0}${session.canRedo ? 1 : 0}${session.color}`);
  const canUndo = hist[0] === '1';
  const canRedo = hist[1] === '1';
  const color = session.color;

  useEffect(() => {
    document.body.classList.add('editing');
    return () => document.body.classList.remove('editing');
  }, []);

  // Rotation, arrière-plan, perte de focus: le trait en cours est abandonné, jamais validé par accident.
  const directId = useRef<number | null>(null);
  useEffect(() => {
    const interrupt = () => {
      pen.interrupt();
      if (directId.current !== null) {
        directId.current = null;
        session.pointerCancel();
      }
    };
    const onVisibility = () => document.hidden && interrupt();
    window.addEventListener('blur', interrupt);
    window.addEventListener('pagehide', interrupt);
    window.addEventListener('orientationchange', interrupt);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', interrupt);
      window.removeEventListener('pagehide', interrupt);
      window.removeEventListener('orientationchange', interrupt);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pen, session]);

  // Essais au clavier: Espace tient lieu de TRACER pendant qu'on glisse sur le pavé à la souris.
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLButtonElement;
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !isField(e.target) && modeRef.current === 'pad') {
        e.preventDefault();
        pen.traceDown(-1);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo(e.shiftKey);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') pen.traceUp(-1);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pen]);

  const undo = (redo = false) => {
    if (redo) return session.redo();
    if (!session.canUndo) return;
    session.undo();
    setStats((s) => ({ ...s, [modeRef.current]: { ...s[modeRef.current], undos: s[modeRef.current].undos + 1 } }));
  };

  const clear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    setConfirmClear(false);
    if (session.project.pixels.some(Boolean)) session.deleteSelection();
  };

  const switchMode = (m: Mode) => {
    pen.interrupt();
    setMode(m);
  };

  return (
    <div className={`lab lab--${mode}`} onContextMenu={(e) => e.preventDefault()}>
      <header className="lab-head">
        <ToyButton variant="soft" size="s" iconOnly icon="back" href="#/" aria-label="Quitter le laboratoire" />
        <div className="lab-title">
          <strong>Télécrayon</strong>
          <span>Prototype · rien n’est publié</span>
        </div>
        <div className="lab-modes" role="group" aria-label="Méthode de dessin">
          {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
            <button key={m} type="button" className={mode === m ? 'is-on' : ''} aria-pressed={mode === m} onClick={() => switchMode(m)}>
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
        <ToyButton variant="soft" size="s" iconOnly icon="gear" selected={panel} aria-label="Mesures du laboratoire" onClick={() => setPanel(!panel)} />
      </header>

      <section className="lab-stage">
        <LabCanvas session={session} pen={pen} mode={mode} directId={directId} onDirectStroke={() => countStroke('direct')} />
        {panel && (
          <Panel
            mode={mode} profile={profile} settings={settings} stats={stats} startedAt={startedAt}
            onSettings={(p, s) => setSettings((cur) => ({ ...cur, [p]: s }))}
            onReset={() => { setStats(EMPTY_STATS); setStartedAt(null); setSettings({ precise: { ...PROFILES.precise }, fast: { ...PROFILES.fast } }); }}
          />
        )}
      </section>

      <div className="lab-palette" role="group" aria-label="Couleurs">
        {PALETTE.map((c, i) => (
          <ColorSwatch key={c.id} color={c.hex} label={c.label} selected={color === i} onClick={() => session.update({ color: i })} />
        ))}
      </div>

      <div className="lab-strip">
        <ToyButton variant="soft" size="s" iconOnly icon="undo" aria-label="Annuler" disabled={!canUndo} onClick={() => undo()} />
        <ToyButton variant="soft" size="s" iconOnly icon="redo" aria-label="Rétablir" disabled={!canRedo} onClick={() => undo(true)} />
        {mode === 'pad' && (
          <div className="lab-profiles" role="group" aria-label="Sensibilité du pavé">
            {(Object.keys(PROFILE_LABELS) as ProfileId[]).map((p) => (
              <button key={p} type="button" className={profile === p ? 'is-on' : ''} aria-pressed={profile === p} onClick={() => setProfile(p)}>
                {PROFILE_LABELS[p]}
              </button>
            ))}
          </div>
        )}
        <span className="lab-strip__gap" />
        <ToyButton variant={confirmClear ? 'danger' : 'soft'} size="s" icon="trash" onClick={clear}>{confirmClear ? 'Sûr ?' : 'Effacer'}</ToyButton>
      </div>

      {mode === 'pad' ? <Controls pen={pen} /> : <p className="lab-direct-hint">Mode Direct : le doigt dessine directement sur la toile, comme dans l’éditeur du jeu.</p>}
    </div>
  );
}

// ───────────── Toile et curseur ─────────────

function LabCanvas({ session, pen, mode, directId, onDirectStroke }: {
  session: EditorSession;
  pen: Telecrayon;
  mode: Mode;
  directId: React.MutableRefObject<number | null>;
  onDirectStroke: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const paint = () => {
      frame.current = 0;
      const c = canvas.current;
      const o = overlay.current;
      if (!c || !o) return;
      const rgba = indexedToRgba(session.current().pixels);
      c.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, WIDTH, HEIGHT), 0, 0);
      const ctx = o.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, o.width, o.height);
      if (modeRef.current === 'pad') drawCursor(ctx, o.width, pen, PALETTE[session.color].hex);
    };
    const schedule = () => {
      if (!frame.current) frame.current = requestAnimationFrame(paint);
    };
    const resize = () => {
      const o = overlay.current;
      const b = box.current;
      if (!o || !b) return;
      const dpr = window.devicePixelRatio || 1;
      o.width = Math.round(b.clientWidth * dpr);
      o.height = Math.round(b.clientHeight * dpr);
      schedule();
    };
    const offSession = session.subscribe(schedule);
    const offPen = pen.subscribe(schedule);
    const ro = new ResizeObserver(resize);
    ro.observe(box.current!);
    resize();
    schedule();
    return () => {
      offSession();
      offPen();
      ro.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [session, pen, mode]);

  useEffect(() => {
    const el = box.current!;
    const prevent = (e: Event) => e.preventDefault();
    const types = ['gesturestart', 'gesturechange', 'gestureend'];
    for (const t of types) el.addEventListener(t, prevent, { passive: false });
    return () => types.forEach((t) => el.removeEventListener(t, prevent));
  }, []);

  const logical = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * WIDTH, y: ((e.clientY - r.top) / r.height) * HEIGHT };
  };

  const direct = mode === 'direct';
  return (
    <div
      ref={box}
      className={`lab-board ${direct ? 'is-direct' : ''}`}
      onPointerDown={(e) => {
        if (!direct || directId.current !== null) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        directId.current = e.pointerId;
        const p = logical(e);
        session.pointerDown(p.x, p.y);
      }}
      onPointerMove={(e) => {
        if (!direct || directId.current !== e.pointerId) return;
        const evs = (e.nativeEvent.getCoalescedEvents?.() ?? []) as PointerEvent[];
        const r = canvas.current!.getBoundingClientRect();
        for (const ev of evs.length ? evs : [e.nativeEvent]) {
          session.pointerMove(((ev.clientX - r.left) / r.width) * WIDTH, ((ev.clientY - r.top) / r.height) * HEIGHT);
        }
      }}
      onPointerUp={(e) => {
        if (directId.current !== e.pointerId) return;
        directId.current = null;
        session.pointerUp();
        onDirectStroke();
      }}
      onPointerCancel={(e) => {
        if (directId.current !== e.pointerId) return;
        directId.current = null;
        session.pointerCancel();
      }}
    >
      <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-label="Toile de dessin 320 par 240" />
      <canvas ref={overlay} className="lab-overlay" aria-hidden="true" />
    </div>
  );
}

/** Réticule au pixel ciblé; jamais intégré au dessin (calque d'affichage à la résolution de l'écran). */
function drawCursor(ctx: CanvasRenderingContext2D, deviceWidth: number, pen: Telecrayon, color: string) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cssW = deviceWidth / dpr;
  const s = cssW / WIDTH;
  const { x, y } = pen.cell;
  const cx = (x + 0.5) * s;
  const cy = (y + 0.5) * s;
  const outlined = (draw: () => void, w: number) => {
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = w + 3;
    draw();
    ctx.strokeStyle = '#141414';
    ctx.lineWidth = w;
    draw();
  };
  if (pen.cancelArmed) {
    const r = 9;
    outlined(() => { ctx.beginPath(); ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r); ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r); ctx.stroke(); }, 3);
    return;
  }
  if (pen.penDown) {
    outlined(() => { ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.stroke(); }, 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const gap = 3;
  const arm = 10;
  outlined(() => {
    ctx.beginPath();
    ctx.moveTo(cx - gap - arm, cy); ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + arm, cy);
    ctx.moveTo(cx, cy - gap - arm); ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + arm);
    ctx.stroke();
  }, 1.5);
}

// ───────────── Commandes tactiles ─────────────

function Controls({ pen }: { pen: Telecrayon }) {
  const state = useSyncExternalStore(pen.subscribe, () => (pen.cancelArmed ? 'armed' : pen.penDown ? 'down' : 'idle'));
  const dot = useRef<HTMLSpanElement>(null);
  const padBox = useRef<HTMLDivElement>(null);
  const zone = useRef<HTMLDivElement>(null);

  const moveDot = (e: React.PointerEvent) => {
    const r = padBox.current!.getBoundingClientRect();
    dot.current!.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px)`;
  };

  return (
    <div className="lab-ctrl">
      <div
        ref={padBox}
        className="lab-pad"
        role="application"
        aria-label="Pavé tactile : glisse le pouce pour déplacer le crayon"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          pen.padDown(e.pointerId, e.clientX, e.clientY, e.timeStamp);
          moveDot(e);
          dot.current!.classList.add('is-on');
        }}
        onPointerMove={(e) => {
          const evs = (e.nativeEvent.getCoalescedEvents?.() ?? []) as PointerEvent[];
          for (const ev of evs.length ? evs : [e.nativeEvent]) pen.padMove(e.pointerId, ev.clientX, ev.clientY, ev.timeStamp);
          if (pen.padActive) moveDot(e);
        }}
        onPointerUp={(e) => { pen.padUp(e.pointerId); dot.current?.classList.remove('is-on'); }}
        onPointerCancel={(e) => { pen.padUp(e.pointerId); dot.current?.classList.remove('is-on'); }}
        onLostPointerCapture={(e) => { pen.padUp(e.pointerId); dot.current?.classList.remove('is-on'); }}
      >
        <span className="lab-pad__label" aria-hidden="true">Glisse ici</span>
        <span ref={dot} className="lab-pad__dot" aria-hidden="true" />
      </div>

      <div className="lab-right">
        <div ref={zone} className={`lab-cancel is-${state}`} aria-hidden="true">
          {state === 'armed' ? 'Relâche : trait annulé' : state === 'down' ? '↑ Glisse ici pour annuler' : 'Annulation du trait'}
        </div>
        <button
          type="button"
          className={`lab-trace is-${state}`}
          aria-label="Tracer : maintiens pour dessiner"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            pen.traceDown(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!pen.penDown) return;
            const z = zone.current!.getBoundingClientRect();
            pen.setCancelArmed(e.pointerId, e.clientX >= z.left && e.clientX <= z.right && e.clientY >= z.top && e.clientY <= z.bottom);
          }}
          onPointerUp={(e) => pen.traceUp(e.pointerId)}
          onPointerCancel={(e) => pen.traceAbort(e.pointerId)}
          onLostPointerCapture={(e) => pen.traceAbort(e.pointerId)}
        >
          TRACER
        </button>
      </div>
    </div>
  );
}

// ───────────── Mesures locales (jamais envoyées) ─────────────

function Panel({ mode, profile, settings, stats, startedAt, onSettings, onReset }: {
  mode: Mode;
  profile: ProfileId;
  settings: Record<ProfileId, PadSettings>;
  stats: Stats;
  startedAt: number | null;
  onSettings: (p: ProfileId, s: PadSettings) => void;
  onReset: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const secs = startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  const s = settings[profile];
  const set = (patch: Partial<PadSettings>) => onSettings(profile, { ...s, ...patch });

  return (
    <aside className="lab-panel" aria-label="Mesures locales">
      <p><strong>Mode :</strong> {MODE_LABELS[mode]}{mode === 'pad' && <> · {PROFILE_LABELS[profile]}</>}</p>
      <p>
        <strong>Traits :</strong> direct {stats.direct.strokes} · télécrayon {stats.pad.strokes}</p>
      <p><strong>Annulations :</strong> direct {stats.direct.undos} · télécrayon {stats.pad.undos}
      </p>
      <p><strong>Temps depuis le premier trait :</strong> {Math.floor(secs / 60)} min {String(secs % 60).padStart(2, '0')} s</p>
      {mode === 'pad' && (
        <>
          <label className="lab-slider">
            <span>Vitesse du curseur : {s.gain.toFixed(2)}</span>
            <input type="range" min={0.1} max={1.5} step={0.05} value={s.gain} onChange={(e) => set({ gain: Number(e.target.value) })} />
          </label>
          <label className="lab-slider">
            <span>Accélération : ×{s.accel.toFixed(1)}</span>
            <input type="range" min={1} max={4} step={0.1} value={s.accel} onChange={(e) => set({ accel: Number(e.target.value) })} />
          </label>
          <label className="lab-slider">
            <span>Anti-tremblement : {s.slop.toFixed(1)} px</span>
            <input type="range" min={0} max={6} step={0.5} value={s.slop} onChange={(e) => set({ slop: Number(e.target.value) })} />
          </label>
        </>
      )}
      <ToyButton variant="soft" size="s" onClick={onReset}>Tout remettre à zéro</ToyButton>
      <p className="lab-panel__note">Données gardées sur cet écran uniquement, perdues en quittant la page.</p>
    </aside>
  );
}
