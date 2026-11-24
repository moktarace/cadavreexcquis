import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { hrefOf } from '../app/router';
import { HEIGHT, WIDTH } from '../editor/palette';
import { indexedToRgba } from '../editor/render';
import { EditorSession } from '../editor/session';
import { EditorWorkspace } from '../editor/ui/EditorWorkspace';
import { PageFrame } from '../pages/shared';
import { PixelIcon, ToyButton, ToyCard, ToyDialog } from '../ui';
import { SURVIVOR } from './config';
import { constraintById, diceOf } from './constraints';
import { exportSurvivorPng } from './exportSheet';
import { SurvivorGame } from './game';
import { clearRun, loadRun, saveRun } from './storage';
import { UPGRADES, upgradeById } from './upgrades';
import './survivor.css';

/** Mode expérimental (#/lab/survivor): une BD de 16 cases à finir avant d'être à court d'encre. Hors ligne, sans compte. */
export default function SurvivorPage() {
  const [game, setGame] = useState<SurvivorGame | null>(null);
  const [saved] = useState(() => loadRun());
  const [, bump] = useReducer((n: number) => n + 1, 0);

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

  if (!game) return <Menu saved={saved} onNew={start} onResume={() => saved && setGame(saved)} />;
  const phase = game.state.phase;
  if (phase === 'finished') return <End game={game} onRestart={start} onMenu={() => setGame(null)} />;
  if (phase === 'upgrade') return <UpgradeView game={game} onPick={(id) => game.chooseUpgrade(id) && changed(game)} />;
  return <Play key={game.state.caseNo} game={game} onChange={() => changed(game)} onQuit={() => setGame(null)} />;
}

// ───────────── Menu ─────────────

function Menu({ saved, onNew, onResume }: { saved: SurvivorGame | null; onNew: () => void; onResume: () => void }) {
  return (
    <div className="app-shell">
      <main>
        <PageFrame title="Survivor" subtitle="Laboratoire · expérimental" backHref={hrefOf({ name: 'home' })} tone="lavender">
          <ToyCard tone="yellow">
            <p className="plain-text"><strong>{SURVIVOR.totalCases} cases à dessiner avant la panne d’encre.</strong></p>
            <ul className="sv-rules">
              <li>Un thème tiré au hasard, une contrainte par case.</li>
              <li>Une seule réserve d’encre pour toute la partie : traits, Mimo, textes et décors la font fondre.</li>
              <li>Après chaque case, dis si tu as respecté la contrainte : +{SURVIVOR.rewards.respected} d’encre si oui, +{SURVIVOR.rewards.notRespected} sinon.</li>
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

function Play({ game, onChange, onQuit }: { game: SurvivorGame; onChange: () => void; onQuit: () => void }) {
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
  const validating = s.phase === 'validating';

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
    game.finishCase(pixels, session.project.ink?.spent ?? 0);
    onChange();
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
          <p className="sv-constraint"><span className="sv-dice" aria-label={`Dés ${game.constraint.id}`}>{diceOf(game.constraint.id)}</span> {game.constraint.text}</p>
          <InkGauge left={session.inkLeft} capacity={game.capacity} pending={session.pendingCost} />
          <div className="sv-brief__tools">
            <ToyButton variant="soft" size="s" icon="eye" onClick={() => setReviewOpen(true)} disabled={game.cases.length === 0}>Cases</ToyButton>
            {s.jokers > 0 && (
              <ToyButton variant="soft" size="s" icon="swap" onClick={() => game.replaceConstraint() && onChange()}>Joker ×{s.jokers}</ToyButton>
            )}
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
              <span><strong>{i + 1}</strong> {s.results[i] ? '✓' : '✗'} {constraintById(s.constraintIds[i])?.text}</span>
            </li>
          ))}
        </ul>
      </ToyDialog>
      <ToyDialog
        open={validating}
        title="Contrainte respectée ?"
        locked
        onClose={() => {}}
        actions={
          <>
            <ToyButton variant="soft" onClick={() => { game.validate(false); onChange(); }}>Non · +{game.rewardFor(false)}</ToyButton>
            <ToyButton variant="success" icon="check" onClick={() => { game.validate(true); onChange(); }}>Oui · +{game.rewardFor(true)}</ToyButton>
          </>
        }
      >
        <p className="plain-text"><strong>{game.constraint.text}</strong></p>
        <p className="hint">À toi de juger : le jeu te fait confiance. Respecter la contrainte rend plus d’encre.</p>
      </ToyDialog>
    </EditorWorkspace>
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
              <li><strong>{game.respectedCount}</strong> contrainte{game.respectedCount > 1 ? 's' : ''} respectée{game.respectedCount > 1 ? 's' : ''}</li>
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
