import { describe, expect, it } from 'vitest';
import {
  buildTree,
  cannotContinue,
  completeStories,
  continuable,
  countLeaves,
  explorerView,
  recentCards,
  siblingLabel,
  isOpenEnd,
  pathTo,
  pruneTree,
  treeStats,
  unfinished,
  type Card,
  type CaseNumber,
} from './cards';

let t = 0;
const card = (id: string, caseNumber: CaseNumber, parentId: string | null, authorId: string, childCount = 0): Card => ({
  id,
  gameId: 'g',
  roomId: 'r',
  authorId,
  authorName: authorId,
  caseNumber,
  parentId,
  previewUrl: `https://x/${id}.png`,
  publishedAt: ++t,
  childCount,
});

// a1 ─ b2 ─ a3 ─ c4
//        └─ d3 ─ e4
//    └ f2
const cards = [
  card('a1', 1, null, 'alice', 2),
  card('b2', 2, 'a1', 'bob', 2),
  card('f2', 2, 'a1', 'fay'),
  card('a3', 3, 'b2', 'alice', 1),
  card('d3', 3, 'b2', 'dan', 1),
  card('c4', 4, 'a3', 'chloe'),
  card('e4', 4, 'd3', 'eve'),
];

describe('règles de continuation côté lecture', () => {
  it('interdit de continuer sa propre case et une case finale', () => {
    expect(cannotContinue(cards[0], 'alice')).toMatch(/propre/);
    expect(cannotContinue(cards[5], 'bob')).toMatch(/terminée/);
    expect(cannotContinue(cards[0], 'bob')).toBeNull();
  });

  it('interdit de continuer directement une case masquée, sans toucher à ses descendants', () => {
    const hidden = { ...cards[1], hidden: true, hiddenKind: 'review' as const };
    expect(cannotContinue(hidden, 'alice')).toMatch(/masqué/);
    expect(continuable([hidden, cards[3]], 'zoe').map((c) => c.id)).toEqual(['a3']);
  });

  it('autorise à réintervenir sur une case d’un autre auteur', () => {
    expect(cannotContinue(cards[1], 'alice')).toBeNull();
  });

  it('propose les cases sans suite en premier, sans les siennes ni les fins', () => {
    const list = continuable(cards, 'alice').map((c) => c.id);
    expect(list).toEqual(['f2', 'd3', 'b2']);
  });

  it('une case 4 ne termine que sa propre branche', () => {
    // c4 termine a1 → b2 → a3 → c4, mais b2 et a1 restent continuables par d'autres versions
    const ids = continuable(cards, 'zoe').map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['a1', 'b2', 'f2', 'a3', 'd3']));
    expect(ids).not.toContain('c4');
    expect(ids).not.toContain('e4');
  });

  it('propose tout à un joueur non connecté... sauf les fins', () => {
    expect(continuable(cards, null).map((c) => c.id)).not.toContain('c4');
  });
});

describe('chemins, histoires et arbre', () => {
  it('reconstruit le chemin racine → case', () => {
    expect(pathTo(cards, 'c4').map((c) => c.id)).toEqual(['a1', 'b2', 'a3', 'c4']);
    expect(pathTo(cards, 'nope')).toEqual([]);
  });

  it('liste les histoires complètes sans dupliquer les cases partagées', () => {
    const stories = completeStories(cards);
    expect(stories.map((s) => s.map((c) => c.id))).toEqual([
      ['a1', 'b2', 'a3', 'c4'],
      ['a1', 'b2', 'd3', 'e4'],
    ]);
  });

  it('ignore une fin dont la lignée est incomplète', () => {
    expect(completeStories(cards.filter((c) => c.id !== 'b2'))).toEqual([]);
  });

  it('repère les branches inachevées', () => {
    expect(unfinished(cards).map((c) => c.id)).toEqual(['f2']);
  });

  it('construit l’arbre d’une case et compte ses chemins', () => {
    const tree = buildTree(cards[0], cards.slice(1));
    expect(tree.children.map((n) => n.card.id)).toEqual(['b2', 'f2']);
    expect(countLeaves(tree)).toBe(3);
  });

  it('résume l’arbre: chemins, histoires terminées et branches à continuer', () => {
    expect(treeStats(buildTree(cards[0], cards.slice(1)))).toEqual({ paths: 3, completed: 2, open: 1 });
  });

  it('ne garde que les chemins menant à une branche à continuer', () => {
    const tree = buildTree(cards[0], cards.slice(1));
    const pruned = pruneTree(tree, isOpenEnd)!;
    expect(pruned.children.map((n) => n.card.id)).toEqual(['f2']);
    expect(pruneTree(buildTree(cards[1], cards.slice(3)), isOpenEnd)).toBeNull();
  });
});

describe('explorateur progressif', () => {
  const tree = buildTree(cards[0], cards.slice(1));

  it('n’affiche que les suites de la racine tant que rien n’est choisi', () => {
    const v = explorerView(tree, null);
    expect(v.path.map((n) => n.card.id)).toEqual(['a1']);
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].nodes.map((n) => n.card.id)).toEqual(['b2', 'f2']);
    expect(v.rows[0].selectedId).toBeNull();
  });

  it('déroule une rangée par niveau sous le chemin choisi', () => {
    const v = explorerView(tree, 'a3');
    expect(v.path.map((n) => n.card.id)).toEqual(['a1', 'b2', 'a3']);
    expect(v.rows.map((r) => r.parent.id)).toEqual(['a1', 'b2', 'a3']);
    expect(v.rows[0].selectedId).toBe('b2');
    expect(v.rows[1].selectedId).toBe('a3');
    expect(v.rows[1].nodes.map((n) => n.card.id)).toEqual(['a3', 'd3']);
    expect(v.rows[2].selectedId).toBeNull();
  });

  it('permet de choisir une autre branche à n’importe quel niveau', () => {
    expect(explorerView(tree, 'f2').rows).toHaveLength(1);
    expect(explorerView(tree, 'e4').path.map((n) => n.card.id)).toEqual(['a1', 'b2', 'd3', 'e4']);
  });

  it('ne propose pas de rangée sous une fin et retombe sur la racine si l’identifiant est inconnu', () => {
    expect(explorerView(tree, 'c4').rows).toHaveLength(3);
    expect(explorerView(tree, 'inconnu').path.map((n) => n.card.id)).toEqual(['a1']);
  });

  it('étiquette les alternatives A, B, C… puis par numéro', () => {
    expect([0, 1, 25, 26, 40].map(siblingLabel)).toEqual(['A', 'B', 'Z', '27', '41']);
  });

  it('retrouve les dessins récents, les plus neufs d’abord', () => {
    expect(recentCards(cards, 3).map((c) => c.id)).toEqual(['e4', 'c4', 'd3']);
  });
});
