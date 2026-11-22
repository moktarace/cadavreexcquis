import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Target } from '../../backend/api';
import { go } from '../../app/router';
import { ToyButton, ToyDialog } from '../../ui';
import { EditorSession, closesDrawerOnDraw } from '../session';
import { Brief, useBrief } from './Brief';
import { ContextPanel, PublishSheet } from './PublishSheet';
import { SettingsPanel } from './Panels';
import { Stage, type StageHandle } from './Stage';
import { ColorRow, OptionsRow, SecondaryTools, StampSize, ToolRow } from './Toolbars';

const PREFS_KEY = 'cl.editorPrefs.v1';

/** Le dessin n'existe qu'ici: on le publie, ou on le perd en quittant. */
export function EditorScreen({ parentId }: { parentId: string | null }) {
  const [session] = useState(() => new EditorSession());
  const version = useSyncExternalStore(session.subscribe, session.getVersion);
  const target: Target = parentId ? { kind: 'continue', parentId } : { kind: 'root' };
  const onClose = () => {
    if (session.canUndo && !window.confirm('Abandonner ce dessin ? Il ne sera pas conservé.')) return;
    go(parentId ? { name: 'play', startId: parentId } : { name: 'home' });
  };
  const brief = useBrief(parentId);
  const [moreOpen, setMoreOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const stage = useRef<StageHandle | null>(null);

  useEffect(() => {
    document.body.classList.add('editing');
    return () => document.body.classList.remove('editing');
  }, []);

  // Rotation de l'appareil: on met le dessin à l'abri avant que la mise en page ne change.
  useEffect(() => {
    const flush = () => session.flush();
    window.addEventListener('orientationchange', flush);
    return () => window.removeEventListener('orientationchange', flush);
  }, [session]);

  // Réglage stylet seul conservé d'une session à l'autre.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
      session.update({ penOnly: saved.penOnly === true });
    } catch {
      // préférences illisibles: valeurs par défaut
    }
    const unsubscribe = session.subscribe(() => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ penOnly: session.penOnly }));
    });
    return () => {
      unsubscribe();
    };
  }, [session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) session.redo();
        else session.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        session.redo();
      } else if (mod && e.key.toLowerCase() === 'c') {
        session.copy();
      } else if (mod && e.key.toLowerCase() === 'v') {
        session.paste();
      } else if (mod && e.key.toLowerCase() === 'x') {
        session.cut();
      } else if (!mod && e.key === 'Enter') {
        session.commitFloating();
      } else if (!mod && e.key === 'Escape') {
        session.cancelFloating();
      } else if (!mod && e.key === 'Delete') {
        session.deleteSelection();
      } else if (!mod && e.key === '+') {
        stage.current?.zoomBy(1.25);
      } else if (!mod && e.key === '-') {
        stage.current?.zoomBy(0.8);
      } else if (!mod && e.key === '0') {
        stage.current?.fit();
      } else if (!mod) {
        const tool = { b: 'pen', e: 'eraser', g: 'fill', m: 'rect', l: 'lasso', v: 'move', h: 'hand' }[e.key.toLowerCase()];
        if (tool) session.setTool(tool as Parameters<typeof session.setTool>[0]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  return (
    <div className="editor">
      <header className="ed-top">
        <ToyButton className="ed-collapse" variant="soft" size="s" icon="back" onClick={onClose} aria-label="Quitter l'éditeur">Quitter</ToyButton>
        <span className="spacer" />
        <ToyButton variant="soft" size="s" iconOnly icon="undo" onClick={() => session.undo()} disabled={!session.canUndo} aria-label="Annuler" title="Annuler" />
        <ToyButton variant="soft" size="s" iconOnly icon="redo" onClick={() => session.redo()} disabled={!session.canRedo} aria-label="Rétablir" title="Rétablir" />
        <ToyButton variant="primary" size="s" icon="share" onClick={() => { session.flush(); setPublishOpen(true); }}>Publier ma case</ToyButton>
      </header>

      <div className="ed-brief-row">
        {brief && <Brief info={brief} />}
        {parentId && (
          <ToyButton className="ed-review" variant="soft" size="s" icon="eye" onClick={() => setContextOpen(true)}>Revoir l’histoire</ToyButton>
        )}
      </div>

      <div className="ed-stage" onPointerDownCapture={() => moreOpen && closesDrawerOnDraw(session.tool) && setMoreOpen(false)}>
        <Stage session={session} version={version} handleRef={stage} />
        {session.floating && (
          <div className="ed-floating" role="group" aria-label={session.floating.stamp ? 'Tampon en cours de placement' : 'Sélection en cours de déplacement'}>
            {session.floating.stamp && <StampSize session={session} />}
            <ToyButton variant="success" size="s" icon="check" onClick={() => session.commitFloating()}>OK</ToyButton>
            <ToyButton variant="soft" size="s" icon="close" onClick={() => session.cancelFloating()}>Annuler</ToyButton>
          </div>
        )}
        <div className="ed-zoom" role="group" aria-label="Zoom">
          <ToyButton variant="soft" size="s" iconOnly icon="plus" onClick={() => stage.current?.zoomBy(1.25)} aria-label="Zoom avant" />
          <ToyButton variant="soft" size="s" iconOnly icon="minus" onClick={() => stage.current?.zoomBy(0.8)} aria-label="Zoom arrière" />
          <ToyButton variant="soft" size="s" iconOnly onClick={() => stage.current?.fit()} aria-label="Ajuster la vue">1:1</ToyButton>
        </div>
      </div>

      <section className="ed-console" aria-label="Outils de dessin">
        {moreOpen && (
          <div className="ed-more" id="ed-more">
            <SecondaryTools session={session} />
            <OptionsRow session={session} onStampPicked={() => setMoreOpen(false)} />
            <SettingsPanel session={session} />
          </div>
        )}
        <ToolRow session={session} moreOpen={moreOpen} onMore={() => setMoreOpen((v) => !v)} />
        <ColorRow session={session} />
      </section>

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
    </div>
  );
}
