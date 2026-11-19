import { useState } from 'react';
import {
  adminBacklog, adminCleanupExecute, adminCleanupPreview, adminGames, adminPurgeLog, explain, purgeFilesNow,
  type CleanupMode, type CleanupPreview,
} from '../backend/api';
import { expiryPhase, formatExpiryDate, gameWindow } from '../domain/expiry';
import { ToyButton, ToyCard } from '../ui';
import { Async, useAsync } from './shared';

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Suppression définitive: sélection précise, aperçu chiffré, puis confirmation explicite. */
export function AdminCleanup({ ids, onDone, onBack }: { ids: readonly string[]; onDone: () => void; onBack: () => void }) {
  const [mode, setMode] = useState<CleanupMode>('selection');
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (ids.length === 0 && !message) {
    return (
      <ToyCard tone="lavender">
        <p className="plain-text">Aucun dessin sélectionné. Choisis précisément les dessins à supprimer dans l’onglet « Dessins » (par exemple avec « Mes contributions »).</p>
        <ToyButton variant="soft" size="s" icon="back" onClick={onBack}>Choisir des dessins</ToyButton>
      </ToyCard>
    );
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };

  const compute = (m: CleanupMode) => run(async () => {
    setMode(m);
    setConfirm('');
    setPreview(await adminCleanupPreview(ids, m));
  });

  const execute = () => run(async () => {
    if (!preview) return;
    const res = await adminCleanupExecute(ids, preview.mode, preview.signature);
    let files = `${plural(res.filesQueued, 'fichier', 'fichiers')} à supprimer du stockage`;
    try {
      const purged = await purgeFilesNow();
      files = `${plural(purged.removed, 'fichier supprimé', 'fichiers supprimés')} du stockage${purged.failed ? `, ${purged.failed} à reprendre` : ''}`;
    } catch {
      files += ' (reprise automatique dans quelques minutes)';
    }
    setMessage(`Suppression effectuée. ${files}.`);
    setPreview(null);
    onDone();
  });

  if (message) {
    return (
      <ToyCard tone="green">
        <p className="plain-text" role="status"><strong>{message}</strong></p>
        <ToyButton variant="soft" size="s" icon="back" onClick={onBack}>Retour aux dessins</ToyButton>
      </ToyCard>
    );
  }

  return (
    <>
      <ToyCard tone="yellow">
        <p className="plain-text"><strong>{plural(ids.length, 'dessin sélectionné', 'dessins sélectionnés')}.</strong> Rien n’est supprimé avant la confirmation finale.</p>
        <div className="row-buttons">
          <ToyButton variant={mode === 'selection' && preview ? 'primary' : 'soft'} size="s" disabled={busy} onClick={() => compute('selection')}>Aperçu : seulement ces dessins</ToyButton>
          <ToyButton variant={mode === 'story' && preview ? 'primary' : 'soft'} size="s" disabled={busy} onClick={() => compute('story')}>Aperçu : avec toutes leurs suites</ToyButton>
        </div>
        <p className="hint">« Seulement ces dessins » conserve les suites des autres joueurs (la case retirée devient un emplacement neutre). « Avec toutes leurs suites » supprime aussi les dessins des autres participants situés en dessous.</p>
      </ToyCard>
      {error && <ToyCard tone="error"><p role="alert">{error}</p></ToyCard>}

      {preview && (
        <section className="stack" aria-label="Aperçu de la suppression">
          <ToyCard tone={preview.mode === 'story' && preview.cascadedRows > 0 ? 'error' : 'lavender'}>
            <ul className="admin-summary">
              <li><strong>{plural(preview.deleteRows, 'dessin supprimé', 'dessins supprimés')}</strong></li>
              {preview.tombstoneRows > 0 && <li>{plural(preview.tombstoneRows, 'emplacement neutre conservé', 'emplacements neutres conservés')} (image supprimée, {plural(preview.childrenKept, 'suite préservée', 'suites préservées')})</li>}
              {preview.cascadedRows > 0 && <li>dont <strong>{plural(preview.cascadedRows, 'dessin non sélectionné', 'dessins non sélectionnés')}</strong>, de {plural(preview.authors, 'auteur', 'auteurs')}</li>}
              <li>{plural(preview.stories, 'histoire concernée', 'histoires concernées')}</li>
              <li>{plural(preview.files, 'fichier du stockage', 'fichiers du stockage')}</li>
              <li>{plural(preview.reports, 'signalement', 'signalements')}, {plural(preview.reads, 'état de lecture', 'états de lecture')}, {plural(preview.notifications, 'notification', 'notifications')}</li>
            </ul>
          </ToyCard>
          <ul className="admin-list">
            {preview.items.map((i) => (
              <li key={i.id} className="admin-row admin-row--compact">
                {i.previewUrl ? <img className="admin-thumb" src={i.previewUrl} width={320} height={240} loading="lazy" alt={`Case ${i.caseNumber} de ${i.author}`} /> : <span className="admin-thumb admin-thumb--none">—</span>}
                <div className="admin-row__body">
                  <p><strong>Case {i.caseNumber}</strong> · {i.author}</p>
                  <p><span className={`admin-status admin-status--${i.action === 'delete' ? 'alert' : 'hidden'}`}>{i.action === 'delete' ? 'supprimé' : 'emplacement neutre'}</span>{!i.chosen && <span className="admin-status">suite incluse</span>}</p>
                </div>
              </li>
            ))}
          </ul>
          <label className="toy-field">
            <span>Pour confirmer, écris SUPPRIMER</span>
            <input className="toy-input" value={confirm} autoCapitalize="characters" autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />
          </label>
          <ToyButton variant="danger" icon="trash" loading={busy} disabled={confirm !== 'SUPPRIMER'} onClick={execute}>Supprimer définitivement</ToyButton>
          <p className="hint">Action irréversible: les images sont retirées du stockage.</p>
        </section>
      )}
    </>
  );
}

const KIND_LABELS = { expiry: 'Expiration', cleanup: 'Nettoyage', drafts: 'Brouillons techniques', orphans: 'Fichiers orphelins' } as const;

/** Prochaines suppressions automatiques, état de la file de fichiers et journal. */
export function AdminSchedule() {
  const games = useAsync(adminGames, []);
  const backlog = useAsync(adminBacklog, []);
  const log = useAsync(adminPurgeLog, []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const now = Date.now();

  const flush = async () => {
    setBusy(true);
    try {
      const r = await purgeFilesNow();
      setMessage(`${plural(r.removed, 'fichier supprimé', 'fichiers supprimés')}${r.failed ? `, ${r.failed} en échec (repris plus tard)` : ''}.`);
      backlog.reload();
      log.reload();
    } catch (e) {
      setMessage(explain(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Async state={backlog}>
        {(b) => (
          <ToyCard tone={b.armed ? 'green' : 'yellow'}>
            <p className="plain-text"><strong>{b.armed ? 'Suppression automatique active.' : 'Suppression automatique désarmée : rien n’est supprimé automatiquement.'}</strong></p>
            <p className="hint">{plural(b.pending, 'fichier', 'fichiers')} en attente de suppression{b.failing ? `, dont ${b.failing} en échec` : ''}.</p>
            {b.pending > 0 && <ToyButton variant="soft" size="s" loading={busy} onClick={flush}>Supprimer les fichiers maintenant</ToyButton>}
            {message && <p className="hint" role="status">{message}</p>}
          </ToyCard>
        )}
      </Async>

      <h2 className="section-title"><span>Prochaines suppressions</span></h2>
      <Async state={games}>
        {(list) => {
          const rows = list.filter((g) => !g.isPrivate && g.expiresAtMs !== null).sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0));
          const priv = list.filter((g) => g.isPrivate);
          return (
            <>
              <ul className="admin-list">
                {rows.map((g) => {
                  const phase = expiryPhase(now, gameWindow(g.isoYear, g.isoWeek));
                  const state = g.purgedAtMs && g.contributions === 0 ? 'supprimé' : phase === 'expired' ? 'à supprimer' : phase === 'previous' ? 'ancien thème' : phase === 'current' ? 'thème actif' : 'à venir';
                  return (
                    <li key={g.gameId} className="admin-row admin-row--compact">
                      <div className="admin-row__body">
                        <p><strong>S{g.isoWeek}/{g.isoYear}</strong> · {g.themeText}</p>
                        <p className="hint">{plural(g.contributions, 'dessin', 'dessins')} · suppression le <strong>{formatExpiryDate(g.expiresAtMs!)}</strong> à 00 h · {state}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {rows.length === 0 && <p className="hint">Aucun thème n’a de dessins pour l’instant.</p>}
              {priv.length > 0 && <p className="hint">{plural(priv.length, 'partie privée ou de test', 'parties privées ou de test')} sans échéance automatique : à nettoyer à la main.</p>}
            </>
          );
        }}
      </Async>

      <h2 className="section-title"><span>Journal</span></h2>
      <Async state={log}>
        {(entries) => (
          <ul className="admin-list">
            {entries.length === 0 && <li className="hint">Aucune opération enregistrée.</li>}
            {entries.map((e) => (
              <li key={e.id} className="admin-row admin-row--compact">
                <div className="admin-row__body">
                  <p><strong>{KIND_LABELS[e.kind]}</strong> <span className={`admin-status admin-status--${e.status === 'ok' ? 'ok' : 'alert'}`}>{e.status === 'ok' ? 'réussi' : 'échec'}</span></p>
                  <p className="hint">{new Date(e.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}{e.details ? ` · ${Object.entries(e.details).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}{e.error ? ` · ${e.error}` : ''}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Async>
    </>
  );
}
