import { useState } from 'react';
import { ToyButton, ToyCard } from '../../ui';
import { MODE_LABELS } from '../multi/types';
import { markSeen, seen } from './prefs';
import type { PlayTarget } from './types';

/** Aide contextuelle montrée une seule fois, à la découverte d'une mécanique. */
export function ContextHint({ id, children }: { id: string; children: React.ReactNode }) {
  const [gone, setGone] = useState(() => seen(id));
  if (gone) return null;
  return (
    <ToyCard tone="lavender" role="note">
      <p className="hint">{children}</p>
      <ToyButton variant="ghost" size="s" icon="check" onClick={() => { markSeen(id); setGone(true); }}>Compris</ToyButton>
    </ToyCard>
  );
}

export interface AfterActions {
  /** Prochaine activité suggérée par le serveur, hors la partie courante (jamais lancée sans geste du joueur). */
  next: PlayTarget;
  onNext: () => void;
  onArbiter: () => void;
}

/** Que faire après un tour: enchaîner sans repasser par l'accueil. */
export function NextActions({ after, onGames }: { after: AfterActions; onGames: () => void }) {
  const t = after.next;
  const label =
    t.kind === 'game' ? `Jouer un autre tour · ${MODE_LABELS[t.game.mode]} « ${t.game.theme} »` : t.kind === 'solo' ? 'Reprendre ma partie Solo' : t.kind === 'relay_new' ? 'Contribuer à un Relay' : null;
  return (
    <div className="row-buttons">
      {label ? (
        <ToyButton variant="primary" icon="play" onClick={after.onNext}>{label}</ToyButton>
      ) : (
        <ToyButton variant="primary" icon="eye" onClick={after.onArbiter}>Arbitrer une BD</ToyButton>
      )}
      <ToyButton variant="soft" icon="pages" onClick={onGames}>Retour à mes parties</ToyButton>
    </div>
  );
}
