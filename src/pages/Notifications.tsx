import { useEffect, useState } from 'react';
import { explain } from '../backend/api';
import { useGame } from '../app/game';
import { DEFAULT_PREFS, disable, enable, getStatus, savePrefs, type Prefs, type PushStatus } from '../push/client';
import { PUSH_SUPPORT_MESSAGES } from '../push/logic';
import { ToyButton, ToyCard, ToySpinner, ToyToggle } from '../ui';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, '0')} h`;

export function NotificationsSection() {
  const g = useGame();
  const userId = g.me?.userId ?? null;
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [draft, setDraft] = useState<Prefs>(DEFAULT_PREFS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => getStatus(userId).then(setStatus, (e) => setMessage(explain(e)));
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setMessage(explain(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <ToyCard title="Notifications" icon="alert">
        {message ? <p className="error-text" role="alert">{message}</p> : <p className="hint"><ToySpinner label="Vérification" /> Vérification…</p>}
      </ToyCard>
    );
  }

  if (!status.support.ok) {
    return (
      <ToyCard title="Notifications" icon="alert">
        <p>{PUSH_SUPPORT_MESSAGES[status.support.reason]}</p>
        {status.support.reason === 'no-service-worker' && (
          <p className="hint">En développement, le service worker est désactivé : utilise la version construite (npm run build puis npm run preview).</p>
        )}
      </ToyCard>
    );
  }
  if (!status.configured) {
    return (
      <ToyCard title="Notifications" icon="alert">
        <p>Notifications non configurées (clé VAPID publique manquante).</p>
      </ToyCard>
    );
  }

  const prefs = status.prefs ?? draft;
  const change = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    if (status.subscribed && userId) void run(() => savePrefs(userId, next));
    else setDraft(next);
  };

  return (
    <ToyCard title="Notifications" icon="alert">
      <p className="hint">
        Désactivées tant que tu ne les actives pas. Chaque événement est regroupé : jamais 40 notifications pour 40 suites.
      </p>
      <ToyToggle checked={prefs.newTheme} disabled={busy} onChange={(v) => change({ newTheme: v })}>
        Rappel : le nouveau thème du lundi
      </ToyToggle>
      <ToyToggle checked={prefs.social} disabled={busy} onChange={(v) => change({ social: v })}>
        Activité : suite de mon dessin, autre suite, histoire terminée
      </ToyToggle>
      <div className="row-buttons">
        <label className="toy-field">
          <span>Silence de</span>
          <select
            className="toy-select"
            value={prefs.quietStart ?? ''}
            disabled={busy}
            onChange={(e) => change({ quietStart: e.target.value === '' ? null : Number(e.target.value), quietEnd: prefs.quietEnd ?? 8 })}
          >
            <option value="">aucun</option>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
        <label className="toy-field">
          <span>jusqu’à</span>
          <select
            className="toy-select"
            value={prefs.quietEnd ?? ''}
            disabled={busy || prefs.quietStart === null}
            onChange={(e) => change({ quietEnd: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">—</option>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
      </div>
      <p className="hint">Heure de Paris. Une notification reçue pendant le silence attend la fin de la période.</p>
      {status.subscribed ? (
        <div className="row-buttons">
          <ToyButton variant="soft" disabled={busy || !userId} onClick={() => userId && run(() => disable(userId))}>Désactiver sur cet appareil</ToyButton>
        </div>
      ) : status.permission === 'denied' ? (
        <p role="alert" className="error-text">Les notifications sont bloquées pour ce site : modifie l’autorisation dans les réglages du navigateur ou du téléphone.</p>
      ) : (
        <div className="row-buttons">
          <ToyButton variant="primary" disabled={!userId} loading={busy} onClick={() => userId && run(() => enable(userId, draft))}>
            Activer les notifications
          </ToyButton>
        </div>
      )}
      {message && <p role="alert" className="error-text">{message}</p>}
    </ToyCard>
  );
}
