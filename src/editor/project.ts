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
  /** Mimo déjà placés sur cette version du dessin (suit annuler/rétablir; absent = 0, anciens dessins compris). */
  mimos?: number;
}

export function newProject(): Project {
  return { pixels: new Uint8Array(PIXELS) };
}
