import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { hrefOf } from '../app/router';
import { HEIGHT, WIDTH } from '../editor/palette';
import { indexedToRgba } from '../editor/render';
import { EditorSession } from '../editor/session';
import { EditorWorkspace } from '../editor/ui/EditorWorkspace';
import { PageFrame } from '../pages/shared';
import { PixelIcon, ToyButton, ToyCard, ToyDialog } from '../ui';
import { SURVIVOR } from './config';
import { LEVELS, LEVEL_LABELS, constraintById, diceOf } from './constraints';
import { exportSurvivorPng } from './exportSheet';
import { SurvivorGame, type CaseGain } from './game';
import { clearRun, loadRun, saveRun } from './storage';
import { InviteView, MultiLab } from './multi/MultiLab';
import { MODE_BLURBS, MODE_LABELS, type MultiMode } from './multi/types';
import { UPGRADES, upgradeById } from './upgrades';
import './survivor.css';

/** Mode expérimental (#/lab/survivor): une BD de 16 cases à finir avant d'être à court d'encre. Hors ligne, sans compte. */
export default function SurvivorPage({ invite = null }: { invite?: string | null }) {
  const [game, setGame] = useState<SurvivorGame | null>(null);
  // Multijoueur (expérimental): le Solo ci-dessous reste local et hors ligne.
  const [lab, setLab] = useState<MultiMode | 'invite' | null>(invite ? 'invite' : null);
  const [saved, setSaved] = useState(() => loadRun());
  const [toast, setToast] = useState<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // Gain d'encre: un bref message qui ne bloque rien.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const changed = (g: SurvivorGame) => {
    saveRun(g);
    bump();
  };
  const start = () => {
    clearRun();
    const g = SurvivorGame.start();
    saveRun(g);
    setGame(g);
  };
  // Le menu relit la dernière sauvegarde: la reprise ne propose jamais une version périmée.
  const toMenu = () => {
    setSaved(loadRun());
    setGame(null);
  };
  const finished = (g: SurvivorGame, gain: CaseGain) => {
    changed(g);
    setToast(`+${Math.round(gain.gained)} d’encre${gain.gained < gain.reward ? ' · réserve pleine' : ''}`);
  };

  let view;
  if (!game && lab === 'invite' && invite) {
    view = <InviteView token={invite} onBack={() => setLab(null)} onDone={(mode) => { location.hash = hrefOf({ name: 'survivor' }); setLab(mode); }} />;
  } else if (!game && lab && lab !== 'invite') view = <MultiLab mode={lab} onBack={() => setLab(null)} />;
  else if (!game) view = <Menu saved={saved} onNew={start} onResume={() => saved && setGame(saved)} onLab={setLab} />;
  else if (game.state.phase === 'finished') view = <End game={game} onRestart={start} onMenu={toMenu} />;
  else if (game.state.phase === 'upgrade') view = <UpgradeView game={game} onPick={(id) => game.chooseUpgrade(id) && changed(game)} />;
  else if (game.state.phase === 'choosing') {
    view = <ChooseView game={game} onPick={(id) => game.choose(id) && changed(game)} onJoker={() => game.rerollProposals() && changed(game)} onMenu={toMenu} />;
  } else view = <Play key={game.state.caseNo} game={game} onChange={() => changed(game)} onFinished={(gain) => finished(game, gain)} onQuit={toMenu} />;

  return (
    <>
      {view}
      {toast && <div className="sv-toast" role="status">{toast}</div>}
    </>
  );
}

// ───────────── Menu ─────────────

function Menu({ saved, onNew, onResume, onLab }: { saved: SurvivorGame | null; onNew: () => void; onResume: () => void; onLab: (mode: MultiMode) => void }) {
  return (
    <div className="app-shell">
      <main>
        <PageFrame title="Survivor" subtitle="Solo, Relay, Duel, Battle · laboratoire" backHref={hrefOf({ name: 'home' })} tone="lavender">
          <ToyCard tone="yellow">
            <p className="plain-text"><strong>{SURVIVOR.totalCases} cases à dessiner avant la panne d’encre.</strong></p>
            <ul className="sv-rules">
              <li>Un thème tiré au hasard. Avant chaque case, l’éditeur propose trois demandes : choisis celle que tu glisses dans ton histoire.</li>
              <li>Une seule réserve d’encre pour toute la partie : traits, Mimo, textes et décors la font fondre.</li>
              <li>Terminer la case rapporte de l’encre selon la demande : +{SURVIVOR.rewards.easy} (facile), +{SURVIVOR.rewards.medium} (intermédiaire), +{SURVIVOR.rewards.hard} (difficile).</li>
              <li>Toutes les {SURVIVOR.upgradeEvery} cases, une amélioration à choisir parmi {SURVIVOR.offerSize}.</li>
            </ul>
            <div className="row-buttons">
              <ToyButton variant="primary" icon="play" onClick={onNew}>Nouvelle partie</ToyButton>
              {saved && (
                <ToyButton variant="soft" icon="pages" onClick={onResume}>
                  Reprendre ({saved.state.phase === 'finished' ? 'terminée' : `case ${saved.state.caseNo}`})
                </ToyButton>
              )}
            </div>
            <p className="hint">Tout reste sur cet appareil. Le dessin de la case en cours n’est pas sauvegardé : seules les cases terminées le sont.</p>
          </ToyCard>
          <ToyCard tone="lavender" title="Multijoueur · expérimental">
            <p className="hint">Parties asynchrones sur le serveur (connexion nécessaire). Le dessin multijoueur n’est pas encore disponible.</p>
            <div className="sv-modes">
              {(['relay', 'duel', 'battle'] as const).map((m) => (
                <ToyButton key={m} variant="soft" onClick={() => onLab(m)}>
                  {MODE_LABELS[m]} · {MODE_BLURBS[m]}
                </ToyButton>
              ))}
            </div>
          </ToyCard>
        </PageFrame>
      </main>
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

function InkGauge({ left, capacity, pending }: { left: number; capacity: number; pending: number }) {
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / capacity) * 100))}%`;
  const ghost = Math.min(pending, Math.max(0, left));
  return (
    <div className="sv-gauge" role="meter" aria-label="Encre restante" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={Math.max(0, Math.round(left))}>
      <div className="sv-gauge__fill" style={{ width: pct(left - ghost) }} />
      {ghost > 0 && <div className="sv-gauge__ghost" style={{ width: pct(ghost) }} />}
      <span className="sv-gauge__text">Encre {Math.max(0, Math.ceil(left))} / {capacity}{pending > 0 ? ` · −${Math.ceil(pending)}` : ''}</span>
    </div>
  );
}

// ───────────── Une case ─────────────

function Play({ game, onChange, onFinished, onQuit }: { game: SurvivorGame; onChange: () => void; onFinished: (gain: CaseGain) => void; onQuit: () => void }) {
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

  // Défaite: plus d'encre, plus d'action gratuite ni de secours, et une case encore trop vide pour être terminée.
  useEffect(() => {
    if (game.isStuck(session.inkLeft, session.freeMimoLeft, session.project.pixels)) {
      game.lose();
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
      leading={<ToyButton className="ed-collapse" variant="soft" size="s" icon="back" onClick={onQuit} aria-label="Retour au menu (la partie est conservée)">Menu</ToyButton>}
      trailing={(settle) => (
        <ToyButton variant="primary" size="s" icon="check" onClick={() => finish(settle)}>Terminer la case</ToyButton>
      )}
      brief={
        <div className="sv-brief">
          <div className="sv-brief__top">
            <strong>Case {s.caseNo}/{SURVIVOR.totalCases}</strong>
            <span>{game.phaseLabel} · {s.theme}</span>
          </div>
          {asked && (
            <div className="sv-ask">
              <p className="sv-constraint"><span className="sv-dice" aria-label={`Dés ${asked.id}`}>{diceOf(asked.id)}</span> {asked.text}</p>
              <span className="sv-reward" title="Encre gagnée en terminant la case">+{game.rewardOf(asked.id)}</span>
            </div>
          )}
          <InkGauge left={session.inkLeft} capacity={game.capacity} pending={session.pendingCost} />
          <div className="sv-brief__tools">
            <ToyButton variant="soft" size="s" icon="eye" onClick={() => setReviewOpen(true)} disabled={game.cases.length === 0}>Cases</ToyButton>
            {s.emergency > 0 && session.inkLeft < 10 && (
              <ToyButton variant="danger" size="s" icon="alert" onClick={emergency}>Dernier souffle +{SURVIVOR.upgrades.dernierSouffle}</ToyButton>
            )}
            {session.inkLeft < SURVIVOR.ink.minPlayable && <span className="sv-empty">Plus d’encre !</span>}
          </div>
          {notice && <p className="sv-notice" role="status">{notice}</p>}
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

function ChooseView({ game, onPick, onJoker, onMenu }: { game: SurvivorGame; onPick: (id: string) => void; onJoker: () => void; onMenu: () => void }) {
  const s = game.state;
  return (
    <div className="app-shell">
      <main>
        <PageFrame title={`Case ${s.caseNo}/${SURVIVOR.totalCases}`} subtitle={`${game.phaseLabel} · ${s.theme}`} tone="lavender" right={<span />}>
          <div className="sv-choose-gauge">
            <InkGauge left={s.reserve} capacity={game.capacity} pending={0} />
          </div>
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
            <ToyButton variant="ghost" icon="back" onClick={onMenu}>Menu</ToyButton>
          </div>
        </PageFrame>
      </main>
    </div>
  );
}

// ───────────── Choix d'une amélioration ─────────────

function UpgradeView({ game, onPick }: { game: SurvivorGame; onPick: (id: string) => void }) {
  const s = game.state;
  return (
    <div className="app-shell">
      <main>
        <PageFrame title="Une amélioration !" subtitle={`Après la case ${s.caseNo} · encre ${Math.ceil(s.reserve)} / ${game.capacity}`} tone="yellow" right={<span />}>
          <div className="sv-offer">
            {s.offer.map((id) => {
              const def = upgradeById(id)!;
              const owned = s.upgrades[id] ?? 0;
              return (
                <ToyCard key={id} tone="lavender">
                  <div className="sv-upgrade">
                    <PixelIcon name={def.icon} size={36} />
                    <div>
                      <p className="plain-text"><strong>{def.name}</strong>{owned > 0 && <span className="hint"> · déjà ×{owned}</span>}</p>
                      <p className="hint">{def.text}</p>
                    </div>
                  </div>
                  <ToyButton variant="primary" icon="check" onClick={() => onPick(id)}>Prendre</ToyButton>
                </ToyCard>
              );
            })}
          </div>
        </PageFrame>
      </main>
    </div>
  );
}

// ───────────── Fin de partie ─────────────

function End({ game, onRestart, onMenu }: { game: SurvivorGame; onRestart: () => void; onMenu: () => void }) {
  const s = game.state;
  const won = s.outcome === 'victory';
  const [error, setError] = useState<string | null>(null);
  const chosen = game.chosenByLevel;
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
              <li><strong>{Math.round(s.totalSpent)}</strong> d’encre consommée au total</li>
              <li>Améliorations : {owned.length ? owned.map((u) => `${u.name}${(s.upgrades[u.id] ?? 0) > 1 ? ` ×${s.upgrades[u.id]}` : ''}`).join(', ') : 'aucune'}</li>
            </ul>
          </ToyCard>
          <div className="row-buttons">
            <ToyButton variant="primary" icon="download" onClick={() => exportSurvivorPng(game.cases, title).catch((e) => setError(e instanceof Error ? e.message : 'Export impossible'))}>Exporter en PNG</ToyButton>
            <ToyButton variant="soft" icon="rotate" onClick={onRestart}>Recommencer</ToyButton>
            <ToyButton variant="ghost" icon="back" onClick={onMenu}>Menu</ToyButton>
          </div>
          {error && <p className="hint" role="alert">{error}</p>}
        </PageFrame>
      </main>
    </div>
  );
}
