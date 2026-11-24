/** Réserve d'encre (mode Survivor): les règles de coût sont fournies de l'extérieur, l'éditeur ne connaît que cette interface. */
export interface InkState {
  /** Encre dépensée sur cette version du dessin, remboursements déduits (suit annuler/rétablir). */
  spent: number;
  /** Mimo gratuits déjà utilisés sur cette case. */
  freeMimos: number;
}

export interface InkRules {
  /** Coût d'un trait: longueur et épaisseur en pixels de la toile. */
  stroke(length: number, size: number): number;
  /** Coût d'un remplissage de `pixels` pixels. */
  fill(pixels: number): number;
  mimo(): number;
  text(): number;
  decor(): number;
  stamp(): number;
  /** Nombre de Mimo offerts par case. */
  freeMimos: number;
  /** Encre restituée quand la gomme efface `pixels` pixels dessinés. */
  refund(pixels: number): number;
}

/** Part de pixels réellement noircis par une texture, par rapport à un trait plein. */
export const TEXTURE_DENSITY: Record<string, number> = { solid: 1, checker: 0.5, dots: 0.25, lines: 0.5, diagonal: 0.25, sparse: 0.25 };
