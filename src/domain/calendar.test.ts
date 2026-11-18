import { describe, expect, it } from 'vitest';
import { addDays, getGameMoment, isoWeekOf, mondayOf, parseCivil, type CalendarConfig } from './calendar';

const iso = (ms: number) => new Date(ms).toISOString();

describe('semaine ISO', () => {
  it('gère les semaines limites', () => {
    expect(isoWeekOf({ y: 2026, m: 1, d: 1 })).toEqual({ isoYear: 2026, isoWeek: 1 });
    expect(isoWeekOf({ y: 2020, m: 12, d: 31 })).toEqual({ isoYear: 2020, isoWeek: 53 });
    expect(isoWeekOf({ y: 2027, m: 1, d: 1 })).toEqual({ isoYear: 2026, isoWeek: 53 });
    expect(isoWeekOf({ y: 2026, m: 12, d: 28 })).toEqual({ isoYear: 2026, isoWeek: 53 });
    expect(isoWeekOf({ y: 2026, m: 11, d: 16 })).toEqual({ isoYear: 2026, isoWeek: 47 });
  });
});

describe('changement de thème (Europe/Paris)', () => {
  it('garde la même semaine du lundi au dimanche', () => {
    const weeks = [16, 17, 18, 19, 20, 21, 22].map((d) => getGameMoment(Date.UTC(2026, 10, d, 11)).isoWeek);
    expect(new Set(weeks)).toEqual(new Set([47]));
  });

  it('change de semaine le lundi à 00:00 heure de Paris (hiver)', () => {
    const sunday = getGameMoment(Date.UTC(2026, 10, 22, 22, 59, 59));
    const monday = getGameMoment(Date.UTC(2026, 10, 22, 23, 0, 0));
    expect(sunday.isoWeek).toBe(47);
    expect(monday.isoWeek).toBe(48);
    expect(monday.weekday).toBe(1);
  });

  it('change de semaine le lundi à 00:00 heure de Paris (été)', () => {
    const sunday = getGameMoment(Date.UTC(2026, 6, 5, 21, 59, 59));
    const monday = getGameMoment(Date.UTC(2026, 6, 5, 22, 0, 0));
    expect(sunday.isoWeek).toBe(27);
    expect(monday.isoWeek).toBe(28);
  });

  it('expose le prochain changement de thème sans durée fixe (passage à l’heure d’été)', () => {
    // Samedi 28 mars 2026 12:00 Paris; lundi 30 mars 00:00 CEST = 29 mars 22:00Z
    const m = getGameMoment(Date.UTC(2026, 2, 28, 11));
    expect(iso(m.nextThemeAtMs)).toBe('2026-03-29T22:00:00.000Z');
  });

  it('expose le prochain changement de thème (passage à l’heure d’hiver)', () => {
    // Samedi 24 oct. 2026 12:00 Paris; lundi 26 oct. 00:00 CET = 25 oct. 23:00Z
    const m = getGameMoment(Date.UTC(2026, 9, 24, 10));
    expect(iso(m.nextThemeAtMs)).toBe('2026-10-25T23:00:00.000Z');
  });

  it('un lundi, le prochain thème est dans une semaine', () => {
    const m = getGameMoment(Date.UTC(2026, 10, 16, 11));
    expect(iso(m.nextThemeAtMs)).toBe('2026-11-22T23:00:00.000Z');
  });

  it('retourne le lundi de la semaine', () => {
    expect(mondayOf(Date.UTC(2026, 10, 18, 10))).toBe('2026-11-16');
  });
});

describe('calendrier accéléré', () => {
  const start = 1_000_000;
  const config: CalendarConfig = {
    timeZone: 'Europe/Paris',
    accelerated: { startMs: start, dayMs: 60_000, anchorMonday: '2026-11-16' },
  };

  it('simule une semaine en sept minutes sans toucher à l’horloge système', () => {
    expect(getGameMoment(start + 1, config).weekday).toBe(1);
    expect(getGameMoment(start + 6 * 60_000 + 1, config).weekday).toBe(7);
    expect(getGameMoment(start + 6 * 60_000 + 1, config).isoWeek).toBe(47);
  });

  it('enchaîne sur la semaine suivante', () => {
    const m = getGameMoment(start + 7 * 60_000, config);
    expect(m.isoWeek).toBe(48);
    expect(m.weekday).toBe(1);
  });

  it('expose le prochain changement de thème', () => {
    expect(getGameMoment(start + 5, config).nextThemeAtMs).toBe(start + 7 * 60_000);
    expect(getGameMoment(start + 6 * 60_000, config).nextThemeAtMs).toBe(start + 7 * 60_000);
  });
});

describe('dates civiles', () => {
  it('ajoute des jours à travers les fins de mois et d’année', () => {
    expect(addDays(parseCivil('2026-12-31'), 1)).toEqual({ y: 2027, m: 1, d: 1 });
    expect(addDays(parseCivil('2028-02-28'), 1)).toEqual({ y: 2028, m: 2, d: 29 });
  });
});
