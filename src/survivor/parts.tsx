import { PixelIcon, ToyButton, ToyCard } from '../ui';
import { diceOf, type Constraint } from './constraints';
import { upgradeById } from './upgrades';

/** Jauge d'encre commune au Solo et au multijoueur; `pending` = coût de l'objet en attente de placement. */
export function InkGauge({ left, capacity, pending = 0, label = 'Encre', rival = false }: { left: number; capacity: number; pending?: number; label?: string; rival?: boolean }) {
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / capacity) * 100))}%`;
  const ghost = Math.min(pending, Math.max(0, left));
  return (
    <div className={rival ? 'sv-gauge sv-gauge--rival' : 'sv-gauge'} role="meter" aria-label={`${label} restante`} aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={Math.max(0, Math.round(left))}>
      <div className="sv-gauge__fill" style={{ width: pct(left - ghost) }} />
      {ghost > 0 && <div className="sv-gauge__ghost" style={{ width: pct(ghost) }} />}
      <span className="sv-gauge__text">{label} {Math.max(0, Math.ceil(left))} / {capacity}{pending > 0 ? ` · −${Math.ceil(pending)}` : ''}</span>
    </div>
  );
}

/** Les trois améliorations proposées (Solo et multijoueur). */
export function UpgradeChoice({ offer, owned, onPick, busy = false }: { offer: readonly string[]; owned: Readonly<Record<string, number>>; onPick: (id: string) => void; busy?: boolean }) {
  return (
    <div className="sv-offer">
      {offer.map((id) => {
        const def = upgradeById(id);
        if (!def) return null;
        const n = owned[id] ?? 0;
        return (
          <ToyCard key={id} tone="lavender">
            <div className="sv-upgrade">
              <PixelIcon name={def.icon} size={36} />
              <div>
                <p className="plain-text"><strong>{def.name}</strong>{n > 0 && <span className="hint"> · déjà ×{n}</span>}</p>
                <p className="hint">{def.text}</p>
              </div>
            </div>
            <ToyButton variant="primary" icon="check" onClick={() => onPick(id)} disabled={busy}>Prendre</ToyButton>
          </ToyCard>
        );
      })}
    </div>
  );
}

/** Repère de la case, identique dans les quatre modes: « Thème » (toute la BD), progression, puis « Ta contrainte » (cette case). */
export function CaseBrief({ theme, phase, caseNo, total, modeLabel, asked, reward }: { theme: string; phase: string; caseNo: number; total: number; modeLabel?: string; asked?: Constraint; reward: number }) {
  return (
    <>
      <div className="sv-theme">
        <span className="sv-tag">Thème</span>
        <strong className="sv-theme__text">{theme}</strong>
      </div>
      <div className="sv-prog" role="progressbar" aria-label="Progression de l’histoire" aria-valuemin={1} aria-valuemax={total} aria-valuenow={caseNo} aria-valuetext={`Case ${caseNo} sur ${total}, ${phase}`}>
        <span className="sv-prog__label">{modeLabel ? `${modeLabel} · ` : ''}Case {caseNo}/{total} · {phase}</span>
        <span className="sv-prog__bar"><i style={{ width: `${(caseNo / total) * 100}%` }} /></span>
      </div>
      {asked && (
        <div className="sv-ask">
          <span className="sv-tag sv-tag--ask">Ta contrainte</span>
          <p className="sv-constraint"><span className="sv-dice" aria-label={`Dés ${asked.id}`}>{diceOf(asked.id)}</span> {asked.text}</p>
          <span className="sv-reward" title="Encre gagnée en terminant la case">+{reward}</span>
        </div>
      )}
    </>
  );
}

/** Le thème de la BD au-dessus d'un choix (écrans sans éditeur). */
export function ThemeLine({ theme }: { theme: string }) {
  return (
    <p className="sv-themeline">
      <span className="sv-tag sv-tag--light">Thème</span> <strong>{theme}</strong>
    </p>
  );
}
