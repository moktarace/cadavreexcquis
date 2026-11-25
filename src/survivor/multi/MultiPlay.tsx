import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { previewPng } from '../../editor/export';
import { EditorSession } from '../../editor/session';
import { EditorWorkspace } from '../../editor/ui/EditorWorkspace';
import { PageFrame } from '../../pages/shared';
import { ToyButton, ToyCard, ToyDialog } from '../../ui';
import { SURVIVOR } from '../config';
import { LEVELS, LEVEL_LABELS, PHASE_LABELS, constraintById, diceOf, phaseOf } from '../constraints';
import { exportSurvivorPng } from '../exportSheet';
import { nonWhite, stuckNow } from '../game';
import { duelVerdict, submitGameBd } from '../arbiter/api';
import { NARRATIVE_LABELS, type NarrativeResult } from '../arbiter/types';
import { ContextHint, NextActions, type AfterActions } from '../home/parts';
import { matchState } from '../home/types';
import { InkGauge, UpgradeChoice } from '../parts';
import { buyItem, type ShopInfo } from '../shop/api';
import { BonusPill, ShopOffer, useShop } from '../shop/ShopOffer';
import type { ShopItem } from '../game';
import { inkRulesFor } from '../rules';
import { UPGRADES, modifiersOf } from '../upgrades';
import { declareStuck, extendReservation, fetchState, pickConstraint, playEmergency, playJoker, chooseUpgrade, setDemands, signedUrls, submitCase, uploadCaseImage } from './api';
import { MODE_LABELS, RESULT_LABELS, describeGame, formatRemaining, type Level, type MpCase, type MpResult, type MpState } from './types';

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Erreur inconnue.');
const EXTEND_EVERY_MS = 4 * 60_000;

/** Parties multijoueurs jouables (Relay, Duel, Battle): mêmes éditeur, jauge et améliorations que le Solo; le serveur décide de tout le reste. */
/** Consommables d'une partie en équipe: le serveur débite l'acheteur seul et renvoie l'état confirmé. */
type Offer = (item: ShopItem, available?: boolean) => React.ReactNode;

export function MultiPlay({ gameId, onBack, after, onChanged }: { gameId: string; onBack: () => void; after: AfterActions; onChanged: () => void }) {
  const [st, setSt] = useState<MpState | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash]);
  const shop = useShop('game', gameId);
  const offer: Offer = (item, available = true) => (
    <ShopOffer
      item={item}
      info={shop.info}
      available={available}
      team={st?.game.mode === 'relay'}
      perform={async (id) => { const r = await buyItem('game', gameId, item, id); if (r.state) setSt(r.state); }}
      onDone={() => void shop.reload()}
    />
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSt(await fetchState(gameId));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [gameId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Une action n'est annoncée réussie qu'après la réponse du serveur; en cas d'échec, on se resynchronise sans effacer le message.
  const act = async (action: () => Promise<MpResult>) => {
    setBusy(true);
    try {
      setSt((await action()).state);
      setError(null);
      onChanged();
    } catch (e) {
      const fresh = await fetchState(gameId).catch(() => null);
      if (fresh) setSt(fresh);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!st) {
    return (
      <Frame title="Partie" onBack={onBack}>
        <p className="hint" role="status">{error ?? 'Chargement…'}</p>
        {error && <ToyButton variant="soft" icon="rotate" onClick={() => void refresh()}>Réessayer</ToyButton>}
      </Frame>
    );
  }
  const g = st.game;
  const run = st.run;
  const ended = g.status !== 'searching' && g.status !== 'active';

  const view = (() => {
  if (ended) return <Finished st={st} onBack={onBack} after={after} />;
  if (!st.acting || !run) return <Waiting st={st} error={error} onRefresh={() => void refresh()} onBack={onBack} after={after} />;
  if (run.step === 'choosing' && run.pick) return <DrawCase key={`${run.position}-${run.pick}`} st={st} offer={offer} shop={shop.info} onState={(s) => { setSt(s); setFlash(`Case ${run.position} publiée`); onChanged(); }} onResync={refresh} onAct={act} onBack={onBack} />;
  if (run.step === 'choosing') return <Pick st={st} offer={offer} shop={shop.info} busy={busy} error={error} onAct={act} onBack={onBack} />;
  if (run.step === 'upgrade') {
    return (
      <Frame title="Une amélioration !" subtitle={g.mode === 'relay' ? 'Amélioration commune à toute la BD' : `Après ta case ${run.cases_done}`} onBack={onBack}>
        <Standings st={st} />
        <UpgradeChoice offer={run.offer} owned={run.upgrades} busy={busy} onPick={(id) => void act(() => chooseUpgrade(gameId, id))} />
        {shop.info?.allowed && <div className="sv-shop">{offer('upgrade_reroll')}</div>}
        {error && <p className="sv-notice sv-notice--error" role="alert">{error}</p>}
      </Frame>
    );
  }
  if (run.step === 'demands') return <Demands st={st} busy={busy} error={error} onAct={act} onBack={onBack} />;
  return <Waiting st={st} error={error} onRefresh={() => void refresh()} onBack={onBack} after={after} />;
  })();
  return (
    <>
      {view}
      {flash && <div className="sv-toast" role="status">{flash}</div>}
    </>
  );
}

function Frame({ title, subtitle, onBack, children }: { title: string; subtitle?: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <main>
        <PageFrame title={title} subtitle={subtitle} tone="lavender" right={<ToyButton variant="soft" size="s" iconOnly icon="back" aria-label="Retour à mes parties" onClick={onBack} />}>
          {children}
          <div className="row-buttons">
            <ToyButton variant="ghost" icon="back" onClick={onBack}>Mes parties</ToyButton>
          </div>
        </PageFrame>
      </main>
    </div>
  );
}

/** Ma réserve et, en Battle, celle de mon adversaire (rose): jamais confondues. */
function Standings({ st }: { st: MpState }) {
  const g = st.game;
  const me = st.runs.find((r) => r.is_me || r.shared);
  const rival = g.mode === 'battle' ? st.runs.find((r) => !r.is_me && !r.shared) : undefined;
  if (!me) return null;
  return (
    <div className="sv-versus">
      <InkGauge left={me.reserve} capacity={me.capacity} label={g.mode === 'relay' ? 'Encre commune' : 'Ton encre'} />
      {rival && <InkGauge left={rival.reserve} capacity={rival.capacity} rival label={`Encre de ${rival.nickname ?? 'l’adversaire'}`} />}
    </div>
  );
}

// ───────────── Choix de la demande ─────────────

function Pick({ st, offer, shop, busy, error, onAct, onBack }: { st: MpState; offer: Offer; shop: ShopInfo | null; busy: boolean; error: string | null; onAct: (a: () => Promise<MpResult>) => Promise<void>; onBack: () => void }) {
  const g = st.game;
  const run = st.run!;
  const lead =
    g.mode === 'battle'
      ? run.cases_done === 0 && g.cases_done === 0
        ? 'Trois demandes tirées au hasard pour ouvrir la BD.'
        : 'Ton adversaire t’impose ces trois demandes. Laquelle poursuis-tu ?'
      : 'L’éditeur a trois demandes. Laquelle glisses-tu dans l’histoire ?';
  return (
    <Frame title={`Case ${run.position}/${g.total_cases}`} subtitle={`${PHASE_LABELS[phaseOf(run.position, g.total_cases)]} · ${g.theme}`} onBack={onBack}>
      <Standings st={st} />
      <ContextHint id="hint-ink">Chaque action de dessin consomme de l’encre de dessin (la jauge). Terminer une case en rend: plus la demande est dure, plus elle en rend.</ContextHint>
      {g.mode === 'relay' && <ContextHint id="hint-relay">En Relay, l’encre est commune: chaque trait fait fondre la réserve de toute l’équipe, et la BD est perdue si elle tombe à zéro.</ContextHint>}
      {shop?.allowed && (
        <div className="sv-shop">
          <BonusPill balance={shop.balance} />
          {offer('refill', run.capacity - run.reserve >= (shop.rules.items.refill.min_missing ?? 20))}
          {offer('constraint_reroll')}
        </div>
      )}
      <p className="sv-lead">{lead}</p>
      <div className="sv-picks">
        {run.proposals.map((p) => {
          const c = constraintById(p.id);
          return (
            <button key={p.id} type="button" className={`sv-pick sv-pick--${p.level}`} disabled={busy} onClick={() => void onAct(() => pickConstraint(g.id, p.id))}>
              <span className="sv-pick__level">{LEVEL_LABELS[p.level]}</span>
              <span className="sv-pick__dice" aria-hidden="true">{diceOf(p.id)}</span>
              <span className="sv-pick__text">{c?.text ?? p.id}</span>
              <span className="sv-pick__reward">+{p.reward} d’encre</span>
            </button>
          );
        })}
      </div>
      {run.jokers > 0 && (
        <div className="row-buttons">
          <ToyButton variant="soft" icon="swap" disabled={busy} onClick={() => void onAct(() => playJoker(g.id, run.joker_uses))}>Joker ×{run.jokers} · nouvelles demandes</ToyButton>
        </div>
      )}
      {error && <p className="sv-notice sv-notice--error" role="alert">{error}</p>}
    </Frame>
  );
}

// ───────────── Dessin d'une case ─────────────

function DrawCase({ st, offer, shop, onState, onResync, onAct, onBack }: { st: MpState; offer: Offer; shop: ShopInfo | null; onState: (s: MpState) => void; onResync: () => Promise<void>; onAct: (a: () => Promise<MpResult>) => Promise<void>; onBack: () => void }) {
  const g = st.game;
  const run = st.run!;
  const [session] = useState(() => {
    const s = new EditorSession();
    s.ink = inkRulesFor(modifiersOf(run.upgrades));
    s.inkBudget = run.reserve;
    return s;
  });
  const version = useSyncExternalStore(session.subscribe, session.getVersion);
  const [notice, setNotice] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [peek, setPeek] = useState(false);
  const attempt = useRef<{ sub: string; version: number } | null>(null);
  const stuckSent = useRef(false);
  const lastBeat = useRef(Date.now());
  const asked = constraintById(run.pick ?? '');
  // Réserve de l'éditeur alignée sur l'état confirmé par le serveur (Dernier souffle, Dernière chance): le dessin et les dépenses de la case restent.
  useEffect(() => {
    session.inkBudget = run.reserve;
  }, [run.reserve, session]);
  const reward = run.proposals.find((p) => p.id === run.pick)?.reward ?? 0;

  // Panne d'encre: déclarée une fois; le serveur refuse tant qu'un secours existe.
  useEffect(() => {
    if (stuckSent.current || session.inkLeft >= SURVIVOR.ink.minPlayable) return;
    if (stuckNow({ inkLeft: session.inkLeft, freeMimoLeft: session.freeMimoLeft, emergency: run.emergency, terminable: nonWhite(session.project.pixels) >= SURVIVOR.minCasePixels })) {
      stuckSent.current = true;
      void onAct(() => declareStuck(g.id));
    }
  });

  // Relay: la réservation se prolonge pendant que le joueur dessine vraiment (le serveur plafonne le total).
  useEffect(() => {
    if (g.mode !== 'relay' || Date.now() - lastBeat.current < EXTEND_EVERY_MS) return;
    lastBeat.current = Date.now();
    void extendReservation(g.id).catch(() => undefined);
  }, [version, g.id, g.mode]);

  const publish = async (settle: () => void) => {
    settle();
    if (nonWhite(session.project.pixels) < SURVIVOR.minCasePixels) {
      setNotice(`Il faut un peu plus de dessin pour terminer la case (au moins ${SURVIVOR.minCasePixels} pixels).`);
      return;
    }
    // Même identifiant tant que le dessin n'a pas changé: une relance ne crée jamais une seconde case.
    const v = session.getVersion();
    if (!attempt.current || attempt.current.version !== v) attempt.current = { sub: crypto.randomUUID(), version: v };
    setPublishing(true);
    setNotice(null);
    try {
      const png = await previewPng(session.project);
      const imagePath = await uploadCaseImage(g.id, attempt.current.sub, png);
      const res = await submitCase({ gameId: g.id, position: run.position, submissionId: attempt.current.sub, constraintId: run.pick!, imagePath, inkSpent: session.project.ink?.spent ?? 0 });
      onState(res.state);
    } catch (e) {
      setNotice(`${errorText(e)} Ton dessin est conservé tant que cet écran reste ouvert: réessaie.`);
      if (!/connexion/i.test(errorText(e))) void onResync();
    } finally {
      setPublishing(false);
    }
  };

  const emergency = () =>
    void onAct(async () => {
      const r = await playEmergency(g.id, run.emergency_uses);
      session.inkBudget = r.state.run?.reserve ?? session.inkBudget;
      return r;
    });

  const rival = g.mode === 'battle' ? st.runs.find((r) => !r.is_me && !r.shared) : undefined;
  return (
    <EditorWorkspace
      session={session}
      leading={<ToyButton className="ed-collapse" variant="soft" size="s" icon="back" onClick={onBack} aria-label="Retour à mes parties (le dessin en cours est perdu, pas l’encre)">Parties</ToyButton>}
      trailing={(settle) => (
        <ToyButton variant="primary" size="s" icon="check" onClick={() => void publish(settle)} disabled={publishing}>{publishing ? 'Envoi…' : 'Publier la case'}</ToyButton>
      )}
      brief={
        <div className="sv-brief">
          <div className="sv-brief__top">
            <strong>{MODE_LABELS[g.mode]} · case {run.position}/{g.total_cases}</strong>
            <span>{PHASE_LABELS[phaseOf(run.position, g.total_cases)]} · {g.theme}</span>
          </div>
          {asked && (
            <div className="sv-ask">
              <p className="sv-constraint"><span className="sv-dice" aria-label={`Dés ${asked.id}`}>{diceOf(asked.id)}</span> {asked.text}</p>
              <span className="sv-reward" title="Encre gagnée en terminant la case">+{reward}</span>
            </div>
          )}
          <InkGauge left={session.inkLeft} capacity={run.capacity} pending={session.pendingCost} label={g.mode === 'relay' ? 'Encre commune' : 'Ton encre'} />
          {rival && <InkGauge left={rival.reserve} capacity={rival.capacity} rival label={`Encre de ${rival.nickname ?? 'l’adversaire'}`} />}
          <div className="sv-brief__tools">
            {g.seconds_left !== null && <span className="sv-empty">{g.mode === 'relay' ? 'Réservation' : 'Délai'} : {formatRemaining(g.seconds_left)}</span>}
            {session.inkLeft < 10 && run.emergency === 0 && shop?.allowed && offer('emergency_refill')}
            {run.emergency > 0 && session.inkLeft < 10 && (
              <ToyButton variant="danger" size="s" icon="alert" onClick={emergency}>Dernier souffle +{SURVIVOR.upgrades.dernierSouffle}</ToyButton>
            )}
            {session.inkLeft < SURVIVOR.ink.minPlayable && <span className="sv-empty">Plus d’encre !</span>}
            {st.cases.length > 0 && <ToyButton variant="soft" size="s" icon="eye" onClick={() => setPeek(true)}>Cases précédentes</ToyButton>}
          </div>
          <ToyDialog open={peek} title="Cases précédentes" onClose={() => setPeek(false)} actions={<ToyButton variant="primary" onClick={() => setPeek(false)}>Retour au dessin</ToyButton>}>
            <p className="hint">Ton dessin en cours reste là, intact.</p>
            <Gallery cases={st.cases} title={g.theme} />
          </ToyDialog>
          {notice && <p className="sv-notice" role="status">{notice}</p>}
        </div>
      }
    />
  );
}

// ───────────── Battle: demandes pour l'adversaire ─────────────

function Demands({ st, busy, error, onAct, onBack }: { st: MpState; busy: boolean; error: string | null; onAct: (a: () => Promise<MpResult>) => Promise<void>; onBack: () => void }) {
  const g = st.game;
  const options = st.demand_options;
  const rival = st.runs.find((r) => !r.is_me && !r.shared);
  const [chosen, setChosen] = useState<Partial<Record<Level, string>>>({});
  if (!options) return null;
  const ready = LEVELS.every((l) => chosen[l]);
  return (
    <Frame title="Choisis les contraintes de ton adversaire" subtitle={`Après ta case · ${g.theme}`} onBack={onBack}>
      <Standings st={st} />
      <p className="sv-lead">Choisis une demande facile, une intermédiaire et une difficile. {rival?.nickname ?? 'Ton adversaire'} en choisira une: plus c’est dur, plus elle rapporte d’encre.</p>
      {LEVELS.map((l) => (
        <div key={l} className="sv-demands" role="group" aria-label={LEVEL_LABELS[l]}>
          <strong>{LEVEL_LABELS[l]}</strong>
          {options[l].map((id) => (
            <button key={id} type="button" className="sv-demand" aria-pressed={chosen[l] === id} onClick={() => setChosen({ ...chosen, [l]: id })}>
              <span aria-hidden="true">{diceOf(id)}</span> {constraintById(id)?.text ?? id}
            </button>
          ))}
        </div>
      ))}
      <div className="row-buttons">
        <ToyButton variant="primary" icon="check" disabled={!ready || busy} onClick={() => void onAct(() => setDemands(g.id, LEVELS.map((l) => chosen[l]!)))}>Transmettre le tour</ToyButton>
      </div>
      {error && <p className="sv-notice sv-notice--error" role="alert">{error}</p>}
    </Frame>
  );
}

// ───────────── Attente ─────────────

function Waiting({ st, error, onRefresh, onBack, after }: { st: MpState; error: string | null; onRefresh: () => void; onBack: () => void; after: AfterActions }) {
  const g = st.game;
  const state = matchState(g);
  return (
    <Frame title={`${MODE_LABELS[g.mode]} · ${g.theme}`} subtitle={describeGame(g)} onBack={onBack}>
      <Standings st={st} />
      <ToyCard tone="yellow">
        <p className={`sv-state sv-state--${state.key}`}>{g.mode === 'relay' ? 'Le relais est chez un autre dessinateur' : state.label}</p>
        <p className="hint">{g.mode === 'duel' ? g.players.map((p) => `${p.is_me ? 'Toi' : p.nickname} ${p.cases_done}/${g.total_cases}`).join(' · ') || `0/${g.total_cases}` : `${g.cases_done}/${g.total_cases} cases`}</p>
        {g.seconds_left !== null && <p className="hint">Délai : {formatRemaining(g.seconds_left)} restantes</p>}
        {st.upgrade_wait_seconds !== null && <p className="hint">L’auteur de la dernière case choisit son amélioration ({formatRemaining(st.upgrade_wait_seconds)} au plus).</p>}
        <p className="hint">Rien à faire pour l’instant: la partie t’attendra sur le serveur, tu peux fermer l’application.</p>
        <div className="row-buttons">
          <ToyButton variant="soft" icon="rotate" onClick={onRefresh}>Actualiser</ToyButton>
        </div>
        {error && <p className="sv-notice sv-notice--error" role="alert">{error}</p>}
      </ToyCard>
      <NextActions after={after} onGames={onBack} />
      <Gallery cases={st.cases} title="Les cases jusqu’ici" />
    </Frame>
  );
}

// ───────────── BD produites et fin de partie ─────────────

/** Adresses temporaires de lecture des images (bucket privé), demandées seulement pour les cases affichées. */
export function useImages(cases: readonly { image_path: string }[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = cases.map((c) => c.image_path).join('|');
  useEffect(() => {
    const need = cases.map((c) => c.image_path).filter((p) => !urls[p]);
    if (!need.length) return;
    let live = true;
    signedUrls(need).then((m) => live && setUrls((u) => ({ ...u, ...m })), () => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls;
}

function Gallery({ cases, title, exportName }: { cases: readonly MpCase[]; title: string; exportName?: string }) {
  const urls = useImages(cases);
  const [error, setError] = useState<string | null>(null);
  if (!cases.length) return null;
  const exportBd = async () => {
    try {
      const images = await Promise.all(
        cases.map(async (c) => {
          const url = urls[c.image_path];
          return url ? createImageBitmap(await (await fetch(url)).blob()) : undefined;
        }),
      );
      await exportSurvivorPng(images, title, exportName ?? 'survivor-bd.png');
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section className="sv-lab-section">
      <h2 className="sv-lab-title">{title}</h2>
      <ul className="sv-review">
        {cases.map((c) => (
          <li key={`${c.bd_owner}-${c.position}`}>
            {urls[c.image_path] ? <img className="sv-thumb" src={urls[c.image_path]} alt={`Case ${c.position}`} /> : <div className="sv-thumb sv-thumb--empty" role="img" aria-label={`Case ${c.position}`} />}
            <span className="sv-cap"><strong>{c.position}</strong> {c.mine ? 'Toi' : c.nickname} · {constraintById(c.constraint_id)?.text}</span>
          </li>
        ))}
      </ul>
      {exportName && (
        <div className="row-buttons">
          <ToyButton variant="primary" icon="download" onClick={() => void exportBd()}>Exporter en PNG</ToyButton>
        </div>
      )}
      {error && <p className="sv-notice sv-notice--error" role="alert">{error}</p>}
    </section>
  );
}

function levelCounts(cases: readonly MpCase[]) {
  const out: Record<Level, number> = { easy: 0, medium: 0, hard: 0 };
  for (const c of cases) {
    const k = constraintById(c.constraint_id);
    if (k) out[k.level]++;
  }
  return out;
}

function Finished({ st, onBack, after }: { st: MpState; onBack: () => void; after: AfterActions }) {
  const g = st.game;
  const owners = [...new Set(st.cases.map((c) => c.bd_owner))];
  const names = new Map<string, string>(UPGRADES.map((u) => [u.id, u.name]));
  const [verdict, setVerdict] = useState<NarrativeResult | null>(null);
  const [asked, setAsked] = useState<'idle' | 'sending' | 'done'>('idle');
  const [askError, setAskError] = useState<string | null>(null);
  useEffect(() => {
    if (g.mode === 'duel' && g.status === 'finished') duelVerdict(g.id).then(setVerdict, () => undefined);
  }, [g.id, g.mode, g.status]);
  // Demande d'arbitrage: les autres contributeurs doivent accepter, la partie n'attend personne.
  const askArbiters = async () => {
    setAsked('sending');
    setAskError(null);
    try {
      await submitGameBd(g.id);
      setAsked('done');
    } catch (e) {
      setAsked('idle');
      setAskError(errorText(e));
    }
  };
  return (
    <Frame title={g.status === 'cancelled' ? 'Défi annulé' : `${MODE_LABELS[g.mode]} terminé`} subtitle={`« ${g.theme} »`} onBack={onBack}>
      <ToyCard tone={g.result === 'victory' || g.result === 'win' ? 'green' : 'yellow'}>
        <p className="plain-text"><strong>{describeGame(g)}</strong></p>
        {g.mode === 'duel' && (
          <p className="hint">
            <strong>Survie</strong> : le résultat ci-dessous. <strong>Résultat narratif</strong> :{' '}
            {verdict?.status === 'decided' && verdict.result ? `${NARRATIVE_LABELS[verdict.result]} (${verdict.my_ups} upvotes contre ${verdict.rival_ups})` : verdict?.status === 'pending' ? 'en attente des arbitres' : 'pas de vainqueur narratif (les deux BD ne sont pas arbitrées)'}.
          </p>
        )}
        {g.result && RESULT_LABELS[g.result] && g.status === 'finished' && g.mode !== 'duel' && <p className="hint">{RESULT_LABELS[g.result]}</p>}
      </ToyCard>
      <div className="sv-stats-table">
        {st.runs.map((r, i) => {
          const mine = r.is_me || r.shared;
          const bd = st.cases.filter((c) => (g.mode === 'duel' ? (r.is_me ? c.mine : !c.mine) : g.mode === 'battle' ? c.nickname === r.nickname || (r.is_me && c.mine) : true));
          const n = levelCounts(bd);
          const owned = Object.entries(r.upgrades ?? {}).filter(([, v]) => v > 0).map(([id, v]) => `${names.get(id) ?? id}${v > 1 ? ` ×${v}` : ''}`);
          return (
            <ToyCard key={i} tone={mine ? 'lavender' : 'plain'}>
              <p className="plain-text"><strong>{r.shared ? 'BD collective' : r.is_me ? 'Toi' : r.nickname}</strong> · {r.outcome === 'defeat' ? 'panne d’encre' : r.outcome === 'victory' ? 'a tenu jusqu’au bout' : 'en cours'}</p>
              <ul className="sv-stats">
                <li><strong>{r.cases_done}</strong>/{g.total_cases} cases terminées</li>
                <li>Encre restante : {Math.ceil(r.reserve)} / {r.capacity} · consommée : {Math.round(r.total_spent)}</li>
                <li>Demandes : {n.easy} faciles · {n.medium} intermédiaires · {n.hard} difficiles</li>
                <li>Améliorations : {owned.length ? owned.join(', ') : 'aucune'}</li>
              </ul>
            </ToyCard>
          );
        })}
      </div>
      {owners.map((o) => {
        const cases = st.cases.filter((c) => c.bd_owner === o);
        const title = g.mode === 'duel' ? (cases[0]?.mine ? 'Ma BD' : `BD de ${cases[0]?.nickname}`) : 'La BD';
        return <Gallery key={String(o)} cases={cases} title={title} exportName={`survivor-${g.mode}-${o ? o.slice(0, 4) : 'bd'}.png`} />;
      })}
      {g.status === 'finished' && (
        <ToyCard tone="lavender">
          {asked === 'done' ? (
            <p className="plain-text"><strong>Demande envoyée.</strong> Les autres contributeurs la verront dans « Arbitre » et devront accepter.</p>
          ) : (
            <>
              <p className="hint">Facultatif: des arbitres anonymes jugeront le respect des contraintes (au moins quatre cases terminées).</p>
              <ToyButton variant="soft" icon="eye" disabled={asked === 'sending'} onClick={() => void askArbiters()}>Soumettre aux arbitres</ToyButton>
            </>
          )}
          {askError && <p className="sv-notice sv-notice--error" role="alert">{askError}</p>}
        </ToyCard>
      )}
      <NextActions after={after} onGames={onBack} />
    </Frame>
  );
}

