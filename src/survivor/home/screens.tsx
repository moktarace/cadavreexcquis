import { useEffect, useState } from 'react';
import { PageFrame } from '../../pages/shared';
import { EmptyState, PixelIcon, ToyButton, ToyCard, ToyDialog, type IconName } from '../../ui';
import { fetchWallet } from '../arbiter/api';
import { historyLabel, signed, type Wallet } from '../arbiter/types';
import { GameCard } from '../multi/MultiLab';
import { signedUrls } from '../multi/api';
import { MODE_BLURBS, MODE_LABELS, formatRemaining, type GameResult, type GameView, type MultiMode } from '../multi/types';
import { BonusPill } from '../shop/ShopOffer';
import { fetchThumbs } from './api';
import type { Live } from './live';
import { markSeen } from './prefs';
import { activityLines, describeEvent, matchState, type EventTarget, type PlayTarget } from './types';

export type Tab = 'home' | 'games' | 'activity';
export type Activite = 'solo' | MultiMode | 'arbiter';
export interface SoloInfo {
  resumable: boolean;
  caseNo: number;
  finished: boolean;
  outcome: 'victory' | 'defeat' | null;
}

const ACTIVITIES: { id: Activite; name: string; icon: IconName; blurb: string }[] = [
  { id: 'solo', name: 'Solo', icon: 'pencil', blurb: 'Crée ta propre BD et économise ton encre.' },
  { id: 'relay', name: 'Relay', icon: 'pages', blurb: 'Crée une BD à plusieurs avec une réserve commune.' },
  { id: 'duel', name: 'Duel', icon: 'swap', blurb: 'Deux joueurs, deux BD, les mêmes conditions initiales.' },
  { id: 'battle', name: 'Battle', icon: 'star', blurb: 'Affronte un joueur en dessinant la même BD à tour de rôle.' },
  { id: 'arbiter', name: 'Arbitre', icon: 'eye', blurb: 'Lis les BD et gagne de l’encre bonus.' },
];

const errorLine = (live: Live) =>
  live.error ? (
    <ToyCard tone="pink" role="alert">
      <p className="plain-text"><strong>Serveur inaccessible.</strong> {live.error}</p>
      <p className="hint">Le Solo reste jouable hors connexion. Les parties en ligne t’attendent: réessaie quand le réseau revient.</p>
      <ToyButton variant="soft" size="s" icon="rotate" onClick={() => void live.refresh(true)}>Réessayer</ToyButton>
    </ToyCard>
  ) : null;

// ───────────── Navigation propre à Survivor ─────────────

/** Même barre que le jeu classique, en boutons: l'état de l'écran est interne (la route reste #/lab/survivor). Jamais au-dessus du dessin. */
export function SurvivorDock({ tab, onTab, onPlay, unread, turns }: { tab: Tab | null; onTab: (t: Tab) => void; onPlay: () => void; unread: number; turns: number }) {
  const item = (id: Tab, label: string, icon: IconName, badge: boolean, hint: string) => (
    <button key={id} type="button" className={`dock__item ${tab === id ? 'is-active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}>
      <span className="dock__icon">
        <PixelIcon name={icon} size={24} />
        {badge && <span className="dock__badge" aria-hidden="true" />}
      </span>
      <span>{label}{badge && <span className="sr-only"> : {hint}</span>}</span>
    </button>
  );
  return (
    <nav className="dock sv-dock" aria-label="Navigation Survivor">
      <div className="dock__side">
        {item('home', 'Accueil', 'home', false, '')}
        {item('games', 'Mes parties', 'pages', turns > 0, `${turns} à jouer`)}
      </div>
      <button type="button" className="dock__draw" onClick={onPlay}>
        <PixelIcon name="play" size={36} />
        <span>Jouer</span>
      </button>
      <div className="dock__side">{item('activity', 'Activité', 'clock', unread > 0, `${unread} non lue${unread > 1 ? 's' : ''}`)}</div>
    </nav>
  );
}

/** Une page de premier niveau de Survivor: en-tête commun, contenu, navigation. */
export function HubFrame({ title, subtitle, right, children }: { title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <main>
        <PageFrame title={title} subtitle={subtitle} tone="lavender" right={right}>
          {children}
        </PageFrame>
      </main>
    </div>
  );
}

// ───────────── Accueil ─────────────

function suggestion(target: PlayTarget): string {
  if (target.kind === 'game') {
    const g = target.game;
    const left = g.seconds_left !== null ? ` · ${formatRemaining(g.seconds_left)} restantes` : '';
    return `${MODE_LABELS[g.mode]} « ${g.theme} » · ${matchState(g).label}${left}`;
  }
  if (target.kind === 'solo') return 'Reprendre ta partie Solo';
  if (target.kind === 'relay_new') return 'Une case de Relay attend un dessinateur';
  return 'Choisis une activité';
}

export function HomeView({ live, solo, target, onPlay, onActivity, onWallet, onActivityTab, onHelp }: {
  live: Live;
  solo: SoloInfo | null;
  target: PlayTarget;
  onPlay: () => void;
  onActivity: (a: Activite) => void;
  onWallet: () => void;
  onActivityTab: () => void;
  onHelp: () => void;
}) {
  const lines = activityLines(live.games, live.activity, live.hub, solo, live.rules);
  const unread = live.activity?.unread ?? 0;
  return (
    <HubFrame title="Survivor" subtitle="16 cases, une réserve d’encre" right={<ToyButton variant="soft" size="s" iconOnly icon="book" aria-label="Aide: comment jouer" onClick={onHelp} />}>
      <ToyCard tone="yellow">
        <div className="sv-hero__top">
          {live.hub ? <button type="button" className="sv-bonus sv-bonus--btn" onClick={onWallet} aria-label={`Encre bonus: ${live.hub.balance}. Ouvrir le portefeuille`}><PixelIcon name="star" size={16} /> Encre bonus <strong>{live.hub.balance}</strong></button> : <span className="hint">Encre bonus: connecte-toi en jouant en ligne</span>}
          {unread > 0 && <button type="button" className="sv-chip sv-chip--new" onClick={onActivityTab}>{unread} nouveauté{unread > 1 ? 's' : ''}</button>}
        </div>
        <p className="sv-lead">{suggestion(target)}</p>
        <ToyButton variant="primary" size="l" icon="play" block onClick={onPlay}>Jouer</ToyButton>
      </ToyCard>
      {errorLine(live)}
      <div className="sv-acts">
        {ACTIVITIES.map((a) => {
          const l = lines[a.id];
          const hot = a.id === 'solo' ? !!solo?.resumable : a.id === 'arbiter' ? !!live.hub && (!!live.hub.active || live.hub.consents.length > 0) : live.games?.some((g) => g.mode === a.id && g.can_play && g.status !== 'finished') ?? false;
          return (
            <button key={a.id} type="button" className={`sv-act${hot ? ' sv-act--hot' : ''}`} onClick={() => onActivity(a.id)}>
              <PixelIcon name={a.icon} size={32} />
              <span className="sv-act__body">
                <strong>{a.name}</strong>
                <span className="sv-act__blurb">{a.blurb}</span>
                <span className="sv-act__now">{l.now}</span>
                {l.open && <span className="sv-act__open">{l.open}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {!live.signedIn && !live.error && <p className="hint">Relay, Duel, Battle et Arbitre se jouent en ligne: un compte invité est créé la première fois que tu en ouvres un. Le Solo n’en a pas besoin.</p>}
    </HubFrame>
  );
}

// ───────────── Mes parties ─────────────

type Filter = 'all' | 'solo' | MultiMode;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Tout' },
  { id: 'solo', label: 'Solo' },
  { id: 'relay', label: 'Relay' },
  { id: 'duel', label: 'Duel' },
  { id: 'battle', label: 'Battle' },
];

/** Miniatures des parties dont la première case est lisible (règles de lecture du serveur; jamais l'adversaire en Duel). */
function useThumbs(games: readonly GameView[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const ids = games.filter((g) => g.status !== 'cancelled' && (g.cases_done > 0 || g.players.some((p) => p.is_me && p.cases_done > 0))).slice(0, 30).map((g) => g.id);
  const key = ids.join('|');
  useEffect(() => {
    if (!ids.length) return;
    let live = true;
    (async () => {
      const found = await fetchThumbs(ids);
      const signed = await signedUrls(found.map((f) => f.image_path));
      if (live) setUrls(Object.fromEntries(found.filter((f) => signed[f.image_path]).map((f) => [f.game_id, signed[f.image_path]])));
    })().catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls;
}

export function MyGamesView({ live, solo, onOpen, onSolo, onPlay, onAction, busy, notice }: {
  live: Live;
  solo: SoloInfo | null;
  onOpen: (g: GameView) => void;
  onSolo: () => void;
  onPlay: () => void;
  onAction: (key: string, action: () => Promise<GameResult>) => void;
  busy: boolean;
  notice: string | null;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const all = (live.games ?? []).filter((g) => g.status !== 'cancelled');
  const thumbs = useThumbs(all);
  const shown = all.filter((g) => filter === 'all' || g.mode === filter);
  const showSolo = !!solo && (filter === 'all' || filter === 'solo') && (solo.resumable || solo.finished);
  const soloDone = !!solo?.finished;
  const groups: { title: string; tone: 'green' | 'lavender' | 'plain'; list: GameView[]; solo: boolean }[] = [
    { title: 'À toi de jouer', tone: 'green', list: shown.filter((g) => g.bucket === 'mine'), solo: showSolo && !soloDone },
    { title: 'En attente', tone: 'lavender', list: shown.filter((g) => g.bucket === 'waiting'), solo: false },
    { title: 'Terminées', tone: 'plain', list: shown.filter((g) => g.bucket === 'done'), solo: showSolo && soloDone },
  ];
  const empty = groups.every((g) => g.list.length === 0 && !g.solo);
  return (
    <HubFrame title="Mes parties" subtitle="Tous les modes au même endroit" right={<ToyButton variant="soft" size="s" iconOnly icon="rotate" aria-label="Actualiser" onClick={() => void live.refresh(true)} disabled={live.loading} />}>
      <div className="sv-filters" role="group" aria-label="Filtrer par mode">
        {FILTERS.map((f) => (
          <ToyButton key={f.id} variant={filter === f.id ? 'primary' : 'soft'} size="s" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}>{f.label}</ToyButton>
        ))}
      </div>
      {errorLine(live)}
      {notice && <p className="sv-notice sv-notice--error" role="status">{notice}</p>}
      {groups.map((grp) =>
        grp.list.length === 0 && !grp.solo ? null : (
          <section key={grp.title} className="sv-lab-section">
            <h2 className="sv-lab-title">{grp.title} <span className="hint">({grp.list.length + (grp.solo ? 1 : 0)})</span></h2>
            {grp.solo && solo && (
              <ToyCard tone={grp.tone}>
                <p className="plain-text"><strong>Solo</strong> · {soloDone ? (solo.outcome === 'victory' ? 'BD terminée: victoire' : 'Panne d’encre') : `case ${solo.caseNo}/16`}</p>
                <p className="hint">Sur cet appareil{soloDone ? '' : ': la partie t’attend, même hors connexion'}.</p>
                <ToyButton variant={soloDone ? 'soft' : 'primary'} size="s" icon={soloDone ? 'eye' : 'play'} onClick={onSolo}>{soloDone ? 'Voir la BD' : 'Reprendre'}</ToyButton>
              </ToyCard>
            )}
            {grp.list.map((g) => (
              <GameCard key={g.id} game={g} thumb={thumbs[g.id]} busy={busy} onOpen={() => onOpen(g)} onAction={onAction} />
            ))}
          </section>
        ),
      )}
      {empty && !live.error && (
        live.games === null && !live.error ? (
          <EmptyState title="Aucune partie en ligne pour l’instant" action={<ToyButton variant="primary" icon="play" onClick={onPlay}>Jouer</ToyButton>}>
            Le Solo se joue sans compte. Relay, Duel et Battle créent un compte invité la première fois que tu en ouvres un.
          </EmptyState>
        ) : (
          <EmptyState title={filter === 'all' ? 'Aucune partie pour l’instant' : `Aucune partie ${filter === 'solo' ? 'Solo' : MODE_LABELS[filter]}`} action={<ToyButton variant="primary" icon="play" onClick={onPlay}>Jouer</ToyButton>}>
            Lance une partie: elle apparaîtra ici avec son tour, son délai et ses actions.
          </EmptyState>
        )
      )}
    </HubFrame>
  );
}

// ───────────── Activité ─────────────

const fmtDate = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function ActivityView({ live, onTarget }: { live: Live; onTarget: (t: EventTarget) => void }) {
  const a = live.activity;
  const readUntil = a ? new Date(a.read_until).getTime() : 0;
  return (
    <HubFrame
      title="Activité"
      subtitle={a && a.unread > 0 ? `${a.unread} non lue${a.unread > 1 ? 's' : ''}` : 'Tout est lu'}
      right={<ToyButton variant="soft" size="s" iconOnly icon="rotate" aria-label="Actualiser" onClick={() => void live.refresh(true)} disabled={live.loading} />}
    >
      {errorLine(live)}
      {a && a.events.length > 0 && (
        <div className="row-buttons">
          <ToyButton variant="soft" size="s" icon="check" disabled={a.unread === 0} onClick={() => void live.markRead()}>Tout marquer comme lu</ToyButton>
        </div>
      )}
      {a && a.events.length === 0 && (
        <EmptyState title="Rien de neuf pour l’instant">
          Les adversaires trouvés, tes tours, les résultats, les arbitrages reçus et l’encre bonus gagnée apparaîtront ici. Rien n’est inventé: ce fil ne montre que ce qui t’est vraiment arrivé.
        </EmptyState>
      )}
      {!a && !live.error && <EmptyState title="Fil d’activité en ligne">Il apparaît dès que tu as joué une partie en ligne ou arbitré une BD. Le Solo reste hors connexion.</EmptyState>}
      <ul className="sv-events">
        {a?.events.map((e) => {
          const d = describeEvent(e);
          const fresh = new Date(e.at).getTime() > readUntil;
          const inner = (
            <>
              <span className="sv-ev__dot" aria-hidden="true">{fresh ? '●' : ''}</span>
              <span className="sv-ev__body">
                <strong>{d.title}</strong>
                {d.detail && <span>{d.detail}</span>}
                <span className="sv-ev__date">{fmtDate(e.at)}{fresh && <span className="sr-only"> (non lue)</span>}</span>
              </span>
            </>
          );
          return (
            <li key={e.key} className={fresh ? 'sv-ev sv-ev--new' : 'sv-ev'}>
              {d.target ? <button type="button" className="sv-ev__btn" onClick={() => onTarget(d.target!)}>{inner}</button> : <div className="sv-ev__btn">{inner}</div>}
            </li>
          );
        })}
      </ul>
    </HubFrame>
  );
}

// ───────────── Portefeuille ─────────────

export function WalletView({ live, onBack, onArbiter }: { live: Live; onBack: () => void; onArbiter: () => void }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!live.signedIn) return;
    fetchWallet().then(setWallet, (e) => setError(e instanceof Error ? e.message : 'Serveur inaccessible.'));
  }, [live.signedIn]);
  const balance = wallet?.balance ?? live.hub?.balance ?? 0;
  return (
    <HubFrame title="Encre bonus" subtitle="Ton portefeuille permanent" right={<ToyButton variant="soft" size="s" iconOnly icon="back" aria-label="Retour" onClick={onBack} />}>
      <ToyCard tone="yellow">
        <p className="plain-text"><BonusPill balance={balance} /></p>
        <p className="hint">L’encre bonus ne se confond pas avec l’encre de dessin d’une partie. Tu en gagnes en arbitrant ou quand tes cases reçoivent des upvotes; tu peux la dépenser en Solo et en Relay (Recharge, Joker, Second choix, Dernière chance). Jamais en Duel ni en Battle.</p>
        <ToyButton variant="soft" size="s" icon="eye" onClick={onArbiter}>Gagner de l’encre en arbitrant</ToyButton>
      </ToyCard>
      {error && <p className="sv-notice sv-notice--error" role="alert">{error}</p>}
      {wallet && wallet.history.length === 0 && <EmptyState title="Aucun mouvement pour l’instant">Tes gains et tes achats d’encre bonus apparaîtront ici.</EmptyState>}
      {wallet && wallet.history.length > 0 && (
        <section className="sv-lab-section">
          <h2 className="sv-lab-title">Gains et dépenses</h2>
          <ul className="sv-ledger">
            {wallet.history.map((h, i) => (
              <li key={i} className={h.amount > 0 ? 'sv-ledger--in' : 'sv-ledger--out'}>
                <strong>{signed(h.amount)}</strong> <span>{historyLabel(h)}</span> <span className="hint">{fmtDate(h.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!live.signedIn && <p className="hint">Pas encore de compte: ton solde est de 0. Arbitre une BD pour en gagner.</p>}
    </HubFrame>
  );
}

// ───────────── Choix d'une activité ─────────────

export function PlayChooser({ open, onClose, onPick, live }: { open: boolean; onClose: () => void; onPick: (a: Activite) => void; live: Live }) {
  const lines = activityLines(live.games, live.activity, live.hub, null, live.rules);
  return (
    <ToyDialog open={open} title="À quoi veux-tu jouer ?" onClose={onClose} actions={<ToyButton variant="soft" onClick={onClose}>Fermer</ToyButton>}>
      <p className="hint">Aucun tour ne t’attend: choisis une activité. Rien ne démarre avant ton choix.</p>
      <div className="sv-modes">
        {(['solo', 'relay', 'duel', 'battle'] as const).map((m) => (
          <ToyButton key={m} variant="soft" onClick={() => onPick(m)}>
            {m === 'solo' ? 'Solo' : MODE_LABELS[m]} · {m === 'solo' ? ACTIVITIES[0].blurb : MODE_BLURBS[m]} ({lines[m].now})
          </ToyButton>
        ))}
      </div>
    </ToyDialog>
  );
}

// ───────────── Tutoriel et aides ─────────────

const STEPS = [
  { title: 'Tu crées une BD', text: 'Avant chaque case, l’éditeur propose trois demandes: choisis celle que tu glisses dans l’histoire. Dans l’éditeur, Mimo et Texte sont dans la barre du bas, et Décor dans « Outils ».' },
  { title: 'Dessiner coûte de l’encre', text: 'Chaque trait, Mimo, texte ou décor consomme de l’encre. La jauge descend en direct: à court d’encre, la BD s’arrête.' },
  { title: 'Terminer une case en rend', text: 'Une demande difficile rapporte plus d’encre qu’une facile. Toutes les deux cases, une amélioration à choisir.' },
  { title: 'Seul ou à plusieurs', text: 'Solo sur ton appareil, Relay à plusieurs avec une réserve commune, Duel et Battle contre un autre joueur.' },
  { title: 'Les arbitres te font gagner de l’encre bonus', text: 'Juge si la contrainte est respectée (jamais le talent): tu gagnes de l’encre bonus, à dépenser en Solo et en Relay.' },
];

/** Cinq écrans très courts, jamais obligatoires: « Passer » à tout moment, rejouable depuis l'aide. */
export function TutorialDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (open) setI(0);
  }, [open]);
  const last = i === STEPS.length - 1;
  const close = () => {
    markSeen('tutorial');
    onClose();
  };
  const step = STEPS[i];
  return (
    <ToyDialog
      open={open}
      title={`${i + 1}/${STEPS.length} · ${step.title}`}
      onClose={close}
      actions={
        <>
          <ToyButton variant="ghost" onClick={close}>Passer</ToyButton>
          {i > 0 && <ToyButton variant="soft" onClick={() => setI(i - 1)}>Précédent</ToyButton>}
          <ToyButton variant="primary" icon={last ? 'check' : undefined} onClick={() => (last ? close() : setI(i + 1))}>{last ? 'Commencer' : 'Suivant'}</ToyButton>
        </>
      }
    >
      <p className="plain-text">{step.text}</p>
    </ToyDialog>
  );
}
