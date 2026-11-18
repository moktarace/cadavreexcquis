/**
 * Calendrier de jeu: le jeu est ouvert 7 jours sur 7, seul le thème change chaque lundi 00:00.
 * Aucune durée fixe en millisecondes n'est utilisée en mode réel :
 * on travaille sur des dates civiles du fuseau de référence, donc DST et fuseaux sont corrects.
 */

export const REFERENCE_TIME_ZONE = 'Europe/Paris';

export interface AcceleratedClock {
  /** Instant réel (ms epoch) correspondant au début du jour virtuel 0. */
  startMs: number;
  /** Durée réelle d'un jour virtuel, en ms. */
  dayMs: number;
  /** Lundi (YYYY-MM-DD) qui sert de jour virtuel 0. */
  anchorMonday: string;
}

export interface CalendarConfig {
  timeZone: string;
  accelerated?: AcceleratedClock;
}

export const DEFAULT_CALENDAR: CalendarConfig = { timeZone: REFERENCE_TIME_ZONE };

export interface GameMoment {
  isoYear: number;
  isoWeek: number;
  /** 1 = lundi … 7 = dimanche. */
  weekday: number;
  /** Date civile du jour de jeu (YYYY-MM-DD). */
  dayKey: string;
  /** Instant (ms epoch) du prochain lundi 00:00: changement de thème, pas une échéance de publication. */
  nextThemeAtMs: number;
}

interface Civil {
  y: number;
  m: number;
  d: number;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const formatCivil = ({ y, m, d }: Civil) => `${y}-${pad2(m)}-${pad2(d)}`;

export function parseCivil(s: string): Civil {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) throw new Error(`Date civile invalide : ${s}`);
  return { y: +match[1], m: +match[2], d: +match[3] };
}

export function addDays({ y, m, d }: Civil, n: number): Civil {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 1 = lundi … 7 = dimanche. */
export function weekdayOf({ y, m, d }: Civil): number {
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

export function isoWeekOf({ y, m, d }: Civil): { isoYear: number; isoWeek: number } {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dow + 3); // jeudi de la semaine
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const isoWeek = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { isoYear, isoWeek };
}

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

export function civilDateInZone(ms: number, timeZone: string): Civil {
  const { y, m, d } = zonedParts(ms, timeZone);
  return { y, m, d };
}

function offsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Instant UTC de 00:00 local pour une date civile. */
export function zonedMidnightMs({ y, m, d }: Civil, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(guess, timeZone);
  return guess - offsetMs(first, timeZone);
}

export function getGameMoment(nowMs: number, config: CalendarConfig = DEFAULT_CALENDAR): GameMoment {
  let civil: Civil;
  let virtualDay = 0;
  if (config.accelerated) {
    const { startMs, dayMs, anchorMonday } = config.accelerated;
    virtualDay = Math.max(0, Math.floor((nowMs - startMs) / dayMs));
    civil = addDays(parseCivil(anchorMonday), virtualDay);
  } else {
    civil = civilDateInZone(nowMs, config.timeZone);
  }

  const weekday = weekdayOf(civil);
  const daysUntilMonday = 8 - weekday;

  const nextThemeAtMs = config.accelerated
    ? config.accelerated.startMs + (virtualDay + daysUntilMonday) * config.accelerated.dayMs
    : zonedMidnightMs(addDays(civil, daysUntilMonday), config.timeZone);

  return { ...isoWeekOf(civil), weekday, dayKey: formatCivil(civil), nextThemeAtMs };
}

/** Lundi (YYYY-MM-DD) de la semaine ISO contenant l'instant donné. */
export function mondayOf(nowMs: number, timeZone: string = REFERENCE_TIME_ZONE): string {
  const civil = civilDateInZone(nowMs, timeZone);
  return formatCivil(addDays(civil, 1 - weekdayOf(civil)));
}
