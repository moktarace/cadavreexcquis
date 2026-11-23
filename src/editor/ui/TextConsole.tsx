import { TEXT_MAX_CHARS } from '../text/text';
import type { EditorSession } from '../session';
import { ToyButton } from '../../ui';

/** Saisie du texte libre: un champ, « Annuler », « Placer ». Remplace la console de dessin tant que le texte n'est pas placé. */
export function TextConsole({ session, inputRef, onPlace }: { session: EditorSession; inputRef: React.RefObject<HTMLTextAreaElement | null>; onPlace: () => void }) {
  const t = session.text;
  if (!t) return null;
  const length = [...t.value].length;
  return (
    <div className="text-console" role="group" aria-label="Texte en cours de placement">
      <textarea
        ref={inputRef}
        className="toy-input text-input"
        rows={2}
        value={t.value}
        maxLength={TEXT_MAX_CHARS}
        placeholder="Écris ici…"
        aria-label="Texte à écrire sur le dessin"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => session.textSet(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onPlace();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            session.cancelText();
          }
        }}
      />
      {length >= TEXT_MAX_CHARS - 15 && (
        <p className="hint text-limit" role="status">
          {length >= TEXT_MAX_CHARS ? `Limite atteinte : ${TEXT_MAX_CHARS} caractères.` : `${length} / ${TEXT_MAX_CHARS}`}
        </p>
      )}
      <div className="text-actions">
        <ToyButton variant="soft" icon="close" onClick={() => session.cancelText()}>Annuler</ToyButton>
        <ToyButton className="text-place" variant="success" icon="check" disabled={!session.textReady} onClick={onPlace}>Placer</ToyButton>
      </div>
      <p className="hint text-help">
        <span className="text-help--touch">Glisse le texte pour le déplacer, pince pour la taille.</span>
        <span className="text-help--mouse">Glisse pour déplacer · poignée ou molette pour la taille · Ctrl+Entrée pour placer.</span>
      </p>
    </div>
  );
}
