import type { InkState } from './ink';
import { PIXELS } from './palette';

/**
 * Un dessin: une seule image 320×240, un indice de palette par pixel (0 = blanc, aussi la gomme).
 * Immuable par convention: un tableau déjà inséré dans un projet ne doit pas être modifié en place
 * (l'historique en dépend).
 */
export interface Project {
  pixels: Uint8Array;
  /** Tampons déjà posés sur cette version du dessin (suit annuler/rétablir). */
  stamps?: number;
  /** Zones d'un Mimo ou d'un texte placés (1 = protégé): un décor ajouté ensuite passe derrière. Jamais affiché ni publié. */
  shield?: Uint8Array;
  /** Encre dépensée (mode Survivor seulement); absent dans le jeu classique. */
  ink?: InkState;
}

export function newProject(): Project {
  return { pixels: new Uint8Array(PIXELS) };
}
