import { useState } from 'react';
import { ApiError, cardPath, explain, publish, type Target } from '../../backend/api';
import { useGame } from '../../app/game';
import { useOnline } from '../../app/hooks';
import { go } from '../../app/router';
import { useAsync } from '../../pages/shared';
import { ThreadPeek, ToyButton, ToyCard, ToyDialog } from '../../ui';
import type { EditorSession } from '../session';
import { caseRole } from '../../domain/play';
import type { BriefInfo } from './Brief';
import { Thumb } from './Panels';
import { cardAlt } from '../../domain/moderation';

interface Props {
  session: EditorSession;
  target: Target;
  /** Rang de la case et thème d'origine de l'histoire. */
  brief: BriefInfo | null;
  onClose: () => void;
}

/** Vérification finale du dessin et de la case parente, avant d'envoyer au serveur. */
export function PublishSheet({ session, target, brief, onClose }: Props) {
  const g = useGame();
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [periodOver, setPeriodOver] = useState(false);
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
      setPeriodOver(e instanceof ApiError && (e.code === 'GAME_EXPIRED' || e.code === 'GAME_NOT_ACTIVE'));
      setBusy(false);
    }
  };

  return (
    <ToyDialog
      open
      title="Publier ma case"
      onClose={onClose}
      locked={busy}
      actions={
        <>
          <ToyButton variant="soft" onClick={onClose} disabled={busy}>Retour au dessin</ToyButton>
          <ToyButton variant="primary" icon="share" onClick={send} loading={busy} disabled={blocked !== null}>
            {busy ? 'Publication…' : 'Publier ma case'}
          </ToyButton>
        </>
      }
    >
      {brief?.themeText && <p className="theme-banner">{brief.themeText}</p>}
      {brief && <p className="hint"><strong>{caseRole(brief.caseNumber).position}</strong>{caseRole(brief.caseNumber).final ? ' : c’est la dernière case de cette histoire.' : ''}</p>}
      <div className="publish-preview">
        {context.data?.map((c) => (
          <figure key={c.id}>
            <img src={c.previewUrl} alt={cardAlt(c)} width={80} height={60} />
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
      {periodOver && (
        <div className="row-buttons">
          {target.kind === 'root' ? (
            <ToyButton variant="primary" icon="star" onClick={() => { setError(null); setPeriodOver(false); g.reload(); }}>Rejoindre le thème de la semaine</ToyButton>
          ) : (
            <ToyButton variant="primary" icon="home" onClick={() => go({ name: 'home' })}>Voir le thème de la semaine</ToyButton>
          )}
        </div>
      )}
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
