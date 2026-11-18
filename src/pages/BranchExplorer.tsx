import { useEffect, useRef, useState } from 'react';
import { go, hrefOf } from '../app/router';
import { cannotContinue, explorerView, isOpenEnd, pruneTree, siblingLabel, treeStats, type TreeNode } from '../domain/cards';
import { BranchNode, ToyButton, ToyCard, ToyToggle } from '../ui';
import { plural } from './shared';

interface Props {
  root: TreeNode;
  userId: string | null;
  initialId?: string | null;
}

/**
 * Arbre déroulé niveau par niveau: une rangée de suites sous chaque case du chemin choisi.
 * Seul le chemin ouvert est affiché, ce qui reste lisible même avec des dizaines de branches.
 */
export function BranchExplorer({ root, userId, initialId = null }: Props) {
  const [selected, setSelected] = useState<string | null>(initialId);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);

  const stats = treeStats(root);
  const pruned = onlyOpen ? pruneTree(root, isOpenEnd) : root;
  const shown = pruned ?? root;
  const view = explorerView(shown, selected);
  const current = view.path[view.path.length - 1].card;
  const blocked = cannotContinue(current, userId);
  const filteredOut = onlyOpen && pruned === null;

  useEffect(() => {
    treeRef.current?.querySelector('.branch-node.is-selected')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [selected, onlyOpen]);

  const startContinuation = () => go({ name: 'draw', parentId: current.id });

  const stateOf = (isLast: boolean, picked: boolean): 'idle' | 'path' | 'selected' => (!picked ? 'idle' : isLast ? 'selected' : 'path');
  const lastIndex = view.path.length - 1;

  return (
    <div className="explorer">
      <p className="hint explorer__stats">
        {plural(stats.paths, 'version', 'versions')} de l’histoire · {plural(stats.completed, 'terminée', 'terminées')} ·{' '}
        {plural(stats.open, 'attend une suite', 'attendent une suite')}
      </p>
      <ToyToggle checked={onlyOpen} onChange={setOnlyOpen}>Seulement celles qui attendent une suite</ToyToggle>
      {filteredOut && <ToyCard tone="green"><p>Toutes les versions de cette histoire sont terminées.</p></ToyCard>}

      <div className="branch-tree" ref={treeRef}>
        <div className="branch-level">
          <div className="branch-scroller">
            <div className="branch-scroller__inner">
              <BranchNode
                card={view.path[0].card}
                state={stateOf(lastIndex === 0, true)}
                eligible={cannotContinue(view.path[0].card, userId) === null}
                own={view.path[0].card.authorId === userId}
                onSelect={() => setSelected(view.path[0].card.id)}
              />
            </div>
          </div>
        </div>
        {view.rows.map((row, depth) => (
          <div className="branch-level" key={row.parent.id}>
            <div className="branch-link is-path" />
            <span className="branch-level__label">
              {row.nodes.length === 1 ? 'Une suite' : `${row.nodes.length} suites`} de la case {row.parent.caseNumber}
            </span>
            <div className="branch-scroller">
              <div className={`branch-scroller__inner ${row.nodes.length > 1 ? 'is-multiple' : ''}`}>
                {row.nodes.map((n, i) => {
                  const picked = n.card.id === row.selectedId;
                  return (
                    <BranchNode
                      key={n.card.id}
                      card={n.card}
                      siblingIndex={row.nodes.length > 1 ? i : undefined}
                      state={stateOf(depth + 1 === lastIndex, picked)}
                      eligible={cannotContinue(n.card, userId) === null}
                      own={n.card.authorId === userId}
                      onSelect={() => setSelected(n.card.id)}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        ))}
        {view.rows.length === 0 && <p className="hint">Personne n’a encore imaginé de suite à cette case.</p>}
      </div>

      <section className="explorer-bar" aria-label="Case choisie">
        <img className="explorer-bar__thumb" src={current.previewUrl} width={320} height={240} alt="" />
        <div className="explorer-bar__info">
          <strong>
            Case {current.caseNumber}
            {view.rows.length > 0 && view.path.length > 1 && siblingsOf(view, current.id)}
          </strong>
          <span>
            {current.authorName} · {current.caseNumber === 4 ? 'fin de l’histoire' : current.childCount === 0 ? 'pas encore de suite' : plural(current.childCount, 'suite', 'suites')}
          </span>
          {blocked && <span>{blocked}</span>}
        </div>
        <div className="explorer-bar__actions">
          <ToyButton variant="primary" size="s" icon="pencil" disabled={blocked !== null} onClick={startContinuation}>
            Dessiner la suite
          </ToyButton>
          {current.caseNumber === 4 && (
            <ToyButton variant="success" size="s" icon="book" href={hrefOf({ name: 'story', id: current.id })}>Lire l’histoire</ToyButton>
          )}
          <ToyButton variant="soft" size="s" icon="eye" href={hrefOf({ name: 'case', id: current.id })}>Voir la case</ToyButton>
        </div>
      </section>
    </div>
  );
}

/** « A », « B »… de la case choisie parmi ses alternatives. */
function siblingsOf(view: ReturnType<typeof explorerView>, id: string): string {
  const row = view.rows.find((r) => r.nodes.some((n) => n.card.id === id));
  if (!row || row.nodes.length < 2) return '';
  return siblingLabel(row.nodes.findIndex((n) => n.card.id === id));
}
