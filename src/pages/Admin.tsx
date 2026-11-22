import { useEffect, useState } from 'react';
import {
  ADMIN_PAGE, adminContributions, adminGames, adminReports, adminReviewReport, adminSetHidden, explain, isAdmin,
  type AdminContribution, type AdminFilters, type AdminReport, type AdminStatusFilter,
} from '../backend/api';
import { useGame } from '../app/game';
import { hrefOf } from '../app/router';
import { REPORT_CATEGORIES, hiddenLabel } from '../domain/moderation';
import { ToyButton, ToyCard, ToySpinner, ToyTabs, type TabDef } from '../ui';
import { AdminCleanup, AdminSchedule } from './AdminCleanup';
import { AdminThemes } from './AdminThemes';
import { Async, Loading, PageFrame, useAsync } from './shared';

const TABS: readonly TabDef[] = [
  { id: 'drawings', label: 'Dessins', icon: 'pages' },
  { id: 'reports', label: 'Signalements', icon: 'alert' },
  { id: 'cleanup', label: 'Nettoyage', icon: 'trash' },
  { id: 'schedule', label: 'Échéances', icon: 'clock' },
  { id: 'themes', label: 'Banque de thèmes', icon: 'book' },
];

const STATUS_LABELS: Record<AdminStatusFilter, string> = {
  published: 'Visibles',
  reported: 'Signalés (ouverts)',
  review: 'Masqués, en examen',
  removed: 'Retirés',
  deleted: 'Emplacements neutres',
};

const categoryLabel = (id: string) => REPORT_CATEGORIES.find((c) => c.id === id)?.label ?? id;
const when = (ms: number) => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

function statusText(c: Pick<AdminContribution, 'status' | 'hiddenKind'>): string {
  return c.status === 'published' ? 'Visible' : c.hiddenKind === 'review' ? 'Masqué (en examen)' : c.hiddenKind === 'deleted' ? 'Emplacement neutre' : hiddenLabel(c.hiddenKind);
}

/** Espace privé: l'accès réel est contrôlé par le serveur (is_admin); cette page ne fait que l'afficher. */
export function AdminPage() {
  const access = useAsync(isAdmin, []);
  const [tab, setTab] = useState('drawings');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  if (access.data === null && !access.error) return <PageFrame title="Administration" backHref={hrefOf({ name: 'home' })}><Loading /></PageFrame>;
  if (!access.data) {
    return (
      <PageFrame title="Page introuvable" backHref={hrefOf({ name: 'home' })}>
        <ToyCard tone="lavender"><p className="plain-text">Cette page n’existe pas.</p></ToyCard>
      </PageFrame>
    );
  }

  const toggle = (ids: readonly string[], on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });

  return (
    <PageFrame title="Administration" tone="lavender" backHref={hrefOf({ name: 'settings' })}>
      <div className="admin-tabs">
        <ToyTabs tabs={TABS} value={tab} onChange={(t) => t && setTab(t)} label="Sections" idPrefix="admin" />
      </div>
      <div id="admin-panel" role="tabpanel" aria-labelledby={`admin-${tab}`} className="stack">
        {tab === 'drawings' && <DrawingsTab selected={selected} onToggle={toggle} onClear={() => setSelected(new Set())} onCleanup={() => setTab('cleanup')} />}
        {tab === 'reports' && <ReportsTab />}
        {tab === 'cleanup' && <AdminCleanup ids={[...selected]} onDone={() => setSelected(new Set())} onBack={() => setTab('drawings')} />}
        {tab === 'schedule' && <AdminSchedule />}
        {tab === 'themes' && <AdminThemes />}
      </div>
    </PageFrame>
  );
}

function Thumb({ url, label }: { url: string | null; label: string }) {
  return url ? <img className="admin-thumb" src={url} width={320} height={240} loading="lazy" alt={label} /> : <span className="admin-thumb admin-thumb--none">Supprimé</span>;
}

function DrawingsTab({ selected, onToggle, onClear, onCleanup }: {
  selected: ReadonlySet<string>;
  onToggle: (ids: readonly string[], on: boolean) => void;
  onClear: () => void;
  onCleanup: () => void;
}) {
  const { me } = useGame();
  const [filters, setFilters] = useState<AdminFilters>({});
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const games = useAsync(adminGames, []);
  const list = useAsync(() => adminContributions(filters, offset), [JSON.stringify(filters), offset]);

  const update = (patch: Partial<AdminFilters>) => {
    setOffset(0);
    setFilters((f) => ({ ...f, ...patch }));
  };

  const act = async (ids: readonly string[], hide: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const n = await adminSetHidden(ids, hide);
      setMessage(hide ? `${n} dessin${n > 1 ? 's' : ''} masqué${n > 1 ? 's' : ''}.` : `${n} dessin${n > 1 ? 's' : ''} rétabli${n > 1 ? 's' : ''}.`);
      list.reload();
    } catch (e) {
      setMessage(explain(e));
    } finally {
      setBusy(false);
    }
  };

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  return (
    <>
      <form className="admin-filters" onSubmit={(e) => { e.preventDefault(); update({ search }); }}>
        <label className="toy-field">
          <span>Thème / semaine</span>
          <select className="toy-input" value={filters.gameId ?? ''} onChange={(e) => update({ gameId: e.target.value || undefined })}>
            <option value="">Tous</option>
            {(games.data ?? []).map((g) => (
              <option key={g.gameId} value={g.gameId}>
                S{g.isoWeek}/{g.isoYear} · {g.themeText} ({g.contributions}){g.isPrivate ? ' · privé' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="toy-field">
          <span>Statut</span>
          <select className="toy-input" value={filters.status ?? ''} onChange={(e) => update({ status: (e.target.value || undefined) as AdminStatusFilter | undefined })}>
            <option value="">Tous</option>
            {(Object.keys(STATUS_LABELS) as AdminStatusFilter[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="toy-field">
          <span>Rechercher (identifiant, auteur, thème)</span>
          <input className="toy-input" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="row-buttons">
          <ToyButton type="submit" variant="primary" size="s" icon="eye">Chercher</ToyButton>
          <ToyButton variant={filters.authorId === me?.userId ? 'primary' : 'soft'} size="s" onClick={() => update({ authorId: filters.authorId === me?.userId ? undefined : me?.userId })}>Mes contributions</ToyButton>
          {filters.authorId && filters.authorId !== me?.userId && <ToyButton variant="soft" size="s" onClick={() => update({ authorId: undefined })}>Retirer le filtre auteur</ToyButton>}
        </div>
      </form>

      {selected.size > 0 && (
        <ToyCard tone="yellow" className="admin-bar">
          <p className="plain-text"><strong>{selected.size}</strong> sélectionné{selected.size > 1 ? 's' : ''}</p>
          <div className="row-buttons">
            <ToyButton variant="soft" size="s" disabled={busy} onClick={() => act([...selected], true)}>Masquer</ToyButton>
            <ToyButton variant="soft" size="s" disabled={busy} onClick={() => act([...selected], false)}>Rétablir</ToyButton>
            <ToyButton variant="danger" size="s" icon="trash" onClick={onCleanup}>Préparer la suppression…</ToyButton>
            <ToyButton variant="ghost" size="s" onClick={onClear}>Tout désélectionner</ToyButton>
          </div>
        </ToyCard>
      )}
      {message && <p className="hint" role="status">{message}</p>}

      <Async state={list}>
        {() => (
          <>
            <p className="hint">{total} dessin{total > 1 ? 's' : ''}{filters.authorId ? ' de cet auteur' : ''}.</p>
            {items.length === 0 && <ToyCard tone="lavender"><p className="plain-text">Aucun dessin ne correspond.</p></ToyCard>}
            <ul className="admin-list">
              {items.map((c) => (
                <li key={c.id} className="admin-row">
                  <input type="checkbox" aria-label={`Sélectionner la case ${c.caseNumber} de ${c.authorName}`} checked={selected.has(c.id)} onChange={(e) => onToggle([c.id], e.target.checked)} />
                  <Thumb url={c.previewUrl} label={`Case ${c.caseNumber} de ${c.authorName}`} />
                  <div className="admin-row__body">
                    <p><strong>Case {c.caseNumber}</strong> · <button type="button" className="link-button" onClick={() => update({ authorId: c.authorId })}>{c.authorName}</button></p>
                    <p className="hint">S{c.isoWeek}/{c.isoYear} · {c.themeText}</p>
                    <p className="hint">{when(c.publishedAt)} · {c.childCount} suite{c.childCount > 1 ? 's' : ''} · <code>{c.id.slice(0, 8)}</code></p>
                    <p><span className={`admin-status admin-status--${c.status === 'published' ? 'ok' : 'hidden'}`}>{statusText(c)}</span>{c.openReports > 0 && <span className="admin-status admin-status--alert">{c.openReports} signalement{c.openReports > 1 ? 's' : ''}</span>}</p>
                    <div className="row-buttons">
                      {c.status === 'published'
                        ? <ToyButton variant="soft" size="s" disabled={busy} onClick={() => act([c.id], true)}>Masquer</ToyButton>
                        : c.hiddenKind !== 'deleted' && <ToyButton variant="soft" size="s" disabled={busy} onClick={() => act([c.id], false)}>Rétablir</ToyButton>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {total > ADMIN_PAGE && (
              <div className="row-buttons">
                <ToyButton variant="soft" size="s" icon="back" disabled={offset === 0 || list.loading} onClick={() => setOffset(Math.max(0, offset - ADMIN_PAGE))}>Précédents</ToyButton>
                <span className="hint">{offset + 1}–{Math.min(offset + ADMIN_PAGE, total)} sur {total}</span>
                <ToyButton variant="soft" size="s" iconRight="play" disabled={offset + ADMIN_PAGE >= total || list.loading} onClick={() => setOffset(offset + ADMIN_PAGE)}>Suivants</ToyButton>
              </div>
            )}
            {list.loading && <ToySpinner />}
            {items.length > 0 && (
              <div className="row-buttons">
                <ToyButton variant="ghost" size="s" onClick={() => onToggle(items.map((i) => i.id), true)}>Sélectionner cette page</ToyButton>
              </div>
            )}
          </>
        )}
      </Async>
    </>
  );
}

const REPORT_FILTERS: { id: AdminReport['status'] | 'all'; label: string }[] = [
  { id: 'open', label: 'À examiner' },
  { id: 'upheld', label: 'Retraits confirmés' },
  { id: 'dismissed', label: 'Écartés' },
  { id: 'abusive', label: 'Abusifs' },
  { id: 'all', label: 'Historique complet' },
];

function ReportsTab() {
  const [filter, setFilter] = useState<AdminReport['status'] | 'all'>('open');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const list = useAsync(() => adminReports(filter === 'all' ? null : filter, offset), [filter, offset]);

  useEffect(() => setOffset(0), [filter]);

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
      list.reload();
    } catch (e) {
      setMessage(explain(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <label className="toy-field">
        <span>Signalements</span>
        <select className="toy-input" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          {REPORT_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </label>
      {message && <p className="hint" role="status">{message}</p>}
      <Async state={list}>
        {({ items, total }) => (
          <>
            {items.length === 0 && <ToyCard tone="green"><p className="plain-text">Aucun signalement dans cette liste.</p></ToyCard>}
            <ul className="admin-list">
              {items.map((r) => (
                <li key={r.reportId} className="admin-row admin-row--report">
                  <Thumb url={r.previewUrl} label={`Case ${r.caseNumber} de ${r.authorName}`} />
                  <div className="admin-row__body">
                    <p><strong>{categoryLabel(r.category)}</strong></p>
                    {r.details && <p className="plain-text">« {r.details} »</p>}
                    <p className="hint">Case {r.caseNumber} de {r.authorName} · {r.themeText}</p>
                    <p className="hint">Signalé par {r.reporterName} ({r.reporterReports} signalement{r.reporterReports > 1 ? 's' : ''}{r.reporterBlocked ? ', bloqué' : ''}) · {when(r.createdAt)}</p>
                    <p><span className={`admin-status admin-status--${r.contributionStatus === 'published' ? 'ok' : 'hidden'}`}>{statusText({ status: r.contributionStatus, hiddenKind: r.hiddenKind })}</span><span className="admin-status">{r.status === 'open' ? 'ouvert' : r.status === 'upheld' ? 'retrait confirmé' : r.status === 'dismissed' ? 'écarté' : 'abusif'}</span></p>
                    <div className="row-buttons">
                      {r.contributionStatus === 'published'
                        ? <ToyButton variant="soft" size="s" disabled={!!busy} onClick={() => run(r.reportId, () => adminSetHidden([r.contributionId], true), 'Dessin masqué, signalement clos.')}>Retirer le dessin</ToyButton>
                        : r.hiddenKind !== 'deleted' && <>
                            {r.hiddenKind === 'review' && <ToyButton variant="danger" size="s" disabled={!!busy} onClick={() => run(r.reportId, () => adminSetHidden([r.contributionId], true), 'Retrait confirmé.')}>Confirmer le retrait</ToyButton>}
                            <ToyButton variant="primary" size="s" disabled={!!busy} onClick={() => run(r.reportId, () => adminSetHidden([r.contributionId], false), 'Dessin rétabli.')}>Rétablir</ToyButton>
                          </>}
                      {r.status === 'open' && (
                        <>
                          <ToyButton variant="ghost" size="s" disabled={!!busy} onClick={() => run(r.reportId, () => adminReviewReport(r.reportId, 'dismissed'), 'Signalement écarté.')}>Écarter</ToyButton>
                          <ToyButton variant="ghost" size="s" disabled={!!busy} onClick={() => run(r.reportId, () => adminReviewReport(r.reportId, 'abusive'), 'Signalement marqué abusif.')}>Abusif</ToyButton>
                          {!r.reporterBlocked && <ToyButton variant="ghost" size="s" disabled={!!busy} onClick={() => run(r.reportId, () => adminReviewReport(r.reportId, 'abusive', true), 'Signaleur bloqué.')}>Abusif + bloquer</ToyButton>}
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {total > ADMIN_PAGE && (
              <div className="row-buttons">
                <ToyButton variant="soft" size="s" icon="back" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - ADMIN_PAGE))}>Précédents</ToyButton>
                <ToyButton variant="soft" size="s" iconRight="play" disabled={offset + ADMIN_PAGE >= total} onClick={() => setOffset(offset + ADMIN_PAGE)}>Suivants</ToyButton>
              </div>
            )}
          </>
        )}
      </Async>
    </>
  );
}
