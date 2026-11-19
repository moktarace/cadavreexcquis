import { describe, expect, it } from 'vitest';
import { expiryNotice, expiryPhase, formatExpiryDate, gameWindow } from './expiry';

const iso = (ms: number) => new Date(ms).toISOString();

describe('fenêtre de vie d’un thème', () => {
  it('suit l’exemple: thème A le 16 novembre 2026, thème B le 23, suppression de A le 30', () => {
    const a = gameWindow(2026, 47);
    expect(iso(a.startMs)).toBe('2026-11-15T23:00:00.000Z');
    expect(iso(a.secondWeekMs)).toBe('2026-11-22T23:00:00.000Z');
    expect(iso(a.expiresMs)).toBe('2026-11-29T23:00:00.000Z');
  });

  it('reste exacte autour des changements d’heure (jamais 14 × 24 h)', () => {
    expect(iso(gameWindow(2026, 42).expiresMs)).toBe('2026-10-25T23:00:00.000Z');
    expect(iso(gameWindow(2026, 43).expiresMs)).toBe('2026-11-01T23:00:00.000Z');
    expect(iso(gameWindow(2027, 11).expiresMs)).toBe('2027-03-28T22:00:00.000Z');
    expect(iso(gameWindow(2027, 12).expiresMs)).toBe('2027-04-04T22:00:00.000Z');
  });

  it('gère la semaine 53 et le changement d’année', () => {
    expect(iso(gameWindow(2026, 53).startMs)).toBe('2026-12-27T23:00:00.000Z');
    expect(iso(gameWindow(2026, 53).expiresMs)).toBe('2027-01-10T23:00:00.000Z');
    expect(iso(gameWindow(2027, 1).startMs)).toBe('2027-01-03T23:00:00.000Z');
  });
});

describe('phases', () => {
  const w = gameWindow(2026, 47);
  it('actif la première semaine, ancien thème la deuxième, expiré au deuxième lundi 00:00', () => {
    expect(expiryPhase(w.startMs - 1, w)).toBe('upcoming');
    expect(expiryPhase(w.startMs, w)).toBe('current');
    expect(expiryPhase(w.secondWeekMs - 1, w)).toBe('current');
    expect(expiryPhase(w.secondWeekMs, w)).toBe('previous');
    expect(expiryPhase(w.expiresMs - 1, w)).toBe('previous');
    expect(expiryPhase(w.expiresMs, w)).toBe('expired');
  });

  it('une continuation du dimanche de la deuxième semaine expire avec le thème, pas plus tard', () => {
    const sundayEvening = Date.UTC(2026, 10, 29, 20, 0);
    expect(expiryPhase(sundayEvening, w)).toBe('previous');
    expect(w.expiresMs - sundayEvening).toBe(3 * 3600_000);
  });
});

describe('affichage', () => {
  it('annonce le lundi de suppression, en français', () => {
    const { expiresMs } = gameWindow(2026, 47);
    expect(formatExpiryDate(expiresMs)).toBe('lundi 30 novembre');
    expect(expiryNotice(expiresMs)).toBe('Les dessins de ce thème disparaîtront le lundi 30 novembre.');
  });
});
