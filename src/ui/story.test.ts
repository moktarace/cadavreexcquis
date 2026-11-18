import { describe, expect, it } from 'vitest';
import { formatDelay } from './Story';

describe('formatDelay', () => {
  it('écrit jours, heures et minutes', () => {
    expect(formatDelay(((6 * 24 + 12) * 60 + 35) * 60000)).toBe('6 j 12 h 35 min');
  });
  it('omet les jours puis les heures quand elles sont nulles', () => {
    expect(formatDelay((5 * 60 + 7) * 60000)).toBe('5 h 07 min');
    expect(formatDelay(42 * 60000)).toBe('42 min');
  });
  it('ne descend jamais sous zéro', () => {
    expect(formatDelay(-5000)).toBe('0 min');
  });
});
