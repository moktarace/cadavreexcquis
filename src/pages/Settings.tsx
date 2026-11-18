import { useState } from 'react';
import { explain, linkEmail } from '../backend/api';
import { hrefOf } from '../app/router';
import { useGame } from '../app/game';
import { useInstall } from '../app/hooks';
import { ToyButton, ToyCard } from '../ui';
import { NotificationsSection } from './Notifications';
import { PageFrame } from './shared';

export function SettingsPage() {
  const g = useGame();
  const install = useInstall();
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      setMessage(ok);
    } catch (e) {
      setMessage(explain(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageFrame title="Réglages" backHref={hrefOf({ name: 'home' })} tone="lavender">
      <ToyCard title="Compte" icon="gear">
        {g.me ? (
          <>
            <label className="toy-field">
              <span>Pseudonyme</span>
              <input className="toy-input" value={name ?? g.nickname} maxLength={24} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="row-buttons">
              <ToyButton variant="primary" icon="check" loading={busy} onClick={() => run(() => g.rename(name ?? g.nickname), 'Pseudonyme enregistré.')}>
                Enregistrer
              </ToyButton>
            </div>
            <p className="hint">
              {g.me.isAnonymous
                ? 'Ton compte est anonyme et lié à cet appareil. Rattache une adresse e-mail pour le retrouver ailleurs.'
                : `Compte rattaché à ${g.me.email ?? 'une adresse e-mail'}.`}
            </p>
            {g.me.isAnonymous && (
              <>
                <label className="toy-field">
                  <span>Adresse e-mail</span>
                  <input className="toy-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                </label>
                <div className="row-buttons">
                  <ToyButton variant="soft" disabled={!email.includes('@') || busy} onClick={() => run(() => linkEmail(email), 'Un message de confirmation a été envoyé.')}>
                    Rattacher mon compte
                  </ToyButton>
                </div>
              </>
            )}
            {message && <p role="status" className="plain-text"><strong>{message}</strong></p>}
          </>
        ) : (
          <p className="hint">{g.error ?? 'Non connecté.'}</p>
        )}
      </ToyCard>

      <ToyCard title="Installation" icon="download">
        {install.standalone ? (
          <p>Cadavre Exquis est installé sur cet appareil.</p>
        ) : install.canPrompt ? (
          <div className="row-buttons">
            <ToyButton variant="primary" icon="download" onClick={install.install}>Installer l’application</ToyButton>
          </div>
        ) : install.isIos ? (
          <p>Sur iPhone et iPad : ouvre Cadavre Exquis dans Safari, touche le bouton Partager, puis « Sur l’écran d’accueil ».</p>
        ) : (
          <p>
            L’installation automatique n’est pas proposée par ce navigateur. Utilise le menu du navigateur
            (« Installer l’application » ou « Ajouter à l’écran d’accueil »).
          </p>
        )}
      </ToyCard>

      <NotificationsSection />
    </PageFrame>
  );
}
