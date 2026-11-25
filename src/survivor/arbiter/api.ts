import { ApiError, ensureSession } from '../../backend/api';
import { previewPng } from '../../editor/export';
import { rpc, uploadPngAt } from '../multi/api';
import type { ArbResult, Arbitration, FlagCategory, Hub, NarrativeResult, Vote, Wallet } from './types';

export const fetchHub = () => rpc<Hub>('survivor_hub');
export const fetchWallet = () => rpc<Wallet>('survivor_wallet');
export const arbitrateNext = () => rpc<ArbResult>('survivor_arbitrate_next');
export const currentArbitration = () => rpc<Arbitration | null>('survivor_arbitration_current');
export const castVote = (arb: string, caseId: string, vote: Vote | null) => rpc<Arbitration>('survivor_vote', { p_arb: arb, p_case: caseId, p_vote: vote });
export const finishArbitration = (arb: string) => rpc<ArbResult>('survivor_arbitration_finish', { p_arb: arb });
export const abandonArbitration = (arb: string) => rpc<{ outcome: string }>('survivor_arbitration_abandon', { p_arb: arb });
export const flagArbitration = (arb: string, slot: number, category: FlagCategory) =>
  rpc<{ outcome: string }>('survivor_arbitration_flag', { p_arb: arb, p_slot: slot, p_category: category });
export const submitGameBd = (game: string) => rpc<{ outcome: string; bds: string[] }>('survivor_submit_game_bd', { p_game: game });
export const answerConsent = (bd: string, accept: boolean) => rpc<{ outcome: string; status: string }>('survivor_consent', { p_bd: bd, p_accept: accept });
export const duelVerdict = (game: string) => rpc<NarrativeResult>('survivor_duel_verdict', { p_game: game });

/** Ce qu'un envoi Solo interrompu a déjà fait: une relance reprend là où elle s'est arrêtée au lieu de tout recommencer. */
export interface SoloUpload {
  bd: string;
  begun: boolean;
  uploaded: { position: number; constraint_id: string; image_path: string }[];
}

export const newSoloUpload = (): SoloUpload => ({ bd: crypto.randomUUID(), begun: false, uploaded: [] });

/**
 * Soumet une BD Solo aux arbitres: seules les cases terminées et leurs demandes partent, rien d'autre.
 * `claimed` (issue, réserve, améliorations) est la déclaration du joueur, conservée comme telle et jamais certifiée.
 */
export async function submitSolo(up: SoloUpload, cases: readonly Uint8Array[], constraintIds: readonly string[], theme: string, claimed: Record<string, unknown>) {
  if (cases.length < 4) throw new ApiError('TOO_SHORT', 'Il faut au moins quatre cases terminées.');
  const me = await ensureSession();
  if (!up.begun) {
    await rpc('survivor_solo_begin', { p_bd: up.bd, p_theme: theme });
    up.begun = true;
  }
  for (let i = up.uploaded.length; i < cases.length; i++) {
    const png = await previewPng({ pixels: cases[i] });
    const path = await uploadPngAt(`${me.userId}/${up.bd}/${crypto.randomUUID()}.png`, png);
    up.uploaded.push({ position: i + 1, constraint_id: constraintIds[i], image_path: path });
  }
  return rpc<{ outcome: string; bd: string; status: string }>('survivor_solo_submit', { p_bd: up.bd, p_cases: up.uploaded, p_claimed: claimed });
}
