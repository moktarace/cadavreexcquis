export type CaseNumber = 1 | 2 | 3 | 4;

/** Contribution publiée telle que lue depuis la vue `contribution_cards`. */
export interface Card {
  id: string;
  gameId: string;
  roomId: string;
  authorId: string;
  authorName: string;
  caseNumber: CaseNumber;
  parentId: string | null;
  previewUrl: string;
  publishedAt: number;
  childCount: number;
}

export const FINAL_CASE = 4;

/** Raison pour laquelle un joueur ne peut pas continuer une case, ou null s'il le peut. */
export function cannotContinue(card: Card, userId: string | null): string | null {
  if (card.caseNumber >= FINAL_CASE) return 'Cette histoire est terminée.';
  if (card.authorId === userId) return 'Tu ne peux pas continuer ton propre dessin.';
  return null;
}

/** Cases à proposer: continuables par ce joueur, sans suite d'abord (jamais de classement par popularité). */
export function continuable(cards: readonly Card[], userId: string | null): Card[] {
  return cards
    .filter((c) => cannotContinue(c, userId) === null)
    .sort((a, b) => a.childCount - b.childCount || a.publishedAt - b.publishedAt || a.id.localeCompare(b.id));
}

export function childrenIndex(cards: readonly Card[]): Map<string | null, Card[]> {
  const map = new Map<string | null, Card[]>();
  for (const c of cards) {
    const list = map.get(c.parentId) ?? [];
    list.push(c);
    map.set(c.parentId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.publishedAt - b.publishedAt || a.id.localeCompare(b.id));
  return map;
}

/** Chemin racine → case, reconstruit à partir de cartes déjà chargées. */
export function pathTo(cards: readonly Card[], id: string): Card[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const path: Card[] = [];
  for (let c = byId.get(id); c; c = c.parentId ? byId.get(c.parentId) : undefined) path.unshift(c);
  return path;
}

/** Histoires complètes (4 cases) d'un lot de cartes, une par case finale. */
export function completeStories(cards: readonly Card[]): Card[][] {
  return cards
    .filter((c) => c.caseNumber === FINAL_CASE)
    .sort((a, b) => a.publishedAt - b.publishedAt || a.id.localeCompare(b.id))
    .map((leaf) => pathTo(cards, leaf.id))
    .filter((p) => p.length === FINAL_CASE);
}

/** Branches inachevées: cases sans suite qui ne sont pas des fins. */
export function unfinished(cards: readonly Card[]): Card[] {
  return cards.filter((c) => c.caseNumber < FINAL_CASE && c.childCount === 0);
}

export interface TreeNode {
  card: Card;
  children: TreeNode[];
}

/** Arbre sous une racine donnée, à partir des cartes de sa descendance. */
export function buildTree(root: Card, descendants: readonly Card[]): TreeNode {
  const index = childrenIndex(descendants);
  const build = (card: Card): TreeNode => ({ card, children: (index.get(card.id) ?? []).map(build) });
  return build(root);
}

/** Dernier niveau atteint par chaque chemin: utile pour résumer une histoire sans la parcourir. */
export function countLeaves(node: TreeNode): number {
  return node.children.length === 0 ? 1 : node.children.reduce((n, c) => n + countLeaves(c), 0);
}

/** Case sans suite qui n'est pas une fin: une branche que l'on peut encore continuer. */
export const isOpenEnd = (c: Card) => c.caseNumber < FINAL_CASE && c.childCount === 0;

/** Ne garde que les chemins menant à une feuille qui vérifie `keep`; null si aucun. */
export function pruneTree(node: TreeNode, keep: (card: Card) => boolean): TreeNode | null {
  const children = node.children.map((c) => pruneTree(c, keep)).filter((c): c is TreeNode => c !== null);
  if (children.length > 0 || (node.children.length === 0 && keep(node.card))) return { card: node.card, children };
  return null;
}

export function treeStats(node: TreeNode): { paths: number; completed: number; open: number } {
  if (node.children.length === 0) {
    return { paths: 1, completed: node.card.caseNumber === FINAL_CASE ? 1 : 0, open: isOpenEnd(node.card) ? 1 : 0 };
  }
  return node.children.map(treeStats).reduce((a, b) => ({ paths: a.paths + b.paths, completed: a.completed + b.completed, open: a.open + b.open }));
}

/** Repère des alternatives d'une même case: A, B, C… puis des nombres au-delà de Z. */
export function siblingLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

export interface ExplorerRow {
  /** Case dont les suites sont affichées (null jamais: la racine est le premier parent). */
  parent: Card;
  nodes: TreeNode[];
  /** Suite choisie dans cette rangée, ou null quand on regarde simplement les suites. */
  selectedId: string | null;
}

export interface ExplorerView {
  /** Chemin sélectionné, de la racine à la case choisie. */
  path: TreeNode[];
  rows: ExplorerRow[];
}

/**
 * Vue progressive d'un arbre: une rangée par niveau, seulement sous le chemin choisi.
 * Reste lisible avec des dizaines de branches: chaque rangée défile à part.
 */
export function explorerView(root: TreeNode, selectedId: string | null): ExplorerView {
  const find = (node: TreeNode, id: string): TreeNode[] | null => {
    if (node.card.id === id) return [node];
    for (const child of node.children) {
      const sub = find(child, id);
      if (sub) return [node, ...sub];
    }
    return null;
  };
  const path = (selectedId && find(root, selectedId)) || [root];
  const rows: ExplorerRow[] = [];
  path.forEach((node, i) => {
    if (node.children.length > 0) rows.push({ parent: node.card, nodes: node.children, selectedId: path[i + 1]?.card.id ?? null });
  });
  return { path, rows };
}

/** Dessins publiés le plus récemment, les plus neufs d'abord. */
export function recentCards(cards: readonly Card[], limit: number): Card[] {
  return [...cards].sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id)).slice(0, limit);
}
