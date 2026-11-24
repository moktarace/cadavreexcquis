import { DECOR_PLACES } from '../decor/art';
import type { EditorSession } from '../session';
import { ToyButton } from '../../ui';
import { placeLabel } from './placeLabel';

/** Commandes du décor en cours de placement: Gommer, Placer, Annuler. Le « Change ! » se fait en touchant le décor. */
export function DecorConsole({ session, onPlace }: { session: EditorSession; onPlace: () => void }) {
  const d = session.decor;
  if (!d) return null;
  return (
    <div className="decor-console" role="group" aria-label="Décor en cours de placement">
      <div className="decor-row">
        <ToyButton className="decor-erase" variant="soft" icon="eraser" selected={d.erasing} aria-pressed={d.erasing} onClick={() => session.decorSetErasing(!d.erasing)}>Gommer</ToyButton>
        <ToyButton variant="soft" iconOnly icon="undo" aria-label="Remettre le dernier élément retiré" title="Remettre le dernier élément retiré" disabled={d.removed.length === 0} onClick={() => session.decorRestore()} />
      </div>
      <p className="hint decor-name" role="status">
        {d.erasing ? 'Touche un élément pour le retirer. Gommer pour revenir au déplacement.' : `${DECOR_PLACES[d.place].name} · tape : Change ! · glisse : déplacer · pince : taille`}
      </p>
      <div className="decor-actions">
        <ToyButton variant="soft" icon="close" onClick={() => session.cancelDecor()}>Annuler</ToyButton>
        <ToyButton className="decor-place" variant="success" icon="check" disabled={!session.canPlacePending} onClick={onPlace}>{placeLabel(session)}</ToyButton>
      </div>
    </div>
  );
}
