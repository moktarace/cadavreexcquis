import { useState } from 'react';
import { cardPath, explain, publish, type Target } from '../../backend/api';
import { useGame } from '../../app/game';
import { useOnline } from '../../app/hooks';
import { go } from '../../app/router';
import { useAsync } from '../../pages/shared';
import { ThreadPeek, ToyButton, ToyCard, ToyDialog } from '../../ui';
import type { EditorSession } from '../session';
import { Thumb } from './Panels';

interface Props {
  session: EditorSession;
  target: Target;
  onClose: () => void;
}

/** Vérification finale du dessin et de la case parente, avant d'envoyer au serveur. */
export function PublishSheet({ session, target, onClose }: Props) {
  const g = useGame();
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = session.current();
  const parentId = target.kind === 'continue' ? target.parentId : null;
  const context = useAsync(() => (parentId ? cardPath(parentId) : Promise.resolve([])), [parentId]);

  const blocked = !online
    ? 'Connexion requise pour publier.'
    : g.status !== 'ready' || !g.game || !g.me
      ? (g.error ?? 'Le serveur n’est pas joignable.')
      : null;

  const send = async () => {
    if (!g.game || !g.me) return;
    setBusy(true);
    setError(null);
    try {
      session.flush();
      const id = await publish(session.current(), target, g.game, g.me.userId);
      go({ name: 'published', id });
    } catch (e) {
      setError(explain(e));
      setBusy(false);
    }
  };

  return (
    <ToyDialog
      open
      title={target.kind === 'root' ? 'Publier une case 1' : 'Publier la suite'}
      onClose={onClose}
      locked={busy}
      actions={
        <>
          <ToyButton variant="soft" onClick={onClose} disabled={busy}>Retour au dessin</ToyButton>
          <ToyButton variant="primary" icon="share" onClick={send} loading={busy} disabled={blocked !== null}>
            {busy ? 'Publication…' : 'Publier'}
          </ToyButton>
        </>
      }
    >
      {g.game && <p className="theme-banner">{g.game.themeText}</p>}
      <div className="publish-preview">
        {context.data?.map((c) => (
          <figure key={c.id}>
            <img src={c.previewUrl} alt={`Case ${c.caseNumber} de ${c.authorName}`} width={80} height={60} />
            <figcaption>{c.caseNumber}</figcaption>
          </figure>
        ))}
        <figure className="mine">
          <Thumb project={project} />
          <figcaption>{(context.data?.length ?? 0) + 1} · ton dessin</figcaption>
        </figure>
      </div>
      <p className="hint">
        Une fois publié, ton dessin est public et ne peut plus être modifié.
      </p>
      {blocked && <ToyCard tone="pink"><p>{blocked}</p></ToyCard>}
      {error && <ToyCard tone="error"><p role="alert">{error}</p></ToyCard>}
    </ToyDialog>
  );
}

/** Cases précédentes de l'histoire, consultables pendant que l'on dessine. */
export function ContextPanel({ parentId }: { parentId: string }) {
  const path = useAsync(() => cardPath(parentId), [parentId]);
  return (
    <>
      {path.error && <p className="error-text">{path.error}</p>}
      {path.loading && <p className="hint">Chargement…</p>}
      {path.data && path.data.length > 0 && <ThreadPeek cards={path.data} />}
    </>
  );
}
