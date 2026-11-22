import { useEffect, useState } from 'react';
import {
  BANK_PAGE, adminThemeAdd, adminThemeBank, adminThemeImport, adminThemeRemove, adminThemeSchedule, adminThemeTexts,
  adminThemeUpdate, explain, type BankTheme, type ThemeImportReport, type ThemeStatus,
} from '../backend/api';
import { SOURCE_LABELS, THEME_MAX, analyzeImport, checkThemeText, parseImport, type ImportRow } from '../domain/themeBank';
import { ToyButton, ToyCard } from '../ui';
import { Async, useAsync } from './shared';

const day = (ms: number) => new Date(ms).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const sourceLabel = (s: string) => SOURCE_LABELS[s as keyof typeof SOURCE_LABELS] ?? s;

type View = 'bank' | 'next' | 'import';
const VIEWS: { id: View; label: string }[] = [
  { id: 'bank', label: 'Tous les thèmes' },
  { id: 'next', label: 'Prochains cartons' },
  { id: 'import', label: 'Importer une liste' },
];

const STATUS_FILTERS: { id: ThemeStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'Tous' },
  { id: 'unused', label: 'Jamais sortis' },
  { id: 'scheduled', label: 'Programmés' },
  { id: 'used', label: 'Déjà utilisés' },
];

const STATUS_TEXT: Record<ThemeStatus, string> = { used: 'Utilisé', scheduled: 'Programmé', unused: 'Libre' };

/** Banque de thèmes du match: consulter, ajouter, corriger, retirer, importer et voir les prochains tirages. */
export function AdminThemes() {
  const [view, setView] = useState<View>('bank');
  return (
    <>
      <div className="row-buttons" role="group" aria-label="Banque de thèmes">
        {VIEWS.map((v) => (
          <ToyButton key={v.id} variant={view === v.id ? 'primary' : 'soft'} size="s" onClick={() => setView(v.id)}>{v.label}</ToyButton>
        ))}
      </div>
      {view === 'bank' && <BankView />}
      {view === 'next' && <NextView />}
      {view === 'import' && <ImportView />}
    </>
  );
}

function BankView() {
  const [status, setStatus] = useState<ThemeStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ text: '', note: '' });
  const [adding, setAdding] = useState({ text: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const list = useAsync(() => adminThemeBank(status === 'all' ? null : status, query, offset), [status, query, offset]);

  useEffect(() => setOffset(0), [status, query]);

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
      list.reload();
    } catch (e) {
      setMessage(explain(e));
    } finally {
      setBusy(false);
    }
  };

  const addChecked = checkThemeText(adding.text);
  const startEdit = (t: BankTheme) => {
    setEditing(t.id);
    setDraft({ text: t.text, note: t.note ?? '' });
  };

  return (
    <>
      <ToyCard tone="yellow">
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!addChecked.ok) return;
            void run(async () => {
              await adminThemeAdd(addChecked.text, adding.note);
              setAdding({ text: '', note: '' });
            }, 'Thème ajouté. Il entre dans le tirage dès les prochaines semaines non encore tirées.');
          }}
        >
          <label className="toy-field">
            <span>Ajouter un thème</span>
            <input className="toy-input" value={adding.text} maxLength={THEME_MAX + 20} onChange={(e) => setAdding({ ...adding, text: e.target.value })} placeholder="Un titre court et ouvert" />
          </label>
          <label className="toy-field">
            <span>Note (facultatif, visible des seuls administrateurs)</span>
            <input className="toy-input" value={adding.note} maxLength={200} onChange={(e) => setAdding({ ...adding, note: e.target.value })} />
          </label>
          {adding.text && !addChecked.ok && <p className="hint" role="status">{addChecked.error}</p>}
          <div className="row-buttons">
            <ToyButton type="submit" variant="primary" size="s" icon="plus" disabled={busy || !addChecked.ok}>Ajouter</ToyButton>
          </div>
        </form>
      </ToyCard>

      <form className="admin-filters" onSubmit={(e) => { e.preventDefault(); setQuery(search); }}>
        <label className="toy-field">
          <span>Afficher</span>
          <select className="toy-input" value={status} onChange={(e) => setStatus(e.target.value as ThemeStatus | 'all')}>
            {STATUS_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <label className="toy-field">
          <span>Rechercher</span>
          <input className="toy-input" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="row-buttons">
          <ToyButton type="submit" variant="primary" size="s" icon="eye">Chercher</ToyButton>
        </div>
      </form>
      {message && <p className="hint" role="status">{message}</p>}

      <Async state={list}>
        {({ items, total }) => (
          <>
            <p className="hint">{total} thème{total > 1 ? 's' : ''}.</p>
            {items.length === 0 && <ToyCard tone="lavender"><p className="plain-text">Aucun thème ne correspond.</p></ToyCard>}
            <ul className="admin-list">
              {items.map((t) => {
                const locked = t.uses > 0;
                return (
                  <li key={t.id} className="admin-row admin-row--compact">
                    <div className="admin-row__body">
                      {editing === t.id ? (
                        <form
                          className="stack"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const checked = checkThemeText(draft.text);
                            if (!checked.ok) { setMessage(checked.error ?? null); return; }
                            void run(async () => {
                              await adminThemeUpdate(t.id, checked.text, draft.note);
                              setEditing(null);
                            }, 'Thème modifié.');
                          }}
                        >
                          <input className="toy-input" aria-label="Titre" value={draft.text} maxLength={THEME_MAX + 20} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
                          <input className="toy-input" aria-label="Note" value={draft.note} maxLength={200} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Note" />
                          <div className="row-buttons">
                            <ToyButton type="submit" variant="primary" size="s" disabled={busy}>Enregistrer</ToyButton>
                            <ToyButton variant="ghost" size="s" onClick={() => setEditing(null)}>Annuler</ToyButton>
                          </div>
                        </form>
                      ) : (
                        <>
                          <p><strong>{t.text}</strong></p>
                          <p>
                            <span className={`admin-status admin-status--${t.status === 'used' ? 'hidden' : 'ok'}`}>{STATUS_TEXT[t.status]}</span>
                            <span className="admin-status">{sourceLabel(t.source)}</span>
                            {!t.inBank && <span className="admin-status admin-status--alert">Hors banque</span>}
                          </p>
                          <p className="hint">
                            {t.uses > 0 && <>Sorti {t.uses} fois (dernier : {t.lastUsedMs ? day(t.lastUsedMs) : '—'}). </>}
                            {t.nextAtMs !== null && <>Prévu le {day(t.nextAtMs)}. </>}
                            {t.note && <>Note : {t.note}</>}
                          </p>
                          {t.inBank && (
                            <div className="row-buttons">
                              <ToyButton variant="soft" size="s" disabled={busy || locked} onClick={() => startEdit(t)}>Modifier</ToyButton>
                              <ToyButton
                                variant="ghost"
                                size="s"
                                disabled={busy || locked}
                                onClick={() => {
                                  if (window.confirm(`Retirer « ${t.text} » de la banque ?`)) void run(() => adminThemeRemove(t.id), 'Thème retiré.');
                                }}
                              >Retirer</ToyButton>
                              {locked && <span className="hint">Déjà utilisé : verrouillé.</span>}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {total > BANK_PAGE && (
              <div className="row-buttons">
                <ToyButton variant="soft" size="s" icon="back" disabled={offset === 0 || list.loading} onClick={() => setOffset(Math.max(0, offset - BANK_PAGE))}>Précédents</ToyButton>
                <span className="hint">{offset + 1}–{Math.min(offset + BANK_PAGE, total)} sur {total}</span>
                <ToyButton variant="soft" size="s" iconRight="play" disabled={offset + BANK_PAGE >= total || list.loading} onClick={() => setOffset(offset + BANK_PAGE)}>Suivants</ToyButton>
              </div>
            )}
          </>
        )}
      </Async>
    </>
  );
}

function NextView() {
  const schedule = useAsync(() => adminThemeSchedule(16), []);
  return (
    <Async state={schedule}>
      {(rows) => (
        <>
          <p className="hint">Le carton de la semaine prochaine est déjà sorti du barillet et ne change plus. Les suivants peuvent être retirés au sort si la banque change ; aucun thème ne revient avant que toute la banque soit passée.</p>
          <ul className="admin-list">
            {rows.map((r) => (
              <li key={`${r.isoYear}-${r.isoWeek}`} className="admin-row admin-row--compact">
                <div className="admin-row__body">
                  <p><strong>{r.text}</strong></p>
                  <p className="hint">S{r.isoWeek}/{r.isoYear} · {day(r.startsAtMs)} à minuit</p>
                  <p>
                    <span className={`admin-status admin-status--${r.started ? 'ok' : 'hidden'}`}>{r.started ? 'En cours ou passé' : r.frozen ? 'Tiré' : 'Provisoire'}</span>
                    <span className="admin-status">{sourceLabel(r.source)}</span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Async>
  );
}

const ROW_LABEL: Record<ImportRow['status'], string> = {
  new: 'Nouveau', similar: 'Trop proche ?', duplicate: 'Doublon', invalid: 'Invalide',
};

function ImportView() {
  const [raw, setRaw] = useState('');
  const [source, setSource] = useState<'imported' | 'referee'>('imported');
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [withSimilar, setWithSimilar] = useState(false);
  const [report, setReport] = useState<ThemeImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyse = async () => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const items = parseImport(raw);
      if (items.length === 0) throw new Error('Aucun titre trouvé : un thème par ligne, ou une liste JSON.');
      setRows(analyzeImport(items, await adminThemeTexts()));
    } catch (e) {
      setRows(null);
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };

  const keep = (rows ?? []).filter((r) => r.status === 'new' || (withSimilar && r.status === 'similar'));

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await adminThemeImport(keep.map((r) => ({ text: r.text, note: r.note })), source));
      setRows(null);
      setRaw('');
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ToyCard tone="lavender">
        <p className="plain-text">Colle une liste (un thème par ligne, ou du JSON). Rien n’est ajouté avant la confirmation : les doublons sont repérés d’abord. Indique honnêtement la provenance : une liste importée n’est jamais présentée comme des thèmes authentiquement joués.</p>
        <label className="toy-field">
          <span>Liste de thèmes</span>
          <textarea className="toy-input" rows={8} value={raw} onChange={(e) => { setRaw(e.target.value); setRows(null); }} />
        </label>
        <label className="toy-field">
          <span>Provenance</span>
          <select className="toy-input" value={source} onChange={(e) => setSource(e.target.value as 'imported' | 'referee')}>
            <option value="imported">{SOURCE_LABELS.imported}</option>
            <option value="referee">{SOURCE_LABELS.referee}</option>
          </select>
        </label>
        <div className="row-buttons">
          <ToyButton variant="primary" size="s" icon="eye" loading={busy} disabled={!raw.trim()} onClick={analyse}>Analyser</ToyButton>
        </div>
      </ToyCard>
      {error && <p className="hint" role="alert">{error}</p>}
      {report && (
        <ToyCard tone="green">
          <p className="plain-text" role="status"><strong>{report.added} thème{report.added > 1 ? 's' : ''} ajouté{report.added > 1 ? 's' : ''}.</strong>{report.skipped.length > 0 && ` ${report.skipped.length} écarté${report.skipped.length > 1 ? 's' : ''} par le serveur.`}</p>
        </ToyCard>
      )}
      {rows && (
        <>
          <p className="hint">{rows.filter((r) => r.status === 'new').length} nouveaux · {rows.filter((r) => r.status === 'similar').length} proches · {rows.filter((r) => r.status === 'duplicate').length} doublons · {rows.filter((r) => r.status === 'invalid').length} invalides.</p>
          <ul className="admin-list">
            {rows.map((r, i) => (
              <li key={i} className="admin-row admin-row--compact">
                <div className="admin-row__body">
                  <p><strong>{r.text}</strong></p>
                  <p><span className={`admin-status admin-status--${r.status === 'new' ? 'ok' : r.status === 'similar' ? 'hidden' : 'alert'}`}>{ROW_LABEL[r.status]}</span>{r.detail && <span className="hint">{r.detail}</span>}</p>
                </div>
              </li>
            ))}
          </ul>
          <label className="toy-field">
            <span><input type="checkbox" checked={withSimilar} onChange={(e) => setWithSimilar(e.target.checked)} /> Inclure aussi les titres trop proches d’un thème existant</span>
          </label>
          <div className="row-buttons">
            <ToyButton variant="primary" size="s" loading={busy} disabled={keep.length === 0} onClick={send}>Importer {keep.length} thème{keep.length > 1 ? 's' : ''}</ToyButton>
          </div>
        </>
      )}
    </>
  );
}
