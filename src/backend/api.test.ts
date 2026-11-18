import { describe, expect, it } from 'vitest';
import { DECK_ORDER, DECK_PAGE_SIZE } from '../domain/discovery';
import { deckCount, deckPage, deckQuery, fetchAll, type Db } from './api';

type Call = [string, ...unknown[]];

/** Client factice: enregistre les appels de la chaîne de requête et répond avec les lignes données. */
function fake(rows: unknown[] = [], count = 0) {
  const calls: Call[] = [];
  const builder: any = new Proxy(
    {},
    {
      get(_, name: string) {
        if (name === 'then') return (resolve: (v: unknown) => void) => resolve({ data: rows, error: null, count });
        return (...args: unknown[]) => {
          calls.push([name, ...args]);
          return builder;
        };
      },
    },
  );
  const client = { from: (table: string) => (calls.push(['from', table]), builder) } as unknown as Db;
  return { client, calls };
}

const names = (calls: Call[]) => calls.map((c) => c[0]);
const q = { roomId: 'room-1', userId: 'me', depth: null, onlyOpen: false } as const;

describe('requêtes de découverte', () => {
  it('exclut les cases finales et celles du joueur, dans la salle demandée seulement', () => {
    const { client, calls } = fake();
    deckQuery(client, q);
    expect(calls).toContainEqual(['eq', 'room_id', 'room-1']);
    expect(calls).toContainEqual(['lt', 'case_number', 4]);
    expect(calls).toContainEqual(['neq', 'author_id', 'me']);
    expect(names(calls)).not.toContain('or');
  });

  it('filtre par profondeur et par « sans suite » seulement à la demande', () => {
    const plain = fake();
    deckQuery(plain.client, q);
    expect(plain.calls.filter((c) => c[0] === 'eq').map((c) => c[1])).toEqual(['room_id']);

    const filtered = fake();
    deckQuery(filtered.client, { ...q, depth: 2, onlyOpen: true });
    expect(filtered.calls).toContainEqual(['eq', 'case_number', 2]);
    expect(filtered.calls).toContainEqual(['eq', 'child_count', 0]);
  });

  it('lit une page dans un ordre total, avec le décompte exact', async () => {
    const { client, calls } = fake([], 347);
    const page = await deckPage(q, DECK_PAGE_SIZE, DECK_PAGE_SIZE, client);
    expect(page.total).toBe(347);
    expect(calls.filter((c) => c[0] === 'order').map((c) => c[1])).toEqual([...DECK_ORDER]);
    expect(calls.filter((c) => c[0] === 'order').every((c) => (c[2] as any).ascending === true)).toBe(true);
    expect(calls).toContainEqual(['range', DECK_PAGE_SIZE, 2 * DECK_PAGE_SIZE - 1]);
    expect(calls).toContainEqual(['select', '*', { count: 'exact', head: false }]);
  });

  it('compte sans rapatrier les lignes', async () => {
    const { client, calls } = fake([], 1500);
    expect(await deckCount({ ...q, onlyOpen: true }, client)).toBe(1500);
    expect(calls).toContainEqual(['select', '*', { count: 'exact', head: true }]);
  });
});

describe('lecture exhaustive', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

  it('ne tronque pas au-delà de 1 000 lignes', async () => {
    const pages = [rows(1000), rows(1000), rows(337)];
    const asked: [number, number][] = [];
    const all = await fetchAll((a, b) => {
      asked.push([a, b]);
      return Promise.resolve({ data: pages[asked.length - 1], error: null });
    });
    expect(all).toHaveLength(2337);
    expect(asked).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('s’arrête sur une page vide quand le total est un multiple de la taille de page', async () => {
    const pages = [rows(1000), []];
    let n = 0;
    const all = await fetchAll(() => Promise.resolve({ data: pages[n++], error: null }));
    expect(all).toHaveLength(1000);
    expect(n).toBe(2);
  });

  it('remonte l’erreur du serveur au lieu de renvoyer un résultat partiel', async () => {
    await expect(fetchAll(() => Promise.resolve({ data: null, error: { message: 'boom' } }))).rejects.toThrow('boom');
  });
});
