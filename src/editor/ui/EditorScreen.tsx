import { useState } from 'react';
import type { Target } from '../../backend/api';
import { go } from '../../app/router';
import { ToyButton, ToyDialog } from '../../ui';
import { EditorSession } from '../session';
import { Brief, useBrief } from './Brief';
import { EditorWorkspace } from './EditorWorkspace';
import { ContextPanel, PublishSheet } from './PublishSheet';

/** Le dessin n'existe qu'ici: on le publie, ou on le perd en quittant. */
export function EditorScreen({ parentId }: { parentId: string | null }) {
  const [session] = useState(() => new EditorSession());
  const target: Target = parentId ? { kind: 'continue', parentId } : { kind: 'root' };
  const onClose = () => {
    if (session.canUndo && !window.confirm('Abandonner ce dessin ? Il ne sera pas conservé.')) return;
    go(parentId ? { name: 'play', startId: parentId } : { name: 'home' });
  };
  const brief = useBrief(parentId);
  const [contextOpen, setContextOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);

  return (
    <EditorWorkspace
      session={session}
      leading={<ToyButton className="ed-collapse" variant="soft" size="s" icon="back" onClick={onClose} aria-label="Quitter l'éditeur">Quitter</ToyButton>}
      trailing={(settle) => (
        <ToyButton variant="primary" size="s" icon="share" onClick={() => { settle(); setPublishOpen(true); }}>Publier ma case</ToyButton>
      )}
      brief={
        <>
          {brief && <Brief info={brief} />}
          {parentId && (
            <ToyButton className="ed-review" variant="soft" size="s" icon="eye" onClick={() => setContextOpen(true)}>Revoir l’histoire</ToyButton>
          )}
        </>
      }
    >
      {parentId && (
        <ToyDialog
          open={contextOpen}
          title="Revoir l’histoire"
          onClose={() => setContextOpen(false)}
          actions={<ToyButton variant="primary" icon="pencil" onClick={() => setContextOpen(false)}>Retour au dessin</ToyButton>}
        >
          <ContextPanel parentId={parentId} />
        </ToyDialog>
      )}
      {publishOpen && <PublishSheet session={session} target={target} brief={brief} onClose={() => setPublishOpen(false)} />}
    </EditorWorkspace>
  );
}
