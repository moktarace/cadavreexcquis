import { useCallback, useEffect, useState } from 'react';
import { hrefOf } from '../../app/router';
import { PageFrame } from '../../pages/shared';
import { ToyButton, ToyCard } from '../../ui';
import { MultiPlay } from './MultiPlay';
import { abandonGame, acceptInvite, cancelChallenge, createChallenge, fetchRules, matchmake, myGames, peekInvite } from './api';
import {
  BUCKET_LABELS,
  MODE_BLURBS,
  MODE_LABELS,
  describeGame,
  formatRemaining,
  inviteLink,
  tokenFrom,
  type Bucket,
  type GameResult,
  type GameView,
  type InvitePeek,
  type MultiMode,
  type Rules,
} from './types';

type Notice = { text: string; error?: boolean };

const OUTCOME_TEXT: Record<string, string> = {
  created: 'Partie créée.',
  joined: 'Adversaire trouvé: la partie commence.',
  searching: 'Ton défi est toujours ouvert.',
  reserved: 'Case réservée.',
  cancelled: 'Défi annulé.',
  abandoned: 'Partie abandonnée.',
  released: 'Case libérée.',
};

const message = (e: unknown): Notice => ({ text: e instanceof Error ? e.message : 'Erreur inconnue.', error: true });

/** Les paramètres affichés viennent du serveur (`survivor_rules`): ils ne peuvent pas diverger des règles appliquées. */
function rulesLine(mode: MultiMode, r: Rules): string {
  if (mode === 'relay') return `2 à ${r.relay.max_players} participants · case réservée ${r.relay.reserve_minutes} min (jusqu'à ${r.relay.reserve_max_minutes} min en dessinant) · ${r.total_cases} cases`;
  if (mode === 'duel') return `${r.duel.hours} h pour finir après l’appariement · ${r.duel.max_unfinished} Duels non terminés au plus · ${r.total_cases} cases`;
  return `${r.battle.turn_hours} h par tour · ${r.battle.max_unfinished} Battles non terminées au plus · ${r.total_cases} cases maximum`;
}

/** Banc d'essai de l'infrastructure multijoueur: aucune simulation, tout vient du serveur. */
export function MultiLab({ mode, onBack }: { mode: MultiMode; onBack: () => void }) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [games, setGames] = useState<GameView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [code, setCode] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, g] = await Promise.all([fetchRules(), myGames()]);
      setRules(r);
      setGames(g);
    } catch (e) {
      setNotice(message(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (key: string, action: () => Promise<GameResult>, text?: (r: GameResult) => string) => {
    setBusy(key);
    setNotice(null);
    try {
      const res = await action();
      const base = text?.(res) ?? OUTCOME_TEXT[res.outcome] ?? '';
      setNotice({ text: base });
      await refresh();
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(null);
    }
  };

  // Ouvre la partie directement quand c'est à moi de jouer.
  const enter = (r: GameResult) => {
    if (r.game.can_play) setOpen(r.game.id);
  };
  const search = () =>
    run('search', () => matchmake(mode).then((r) => (enter(r), r)), (r) => {
      if (mode !== 'relay' && (r.outcome === 'created' || r.outcome === 'searching')) {
        return 'Recherche enregistrée sur le serveur: tu peux fermer l’application, l’adversaire sera trouvé même hors ligne.';
      }
      if (mode === 'relay' && r.game.reservation_until) return `Case réservée pour ${formatRemaining(r.game.seconds_left ?? 0)}.`;
      return OUTCOME_TEXT[r.outcome] ?? '';
    });
  const join = () => {
    const token = tokenFrom(code);
    if (!token) return setNotice({ text: 'Colle le lien ou le code d’invitation complet.', error: true });
    return run('join', () => acceptInvite(token).then((r) => (enter(r), r)));
  };

  const next = async () => {
    setOpen(null);
    await run('search', () => matchmake(mode).then((r) => (enter(r), r)));
  };
  const mineOnly = (games ?? []).filter((g) => g.mode === mode);
  const buckets: Bucket[] = ['mine', 'waiting', 'done'];

  if (open) return <MultiPlay gameId={open} onBack={() => { setOpen(null); void refresh(); }} onNext={() => void next()} />;

  return (
    <div className="app-shell">
      <main>
        <PageFrame title={MODE_LABELS[mode]} subtitle={`Laboratoire · ${MODE_BLURBS[mode]}`} backHref={hrefOf({ name: 'home' })} tone="lavender">
          <ToyCard tone="yellow">
            <p className="hint"><strong>Parties réelles sur le serveur</strong> (connexion nécessaire). Tu peux fermer l’application: les parties et les délais continuent sans toi.</p>
            {rules && <p className="hint">{rulesLine(mode, rules)}</p>}
            <div className="row-buttons">
              <ToyButton variant="primary" icon="play" onClick={search} disabled={busy !== null}>Chercher une partie</ToyButton>
              {mode !== 'relay' && (
                <>
                  <ToyButton variant="soft" icon="plus" onClick={() => run('open', () => createChallenge(mode, 'open'))} disabled={busy !== null}>Créer un défi ouvert</ToyButton>
                  <ToyButton variant="soft" icon="swap" onClick={() => run('invite', () => createChallenge(mode, 'invite'))} disabled={busy !== null}>Inviter par lien</ToyButton>
                </>
              )}
              <ToyButton variant="ghost" icon="rotate" onClick={() => void refresh()} disabled={busy !== null}>Actualiser</ToyButton>
              <ToyButton variant="ghost" icon="back" onClick={onBack}>Menu</ToyButton>
            </div>
            {mode !== 'relay' && (
              <div className="sv-join">
                <input className="sv-join__input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Lien ou code d’invitation" aria-label="Lien ou code d’invitation" />
                <ToyButton variant="soft" icon="check" onClick={join} disabled={busy !== null || !code.trim()}>Rejoindre</ToyButton>
              </div>
            )}
            {notice && <p className={notice.error ? 'sv-notice sv-notice--error' : 'hint'} role="status">{notice.text}</p>}
          </ToyCard>

          {games && buckets.map((b) => {
            const list = mineOnly.filter((g) => g.bucket === b);
            return (
              <section key={b} className="sv-lab-section">
                <h2 className="sv-lab-title">{BUCKET_LABELS[b]} <span className="hint">({list.length})</span></h2>
                {list.length === 0 && <p className="hint">Aucune partie.</p>}
                {list.map((g) => (
                  <GameCard key={g.id} game={g} busy={busy !== null} onOpen={() => setOpen(g.id)} onAction={(key, action) => run(key, action)} />
                ))}
              </section>
            );
          })}
        </PageFrame>
      </main>
    </div>
  );
}

function GameCard({ game: g, busy, onOpen, onAction }: { game: GameView; busy: boolean; onOpen: () => void; onAction: (key: string, action: () => Promise<GameResult>) => void }) {
  const link = g.invite_token ? inviteLink(g.invite_token) : null;
  const copy = () => void navigator.clipboard?.writeText(link!).catch(() => undefined);
  const abandon = () => {
    if (g.mode === 'relay' || window.confirm('Abandonner cette partie ? Elle sera perdue par forfait.')) onAction(`abandon-${g.id}`, () => abandonGame(g.id));
  };
  return (
    <ToyCard tone={g.bucket === 'mine' ? 'green' : g.bucket === 'waiting' ? 'lavender' : 'plain'}>
      <p className="plain-text"><strong>« {g.theme} »</strong> · {MODE_LABELS[g.mode]}</p>
      <p className="hint">{describeGame(g)}</p>
      {g.status !== 'cancelled' && (
        <p className="hint">
          {g.mode === 'duel' ? g.players.map((p) => `${p.is_me ? 'Toi' : p.nickname} ${p.cases_done}/${g.total_cases}`).join(' · ') || `0/${g.total_cases}` : `${g.cases_done}/${g.total_cases} cases`}
          {g.mode !== 'duel' && g.players.length > 0 && ` · ${g.players.map((p) => (p.is_me ? 'Toi' : p.nickname)).join(', ')}`}
        </p>
      )}
      {g.seconds_left !== null && g.bucket !== 'done' && (
        <p className="hint">{g.mode === 'relay' ? 'Réservation' : 'Délai'} : {formatRemaining(g.seconds_left)} restantes</p>
      )}
      {link && (
        <div className="sv-join">
          <input className="sv-join__input" readOnly value={link} aria-label="Lien d’invitation" onFocus={(e) => e.currentTarget.select()} />
          <ToyButton variant="soft" icon="check" onClick={copy}>Copier</ToyButton>
        </div>
      )}
      {g.reserve !== null && g.status !== 'cancelled' && <p className="hint">Encre : {Math.ceil(g.reserve)} / {g.capacity}{g.mode === 'relay' ? ' (commune)' : ''}</p>}
      <div className="row-buttons">
        {g.status !== 'cancelled' && (g.can_play || g.cases_done > 0 || g.players.some((p) => p.cases_done > 0) || g.status !== 'searching') && (
          <ToyButton variant={g.can_play ? 'primary' : 'soft'} size="s" icon={g.can_play ? 'play' : 'eye'} onClick={onOpen}>{g.can_play ? 'Jouer' : g.bucket === 'done' ? 'Voir la BD' : 'Ouvrir'}</ToyButton>
        )}
        {g.can_cancel && <ToyButton variant="soft" icon="alert" onClick={() => onAction(`cancel-${g.id}`, () => cancelChallenge(g.id))} disabled={busy}>Annuler le défi</ToyButton>}
        {g.can_abandon && <ToyButton variant="danger" size="s" icon="alert" onClick={abandon} disabled={busy}>{g.mode === 'relay' ? 'Libérer la case' : 'Abandonner'}</ToyButton>}
      </div>
    </ToyCard>
  );
}

/** Ouverture d'un lien d'invitation: aperçu minimal, puis acceptation explicite. */
export function InviteView({ token, onDone, onBack }: { token: string; onDone: (mode: MultiMode) => void; onBack: () => void }) {
  const [peek, setPeek] = useState<InvitePeek | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    peekInvite(token).then(setPeek, (e) => setNotice(message(e)));
  }, [token]);
  const accept = async () => {
    setBusy(true);
    try {
      const r = await acceptInvite(token);
      onDone(r.game.mode);
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app-shell">
      <main>
        <PageFrame title="Invitation" subtitle="Survivor · laboratoire" backHref={hrefOf({ name: 'home' })} tone="lavender">
          <ToyCard tone="yellow">
            {peek && (
              <>
                <p className="plain-text"><strong>{peek.from}</strong> t’invite à un {MODE_LABELS[peek.mode]} sur « {peek.theme} ».</p>
                {peek.mine && <p className="hint">C’est ton propre défi: envoie ce lien à quelqu’un d’autre.</p>}
                {!peek.available && !peek.mine && <p className="hint">Cette invitation n’est plus disponible.</p>}
              </>
            )}
            {notice && <p className={notice.error ? 'sv-notice sv-notice--error' : 'hint'} role="status">{notice.text}</p>}
            <div className="row-buttons">
              {peek?.available && !peek.mine && <ToyButton variant="primary" icon="check" onClick={accept} disabled={busy}>Accepter</ToyButton>}
              <ToyButton variant="ghost" icon="back" onClick={onBack}>Menu</ToyButton>
            </div>
          </ToyCard>
        </PageFrame>
      </main>
    </div>
  );
}
