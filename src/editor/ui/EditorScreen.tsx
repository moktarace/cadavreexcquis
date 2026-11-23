import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import type { Target } from '../../backend/api';
import { go } from '../../app/router';
import { ToyButton, ToyDialog } from '../../ui';
import { EditorSession, closesDrawerOnDraw } from '../session';
import { Brief, useBrief } from './Brief';
import { MimoConsole, MimoHint } from './MimoConsole';
import { ContextPanel, PublishSheet } from './PublishSheet';
import { SettingsPanel } from './Panels';
import { Stage, type StageHandle } from './Stage';
import { TextConsole } from './TextConsole';
import { ColorRow, OptionsRow, SecondaryTools, StampSize, ToolRow } from './Toolbars';

const PREFS_KEY = 'cl.editorPrefs.v1';
const MIMO_HINT_KEY = 'cl.mimoHint.v1';

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
  const editor = useRef<HTMLDivElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const [mimoHint, setMimoHint] = useState(false);
  const [popped, setPopped] = useState(false);

  useEffect(() => {
    session.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }, [session]);

  useEffect(() => {
    if (!mimoHint) return;
    const id = window.setTimeout(() => setMimoHint(false), 7000);
    return () => window.clearTimeout(id);
  }, [mimoHint]);

  const addMimo = () => {
    if (!session.beginMimo()) return;
    setMoreOpen(false);
    try {
      if (!localStorage.getItem(MIMO_HINT_KEY)) {
        localStorage.setItem(MIMO_HINT_KEY, '1');
        setMimoHint(true);
      }
    } catch {
      // stockage indisponible: pas d'indication
    }
  };

  // L'ouverture du clavier doit se faire dans le geste de l'utilisateur: on rend le champ tout de suite, puis on lui donne le focus.
  const addText = () => {
    setMoreOpen(false);
    flushSync(() => {
      session.beginText();
    });
    textInput.current?.focus({ preventScroll: true });
  };

  const placeText = () => {
    if (!session.placeText()) return;
    setPopped(true);
    window.setTimeout(() => setPopped(false), 320);
  };

  // Clavier virtuel: la console suit le bas de la zone réellement visible, les boutons restent accessibles.
  const typing = !!session.text;
  useEffect(() => {
    const vv = window.visualViewport;
    const el = editor.current;
    if (!typing || !vv || !el) return;
    const fit = () => {
      el.style.height = `${vv.height}px`;
      el.style.transform = `translateY(${vv.offsetTop}px)`;
    };
    fit();
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    return () => {
      vv.removeEventListener('resize', fit);
      vv.removeEventListener('scroll', fit);
      el.style.height = '';
      el.style.transform = '';
    };
  }, [typing]);

  const placeMimo = () => {
    if (!session.placeMimo()) return;
    setMimoHint(false);
    setPopped(true);
    window.setTimeout(() => setPopped(false), 320);
  };

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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
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
        if (!session.placeMimo() && !session.placeText()) session.commitFloating();
      } else if (!mod && e.key === 'Escape') {
        if (session.mimo) session.cancelMimo();
        else if (session.text) session.cancelText();
        else session.cancelFloating();
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
    <div className="editor" ref={editor}>
      <header className="ed-top">
        <ToyButton className="ed-collapse" variant="soft" size="s" icon="back" onClick={onClose} aria-label="Quitter l'éditeur">Quitter</ToyButton>
        <span className="spacer" />
        <ToyButton variant="soft" size="s" iconOnly icon="undo" onClick={() => session.undo()} disabled={!session.canUndo} aria-label="Annuler" title="Annuler" />
        <ToyButton variant="soft" size="s" iconOnly icon="redo" onClick={() => session.redo()} disabled={!session.canRedo} aria-label="Rétablir" title="Rétablir" />
        <ToyButton variant="primary" size="s" icon="share" onClick={() => { session.placeMimo(); if (!session.placeText()) session.cancelText(); session.flush(); setPublishOpen(true); }}>Publier ma case</ToyButton>
      </header>

      <div className="ed-brief-row">
        {brief && <Brief info={brief} />}
        {parentId && (
          <ToyButton className="ed-review" variant="soft" size="s" icon="eye" onClick={() => setContextOpen(true)}>Revoir l’histoire</ToyButton>
        )}
      </div>

      <div className={`ed-stage ${popped ? 'is-popped' : ''}`} onPointerDownCapture={() => moreOpen && closesDrawerOnDraw(session.tool) && setMoreOpen(false)}>
        <Stage session={session} version={version} handleRef={stage} onTextTap={() => textInput.current?.focus({ preventScroll: true })} />
        {session.floating && (
          <div className="ed-floating" role="group" aria-label={session.floating.stamp ? 'Tampon en cours de placement' : 'Sélection en cours de déplacement'}>
            {session.floating.stamp && <StampSize session={session} />}
            <ToyButton variant="success" size="s" icon="check" onClick={() => session.commitFloating()}>OK</ToyButton>
            <ToyButton variant="soft" size="s" icon="close" onClick={() => session.cancelFloating()}>Annuler</ToyButton>
          </div>
        )}
        {mimoHint && session.mimo && <MimoHint />}
        <div className="ed-zoom" role="group" aria-label="Zoom" hidden={!!session.mimo || !!session.text}>
          <ToyButton variant="soft" size="s" iconOnly icon="plus" onClick={() => stage.current?.zoomBy(1.25)} aria-label="Zoom avant" />
          <ToyButton variant="soft" size="s" iconOnly icon="minus" onClick={() => stage.current?.zoomBy(0.8)} aria-label="Zoom arrière" />
          <ToyButton variant="soft" size="s" iconOnly onClick={() => stage.current?.fit()} aria-label="Ajuster la vue">1:1</ToyButton>
        </div>
      </div>

      <section className="ed-console" aria-label="Outils de dessin">
        {session.mimo ? (
          <MimoConsole session={session} onPlace={placeMimo} />
        ) : session.text ? (
          <TextConsole session={session} inputRef={textInput} onPlace={placeText} />
        ) : (
          <>
            {moreOpen && (
              <div className="ed-more" id="ed-more">
                <SecondaryTools session={session} />
                <OptionsRow session={session} onStampPicked={() => setMoreOpen(false)} />
                <SettingsPanel session={session} />
              </div>
            )}
            <ToolRow session={session} moreOpen={moreOpen} onMore={() => setMoreOpen((v) => !v)} onMimo={addMimo} onText={addText} />
            <ColorRow session={session} />
          </>
        )}
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
