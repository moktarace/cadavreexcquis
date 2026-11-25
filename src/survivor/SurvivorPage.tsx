import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { hrefOf } from '../app/router';
import { HEIGHT, WIDTH } from '../editor/palette';
import { indexedToRgba } from '../editor/render';
import { EditorSession } from '../editor/session';
import { EditorWorkspace } from '../editor/ui/EditorWorkspace';
import { PageFrame } from '../pages/shared';
import { ToyButton, ToyCard, ToyDialog } from '../ui';
import { SURVIVOR } from './config';
import { LEVELS, LEVEL_LABELS, constraintById, diceOf } from './constraints';
import { exportSurvivorPng } from './exportSheet';
import { SurvivorGame, drawnPixels, inkOutMessage, inkOutState, type CaseGain, type ShopItem } from './game';
import { SAVE_MESSAGES, beginRun, persistRun, readRun, type SaveFailure } from './storage';
import { ArbiterPage } from './arbiter/ArbiterPage';
import { newSoloUpload, submitSolo } from './arbiter/api';
import { InviteView, MultiLab } from './multi/MultiLab';
import { MultiPlay } from './multi/MultiPlay';
import { matchmake, reserveSlot } from './multi/api';
import type { GameResult, GameView, MultiMode } from './multi/types';
import { CaseBrief, InkGauge, ThemeLine, UpgradeChoice } from './parts';
import { buyItem, checkPurchase, type ShopInfo } from './shop/api';
import { soloPurchase } from './shop/solo';
import { BonusPill, ShopOffer, useShop } from './shop/ShopOffer';
import { ContextHint } from './home/parts';
import { useLive } from './home/live';
import { TUTORIAL, seen } from './home/prefs';
import { ActivityView, HomeView, MyGamesView, PlayChooser, SurvivorDock, TutorialDialog, WalletView, type Activite, type SoloInfo, type Tab } from './home/screens';
import { suggestPlay, type EventTarget, type PlayTarget } from './home/types';
import { UPGRADES } from './upgrades';
import './survivor.css';

type Screen =
  | { k: 'tab'; tab: Tab }
  | { k: 'solo' }
  | { k: 'mode'; mode: MultiMode }
  | { k: 'arbiter' }
  | { k: 'wallet' }
  | { k: 'play'; gameId: string }
  | { k: 'invite' };

/** Confirmation avant une action qui réserve ou engage quelque chose (jamais lancée sans le geste du joueur). */
type Confirm = { kind: 'relay_new' } | { kind: 'reserve'; game: GameView };

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Erreur inconnue.');

/** Survivor (#/lab/survivor): accueil, parties, activité, Solo hors ligne et modes en ligne. Le Solo ne crée jamais de compte. */
export default function SurvivorPage({ invite = null }: { invite?: string | null }) {
  const [game, setGame] = useState<SurvivorGame | null>(null);
  const [screen, setScreen] = useState<Screen>(invite ? { k: 'invite' } : { k: 'tab', tab: 'home' });
  const [initial] = useState(() => readRun());
  const [saved, setSaved] = useState<SurvivorGame | null>(initial.kind === 'ok' ? initial.game : null);
  // Sauvegarde présente mais illisible: jamais prise pour une absence, jamais écrasée sans confirmation.
  const [unreadable, setUnreadable] = useState<'unavailable' | 'corrupt' | null>(initial.kind === 'unreadable' ? initial.reason : null);
  const [saveFail, setSaveFail] = useState<SaveFailure | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const shopInfo = useShop('solo', game?.gameId, { needSession: true });
  const live = useLive();
  const [tutorial, setTutorial] = useState(() => !invite && !seen(TUTORIAL));
  const [chooser, setChooser] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Gain d'encre: un bref message qui ne bloque rien.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  // Les écrans d'ensemble se rafraîchissent à l'ouverture (limité par useLive), jamais en boucle.
  const hub = screen.k === 'tab' || screen.k === 'mode' || screen.k === 'wallet';
  useEffect(() => {
    if (hub && !game) void live.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, screen.k === 'tab' ? screen.tab : '', !!game]);

  // Seule une écriture relue à l'identique compte comme enregistrée; sinon la partie continue en mémoire, avec un avertissement.
  const persist = (g: SurvivorGame): boolean => {
    const r = persistRun(g);
    setSaveFail(r.ok ? null : r.reason);
    return r.ok;
  };
  const changed = (g: SurvivorGame) => {
    persist(g);
    bump();
  };
  const retrySave = () => {
    if (game && persist(game)) setToast('Partie enregistrée');
  };
  // L'ancienne partie n'est remplacée qu'une fois la nouvelle écrite durablement (l'écriture est atomique: l'ancienne survit à un échec).
  const start = () => {
    const r = beginRun(saved);
    if (!r.started) {
      setStartError(`Nouvelle partie impossible: ${SAVE_MESSAGES[r.reason]} Ta partie en cours est conservée.`);
      return;
    }
    setStartError(null);
    setSaveFail(r.save.ok ? null : r.save.reason);
    setUnreadable(null);
    setSaved(r.game);
    setGame(r.game);
  };
  const home = () => setScreen({ k: 'tab', tab: 'home' });
  // Le menu relit la dernière sauvegarde (jamais une version périmée), sauf si l'écriture a échoué: la mémoire est alors plus récente.
  const toMenu = () => {
    if (game && saveFail) setSaved(game);
    else {
      const r = readRun();
      setSaved(r.kind === 'ok' ? r.game : null);
      setUnreadable(r.kind === 'unreadable' ? r.reason : null);
    }
    setGame(null);
    home();
  };
  const finished = (g: SurvivorGame, gain: CaseGain) => {
    changed(g);
    setToast(`+${Math.round(gain.gained)} d’encre${gain.gained < gain.reward ? ' · réserve pleine' : ''}`);
  };

  // Un achat dont la réponse s'est perdue (fermeture, réseau): on récupère son reçu et on l'applique une seule fois.
  const pendingId = game?.shop.pending?.id;
  useEffect(() => {
    if (!game || !pendingId) return;
    let alive = true;
    checkPurchase('solo', game.gameId, pendingId).then(
      (r) => {
        if (!alive) return;
        if (r) game.applyPurchase({ purchase: r.purchase, item: r.item, effect: r.effect });
        else game.clearPending();
        changed(game);
        void shopInfo.reload();
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, pendingId]);

  const soloShop = (g: SurvivorGame): SoloShop => {
    const buy = (item: ShopItem) => (id: string) =>
      soloPurchase(g, item, id, {
        persist: (x) => {
          const ok = persist(x);
          bump();
          return ok;
        },
        buy: (it, pid) => buyItem('solo', g.gameId, it, pid),
      });
    return {
      info: shopInfo.info,
      reload: () => void shopInfo.reload(),
      buy,
      offer: (item, extra) => (
        <ShopOffer item={item} info={shopInfo.info} available={g.canUse(item, shopInfo.info?.rules.items.refill.min_missing)} perform={async (id) => { await buy(item)(id); extra?.(); }} onDone={() => void shopInfo.reload()} />
      ),
    };
  };

  // ───── Navigation entre activités ─────
  const solo: SoloInfo | null = saved ? { resumable: saved.state.phase !== 'finished', caseNo: saved.state.caseNo, finished: saved.state.phase === 'finished', outcome: saved.state.outcome } : null;
  const openRelay = live.activity?.open.relay ?? 0;
  const target = suggestPlay(live.games, { resumable: !!solo?.resumable }, openRelay);

  const resumeSolo = () => saved && setGame(saved);
  const openGame = (g: GameView) => {
    setConfirmError(null);
    // Une case de Relay se réserve avant de dessiner: geste confirmé, jamais silencieux.
    if (g.mode === 'relay' && g.can_play && g.status === 'active' && !g.reservation_until) setConfirm({ kind: 'reserve', game: g });
    else setScreen({ k: 'play', gameId: g.id });
  };
  const play = (t: PlayTarget) => {
    if (t.kind === 'game') openGame(t.game);
    else if (t.kind === 'solo') resumeSolo();
    else if (t.kind === 'relay_new') {
      setConfirmError(null);
      setConfirm({ kind: 'relay_new' });
    } else setChooser(true);
  };
  const pickActivity = (a: Activite) => {
    setChooser(false);
    if (a === 'solo') setScreen({ k: 'solo' });
    else if (a === 'arbiter') setScreen({ k: 'arbiter' });
    else setScreen({ k: 'mode', mode: a });
  };
  const toTarget = (t: EventTarget) => {
    if (t.to === 'arbiter') setScreen({ k: 'arbiter' });
    else if (t.to === 'wallet') setScreen({ k: 'wallet' });
    else {
      const g = live.games?.find((x) => x.id === t.gameId);
      if (g) openGame(g);
      else setScreen({ k: 'play', gameId: t.gameId });
    }
  };
  const runAction = async (key: string, action: () => Promise<GameResult>) => {
    void key;
    setBusy(true);
    setNotice(null);
    try {
      await action();
      await live.refresh(true);
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const doConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    setConfirmError(null);
    try {
      const r = confirm.kind === 'relay_new' ? await matchmake('relay') : await reserveSlot(confirm.game.id);
      setConfirm(null);
      void live.refresh(true);
      setScreen({ k: 'play', gameId: r.game.id });
    } catch (e) {
      setConfirmError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const relay = live.rules?.relay;
  const turns = live.games?.filter((g) => g.can_play && (g.status === 'active' || g.status === 'searching')).length ?? 0;

  let view;
  let dock: Tab | null | false = false;
  if (game) {
    if (game.state.phase === 'finished') view = <End game={game} onRestart={start} onMenu={toMenu} onArbiter={() => { setGame(null); setScreen({ k: 'arbiter' }); }} />;
    else if (game.state.phase === 'upgrade') view = <UpgradeView game={game} shop={soloShop(game)} onPick={(id) => game.chooseUpgrade(id) && changed(game)} />;
    else if (game.state.phase === 'choosing') {
      view = <ChooseView game={game} shop={soloShop(game)} onPick={(id) => game.choose(id) && changed(game)} onJoker={() => game.rerollProposals() && changed(game)} onMenu={toMenu} />;
    } else view = <Play key={game.state.caseNo} game={game} shop={soloShop(game)} saveFail={saveFail} onRetrySave={retrySave} onChange={() => changed(game)} onFinished={(gain) => finished(game, gain)} onQuit={toMenu} />;
  } else if (screen.k === 'invite' && invite) {
    view = (
      <InviteView
        token={invite}
        onBack={home}
        onDone={(g) => {
          location.hash = hrefOf({ name: 'survivor' });
          void live.refresh(true);
          if (g.can_play) openGame(g);
          else setScreen({ k: 'tab', tab: 'games' });
        }}
      />
    );
  } else if (screen.k === 'arbiter') view = <ArbiterPage onBack={() => { home(); void live.refresh(true); }} />;
  else if (screen.k === 'play') {
    const gameId = screen.gameId;
    view = (
      <MultiPlay
        key={gameId}
        gameId={gameId}
        onBack={() => { setScreen({ k: 'tab', tab: 'games' }); void live.refresh(true); }}
        onChanged={() => void live.refresh(true)}
        after={{ next: suggestPlay(live.games, { resumable: !!solo?.resumable }, openRelay, gameId), onNext: () => play(suggestPlay(live.games, { resumable: !!solo?.resumable }, openRelay, gameId)), onArbiter: () => setScreen({ k: 'arbiter' }) }}
      />
    );
  } else if (screen.k === 'mode') {
    dock = 'home';
    view = <MultiLab mode={screen.mode} onBack={home} onOpen={openGame} onChanged={() => void live.refresh(true)} />;
  } else if (screen.k === 'solo') {
    dock = 'home';
    view = <SoloMenu saved={saved} unreadable={unreadable} onNew={start} onResume={resumeSolo} onBack={home} />;
  } else if (screen.k === 'wallet') {
    dock = 'home';
    view = <WalletView live={live} onBack={home} onArbiter={() => setScreen({ k: 'arbiter' })} />;
  } else if (screen.k === 'tab' && screen.tab === 'games') {
    dock = 'games';
    view = <MyGamesView live={live} solo={solo} onOpen={openGame} onSolo={resumeSolo} onPlay={() => play(target)} onAction={runAction} busy={busy} notice={notice} />;
  } else if (screen.k === 'tab' && screen.tab === 'activity') {
    dock = 'activity';
    view = <ActivityView live={live} onTarget={toTarget} />;
  } else {
    dock = 'home';
    view = (
      <HomeView live={live} solo={solo} target={target} onPlay={() => play(target)} onActivity={pickActivity} onWallet={() => setScreen({ k: 'wallet' })} onActivityTab={() => setScreen({ k: 'tab', tab: 'activity' })} onHelp={() => setTutorial(true)} />
    );
  }

  const playing = !!game && game.state.phase === 'drawing';
  return (
    <>
      {view}
      {(startError || (saveFail && !playing)) && (
        <div className="sv-savebar" role="alert">
          <span>{startError ?? (saveFail ? `${SAVE_MESSAGES[saveFail]} Elle sera perdue si tu fermes l’application.` : '')}</span>
          {saveFail && !startError && <ToyButton variant="soft" size="s" icon="rotate" onClick={retrySave}>Réessayer</ToyButton>}
          {startError && <ToyButton variant="soft" size="s" onClick={() => setStartError(null)}>OK</ToyButton>}
        </div>
      )}
      {dock !== false && <SurvivorDock tab={dock} onTab={(t) => setScreen({ k: 'tab', tab: t })} onPlay={() => play(target)} unread={live.activity?.unread ?? 0} turns={turns} />}
      <TutorialDialog open={tutorial} onClose={() => setTutorial(false)} />
      <PlayChooser open={chooser} onClose={() => setChooser(false)} onPick={pickActivity} live={live} />
      <ToyDialog
        open={!!confirm}
        title={confirm?.kind === 'relay_new' ? 'Réserver une case de Relay ?' : 'Réserver la prochaine case ?'}
        locked={busy}
        onClose={() => setConfirm(null)}
        actions={
          <>
            <ToyButton variant="soft" disabled={busy} onClick={() => setConfirm(null)}>Annuler</ToyButton>
            <ToyButton variant="primary" icon="check" disabled={busy} onClick={() => void doConfirm()}>{busy ? 'Réservation…' : 'Réserver'}</ToyButton>
          </>
        }
      >
        <p className="plain-text">
          {confirm?.kind === 'reserve' ? `« ${confirm.game.theme} » : la case est à toi` : 'Une BD collective attend un dessinateur'}
          {relay ? ` pendant ${relay.reserve_minutes} min, prolongée tant que tu dessines (jusqu’à ${relay.reserve_max_minutes} min).` : ' pendant un temps limité.'}
        </p>
        <p className="hint">Passé ce délai, elle est libérée pour les autres. Tu peux la libérer toi-même depuis « Mes parties ».</p>
        {confirmError && <p className="sv-notice sv-notice--error" role="alert">{confirmError}</p>}
      </ToyDialog>
      {toast && <div className="sv-toast" role="status">{toast}</div>}
    </>
  );
}

/** Achats du Solo: le serveur délivre un reçu, le moteur local l'applique une seule fois; la partie reste jouable hors ligne. */
interface SoloShop {
  info: ShopInfo | null;
  reload: () => void;
  buy: (item: ShopItem) => (purchaseId: string) => Promise<void>;
  offer: (item: ShopItem, extra?: () => void) => React.ReactNode;
}

// ───────────── Solo ─────────────

function SoloMenu({ saved, unreadable, onNew, onResume, onBack }: { saved: SurvivorGame | null; unreadable: 'unavailable' | 'corrupt' | null; onNew: () => void; onResume: () => void; onBack: () => void }) {
  const [replace, setReplace] = useState(false);
  const inProgress = (!!saved && saved.state.phase !== 'finished') || !!unreadable;
  return (
    <div className="app-shell">
      <main>
        <PageFrame title="Solo" subtitle="Sur cet appareil, sans connexion" tone="lavender" right={<ToyButton variant="soft" size="s" iconOnly icon="back" aria-label="Retour à l’accueil" onClick={onBack} />}>
          <ToyCard tone="yellow">
            <p className="plain-text"><strong>{SURVIVOR.totalCases} cases à dessiner avant la panne d’encre.</strong></p>
            <ul className="sv-rules">
              <li>Récompense d’une case : +{SURVIVOR.rewards.easy} (facile), +{SURVIVOR.rewards.medium} (intermédiaire), +{SURVIVOR.rewards.hard} (difficile).</li>
              <li>Toutes les {SURVIVOR.upgradeEvery} cases, une amélioration à choisir parmi {SURVIVOR.offerSize}.</li>
            </ul>
            <div className="row-buttons">
              <ToyButton variant="primary" icon="play" onClick={() => (inProgress ? setReplace(true) : onNew())}>Nouvelle partie</ToyButton>
              {saved && (
                <ToyButton variant="soft" icon="pages" onClick={onResume}>
                  Reprendre ({saved.state.phase === 'finished' ? 'terminée' : `case ${saved.state.caseNo}`})
                </ToyButton>
              )}
            </div>
            {unreadable && (
              <p className="sv-notice sv-notice--error" role="alert">
                {unreadable === 'unavailable' ? 'Le stockage de cet appareil est bloqué: une éventuelle partie enregistrée ne peut pas être relue.' : 'Une sauvegarde existe mais n’a pas pu être relue (données endommagées).'} Elle est conservée tant que tu ne lances pas une nouvelle partie.
              </p>
            )}
            <p className="hint">Tout reste sur cet appareil. Le dessin de la case en cours n’est pas sauvegardé : seules les cases terminées le sont.</p>
          </ToyCard>
        </PageFrame>
      </main>
      <ToyDialog
        open={replace}
        title="Remplacer ta partie en cours ?"
        onClose={() => setReplace(false)}
        actions={
          <>
            <ToyButton variant="soft" onClick={() => setReplace(false)}>Garder ma partie</ToyButton>
            <ToyButton variant="danger" icon="trash" onClick={() => { setReplace(false); onNew(); }}>Remplacer</ToyButton>
          </>
        }
      >
        <p className="plain-text">{saved && saved.state.phase !== 'finished' ? `Ta partie Solo (case ${saved.state.caseNo}) sera perdue` : 'La sauvegarde illisible sera remplacée'}: il n’y a qu’une sauvegarde Solo par appareil.</p>
      </ToyDialog>
    </div>
  );
}

// ───────────── Pièces communes ─────────────

function PixelThumb({ pixels, label }: { pixels: Uint8Array; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    ref.current!.getContext('2d')!.putImageData(new ImageData(indexedToRgba(pixels) as Uint8ClampedArray<ArrayBuffer>, WIDTH, HEIGHT), 0, 0);
  }, [pixels]);
  return <canvas ref={ref} className="sv-thumb" width={WIDTH} height={HEIGHT} role="img" aria-label={label} />;
}

// ───────────── Une case ─────────────

function Play({ game, shop, saveFail, onRetrySave, onChange, onFinished, onQuit }: { game: SurvivorGame; shop: SoloShop; saveFail: SaveFailure | null; onRetrySave: () => void; onChange: () => void; onFinished: (gain: CaseGain) => void; onQuit: () => void }) {
  const [session] = useState(() => {
    const s = new EditorSession();
    s.ink = game.rules;
    s.inkBudget = game.state.reserve;
    return s;
  });
  useSyncExternalStore(session.subscribe, session.getVersion);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const s = game.state;
  const asked = game.constraint;
  const out = inkOutState({ inkLeft: session.inkLeft, freeMimoLeft: session.freeMimoLeft, emergency: s.emergency, terminable: session.inkLeft < SURVIVOR.ink.minPlayable && game.isTerminable(drawnPixels(session)) });
  const outMessage = inkOutMessage(out, { freeMimoLeft: session.freeMimoLeft, emergency: s.emergency });

  // Défaite: plus d'encre, plus d'action gratuite ni de secours, et une case encore trop vide pour être terminée.
  useEffect(() => {
    if (game.isStuck(session.inkLeft, session.freeMimoLeft, drawnPixels(session))) {
      // Consommation nette de la case (trait en cours compris, actions annulées remboursées): budget moins ce qui reste.
      game.lose(session.inkBudget - Math.max(0, session.inkLeft));
      onChange();
    }
  });

  const finish = (settle: () => void) => {
    settle();
    const pixels = session.project.pixels;
    if (!game.isTerminable(pixels)) {
      setNotice(`Il faut un peu plus de dessin pour terminer la case (au moins ${SURVIVOR.minCasePixels} pixels).`);
      return;
    }
    setNotice(null);
    const gain = game.finishCase(pixels, session.project.ink?.spent ?? 0);
    if (gain) onFinished(gain);
  };

  const emergency = () => {
    if (game.useEmergency()) {
      session.inkBudget = game.state.reserve;
      onChange();
    }
  };

  return (
    <EditorWorkspace
      session={session}
      leading={<ToyButton className="ed-collapse" variant="soft" size="s" icon="back" onClick={onQuit} aria-label="Retour à l’accueil (la partie est conservée)">Accueil</ToyButton>}
      trailing={(settle) => (
        <ToyButton variant="primary" size="s" icon="check" onClick={() => finish(settle)}>Terminer la case</ToyButton>
      )}
      brief={
        <div className="sv-brief">
          <CaseBrief theme={s.theme} phase={game.phaseLabel} caseNo={s.caseNo} total={SURVIVOR.totalCases} asked={asked} reward={asked ? game.rewardOf(asked.id) : 0} />
          <InkGauge left={session.inkLeft} capacity={game.capacity} pending={session.pendingCost} label="Ton encre" />
          <div className="sv-brief__tools">
            <ToyButton variant="soft" size="s" icon="eye" onClick={() => setReviewOpen(true)} disabled={game.cases.length === 0}>Cases</ToyButton>
            {s.emergency > 0 && session.inkLeft < 10 && (
              <ToyButton variant="danger" size="s" icon="alert" onClick={emergency}>Dernier souffle +{SURVIVOR.upgrades.dernierSouffle}</ToyButton>
            )}
            {session.inkLeft < 10 && shop.info?.allowed && game.canUse('emergency_refill') && shop.offer('emergency_refill', () => { session.inkBudget = game.state.reserve; })}
          </div>
          {outMessage && <p className={out === 'validable' ? 'sv-notice sv-notice--ok' : 'sv-notice'} role="status">{outMessage}</p>}
          {notice && <p className="sv-notice" role="status">{notice}</p>}
          {saveFail && (
            <p className="sv-notice" role="alert">
              {SAVE_MESSAGES[saveFail]} <ToyButton variant="soft" size="s" icon="rotate" onClick={onRetrySave}>Réessayer</ToyButton>
            </p>
          )}
        </div>
      }
    >
      <ToyDialog
        open={reviewOpen}
        title="Cases précédentes"
        onClose={() => setReviewOpen(false)}
        actions={<ToyButton variant="primary" icon="pencil" onClick={() => setReviewOpen(false)}>Retour au dessin</ToyButton>}
      >
        <ul className="sv-review">
          {game.cases.map((c, i) => (
            <li key={i}>
              <PixelThumb pixels={c} label={`Case ${i + 1}`} />
              <span><strong>{i + 1}</strong> {constraintById(s.constraintIds[i])?.text}</span>
            </li>
          ))}
        </ul>
      </ToyDialog>
    </EditorWorkspace>
  );
}

// ───────────── Choix de la demande ─────────────

function ChooseView({ game, shop, onPick, onJoker, onMenu }: { game: SurvivorGame; shop: SoloShop; onPick: (id: string) => void; onJoker: () => void; onMenu: () => void }) {
  const s = game.state;
  return (
    <div className="app-shell">
      <main>
        <PageFrame title={`Case ${s.caseNo}/${SURVIVOR.totalCases}`} subtitle={`${game.phaseLabel} · ${s.theme}`} tone="lavender" right={<span />}>
          <ThemeLine theme={s.theme} />
          <div className="sv-choose-gauge">
            <InkGauge left={s.reserve} capacity={game.capacity} pending={0} label="Encre de dessin" />
          </div>
          <ContextHint id="hint-ink">Chaque action de dessin consomme de l’encre de dessin (la jauge). Terminer une case en rend: plus la demande est dure, plus elle en rend.</ContextHint>
          {shop.info?.allowed && <ContextHint id="hint-bonus">L’encre bonus (étoile) est ton portefeuille permanent, gagné en arbitrant. Elle sert à acheter des coups de pouce, jamais obligatoires, et ne se confond pas avec la jauge de dessin.</ContextHint>}
          {shop.info?.allowed && (
            <div className="sv-shop">
              <BonusPill balance={shop.info.balance} />
              {shop.offer('refill')}
              {shop.offer('constraint_reroll')}
            </div>
          )}
          <p className="sv-lead">L’éditeur a trois demandes. Laquelle glisses-tu dans ton histoire ?</p>
          <div className="sv-picks">
            {s.proposals.map((id) => {
              const c = constraintById(id)!;
              return (
                <button key={id} type="button" className={`sv-pick sv-pick--${c.level}`} onClick={() => onPick(id)}>
                  <span className="sv-pick__level">{LEVEL_LABELS[c.level]}</span>
                  <span className="sv-pick__dice" aria-hidden="true">{diceOf(id)}</span>
                  <span className="sv-pick__text">{c.text}</span>
                  <span className="sv-pick__reward">+{game.rewardOf(id)} d’encre</span>
                </button>
              );
            })}
          </div>
          <div className="row-buttons">
            {s.jokers > 0 && <ToyButton variant="soft" icon="swap" onClick={onJoker}>Joker ×{s.jokers} · nouvelles demandes</ToyButton>}
            <ToyButton variant="ghost" icon="back" onClick={onMenu}>Accueil</ToyButton>
          </div>
        </PageFrame>
      </main>
    </div>
  );
}

// ───────────── Choix d'une amélioration ─────────────

function UpgradeView({ game, shop, onPick }: { game: SurvivorGame; shop: SoloShop; onPick: (id: string) => void }) {
  const s = game.state;
  return (
    <div className="app-shell">
      <main>
        <PageFrame title="Une amélioration !" subtitle={`Après la case ${s.caseNo} · encre ${Math.ceil(s.reserve)} / ${game.capacity}`} tone="yellow" right={<span />}>
          <UpgradeChoice offer={s.offer} owned={s.upgrades} onPick={onPick} />
          {shop.info?.allowed && <div className="sv-shop">{shop.offer('upgrade_reroll')}</div>}
        </PageFrame>
      </main>
    </div>
  );
}

// ───────────── Fin de partie ─────────────

function End({ game, onRestart, onMenu, onArbiter }: { game: SurvivorGame; onRestart: () => void; onMenu: () => void; onArbiter: () => void }) {
  const s = game.state;
  const won = s.outcome === 'victory';
  const [error, setError] = useState<string | null>(null);
  const upload = useRef(newSoloUpload());
  const [sent, setSent] = useState<'idle' | 'sending' | 'done'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);
  const chosen = game.chosenByLevel;
  // Facultatif et en ligne: seules les cases terminées et leurs demandes partent; la partie reste jouable hors ligne.
  const submit = async () => {
    setSent('sending');
    setSendError(null);
    try {
      await submitSolo(upload.current, game.cases, s.constraintIds.slice(0, game.cases.length), s.theme, { outcome: s.outcome, reserve: s.reserve, spent: s.totalSpent, upgrades: s.upgrades });
      setSent('done');
    } catch (e) {
      setSent('idle');
      setSendError(e instanceof Error ? e.message : 'Envoi impossible.');
    }
  };
  const owned = UPGRADES.filter((u) => (s.upgrades[u.id] ?? 0) > 0);
  const title = `Survivor · ${won ? 'victoire' : 'défaite'} · ${game.finishedCases}/${SURVIVOR.totalCases} cases · « ${s.theme} »`;
  return (
    <div className="app-shell">
      <main>
        <PageFrame title={won ? 'Victoire !' : 'Panne d’encre'} subtitle={`« ${s.theme} »`} tone={won ? 'yellow' : 'pink'} right={<span />}>
          <div className="sv-bd" role="list" aria-label="La BD produite">
            {Array.from({ length: SURVIVOR.totalCases }, (_, i) => (
              <div key={i} role="listitem">
                {game.cases[i] ? <PixelThumb pixels={game.cases[i]} label={`Case ${i + 1}`} /> : <div className="sv-thumb sv-thumb--empty" aria-label={`Case ${i + 1} non dessinée`} />}
              </div>
            ))}
          </div>
          <ToyCard tone={won ? 'green' : 'yellow'}>
            <ul className="sv-stats">
              <li><strong>{game.finishedCases}</strong> case{game.finishedCases > 1 ? 's' : ''} terminée{game.finishedCases > 1 ? 's' : ''} sur {SURVIVOR.totalCases}</li>
              <li>Demandes choisies : {LEVELS.map((l) => `${chosen[l]} ${LEVEL_LABELS[l].toLowerCase()}${chosen[l] > 1 && l !== 'medium' ? 's' : ''}`).join(' · ')}</li>
              <li>
                <strong>{Math.ceil(s.totalSpent)}</strong> d’encre consommée au total
                {(s.lostSpent ?? 0) > 0 && <> (dont {Math.ceil(s.lostSpent!)} sur la dernière case, non terminée)</>}
              </li>
              <li>Améliorations : {owned.length ? owned.map((u) => `${u.name}${(s.upgrades[u.id] ?? 0) > 1 ? ` ×${s.upgrades[u.id]}` : ''}`).join(', ') : 'aucune'}</li>
            </ul>
          </ToyCard>
          <div className="row-buttons">
            <ToyButton variant="primary" icon="download" onClick={() => exportSurvivorPng(game.cases, title).catch((e) => setError(e instanceof Error ? e.message : 'Export impossible'))}>Exporter en PNG</ToyButton>
            <ToyButton variant="soft" icon="rotate" onClick={onRestart}>Recommencer</ToyButton>
            <ToyButton variant="soft" icon="eye" onClick={onArbiter}>Arbitrer une BD</ToyButton>
            <ToyButton variant="ghost" icon="back" onClick={onMenu}>Accueil</ToyButton>
          </div>
          {error && <p className="hint" role="alert">{error}</p>}
          {game.finishedCases >= 4 && (
            <ToyCard tone="lavender">
              {sent === 'done' ? (
                <p className="plain-text"><strong>BD soumise.</strong> Des arbitres anonymes la liront; retrouve les résultats dans « Arbitre ».</p>
              ) : (
                <>
                  <p className="hint">Facultatif, connexion nécessaire: des arbitres anonymes jugeront si tes contraintes sont respectées (+5 encre bonus par upvote). Ton issue et ta réserve sont des déclarations de ton appareil, non certifiées.</p>
                  <ToyButton variant="soft" icon="eye" disabled={sent === 'sending'} onClick={() => void submit()}>{sent === 'sending' ? 'Envoi…' : 'Soumettre aux arbitres'}</ToyButton>
                </>
              )}
              {sendError && <p className="sv-notice sv-notice--error" role="alert">{sendError}</p>}
            </ToyCard>
          )}
        </PageFrame>
      </main>
    </div>
  );
}
