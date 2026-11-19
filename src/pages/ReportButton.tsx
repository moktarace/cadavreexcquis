import { useState } from 'react';
import { explain, reportContribution } from '../backend/api';
import { useGame } from '../app/game';
import type { Card } from '../domain/cards';
import { REPORT_CATEGORIES, REPORT_DETAILS_MAX, type ReportCategory } from '../domain/moderation';
import { ToyButton, ToyCard, ToyDialog } from '../ui';

/** « Signaler ce dessin »: discret, absent sur ses propres dessins et sur ceux déjà masqués. */
export function ReportButton({ card, onDone }: { card: Card; onDone?: (result: 'hidden' | 'recorded') => void }) {
  const { me } = useGame();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!me || card.hidden || card.authorId === me.userId) return null;

  const close = () => {
    setOpen(false);
    setError(null);
  };

  const send = async () => {
    if (!category) return;
    setSending(true);
    setError(null);
    try {
      const result = await reportContribution(card.id, category, details);
      setOpen(false);
      setNotice(result === 'hidden' ? 'Merci ! Ce dessin est masqué en attendant son examen.' : 'Merci, ton signalement est enregistré.');
      onDone?.(result);
    } catch (e) {
      setError(explain(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <ToyButton variant="ghost" size="s" icon="alert" onClick={() => setOpen(true)}>Signaler ce dessin</ToyButton>
      {notice && <ToyCard tone="green"><p role="status">{notice}</p></ToyCard>}
      <ToyDialog
        open={open}
        title="Signaler ce dessin"
        locked={sending}
        onClose={close}
        actions={
          <>
            <ToyButton variant="soft" disabled={sending} onClick={close}>Annuler</ToyButton>
            <ToyButton variant="danger" icon="alert" loading={sending} disabled={!category} onClick={send}>Signaler</ToyButton>
          </>
        }
      >
        <fieldset className="report-options">
          <legend>Pourquoi signales-tu ce dessin ?</legend>
          {REPORT_CATEGORIES.map((c) => (
            <label key={c.id} className="report-options__item">
              <input type="radio" name="report-category" checked={category === c.id} onChange={() => setCategory(c.id)} />
              <span>{c.label}</span>
            </label>
          ))}
        </fieldset>
        <label className="toy-field">
          <span>Précision (facultatif)</span>
          <textarea className="toy-input" rows={2} maxLength={REPORT_DETAILS_MAX} value={details} onChange={(e) => setDetails(e.target.value)} />
        </label>
        <p className="hint">Le dessin est masqué dès ton signalement, puis examiné.</p>
        {error && <p className="error-text" role="alert">{error}</p>}
      </ToyDialog>
    </>
  );
}
