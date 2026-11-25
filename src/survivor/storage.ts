import { constraintById } from './constraints';
import { SurvivorGame, type RunState, type RunStateV1 } from './game';

const KEY = 'cl.survivor.v1';

/** Compression par plages (valeur, longueur): une case est surtout du blanc, elle tient en quelques ko. */
export function encodeCase(pixels: Uint8Array): string {
  let out = '';
  for (let i = 0; i < pixels.length; ) {
    let n = 1;
    while (i + n < pixels.length && pixels[i + n] === pixels[i] && n < 255) n++;
    out += String.fromCharCode(pixels[i], n);
    i += n;
  }
  return btoa(out);
}

export function decodeCase(text: string, length: number): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const n = raw.charCodeAt(i + 1);
    out.fill(raw.charCodeAt(i), at, at + n);
    at += n;
  }
  return out;
}

interface Saved {
  state: RunState | RunStateV1;
  cases: string[];
}

const PIXELS = 320 * 240;

export type SaveFailure = 'quota' | 'unavailable' | 'error';
export type SaveResult = { ok: true } | { ok: false; reason: SaveFailure };

const isQuota = (e: unknown) => e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);

/**
 * Garde la partie (cases terminées, progression, demandes proposées et choisie, achats en cours), jamais le dessin en cours.
 * `setItem` est atomique: en cas d'échec, la dernière sauvegarde valide reste telle quelle. Une écriture n'est confirmée
 * qu'une fois relue à l'identique (certains navigateurs acceptent sans conserver).
 */
export function persistRun(game: SurvivorGame): SaveResult {
  let text: string;
  try {
    const saved: Saved = { state: game.state, cases: game.cases.map(encodeCase) };
    text = JSON.stringify(saved);
  } catch {
    return { ok: false, reason: 'error' };
  }
  try {
    localStorage.setItem(KEY, text);
    return localStorage.getItem(KEY) === text ? { ok: true } : { ok: false, reason: 'error' };
  } catch (e) {
    return { ok: false, reason: isQuota(e) ? 'quota' : 'unavailable' };
  }
}

export const saveRun = (game: SurvivorGame): boolean => persistRun(game).ok;

export const SAVE_MESSAGES: Record<SaveFailure, string> = {
  quota: 'Espace de stockage plein sur cet appareil: ta progression n’est pas enregistrée.',
  unavailable: 'Stockage bloqué (navigation privée ou réglages du navigateur): ta progression n’est pas enregistrée.',
  error: 'L’enregistrement a échoué: ta progression n’est pas enregistrée.',
};

/** Nouvelle partie: l'ancienne (non terminée) n'est remplacée que si la nouvelle est écrite durablement; sinon elle reste intacte. */
export function beginRun(previous: SurvivorGame | null, rng?: () => number): { started: true; game: SurvivorGame; save: SaveResult } | { started: false; reason: SaveFailure } {
  const game = SurvivorGame.start(rng);
  const save = persistRun(game);
  if (!save.ok && previous && previous.state.phase !== 'finished') return { started: false, reason: save.reason };
  return { started: true, game, save };
}

export type RunRead = { kind: 'none' } | { kind: 'ok'; game: SurvivorGame } | { kind: 'unreadable'; reason: 'unavailable' | 'corrupt' };

/** Distingue « aucune sauvegarde » d'une sauvegarde illisible: celle-ci ne doit jamais être prise pour une absence puis écrasée en silence. */
export function readRun(rng?: () => number): RunRead {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { kind: 'unreadable', reason: 'unavailable' };
  }
  if (!raw) return { kind: 'none' };
  try {
    const saved = JSON.parse(raw) as Saved;
    const old = saved.state.version === 1;
    const game = old ? SurvivorGame.fromV1(saved.state as RunStateV1, rng) : new SurvivorGame(saved.state as RunState, rng);
    if (!old && saved.state.version !== 2) return { kind: 'unreadable', reason: 'corrupt' };
    const s = game.state;
    if (s.phase === 'choosing' && !s.proposals.every(constraintById)) return { kind: 'unreadable', reason: 'corrupt' };
    // Anciennes sauvegardes: identifiant de partie et état des achats ajoutés sans rien perdre.
    const upgraded = !s.gameId || !s.shop;
    void game.gameId;
    void game.shop;
    game.cases = saved.cases.map((c) => decodeCase(c, PIXELS));
    if (old || upgraded) saveRun(game);
    return { kind: 'ok', game };
  } catch {
    return { kind: 'unreadable', reason: 'corrupt' };
  }
}

/** Dernière partie enregistrée; une partie de l'ancien format est migrée (cases conservées) puis réécrite. */
export function loadRun(rng?: () => number): SurvivorGame | null {
  const r = readRun(rng);
  return r.kind === 'ok' ? r.game : null;
}

export function clearRun(): boolean {
  try {
    localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
