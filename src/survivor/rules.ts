import type { InkRules } from '../editor/ink';
import { SURVIVOR } from './config';
import type { Modifiers } from './upgrades';

const C = SURVIVOR.costs;

/** Règles de coût de l'éditeur pour la partie en cours: la config de base, modifiée par les améliorations. */
export function inkRulesFor(m: Modifiers): InkRules {
  return {
    stroke: (length, size) => Math.max(0, length) * Math.max(0, size) * C.strokePerPixel * m.stroke,
    fill: (pixels) => Math.min(C.fillMax, C.fillBase + pixels * C.fillPerPixel) * m.stroke,
    mimo: () => C.mimo,
    text: () => C.text * m.text,
    decor: () => C.decor * m.decor,
    stamp: () => C.stamp,
    freeMimos: m.freeMimos,
    // Un pixel dessiné a coûté `strokePerPixel` d'encre: la gomme en rend une part.
    refund: (pixels) => pixels * C.strokePerPixel * m.eraseRefund,
  };
}
