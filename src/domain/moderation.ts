/** Signalements et dessins masqués: libellés et emplacement neutre, indépendants du réseau. */

export type HiddenKind = 'review' | 'removed' | 'deleted';

export const REPORT_CATEGORIES = [
  { id: 'offensive', label: 'Contenu offensant ou inapproprié' },
  { id: 'hateful', label: 'Harcèlement ou contenu haineux' },
  { id: 'sexual', label: 'Contenu sexuel inapproprié' },
  { id: 'spam', label: 'Spam' },
  { id: 'other', label: 'Autre motif' },
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number]['id'];

export const REPORT_DETAILS_MAX = 300;

/** Texte affiché à la place du dessin. */
export function hiddenLabel(kind: HiddenKind | null | undefined): string {
  return kind === 'removed' || kind === 'deleted' ? 'Dessin retiré' : 'Dessin temporairement masqué';
}

/** Emplacement neutre: une image 320 × 240 comme les vrais dessins, donc utilisable partout où une case est affichée. */
export function hiddenPlaceholder(kind: HiddenKind | null | undefined): string {
  const label = hiddenLabel(kind);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">` +
    `<rect width="320" height="240" fill="#ede5ff"/>` +
    `<rect x="8" y="8" width="304" height="224" fill="none" stroke="#a89cc9" stroke-width="4" stroke-dasharray="12 8"/>` +
    `<text x="160" y="126" font-family="sans-serif" font-size="17" font-weight="700" fill="#6c5a9b" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Texte alternatif d'une case, qui ne révèle rien d'un dessin masqué. */
export function cardAlt(card: { caseNumber: number; authorName: string; hidden?: boolean; hiddenKind?: HiddenKind | null }): string {
  return card.hidden ? `Case ${card.caseNumber} : ${hiddenLabel(card.hiddenKind).toLowerCase()}` : `Case ${card.caseNumber} de ${card.authorName}`;
}
