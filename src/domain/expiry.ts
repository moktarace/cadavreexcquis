/**
 * Durée de vie d'un thème: actif la semaine de son lundi, encore jouable la semaine suivante, supprimé le
 * lundi d'après à 00:00 (Europe/Paris). Même calcul, en dates civiles, que `game_window` côté serveur.
 */
import { REFERENCE_TIME_ZONE, addDays, weekdayOf, zonedMidnightMs } from './calendar';

export interface GameWindow {
  /** Lundi 00:00 de la semaine du thème. */
  startMs: number;
  /** Lundi 00:00 suivant: le thème devient « ancien thème ». */
  secondWeekMs: number;
  /** Deuxième lundi 00:00: suppression de toutes ses contributions. */
  expiresMs: number;
}

export function gameWindow(isoYear: number, isoWeek: number, timeZone: string = REFERENCE_TIME_ZONE): GameWindow {
  const jan4 = { y: isoYear, m: 1, d: 4 };
  const mondayOfWeek1 = addDays(jan4, -(weekdayOf(jan4) - 1));
  const monday = addDays(mondayOfWeek1, (isoWeek - 1) * 7);
  return {
    startMs: zonedMidnightMs(monday, timeZone),
    secondWeekMs: zonedMidnightMs(addDays(monday, 7), timeZone),
    expiresMs: zonedMidnightMs(addDays(monday, 14), timeZone),
  };
}

export type ExpiryPhase = 'upcoming' | 'current' | 'previous' | 'expired';

export function expiryPhase(nowMs: number, w: GameWindow): ExpiryPhase {
  if (nowMs < w.startMs) return 'upcoming';
  if (nowMs < w.secondWeekMs) return 'current';
  if (nowMs < w.expiresMs) return 'previous';
  return 'expired';
}

/** « lundi 30 novembre » */
export function formatExpiryDate(ms: number, timeZone: string = REFERENCE_TIME_ZONE): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(ms);
}

/** Phrase discrète affichée près d'un thème. */
export function expiryNotice(expiresMs: number): string {
  return `Les dessins de ce thème disparaîtront le ${formatExpiryDate(expiresMs)}.`;
}
