import { useCallback, useEffect, useState } from 'react';
import { hrefOf } from '../../app/router';
import { PageFrame } from '../../pages/shared';
import { PixelIcon, ToyButton, ToyCard } from '../../ui';
import { constraintById, diceOf } from '../constraints';
import { useImages } from '../multi/MultiPlay';
import { abandonArbitration, answerConsent, arbitrateNext, castVote, currentArbitration, finishArbitration, flagArbitration, fetchHub, fetchWallet, submitGameBd } from './api';
import { BD_STATUS_LABELS, NARRATIVE_LABELS, REASON_LABELS, SOURCE_LABELS, type ArbResult, type Arbitration, type FlagCategory, type Hub, type Vote, type Wallet } from './types';

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Erreur inconnue.');

type View = { kind: 'hub' } | { kind: 'arbitration'; arb: Arbitration } | { kind: 'done'; arb: Arbitration; closed: boolean };

/** Activité Arbitre: lire les BD des autres et juger le respect des contraintes (jamais le talent). */
export function ArbiterPage({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<View>({ kind: 'hub' });
  const [hub, setHub] = useState<Hub | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [h, w] = await Promise.all([fetchHub(), fetchWallet()]);
      setHub(h);
      setWallet(w);
    } catch (e) {
      setNotice(errorText(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async <T,>(action: () => Promise<T>, then?: (r: T) => void) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await action();
      then?.(r);
      return r;
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(arbitrateNext, (r: ArbResult) => {
      if (r.arbitration) setView({ kind: 'arbitration', arb: r.arbitration });
      else setNotice('Aucune BD à arbitrer pour le moment: reviens plus tard.');
    });
  const back = () => {
    setView({ kind: 'hub' });
    void refresh();
  };

  if (view.kind === 'arbitration') {
    return <Judging arb={view.arb} onChange={(arb) => setView({ kind: 'arbitration', arb })} onDone={(arb, closed) => setView({ kind: 'done', arb, closed })} onLeave={back} />;
  }
  if (view.kind === 'done') {
    const { arb, closed } = view;
    return (
      <Shell title="Arbitrage terminé" subtitle={`« ${arb.theme} »`}>
        <ToyCard tone={closed ? 'yellow' : 'green'}>
          {closed ? (
            <p className="plain-text"><strong>Cette BD a déjà reçu tous ses arbitrages</strong>: aucun gain, merci d’avoir lu.</p>
          ) : (
            <ul className="sv-stats">
              <li><strong>{arb.total}</strong> case{arb.total > 1 ? 's' : ''} évaluée{arb.total > 1 ? 's' : ''}</li>
              <li><strong>{arb.up}</strong> upvote{arb.up > 1 ? 's' : ''} · <strong>{arb.down}</strong> downvote{arb.down > 1 ? 's' : ''}</li>
              <li>Encre bonus obtenue : <strong>+{arb.reward}</strong></li>
            </ul>
          )}
        </ToyCard>
        {notice && <p className="sv-notice sv-notice--error" role="alert">{notice}</p>}
        <div className="row-buttons">
          <ToyButton variant="primary" icon="play" disabled={busy} onClick={() => void start()}>Arbitrer une autre BD</ToyButton>
          <ToyButton variant="ghost" icon="back" onClick={back}>Retour</ToyButton>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Arbitre" subtitle="Lis les BD des autres et juge les contraintes">
      <ToyCard tone="yellow">
        <p className="plain-text"><strong>Encre bonus : {wallet?.balance ?? hub?.balance ?? '…'}</strong></p>
        <p className="hint">Juge la contrainte, pas le talent du dessinateur. Un dessin rudimentaire, un Mimo ou une interprétation drôle sont valables s’ils répondent à la contrainte.</p>
        {hub && (
          <>
            <p className="hint">
              {hub.available} BD disponible{hub.available > 1 ? 's' : ''} · {hub.daily_done}/{hub.daily_limit} arbitrages aujourd’hui · une case jugée rapporte +{hub.rules.rewards.vote_given}, un arbitrage complet +{hub.rules.rewards.complete_bonus} de plus.
            </p>
            <div className="row-buttons">
              {hub.active ? (
                <ToyButton variant="primary" icon="play" disabled={busy} onClick={() => void run(currentArbitration, (a) => a && setView({ kind: 'arbitration', arb: a }))}>
                  Reprendre l’arbitrage ({hub.active.voted}/{hub.active.total})
                </ToyButton>
              ) : (
                <ToyButton variant="primary" icon="play" disabled={busy || hub.available === 0 || hub.daily_done >= hub.daily_limit} onClick={() => void start()}>Arbitrer une BD</ToyButton>
              )}
              <ToyButton variant="ghost" icon="back" onClick={onBack}>Menu</ToyButton>
            </div>
          </>
        )}
        {!hub && <div className="row-buttons"><ToyButton variant="ghost" icon="back" onClick={onBack}>Menu</ToyButton></div>}
        {notice && <p className="sv-notice sv-notice--error" role="alert">{notice}</p>}
      </ToyCard>

      {hub && hub.consents.length > 0 && (
        <section className="sv-lab-section">
          <h2 className="sv-lab-title">Demandes d’arbitrage <span className="hint">({hub.consents.length})</span></h2>
          {hub.consents.map((c) => (
            <ToyCard key={c.bd_id} tone="lavender">
              <p className="plain-text"><strong>« {c.theme} »</strong> · {SOURCE_LABELS[c.source]} · {c.cases} cases</p>
              <p className="hint">Autoriser des arbitres anonymes à lire cette BD et à juger les contraintes ? Ta décision est définitive.</p>
              <div className="row-buttons">
                <ToyButton variant="success" size="s" icon="check" disabled={busy} onClick={() => void run(() => answerConsent(c.bd_id, true), refresh)}>Accepter</ToyButton>
                <ToyButton variant="soft" size="s" disabled={busy} onClick={() => void run(() => answerConsent(c.bd_id, false), refresh)}>Refuser</ToyButton>
              </div>
            </ToyCard>
          ))}
        </section>
      )}

      {hub && hub.submittable.length > 0 && (
        <section className="sv-lab-section">
          <h2 className="sv-lab-title">Parties à soumettre <span className="hint">({hub.submittable.length})</span></h2>
          {hub.submittable.map((g) => (
            <ToyCard key={g.game_id} tone="plain">
              <p className="plain-text"><strong>« {g.theme} »</strong> · {SOURCE_LABELS[g.mode]} · {g.cases} cases</p>
              <p className="hint">Les autres contributeurs devront accepter; la partie n’attend personne.</p>
              <ToyButton variant="soft" size="s" icon="eye" disabled={busy} onClick={() => void run(() => submitGameBd(g.game_id), refresh)}>Soumettre aux arbitres</ToyButton>
            </ToyCard>
          ))}
        </section>
      )}

      {hub && hub.mine.length > 0 && (
        <section className="sv-lab-section">
          <h2 className="sv-lab-title">Mes BD soumises</h2>
          {hub.mine.map((m) => (
            <ToyCard key={m.bd_id} tone="plain">
              <p className="plain-text"><strong>« {m.theme} »</strong> · {SOURCE_LABELS[m.source]} · {m.cases} cases</p>
              <p className="hint">{BD_STATUS_LABELS[m.status]} · {m.arbitrations_done}/{m.arbitrations_max} arbitrages</p>
              {m.arbitrations_done > 0 && (
                <p className="hint">
                  <PixelIcon name="thumbUp" size={14} /> {m.ups} · <PixelIcon name="thumbDown" size={14} /> {m.downs} · encre bonus gagnée : +{m.ink_earned}
                </p>
              )}
              {m.narrative?.status === 'decided' && m.narrative.result && <p className="hint"><strong>{NARRATIVE_LABELS[m.narrative.result]}</strong> (la survie et les forfaits ne changent pas)</p>}
              {m.narrative?.status === 'pending' && <p className="hint">Départage narratif en attente d’arbitrages.</p>}
              {m.source === 'solo' && <p className="hint">Performances déclarées par ton appareil, non certifiées.</p>}
            </ToyCard>
          ))}
        </section>
      )}

      {wallet && wallet.history.length > 0 && (
        <section className="sv-lab-section">
          <h2 className="sv-lab-title">Dernières encres bonus</h2>
          <ul className="sv-stats">
            {wallet.history.slice(0, 8).map((h, i) => (
              <li key={i}>+{h.amount} · {REASON_LABELS[h.reason]}</li>
            ))}
          </ul>
          <p className="hint">Cette encre ne se dépense pas encore.</p>
        </section>
      )}
    </Shell>
  );
}

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <main>
        <PageFrame title={title} subtitle={subtitle} backHref={hrefOf({ name: 'home' })} tone="lavender" right={<span />}>
          {children}
        </PageFrame>
      </main>
    </div>
  );
}

// ───────────── Une BD à juger ─────────────

function Judging({ arb, onChange, onDone, onLeave }: { arb: Arbitration; onChange: (a: Arbitration) => void; onDone: (a: Arbitration, closed: boolean) => void; onLeave: () => void }) {
  const [slot, setSlot] = useState(0);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const bd = arb.bds[slot];
  const c = bd.cases[at];
  const urls = useImages(arb.bds.flatMap((b) => b.cases));
  const asked = constraintById(c.constraint_id);

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  // Un second appui sur le même pouce retire le vote; on passe ensuite à la case suivante.
  const vote = (v: Vote) =>
    guard(async () => {
      onChange(await castVote(arb.id, c.id, c.vote === v ? null : v));
      if (c.vote !== v && at < bd.cases.length - 1) setAt(at + 1);
    });
  const finish = () =>
    guard(async () => {
      const r = await finishArbitration(arb.id);
      if (r.arbitration) onDone(r.arbitration, r.outcome === 'closed');
    });
  const leave = () => guard(async () => { await abandonArbitration(arb.id); onLeave(); });
  const flag = (category: FlagCategory) => guard(async () => { await flagArbitration(arb.id, bd.slot, category); onLeave(); });

  return (
    <Shell title="Arbitrage" subtitle={`« ${arb.theme} » · ${arb.voted}/${arb.total} cases jugées`}>
      <p className="sv-lead">Juge la contrainte, pas le talent du dessinateur.</p>
      <div className="sv-arb__progress" role="progressbar" aria-valuemin={0} aria-valuemax={arb.total} aria-valuenow={arb.voted}>
        <div className="sv-arb__bar" style={{ width: `${(arb.voted / arb.total) * 100}%` }} />
      </div>
      {arb.duel && (
        <div className="row-buttons" role="tablist" aria-label="BD à comparer">
          {arb.bds.map((b, i) => (
            <ToyButton key={b.slot} variant={i === slot ? 'primary' : 'soft'} size="s" onClick={() => { setSlot(i); setAt(0); }}>BD {b.label}</ToyButton>
          ))}
        </div>
      )}
      <ToyCard tone="plain">
        {urls[c.image_path] ? <img className="sv-arb__img" src={urls[c.image_path]} alt={`Case ${c.position}`} /> : <div className="sv-arb__img sv-thumb--empty" role="img" aria-label="Chargement du dessin" />}
        <p className="sv-arb__ask"><span className="sv-dice" aria-hidden="true">{diceOf(c.constraint_id)}</span> {asked?.text ?? c.constraint_id}</p>
        <p className="hint">Case {c.position}{arb.duel ? ` de la BD ${bd.label}` : ''} · la contrainte est-elle respectée ?</p>
        <div className="sv-arb__votes">
          <ToyButton variant={c.vote === 'up' ? 'success' : 'soft'} icon="thumbUp" disabled={busy} onClick={() => void vote('up')} aria-pressed={c.vote === 'up'} aria-label="Upvote: contrainte respectée">Respectée</ToyButton>
          <ToyButton variant={c.vote === 'down' ? 'danger' : 'soft'} icon="thumbDown" disabled={busy} onClick={() => void vote('down')} aria-pressed={c.vote === 'down'} aria-label="Downvote: contrainte non respectée">Pas respectée</ToyButton>
        </div>
        <div className="row-buttons">
          <ToyButton variant="ghost" size="s" icon="back" disabled={at === 0} onClick={() => setAt(at - 1)}>Précédente</ToyButton>
          <ToyButton variant="ghost" size="s" disabled={at === bd.cases.length - 1} onClick={() => setAt(at + 1)}>Suivante</ToyButton>
        </div>
      </ToyCard>
      <div className="sv-arb__strip" role="group" aria-label="Cases de la BD">
        {bd.cases.map((k, i) => (
          <button key={k.id} type="button" className={`sv-arb__chip${i === at ? ' sv-arb__chip--on' : ''}${k.vote ? ` sv-arb__chip--${k.vote}` : ''}`} onClick={() => setAt(i)} aria-label={`Case ${k.position}${k.vote === 'up' ? ', respectée' : k.vote === 'down' ? ', non respectée' : ', à juger'}`}>
            {k.position}
          </button>
        ))}
      </div>

      {confirming ? (
        <ToyCard tone="yellow">
          <p className="plain-text"><strong>Valider l’arbitrage ?</strong> Tes votes deviendront définitifs et l’encre bonus sera versée.</p>
          <div className="row-buttons">
            <ToyButton variant="primary" icon="check" disabled={busy} onClick={() => void finish()}>Oui, valider</ToyButton>
            <ToyButton variant="soft" disabled={busy} onClick={() => setConfirming(false)}>Revoir mes votes</ToyButton>
          </div>
        </ToyCard>
      ) : flagging ? (
        <ToyCard tone="pink">
          <p className="plain-text"><strong>Signaler cette BD{arb.duel ? ` (${bd.label})` : ''}</strong> : l’arbitrage s’arrête sans récompense.</p>
          <div className="row-buttons">
            <ToyButton variant="danger" size="s" disabled={busy} onClick={() => void flag('incomprehensible')}>Incompréhensible</ToyButton>
            <ToyButton variant="danger" size="s" disabled={busy} onClick={() => void flag('inappropriate')}>Inapproprié</ToyButton>
            <ToyButton variant="soft" size="s" onClick={() => setFlagging(false)}>Annuler</ToyButton>
          </div>
        </ToyCard>
      ) : (
        <div className="row-buttons">
          <ToyButton variant="primary" icon="check" disabled={busy || !arb.complete} onClick={() => setConfirming(true)}>Valider l’arbitrage</ToyButton>
          <ToyButton variant="soft" size="s" disabled={busy} onClick={() => void leave()}>Passer cette BD</ToyButton>
          <ToyButton variant="ghost" size="s" icon="alert" onClick={() => setFlagging(true)}>Signaler</ToyButton>
          <ToyButton variant="ghost" size="s" icon="back" onClick={onLeave}>Reprendre plus tard</ToyButton>
        </div>
      )}
      {error && <p className="sv-notice sv-notice--error" role="alert">{error}</p>}
    </Shell>
  );
}
