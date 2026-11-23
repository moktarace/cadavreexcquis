import { useRef, useState } from 'react';
import { DESIGN_NAMES, EMOTION_NAMES, MIMO_DESIGNS, MIMO_EMOTIONS } from '../mimo/art';
import type { EditorSession } from '../session';
import { PixelIcon, ToyButton } from '../../ui';

/** Distance de glissement (px écran) pour passer à la variante suivante: un long glissement en enchaîne plusieurs. */
const STEP = 30;

interface ZoneProps {
  label: string;
  value: string;
  index: number;
  count: number;
  vertical?: boolean;
  onStep: (dir: 1 | -1) => void;
}

/** Zone de balayage: glisser (ou toucher une moitié) change de variante, sans menu. */
function SwipeZone({ label, value, index, count, vertical, onStep }: ZoneProps) {
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const el = useRef<HTMLDivElement>(null);

  const release = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved || e.type === 'pointercancel') return;
    const r = el.current!.getBoundingClientRect();
    // Toucher la moitié « suivante » avance, l'autre recule.
    onStep(vertical ? (e.clientY < r.top + r.height / 2 ? 1 : -1) : e.clientX > r.left + r.width / 2 ? 1 : -1);
  };

  return (
    <div
      ref={el}
      className={`mimo-zone ${vertical ? 'is-vertical' : ''}`}
      role="spinbutton"
      tabIndex={0}
      aria-label={`${label} : ${value}`}
      aria-valuemin={1}
      aria-valuemax={count}
      aria-valuenow={index + 1}
      aria-valuetext={value}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onStep(1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onStep(-1);
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const delta = vertical ? d.y - e.clientY : e.clientX - d.x;
        if (Math.abs(delta) < STEP) return;
        d.moved = true;
        d.x = e.clientX;
        d.y = e.clientY;
        onStep(delta > 0 ? 1 : -1);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <PixelIcon name={vertical ? 'play' : 'back'} size={18} className="mimo-zone__arrow mimo-zone__arrow--a" />
      <span className="mimo-zone__body">
        <span className="mimo-zone__label">{label}</span>
        <span className="mimo-zone__dots" aria-hidden="true">
          {Array.from({ length: count }, (_, i) => (
            <i key={i} className={i === index ? 'is-on' : ''} />
          ))}
        </span>
      </span>
      <PixelIcon name="play" size={18} className="mimo-zone__arrow mimo-zone__arrow--b" />
    </div>
  );
}

const HELP =
  'Tape le Mimo pour changer sa pose. Glisse sur Humeur ou Style (ou touche une moitié) pour changer son visage ou son look. Fais glisser le Mimo pour le déplacer, pince pour l’agrandir.';

/** Commandes du Mimo en cours de placement; remplace la console de dessin tant qu'il n'est pas placé. */
export function MimoConsole({ session, onPlace }: { session: EditorSession; onPlace: () => void }) {
  const m = session.mimo;
  const [help, setHelp] = useState(false);
  if (!m) return null;
  return (
    <div className="mimo-console" role="group" aria-label="Mimo en cours de placement">
      <div className="mimo-zones">
        <SwipeZone label="Humeur" value={EMOTION_NAMES[m.spec.emotion]} index={m.spec.emotion} count={MIMO_EMOTIONS} onStep={(d) => session.mimoStep('emotion', d)} />
        <SwipeZone label="Style" value={DESIGN_NAMES[m.spec.design]} index={m.spec.design} count={MIMO_DESIGNS} vertical onStep={(d) => session.mimoStep('design', d)} />
      </div>
      <div className="mimo-actions">
        <ToyButton variant="soft" icon="close" onClick={() => session.cancelMimo()}>Annuler</ToyButton>
        <ToyButton className="mimo-help" variant="ghost" size="s" iconOnly aria-label="Aide" aria-expanded={help} onClick={() => setHelp(!help)}>?</ToyButton>
        <ToyButton className="mimo-place" variant="success" icon="check" onClick={onPlace}>Placer</ToyButton>
      </div>
      {help && <p className="hint mimo-helptext" role="status">{HELP}</p>}
    </div>
  );
}

/** Indication courte et non bloquante, affichée au tout premier Mimo. */
export function MimoHint() {
  return (
    <p className="mimo-hint" role="status">
      Tape : pose · Glisse : variante · Pince : taille
    </p>
  );
}
