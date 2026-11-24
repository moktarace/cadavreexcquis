import type { EditorSession } from '../session';

/** « Placer », avec le coût en encre quand une réserve est en jeu. */
export function placeLabel(s: EditorSession): string {
  if (!s.ink) return 'Placer';
  const cost = s.pendingCost;
  return cost > 0 ? `Placer (−${Math.ceil(cost)})` : 'Placer (offert)';
}
