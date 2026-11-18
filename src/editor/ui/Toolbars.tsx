import { PALETTE } from '../palette';
import { ERASER_SIZES, PEN_SIZES, TEXTURES, type Texture } from '../raster';
import type { EditorSession, Tool } from '../session';
import { ColorSwatch, ToyButton, type IconName } from '../../ui';

const TOOLS: { id: Tool; label: string; title: string; icon: IconName }[] = [
  { id: 'pen', label: 'Stylo', title: 'Stylo', icon: 'pencil' },
  { id: 'eraser', label: 'Gomme', title: 'Gomme', icon: 'eraser' },
  { id: 'fill', label: 'Pot', title: 'Pot de peinture et motifs', icon: 'bucket' },
  { id: 'rect', label: 'Rect.', title: 'Sélection rectangulaire', icon: 'selectRect' },
  { id: 'lasso', label: 'Lasso', title: 'Sélection libre', icon: 'lasso' },
  { id: 'move', label: 'Bouger', title: 'Déplacer la sélection ou le dessin', icon: 'move' },
  { id: 'hand', label: 'Main', title: 'Déplacer la vue', icon: 'hand' },
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

/** Commandes essentielles: stylo, gomme, et l'accès à la palette d'outils secondaire. */
export function ToolRow({ session, moreOpen, onMore }: { session: EditorSession; moreOpen: boolean; onMore: () => void }) {
  const other = TOOLS.find((t) => t.id === session.tool && !ESSENTIAL.includes(t.id));
  return (
    <div className="ed-tools" role="toolbar" aria-label="Outils">
      {TOOLS.filter((t) => ESSENTIAL.includes(t.id)).map((t) => toolButton(session, t, 'tool-btn tool-btn--main'))}
      <span className="ed-tools__gap" />
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
export function SecondaryTools({ session }: { session: EditorSession }) {
  return (
    <div className="ed-secondary" role="toolbar" aria-label="Autres outils">
      {TOOLS.filter((t) => !ESSENTIAL.includes(t.id)).map((t) => toolButton(session, t, 'tool-btn'))}
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

export function OptionsRow({ session }: { session: EditorSession }) {
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
