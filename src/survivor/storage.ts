import { constraintById } from './constraints';
import { SurvivorGame, type RunState } from './game';

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
  state: RunState;
  cases: string[];
}

const PIXELS = 320 * 240;

/** Garde la partie (cases terminées et progression), jamais le dessin en cours. Faux si le stockage refuse. */
export function saveRun(game: SurvivorGame): boolean {
  try {
    const saved: Saved = { state: game.state, cases: game.cases.map(encodeCase) };
    localStorage.setItem(KEY, JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}

export function loadRun(rng?: () => number): SurvivorGame | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Saved;
    if (saved.state?.version !== 1) return null;
    if (saved.state.constraintIds.some((id) => !constraintById(id))) return null;
    const game = new SurvivorGame(saved.state, rng);
    game.cases = saved.cases.map((c) => decodeCase(c, PIXELS));
    return game;
  } catch {
    return null;
  }
}

export function clearRun() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // rien à effacer
  }
}
