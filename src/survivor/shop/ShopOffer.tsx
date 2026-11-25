import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelIcon, ToyButton, ToyDialog, type IconName } from '../../ui';
import type { ShopItem } from '../game';
import { fetchShop, hasSession, type ShopInfo, type ShopScope } from './api';

export const ITEMS: Record<ShopItem, { name: string; icon: IconName; effect: (r: ShopInfo['rules']['items'][ShopItem]) => string }> = {
  refill: { name: 'Recharge', icon: 'plus', effect: (r) => `+${r.effect} d’encre de dessin, avant de dessiner (jamais au-delà de la capacité)` },
  constraint_reroll: { name: 'Joker', icon: 'swap', effect: () => 'trois nouvelles demandes (tes charges de Joker ne sont pas touchées)' },
  upgrade_reroll: { name: 'Second choix', icon: 'pages', effect: () => 'trois nouvelles améliorations à la place des trois proposées (aucune amélioration en plus)' },
  emergency_refill: { name: 'Dernière chance', icon: 'alert', effect: (r) => `+${r.effect} d’encre pour la case en cours, sans perdre ton dessin` },
};

/** Prix, limites et solde du serveur pour une partie. Absent hors ligne ou sans compte: le Solo n'ouvre jamais de session. */
export function useShop(scope: ShopScope, gameId: string | undefined, { needSession = false }: { needSession?: boolean } = {}) {
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const reload = useCallback(async () => {
    if (!gameId) return;
    try {
      if (needSession && !(await hasSession())) return setInfo(null);
      setInfo(await fetchShop(scope, gameId));
    } catch {
      setInfo(null);
    }
  }, [scope, gameId, needSession]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { info, reload };
}

const message = (e: unknown) => (e instanceof Error ? e.message : 'Achat impossible.');

/**
 * Un consommable, proposé au moment où il sert, avec son prix; l'achat n'est annoncé qu'après la réponse du serveur.
 * `perform` fait l'achat avec l'identifiant fourni (conservé tant qu'il n'a pas réussi: une relance ne débite jamais deux fois).
 */
export function ShopOffer({ item, info, available, team = false, perform, onDone }: {
  item: ShopItem;
  info: ShopInfo | null;
  available: boolean;
  team?: boolean;
  perform: (purchaseId: string) => Promise<void>;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const purchaseId = useRef<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  const rule = info?.rules.items[item];
  if (!info || !rule || !info.allowed || info.remaining <= 0 || info.purchased.includes(item) || !rule.modes.includes(info.mode)) {
    return flash ? <span className="sv-flash" role="status">{flash}</span> : null;
  }
  const def = ITEMS[item];
  const poor = info.balance < rule.price;

  const confirm = async () => {
    purchaseId.current ??= crypto.randomUUID();
    setBusy(true);
    setError(null);
    try {
      await perform(purchaseId.current);
      purchaseId.current = null;
      setOpen(false);
      setFlash(`${def.name} appliqué · −${rule.price} encre bonus`);
      onDone?.();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ToyButton variant="soft" size="s" icon={def.icon} disabled={!available} onClick={() => { setError(null); setOpen(true); }} title={available ? undefined : `${def.name}: pas disponible maintenant`}>
        {def.name} · {rule.price} <PixelIcon name="star" size={12} />
      </ToyButton>
      {flash && <span className="sv-flash" role="status">{flash}</span>}
      <ToyDialog
        open={open}
        title={`${def.name} · ${rule.price} encre bonus`}
        locked={busy}
        onClose={() => setOpen(false)}
        actions={
          <>
            <ToyButton variant="soft" disabled={busy} onClick={() => setOpen(false)}>Annuler</ToyButton>
            <ToyButton variant="primary" icon="check" disabled={busy || poor} onClick={() => void confirm()}>{busy ? 'Achat…' : `Payer ${rule.price}`}</ToyButton>
          </>
        }
      >
        <p className="plain-text">Effet : {def.effect(rule)}.</p>
        <p className="plain-text"><strong>Encre bonus</strong> (ton portefeuille, pas la jauge de la partie) : {info.balance} → {poor ? info.balance : info.balance - rule.price}</p>
        {team && <p className="hint">Toute l’équipe en profite; seul ton portefeuille est débité.</p>}
        {poor && <p className="hint" role="alert">Encre bonus insuffisante. Tu peux en gagner en arbitrant des BD ou en recevant des upvotes.</p>}
        {error && <p className="sv-notice sv-notice--error" role="alert">{error}</p>}
      </ToyDialog>
    </>
  );
}

/** Le solde d'encre bonus, volontairement différent de la jauge d'encre de dessin. */
export function BonusPill({ balance }: { balance: number }) {
  return (
    <span className="sv-bonus" title="Encre bonus: ton portefeuille permanent, distinct de l’encre de dessin d’une partie">
      <PixelIcon name="star" size={16} /> Encre bonus <strong>{balance}</strong>
    </span>
  );
}

