import { describe, expect, it } from 'vitest';
import type { Card, CaseNumber } from './cards';
import { isReplyTo, mineMood, missingCardIds, pairDiscoveries, parentsWithNews, suiteLabel, type UnreadReply } from './discoveries';

const card = (id: string, caseNumber: CaseNumber, parentId: string | null, authorId: string, childCount = 0): Card => ({
  id, gameId: 'g', roomId: 'r', authorId, authorName: authorId, caseNumber, parentId, previewUrl: `/${id}.png`, publishedAt: 0, childCount,
});

// Alice (1) ← Bob (2) ← Chloé (3) ← Alice (4); Dan répond aussi à Alice.
const a1 = card('a1', 1, null, 'alice', 2);
const b2 = card('b2', 2, 'a1', 'bob', 1);
const d2 = card('d2', 2, 'a1', 'dan');
const c3 = card('c3', 3, 'b2', 'chloe', 1);
const a4 = card('a4', 4, 'c3', 'alice');

describe('ce qui constitue une nouveauté', () => {
  it('une case 1 publiée seule ne notifie personne', () => {
    expect(isReplyTo(a1, a1, 'alice')).toBe(false);
  });

  it('Bob continue Alice: nouveauté pour Alice', () => {
    expect(isReplyTo(a1, b2, 'alice')).toBe(true);
  });

  it('Chloé continue Bob: nouveauté pour Bob, pas pour Alice', () => {
    expect(isReplyTo(b2, c3, 'bob')).toBe(true);
    expect(isReplyTo(a1, c3, 'alice')).toBe(false);
  });

  it('une case 4 est une nouveauté pour l’auteur de sa case parente', () => {
    expect(isReplyTo(c3, a4, 'chloe')).toBe(true);
  });

  it('ses propres contributions ne sont jamais des réponses', () => {
    expect(isReplyTo(a1, { parentId: 'a1', authorId: 'alice' }, 'alice')).toBe(false);
    expect(isReplyTo(b2, a4, 'alice')).toBe(false);
  });

  it('personne n’est notifié pour une case qui n’est pas la sienne ou sans compte', () => {
    expect(isReplyTo(a1, b2, 'bob')).toBe(false);
    expect(isReplyTo(a1, b2, null)).toBe(false);
  });
});

describe('paires à découvrir', () => {
  const cards = new Map([a1, b2, d2, c3].map((c) => [c.id, c]));
  const unread: UnreadReply[] = [
    { replyId: 'd2', parentId: 'a1', repliedAt: 2 },
    { replyId: 'b2', parentId: 'a1', repliedAt: 1 },
  ];

  it('garde toutes les réponses à une même case, dans l’ordre reçu', () => {
    const pairs = pairDiscoveries(unread, cards, 'alice');
    expect(pairs.map((p) => [p.original.id, p.reply.id])).toEqual([['a1', 'd2'], ['a1', 'b2']]);
  });

  it('ignore une nouveauté dont une case est inconnue ou qui n’est pas pour ce joueur', () => {
    expect(pairDiscoveries([{ replyId: 'zz', parentId: 'a1', repliedAt: 0 }], cards, 'alice')).toEqual([]);
    expect(pairDiscoveries(unread, cards, 'bob')).toEqual([]);
  });

  it('liste les cases à charger sans doublon', () => {
    expect(missingCardIds(unread, new Map([['a1', a1]]))).toEqual(['d2', 'b2']);
    expect(missingCardIds(unread, cards)).toEqual([]);
  });

  it('retrouve les cases qui ont des nouveautés', () => {
    expect([...parentsWithNews(unread)]).toEqual(['a1']);
  });
});

describe('informations de « Tous mes dessins »', () => {
  it('décrit l’attente, les suites et la dernière case', () => {
    expect(suiteLabel({ caseNumber: 1, childCount: 0 })).toBe('En attente d’une suite');
    expect(suiteLabel({ caseNumber: 2, childCount: 1 })).toBe('1 suite');
    expect(suiteLabel({ caseNumber: 1, childCount: 3 })).toBe('3 suites');
    expect(suiteLabel({ caseNumber: 4, childCount: 0 })).toBe('Dernière case');
    expect(suiteLabel({ caseNumber: 1, childCount: 2, hidden: true, hiddenKind: 'review' })).toBe('Dessin temporairement masqué');
  });
});

describe('messages de « Mes dessins »', () => {
  it('distingue les trois situations vides', () => {
    expect(mineMood([], 0)).toBe('none');
    expect(mineMood([{ caseNumber: 1, childCount: 0 }], 0)).toBe('waiting');
    expect(mineMood([{ caseNumber: 1, childCount: 2 }], 0)).toBe('allRead');
  });

  it('met les nouveautés en avant sans fausse alerte quand tout est lu', () => {
    expect(mineMood([{ caseNumber: 1, childCount: 1 }], 1)).toBe('discover');
    expect(mineMood([{ caseNumber: 1, childCount: 1 }], 0)).not.toBe('discover');
  });

  it('n’annonce pas d’attente quand on n’a que des dernières cases', () => {
    expect(mineMood([{ caseNumber: 4, childCount: 0 }], 0)).toBe('quiet');
  });
});
