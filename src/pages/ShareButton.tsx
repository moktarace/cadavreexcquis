import { useState } from 'react';
import { SHARE_MESSAGES, shareCase } from '../app/share';
import { ToyButton } from '../ui';

/** Invite quelqu'un à imaginer la suite: vrai lien partagé (ou copié), jamais simulé. */
export function ShareButton({ cardId, label = 'Inviter quelqu’un à continuer', variant = 'soft' }: { cardId: string; label?: string; variant?: 'soft' | 'ghost' | 'secondary' }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const share = async () => {
    setBusy(true);
    setMessage(SHARE_MESSAGES[await shareCase(cardId)]);
    setBusy(false);
  };
  return (
    <span className="share">
      <ToyButton variant={variant} size="s" icon="share" loading={busy} onClick={share}>{label}</ToyButton>
      {message && <small className="hint" role="status">{message}</small>}
    </span>
  );
}
