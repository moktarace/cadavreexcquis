import { supabase } from '../../backend/client';
import { fetchWallet } from '../arbiter/api';
import type { Wallet } from '../arbiter/types';
import type { ShopItem } from '../game';
import { rpc } from '../multi/api';
import type { MpState } from '../multi/types';

export type ShopScope = 'solo' | 'game';

/** Catalogue du serveur (`survivor_shop_rules`): prix, effets, modes et limites; l'interface n'en garde aucune copie. */
export interface ShopRules {
  items: Record<ShopItem, { price: number; effect?: number; min_missing?: number; modes: string[] }>;
  modes: Record<string, { max_purchases: number }>;
  per_type_per_game: number;
}

export interface ShopInfo {
  rules: ShopRules;
  mode: string;
  allowed: boolean;
  balance: number;
  purchased: ShopItem[];
  remaining: number;
}

export interface Receipt {
  purchase: string;
  item: ShopItem;
  scope: ShopScope;
  game: string;
  price: number;
  effect: number | null;
  replay: boolean;
  balance: number;
  /** État confirmé de la partie (Relay) après l'achat. */
  state: MpState | null;
}

export const fetchShop = (scope: ShopScope, game: string) => rpc<ShopInfo>('survivor_shop', { p_scope: scope, p_game: game });

/** Le client ne donne qu'un identifiant d'achat: réutilisé après un échec réseau, il ne débite ni n'applique deux fois. */
export const buyItem = (scope: ShopScope, game: string, item: ShopItem, purchase: string) =>
  rpc<Receipt>('survivor_buy', { p_scope: scope, p_game: game, p_item: item, p_purchase: purchase });

/** Reçu d'un achat dont la réponse s'est perdue, ou nul si le serveur ne l'a jamais reçu. */
export const checkPurchase = (scope: ShopScope, game: string, purchase: string) =>
  rpc<Receipt | null>('survivor_buy_check', { p_scope: scope, p_game: game, p_purchase: purchase });

/** Vrai seulement si le joueur a déjà une session: le Solo n'ouvre jamais de compte de lui-même. */
export async function hasSession(): Promise<boolean> {
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  return !!data.session;
}

export async function walletIfSession(): Promise<Wallet | null> {
  return (await hasSession()) ? fetchWallet() : null;
}
