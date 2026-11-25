import { ApiError } from '../../backend/api';
import type { PurchaseReceipt, ShopItem, SurvivorGame } from '../game';

export const SAVE_BEFORE_BUY = 'Achat impossible: ta partie ne peut pas être enregistrée sur cet appareil (espace plein ou stockage bloqué). Rien n’a été débité.';

export interface SoloPurchaseDeps {
  /** Écrit la partie et dit si l'écriture est confirmée. */
  persist: (g: SurvivorGame) => boolean;
  buy: (item: ShopItem, purchaseId: string) => Promise<{ purchase: string; effect: number | null }>;
}

/**
 * Achat Solo: l'identifiant d'achat en cours est écrit AVANT tout débit (sinon un reçu perdu ne pourrait pas être retrouvé),
 * le reçu est appliqué au plus une fois, et un refus définitif libère l'attente. Une erreur réseau garde l'achat « en cours »
 * pour que `survivor_buy_check` le retrouve au prochain chargement.
 */
export async function soloPurchase(g: SurvivorGame, item: ShopItem, id: string, d: SoloPurchaseDeps): Promise<void> {
  g.beginPurchase(id, item);
  if (!d.persist(g)) {
    g.clearPending();
    throw new ApiError('SAVE', SAVE_BEFORE_BUY);
  }
  try {
    const r = await d.buy(item, id);
    const receipt: PurchaseReceipt = { purchase: r.purchase, item, effect: r.effect };
    g.applyPurchase(receipt);
    d.persist(g);
  } catch (e) {
    if (e instanceof ApiError && e.code !== 'SERVER') {
      g.clearPending();
      d.persist(g);
    }
    throw e;
  }
}
