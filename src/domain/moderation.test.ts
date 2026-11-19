import { describe, expect, it } from 'vitest';
import { REPORT_CATEGORIES, cardAlt, hiddenLabel, hiddenPlaceholder } from './moderation';

describe('modération', () => {
  it('propose les cinq motifs du cahier des charges', () => {
    expect(REPORT_CATEGORIES.map((c) => c.id)).toEqual(['offensive', 'hateful', 'sexual', 'spam', 'other']);
  });

  it('affiche « Dessin temporairement masqué » pendant l’examen, « Dessin retiré » ensuite', () => {
    expect(hiddenLabel('review')).toBe('Dessin temporairement masqué');
    expect(hiddenLabel(null)).toBe('Dessin temporairement masqué');
    expect(hiddenLabel('removed')).toBe('Dessin retiré');
    expect(hiddenLabel('deleted')).toBe('Dessin retiré');
  });

  it('l’emplacement neutre est une image qui porte le libellé', () => {
    const uri = decodeURIComponent(hiddenPlaceholder('review'));
    expect(uri.startsWith('data:image/svg+xml')).toBe(true);
    expect(uri).toContain('Dessin temporairement masqué');
    expect(uri).toContain('width="320" height="240"');
  });

  it('le texte alternatif ne nomme pas l’auteur d’un dessin masqué', () => {
    expect(cardAlt({ caseNumber: 2, authorName: 'Tom', hidden: true, hiddenKind: 'review' })).toBe('Case 2 : dessin temporairement masqué');
    expect(cardAlt({ caseNumber: 2, authorName: 'Tom' })).toBe('Case 2 de Tom');
  });
});
