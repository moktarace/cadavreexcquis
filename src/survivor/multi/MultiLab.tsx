import { useCallback, useEffect, useState } from 'react';
import { hrefOf } from '../../app/router';
import { PageFrame } from '../../pages/shared';
import { ToyButton, ToyCard } from '../../ui';
import { matchState } from '../home/types';
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

/** Écran d'un mode multijoueur (recherche, défis, invitation): aucune simulation, tout vient du serveur. */
export function MultiLab({ mode, onBack, onOpen, onChanged }: { mode: MultiMode; onBack: () => void; onOpen: (g: GameView) => void; onChanged: () => void }) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [games, setGames] = useState<GameView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [code, setCode] = useState('');
  const [created, setCreated] = useState<GameView | null>(null);

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
      onChanged();
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(null);
    }
  };

  // Ouvre la partie directement quand c'est à moi de jouer.
  const enter = (r: GameResult) => {
    if (r.game.can_play) onOpen(r.game);
  };
  // Défi créé: proposer de commencer sa propre BD sans attendre l'adversaire.
  const challenge = (visibility: 'open' | 'invite') =>
    run(visibility, () => createChallenge(mode as Exclude<MultiMode, 'relay'>, visibility).then((r) => (setCreated(r.game), r)), (r) =>
      r.outcome === 'joined' ? OUTCOME_TEXT.joined : 'Défi créé: il reste ouvert sur le serveur, même si tu fermes l’application.');
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

  const mineOnly = (games ?? []).filter((g) => g.mode === mode);
  const buckets: Bucket[] = ['mine', 'waiting', 'done'];

  return (
    <div className="app-shell">
      <main>
        <PageFrame title={MODE_LABELS[mode]} subtitle={MODE_BLURBS[mode]} tone="lavender" right={<ToyButton variant="soft" size="s" iconOnly icon="back" aria-label="Retour à l’accueil" onClick={onBack} />}>
          <ToyCard tone="yellow">
            <p className="hint">Connexion nécessaire. Tu peux fermer l’application: les parties et les délais continuent sur le serveur.</p>
            {rules && <p className="hint">{rulesLine(mode, rules)}</p>}
            <div className="row-buttons">
              <ToyButton variant="primary" icon="play" onClick={search} disabled={busy !== null}>{mode === 'relay' ? 'Réserver une case' : 'Chercher une partie'}</ToyButton>
              {mode !== 'relay' && (
                <>
                  <ToyButton variant="soft" icon="plus" onClick={() => void challenge('open')} disabled={busy !== null}>Créer un défi ouvert</ToyButton>
                  <ToyButton variant="soft" icon="swap" onClick={() => void challenge('invite')} disabled={busy !== null}>Inviter par lien</ToyButton>
                </>
              )}
              <ToyButton variant="ghost" icon="rotate" onClick={() => void refresh()} disabled={busy !== null}>Actualiser</ToyButton>
            </div>
            {mode !== 'relay' && (
              <div className="sv-join">
                <input className="sv-join__input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Lien ou code d’invitation" aria-label="Lien ou code d’invitation" />
                <ToyButton variant="soft" icon="check" onClick={join} disabled={busy !== null || !code.trim()}>Rejoindre</ToyButton>
              </div>
            )}
            {notice && <p className={notice.error ? 'sv-notice sv-notice--error' : 'hint'} role="status">{notice.text}</p>}
          </ToyCard>

          {created && created.status === 'searching' && (
            <ToyCard tone="green">
              <p className="plain-text"><strong>Défi créé.</strong> Pendant que ton adversaire arrive, tu peux déjà dessiner ta BD.</p>
              <div className="row-buttons">
                {created.can_play && <ToyButton variant="primary" icon="play" onClick={() => onOpen(created)}>Commencer ma BD</ToyButton>}
                {created.invite_token && <ShareLink token={created.invite_token} />}
              </div>
            </ToyCard>
          )}

          {games && buckets.map((b) => {
            const list = mineOnly.filter((g) => g.bucket === b);
            return (
              <section key={b} className="sv-lab-section">
                <h2 className="sv-lab-title">{BUCKET_LABELS[b]} <span className="hint">({list.length})</span></h2>
                {list.length === 0 && <p className="hint">{b === 'mine' ? 'Aucun tour à jouer: cherche une partie ci-dessus.' : b === 'waiting' ? 'Rien n’attend les autres joueurs.' : 'Aucune partie terminée.'}</p>}
                {list.map((g) => (
                  <GameCard key={g.id} game={g} busy={busy !== null} onOpen={() => onOpen(g)} onAction={(key, action) => run(key, action)} />
                ))}
              </section>
            );
          })}
        </PageFrame>
      </main>
    </div>
  );
}

/** Copier ou partager le lien d'invitation (feuille de partage du système quand elle existe). */
function ShareLink({ token }: { token: string }) {
  const link = inviteLink(token);
  const [copied, setCopied] = useState(false);
  const share = async () => {
    try {
      if (typeof navigator.share === 'function') await navigator.share({ title: 'Survivor', url: link });
      else {
        await navigator.clipboard.writeText(link);
        setCopied(true);
      }
    } catch {
      /* partage annulé ou presse-papiers refusé: le lien reste affiché */
    }
  };
  return (
    <div className="sv-join">
      <input className="sv-join__input" readOnly value={link} aria-label="Lien d’invitation" onFocus={(e) => e.currentTarget.select()} />
      <ToyButton variant="soft" icon="share" onClick={() => void share()}>{copied ? 'Copié' : typeof navigator.share === 'function' ? 'Partager' : 'Copier'}</ToyButton>
    </div>
  );
}

export function GameCard({ game: g, thumb, busy, onOpen, onAction }: { game: GameView; thumb?: string; busy: boolean; onOpen: () => void; onAction: (key: string, action: () => Promise<GameResult>) => void }) {
  const state = matchState(g);
  const abandon = () => {
    if (g.mode === 'relay' || window.confirm('Abandonner cette partie ? Elle sera perdue par forfait.')) onAction(`abandon-${g.id}`, () => abandonGame(g.id));
  };
  return (
    <ToyCard tone={g.bucket === 'mine' ? 'green' : g.bucket === 'waiting' ? 'lavender' : 'plain'}>
      <div className="sv-gc">
        {thumb && <img className="sv-gc__thumb" src={thumb} alt={`Première case de « ${g.theme} »`} />}
        <div>
          <p className="plain-text"><strong>« {g.theme} »</strong> · {MODE_LABELS[g.mode]}</p>
          <p className={`sv-state sv-state--${state.key}`}>{state.label}</p>
          {describeGame(g) !== state.label && <p className="hint">{describeGame(g)}</p>}
        </div>
      </div>
      {g.status !== 'cancelled' && (
        <p className="hint">
          {g.mode === 'duel' ? g.players.map((p) => `${p.is_me ? 'Toi' : p.nickname} ${p.cases_done}/${g.total_cases}`).join(' · ') || `0/${g.total_cases}` : `${g.cases_done}/${g.total_cases} cases`}
          {g.mode !== 'duel' && g.players.length > 0 && ` · ${g.players.map((p) => (p.is_me ? 'Toi' : p.nickname)).join(', ')}`}
        </p>
      )}
      {g.seconds_left !== null && g.bucket !== 'done' && (
        <p className="hint">{g.mode === 'relay' ? 'Réservation' : 'Délai'} : {formatRemaining(g.seconds_left)} restantes</p>
      )}
      {g.invite_token && <ShareLink token={g.invite_token} />}
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
export function InviteView({ token, onDone, onBack }: { token: string; onDone: (game: GameView) => void; onBack: () => void }) {
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
      onDone(r.game);
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app-shell">
      <main>
        <PageFrame title="Invitation" subtitle="Survivor" backHref={hrefOf({ name: 'home' })} tone="lavender">
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
