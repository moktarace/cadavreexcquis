import { useState } from 'react';
import { useRewards } from '../../app/rewards';
import { REWARD_CONFIG, STICKERS, unlockCondition, unlockedSet } from '../../domain/stickers';
import { PALETTE } from '../palette';
import { ERASER_SIZES, PEN_SIZES, TEXTURES, type Texture } from '../raster';
import type { EditorSession, Tool } from '../session';
import { ColorSwatch, PixelIcon, StickerArt, ToyButton, type IconName } from '../../ui';

const TOOLS: { id: Tool; label: string; title: string; icon: IconName }[] = [
  { id: 'pen', label: 'Stylo', title: 'Stylo', icon: 'pencil' },
  { id: 'eraser', label: 'Gomme', title: 'Gomme', icon: 'eraser' },
  { id: 'fill', label: 'Pot', title: 'Pot de peinture et motifs', icon: 'bucket' },
  { id: 'rect', label: 'Rect.', title: 'Sélection rectangulaire', icon: 'selectRect' },
  { id: 'lasso', label: 'Lasso', title: 'Sélection libre', icon: 'lasso' },
  { id: 'move', label: 'Bouger', title: 'Déplacer la sélection ou le dessin', icon: 'move' },
  { id: 'hand', label: 'Main', title: 'Déplacer la vue', icon: 'hand' },
  { id: 'stamp', label: 'Tampons', title: 'Poser un tampon', icon: 'star' },
];

const ESSENTIAL: Tool[] = ['pen', 'eraser'];

function toolButton(session: EditorSession, t: (typeof TOOLS)[number], className: string) {
  return (
    <ToyButton
      key={t.id}
      className={className}
      variant="soft"
      size="s"
      icon={t.icon}
      selected={session.tool === t.id}
      aria-label={t.title}
      title={t.title}
      onClick={() => session.setTool(t.id)}
    >
      {t.label}
    </ToyButton>
  );
}

/** Commandes essentielles (en Survivor, `session.ink` est défini: icônes de personnage et de lettre pour Mimo et Texte): stylo, gomme, et l'accès à la palette d'outils secondaire. */
export function ToolRow({ session, moreOpen, onMore, onMimo, onText }: { session: EditorSession; moreOpen: boolean; onMore: () => void; onMimo?: () => void; onText?: () => void }) {
  const other = TOOLS.find((t) => t.id === session.tool && !ESSENTIAL.includes(t.id));
  return (
    <div className="ed-tools" role="toolbar" aria-label="Outils">
      {TOOLS.filter((t) => ESSENTIAL.includes(t.id)).map((t) => toolButton(session, t, 'tool-btn tool-btn--main'))}
      <span className="ed-tools__gap" />
      {onMimo && (
        <ToyButton
          className="tool-btn tool-btn--more tool-btn--mimo"
          variant="soft"
          size="s"
          icon={session.ink ? 'mimo' : 'plus'}
          disabled={!session.canAfford('mimo')}
          aria-label={session.ink ? 'Ajouter un personnage Mimo' : 'Ajouter un Mimo'}
          title={session.ink ? 'Ajouter un personnage Mimo' : 'Ajouter un Mimo'}
          onClick={onMimo}
        >
          Mimo
        </ToyButton>
      )}
      {onText && (
        <ToyButton className="tool-btn tool-btn--more tool-btn--mimo" variant="soft" size="s" icon={session.ink ? 'text' : 'plus'} disabled={!session.canAfford('text')} aria-label="Ajouter du texte" title="Ajouter du texte" onClick={onText}>
          Texte
        </ToyButton>
      )}
      <ToyButton
        className="tool-btn tool-btn--more"
        variant="soft"
        size="s"
        icon={other ? other.icon : 'gear'}
        selected={moreOpen || !!other}
        aria-expanded={moreOpen}
        aria-controls="ed-more"
        onClick={onMore}
      >
        {other ? other.label : 'Outils'}
      </ToyButton>
    </div>
  );
}

/** Outils supplémentaires: pot, sélections, déplacement, main. */
export function SecondaryTools({ session, onDecor }: { session: EditorSession; onDecor?: () => void }) {
  return (
    <div className="ed-secondary" role="toolbar" aria-label="Autres outils">
      {TOOLS.filter((t) => !ESSENTIAL.includes(t.id)).map((t) => toolButton(session, t, 'tool-btn'))}
      {onDecor && (
        <ToyButton className="tool-btn" variant="soft" size="s" icon="home" disabled={!session.canAfford('decor')} aria-label="Décor : un lieu tiré au hasard" title="Décor : un lieu tiré au hasard" onClick={onDecor}>
          Décor
        </ToyButton>
      )}
    </div>
  );
}

function Sizes({ values, current, onPick }: { values: readonly number[]; current: number; onPick: (n: number) => void }) {
  return (
    <>
      {values.map((n) => (
        <ToyButton key={n} className="size-btn" variant="soft" size="s" iconOnly selected={current === n} aria-label={`Taille ${n}`} onClick={() => onPick(n)}>
          <span className="size-dot" style={{ width: Math.min(n, 22), height: Math.min(n, 22) }} />
        </ToyButton>
      ))}
    </>
  );
}

function TexturePicker({ value, onPick }: { value: Texture; onPick: (t: Texture) => void }) {
  return (
    <select className="toy-select ed-select" aria-label="Motif" value={value} onChange={(e) => onPick(e.target.value as Texture)}>
      {TEXTURES.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </select>
  );
}

/** Tampons de départ et récompenses: les verrouillés disent comment les obtenir et ne se sélectionnent pas. */
function StampTray({ session, onPicked }: { session: EditorSession; onPicked?: () => void }) {
  const { progress } = useRewards();
  const unlocked = unlockedSet(progress.stickers);
  const [hint, setHint] = useState<string | null>(null);
  const current = session.floating?.stamp?.id;
  return (
    <div className="stamp-tray">
      <div className="stamp-tray__row" role="group" aria-label="Tampons">
        {STICKERS.map((def) => {
          const open = unlocked.has(def.id);
          return (
            <button
              key={def.id}
              type="button"
              className={`stamp-btn ${current === def.id ? 'is-selected' : ''} ${open ? '' : 'is-locked'}`}
              aria-disabled={!open}
              aria-pressed={current === def.id}
              aria-label={open ? def.name : `${def.name}, verrouillé : ${unlockCondition(def)}`}
              title={open ? def.name : unlockCondition(def)}
              onClick={() => {
                if (!open) return setHint(`${def.name} : ${unlockCondition(def).toLowerCase()}.`);
                const placed = session.beginStamp(def.id);
                setHint(placed ? null : 'Tu as posé tous les tampons de cette case. Annule-en un pour en changer.');
                if (placed) onPicked?.();
              }}
            >
              <StickerArt def={def} size={3} locked={!open} />
              {!open && <PixelIcon name="lock" size={14} className="stamp-btn__lock" />}
            </button>
          );
        })}
      </div>
      <p className="hint" role="status">{hint ?? `Choisis un tampon : ${session.stampsPlaced} posé${session.stampsPlaced > 1 ? 's' : ''} sur ${session.maxStamps} possibles.`}</p>
    </div>
  );
}

export function OptionsRow({ session, onStampPicked }: { session: EditorSession; onStampPicked?: () => void }) {
  const selectionTool = session.tool === 'rect' || session.tool === 'lasso' || session.tool === 'move';
  return (
    <div className="ed-options">
      {session.tool === 'pen' && (
        <>
          <Sizes values={PEN_SIZES} current={session.pen.size} onPick={(size) => session.update({ pen: { ...session.pen, size } })} />
          <TexturePicker value={session.pen.texture} onPick={(texture) => session.update({ pen: { ...session.pen, texture } })} />
        </>
      )}
      {session.tool === 'eraser' && (
        <Sizes values={ERASER_SIZES} current={session.eraserSize} onPick={(eraserSize) => session.update({ eraserSize })} />
      )}
      {session.tool === 'fill' && (
        <TexturePicker value={session.fillTexture} onPick={(fillTexture) => session.update({ fillTexture })} />
      )}
      {selectionTool && (
        <>
          <ToyButton variant="soft" size="s" iconOnly icon="copy" aria-label="Copier" title="Copier" onClick={() => session.copy()} />
          <ToyButton variant="soft" size="s" iconOnly icon="cut" aria-label="Couper" title="Couper" onClick={() => session.cut()} />
          <ToyButton variant="soft" size="s" iconOnly icon="paste" aria-label="Coller" title="Coller" onClick={() => session.paste()} disabled={!session.clipboard} />
          <ToyButton variant="soft" size="s" iconOnly icon="trash" aria-label="Supprimer la sélection" title="Supprimer la sélection" onClick={() => session.deleteSelection()} />
          <ToyButton variant="soft" size="s" onClick={() => session.selectAll()}>Tout</ToyButton>
          <ToyButton variant="soft" size="s" aria-label="Retourner horizontalement" title="Retourner horizontalement" onClick={() => session.flip('h')}>Miroir H</ToyButton>
          <ToyButton variant="soft" size="s" aria-label="Retourner verticalement" title="Retourner verticalement" onClick={() => session.flip('v')}>Miroir V</ToyButton>
          <ToyButton variant="soft" size="s" iconOnly icon="rotate" aria-label="Rotation d'un quart de tour" title="Rotation d'un quart de tour" onClick={() => session.rotate()} />
        </>
      )}
      {session.tool === 'stamp' && <StampTray session={session} onPicked={onStampPicked} />}
      {session.tool === 'hand' && <span className="hint">Fais glisser pour déplacer. Deux doigts : zoom.</span>}
    </div>
  );
}

export function ColorRow({ session }: { session: EditorSession }) {
  return (
    <div className="ed-colors" role="group" aria-label="Couleurs">
      <div className="ed-colors__palette">
        {PALETTE.map((c, i) => (
          <ColorSwatch
            key={c.id}
            color={c.hex}
            label={c.label}
            selected={session.color === i}
            onClick={() => session.update({ color: i })}
          />
        ))}
      </div>
    </div>
  );
}

/** Taille du tampon en cours de placement, par multiples entiers (jamais de flou). */
export function StampSize({ session }: { session: EditorSession }) {
  const scales = REWARD_CONFIG.stampScales;
  const scale = session.floating?.stamp?.scale ?? session.stampScale;
  const i = scales.indexOf(scale);
  return (
    <>
      <ToyButton variant="soft" size="s" iconOnly icon="minus" aria-label="Tampon plus petit" disabled={i <= 0} onClick={() => session.setStampScale(scales[i - 1])} />
      <ToyButton variant="soft" size="s" iconOnly icon="plus" aria-label="Tampon plus grand" disabled={i >= scales.length - 1} onClick={() => session.setStampScale(scales[i + 1])} />
    </>
  );
}
