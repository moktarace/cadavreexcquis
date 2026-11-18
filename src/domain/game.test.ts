import { describe, expect, it } from 'vitest';
import { getGameMoment } from './calendar';
import { GameEngine, PublishError, type Contribution, type PublishInput } from './game';

// Semaine 47 de 2026 : lundi 16 → dimanche 22 novembre (Paris, UTC+1).
const MON = 16;
const at = (day: number, hour = 11, minute = 0) => Date.UTC(2026, 10, day, hour - 1, minute);

class Table {
  readonly engine: GameEngine;
  constructor(options?: ConstructorParameters<typeof GameEngine>[0]) {
    this.engine = new GameEngine(options);
  }

  game(nowMs: number) {
    return this.engine.ensureGame(getGameMoment(nowMs));
  }

  root(user: string, nowMs: number): Contribution {
    const game = this.game(nowMs);
    const room = this.engine.join(game.id, user);
    return this.publish({ userId: user, roomId: room.id }, nowMs).contribution;
  }

  next(user: string, parent: Contribution, nowMs: number): Contribution {
    return this.publish({ userId: user, parentId: parent.id }, nowMs).contribution;
  }

  publish(input: PublishInput, nowMs: number) {
    return this.engine.publish(input, nowMs, getGameMoment(nowMs));
  }
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PublishError) return e.code;
    throw e;
  }
  return 'OK';
};

describe('création de première case, tous les jours', () => {
  it.each([
    ['mardi', 17],
    ['mercredi', 18],
    ['vendredi', 20],
    ['dimanche', 22],
  ])('autorise une case 1 le %s', (_name, day) => {
    const t = new Table();
    const c = t.root('alice', at(day));
    expect(c.caseNumber).toBe(1);
    expect(c.parentId).toBeNull();
  });

  it('ne bloque la continuation en fonction d’aucun jour', () => {
    for (let day = MON; day <= MON + 6; day++) {
      const t = new Table();
      const a = t.root('alice', at(day));
      expect(t.next('bob', a, at(day, 12)).caseNumber).toBe(2);
    }
  });
});

describe('progression et fin de branche', () => {
  it('permet une continuation immédiate le même jour', () => {
    const t = new Table();
    const a = t.root('alice', at(18, 10, 0));
    const b = t.next('bob', a, at(18, 10, 1));
    expect(b.parentId).toBe(a.id);
    expect(t.engine.children(a.id)).toEqual([b]);
  });

  it('termine un yonkoma en quelques minutes, un dimanche', () => {
    const t = new Table();
    const c1 = t.root('alice', at(22, 14, 0));
    const c2 = t.next('bob', c1, at(22, 14, 2));
    const c3 = t.next('chloe', c2, at(22, 14, 5));
    const c4 = t.next('dan', c3, at(22, 14, 8));
    expect(c4.caseNumber).toBe(4);
    const game = t.game(at(22));
    expect(t.engine.completeStories(game.id)).toEqual([[c1, c2, c3, c4]]);
  });

  it('refuse toute continuation d’une case 4', () => {
    const t = new Table();
    const c1 = t.root('a', at(20));
    const c2 = t.next('b', c1, at(20));
    const c3 = t.next('c', c2, at(20));
    const c4 = t.next('d', c3, at(20));
    expect(code(() => t.next('e', c4, at(20)))).toBe('PARENT_IS_FINAL');
  });

  it('refuse une case parente inconnue', () => {
    const t = new Table();
    expect(code(() => t.publish({ userId: 'a', parentId: 'nope' }, at(20)))).toBe('PARENT_NOT_FOUND');
  });
});

describe('plusieurs contributions du même joueur', () => {
  it('permet plusieurs cases 1 pour un même thème', () => {
    const t = new Table();
    for (let i = 0; i < 5; i++) t.root('alice', at(17, 10, i));
    expect(t.engine.contributionsOf(t.game(at(17)).id)).toHaveLength(5);
  });

  it('permet de continuer autant de dessins qu’on veut dans la journée', () => {
    const t = new Table();
    const roots = ['b', 'c', 'd', 'e'].map((u, i) => t.root(u, at(17, 9, i)));
    for (const [i, r] of roots.entries()) t.next('alice', r, at(17, 10, i));
    expect(roots.every((r) => t.engine.children(r.id).length === 1)).toBe(true);
  });

  it('permet plusieurs continuations d’une même case par le même joueur', () => {
    const t = new Table();
    const a = t.root('alice', at(17));
    const first = t.next('bob', a, at(17, 12, 0));
    const second = t.next('bob', a, at(17, 12, 1));
    expect(t.engine.children(a.id).map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it('crée des embranchements multiples et partage les cases entre histoires', () => {
    const t = new Table();
    const c1 = t.root('a', at(19));
    const c2 = t.next('b', c1, at(19));
    const c3a = t.next('c', c2, at(19));
    const c3b = t.next('d', c2, at(19));
    t.next('e', c3a, at(19));
    t.next('f', c3a, at(19));
    t.next('g', c3b, at(19));
    const stories = t.engine.completeStories(t.game(at(19)).id);
    expect(stories).toHaveLength(3);
    expect(stories.every((s) => s[0].id === c1.id && s[1].id === c2.id)).toBe(true);
    expect(t.engine.descendants(c1.id)).toHaveLength(6);
  });
});

describe('interdiction de continuer sa propre case', () => {
  it('refuse la continuation directe', () => {
    const t = new Table();
    const a = t.root('alice', at(17));
    expect(code(() => t.next('alice', a, at(17)))).toBe('CANNOT_CONTINUE_OWN');
    expect(t.engine.children(a.id)).toHaveLength(0);
  });

  it('refuse aussi dans une histoire plus avancée', () => {
    const t = new Table();
    const a = t.root('alice', at(17));
    const b = t.next('bob', a, at(17));
    expect(code(() => t.next('bob', b, at(17)))).toBe('CANNOT_CONTINUE_OWN');
  });

  it('autorise à réintervenir si la case parente appartient à quelqu’un d’autre', () => {
    const t = new Table();
    const a1 = t.root('alice', at(17));
    const b2 = t.next('bob', a1, at(17));
    const a3 = t.next('alice', b2, at(17));
    const c4 = t.next('chloe', a3, at(17));
    expect(t.engine.pathTo(c4.id).map((c) => c.authorId)).toEqual(['alice', 'bob', 'alice', 'chloe']);
  });

  it('alterne deux auteurs sur trois cases consécutives', () => {
    const t = new Table();
    const a1 = t.root('alice', at(17));
    const b2 = t.next('bob', a1, at(17));
    const a3 = t.next('alice', b2, at(17));
    const b4 = t.next('bob', a3, at(17));
    expect(b4.caseNumber).toBe(4);
  });

  it('ne propose pas à l’auteur ses propres cases', () => {
    const t = new Table();
    const a = t.root('alice', at(17));
    const b = t.root('bob', at(17));
    const room = t.engine.join(t.game(at(17)).id, 'alice');
    expect(t.engine.eligibleParents(room.id, 'alice').map((c) => c.id)).toEqual([b.id]);
    expect(t.engine.eligibleParents(room.id, 'bob').map((c) => c.id)).toEqual([a.id]);
  });

  it('propose en premier les cases sans suite', () => {
    const t = new Table();
    const a = t.root('a', at(17, 9));
    const b = t.root('b', at(17, 10));
    t.next('c', a, at(17, 11));
    const room = t.engine.join(t.game(at(17)).id, 'd');
    expect(t.engine.eligibleParents(room.id, 'd').map((x) => x.id)).toContain(b.id);
    expect(t.engine.eligibleParents(room.id, 'd')[0].id).toBe(b.id);
  });
});

describe('publications simultanées', () => {
  it('crée autant de branches distinctes que de continuations concurrentes', async () => {
    const t = new Table();
    const root = t.root('alice', at(17));
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => Promise.resolve().then(() => t.next(`u${i}`, root, at(17, 12)))),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(40);
    expect(t.engine.children(root.id)).toHaveLength(40);
    expect(t.engine.getContribution(root.id)).toEqual(root);
  });

  it('refuse l’auto-continuation même lorsqu’elle est mêlée à des publications concurrentes', async () => {
    const t = new Table();
    const root = t.root('alice', at(17));
    const outcomes = await Promise.all(
      ['bob', 'alice', 'chloe', 'alice'].map((u) =>
        Promise.resolve().then(() => code(() => t.next(u, root, at(17, 12)))),
      ),
    );
    expect(outcomes).toEqual(['OK', 'CANNOT_CONTINUE_OWN', 'OK', 'CANNOT_CONTINUE_OWN']);
    expect(t.engine.children(root.id).every((c) => c.authorId !== 'alice')).toBe(true);
  });

  it('ne dépasse jamais la capacité quand deux joueurs se disputent la dernière place', async () => {
    const t = new Table({ roomCapacity: 2 });
    const a = t.root('alice', at(17)); // alice occupe 1 place
    const filler = t.next('bob', a, at(17)); // bob occupe la seconde
    const outcomes = await Promise.all(
      ['x', 'y'].map((u) => Promise.resolve().then(() => code(() => t.next(u, filler, at(17, 12))))),
    );
    expect(outcomes).toEqual(['ROOM_FULL', 'ROOM_FULL']);
    expect(t.engine.memberCount(a.roomId)).toBe(2);
  });
});

describe('changement de semaine', () => {
  it('génère le nouveau thème du lundi, sans toucher à l’ancien', () => {
    const t = new Table();
    const sunday = t.game(at(22, 23, 59));
    const monday = t.game(Date.UTC(2026, 10, 22, 23, 0, 0));
    expect(monday.id).not.toBe(sunday.id);
    expect(monday.isoWeek).toBe(48);
    expect(monday.theme.seed).toBe('case-ludique/2026-W48');
    expect(sunday.theme.seed).toBe('case-ludique/2026-W47');
    expect(t.game(at(22, 23, 59)).theme).toEqual(sunday.theme);
  });

  it('permet de continuer une ancienne histoire en gardant son thème d’origine', () => {
    const t = new Table();
    const old = t.root('alice', at(22, 20)); // dimanche soir, semaine 47
    const oldGame = t.engine.getGame(old.gameId)!;
    const newGame = t.game(at(23, 9)); // lundi 23, semaine 48
    expect(newGame.id).not.toBe(oldGame.id);

    const cont = t.next('bob', old, at(23, 9, 30));
    expect(cont.gameId).toBe(oldGame.id);
    expect(t.engine.getGame(cont.gameId)!.theme.seed).toBe('case-ludique/2026-W47');
    expect(t.engine.unfinishedBranches(oldGame.id).map((c) => c.id)).toEqual([cont.id]);
  });

  it('n’autorise une nouvelle case 1 que dans le thème actif', () => {
    const t = new Table();
    const oldRoom = t.engine.join(t.game(at(22)).id, 'alice');
    t.game(at(23)); // le thème de la semaine 48 devient actif
    expect(code(() => t.publish({ userId: 'alice', roomId: oldRoom.id }, at(23, 9)))).toBe('GAME_NOT_ACTIVE');
  });

  it('accepte un seed manuel pour une partie privée', () => {
    const t = new Table();
    const priv = t.engine.ensureGame(getGameMoment(at(20)), 'amis');
    const room = t.engine.join(priv.id, 'alice');
    expect(priv.theme.seed).toBe('amis');
    expect(code(() => t.publish({ userId: 'alice', roomId: room.id }, at(23, 9)))).toBe('OK');
  });
});

describe('salles', () => {
  it('démarre à froid: salle vide, première case possible tout de suite', () => {
    const t = new Table();
    const room = t.engine.join(t.game(at(21)).id, 'alice');
    expect(t.engine.isRoomEmpty(room.id)).toBe(true);
    expect(t.engine.eligibleParents(room.id, 'alice')).toEqual([]);
    expect(code(() => t.publish({ userId: 'alice', roomId: room.id }, at(21)))).toBe('OK');
    expect(t.engine.isRoomEmpty(room.id)).toBe(false);
  });

  it('n’emprunte jamais les dessins d’une autre salle', () => {
    const t = new Table({ roomCapacity: 2 });
    t.root('a', at(17));
    t.root('b', at(17));
    const room2 = t.engine.join(t.game(at(17)).id, 'c');
    expect(room2.number).toBe(2);
    expect(t.engine.isRoomEmpty(room2.id)).toBe(true);
    expect(t.engine.eligibleParents(room2.id, 'c')).toEqual([]);
  });

  it('remplit 99 participants puis ouvre automatiquement une autre salle', () => {
    const t = new Table();
    const game = t.game(at(17));
    const rooms = new Set<string>();
    for (let i = 1; i <= 99; i++) rooms.add(t.engine.join(game.id, `u${i}`).id);
    expect(rooms.size).toBe(1);
    expect(t.engine.join(game.id, 'u100').number).toBe(2);
    expect(t.engine.join(game.id, 'u1').number).toBe(1);
  });

  it('supporte 99 joueurs qui créent et continuent des cases', () => {
    const t = new Table();
    const roots: Contribution[] = [];
    for (let i = 1; i <= 99; i++) roots.push(t.root(`u${i}`, at(17, 10, i % 60)));
    for (let i = 0; i < 99; i++) t.next(`u${((i + 1) % 99) + 1}`, roots[i], at(17, 12, i % 60));
    const game = t.game(at(17));
    expect(t.engine.roomsOf(game.id)).toHaveLength(1);
    expect(t.engine.memberCount(roots[0].roomId)).toBe(99);
    expect(t.engine.contributionsOf(game.id)).toHaveLength(198);
  });

  it('refuse à un nouveau joueur de continuer dans une salle complète', () => {
    const t = new Table({ roomCapacity: 2 });
    const a = t.root('alice', at(17));
    t.next('bob', a, at(17));
    expect(code(() => t.next('zoe', a, at(17)))).toBe('ROOM_FULL');
  });

  it('laisse un membre d’une salle complète continuer', () => {
    const t = new Table({ roomCapacity: 2 });
    const a = t.root('alice', at(17));
    const b = t.root('bob', at(17));
    expect(code(() => t.next('alice', b, at(17)))).toBe('OK');
    expect(code(() => t.next('bob', a, at(17)))).toBe('OK');
  });
});

describe('protection technique contre les abus', () => {
  it('limite le débit de publication sans limite quotidienne', () => {
    const t = new Table({ abuse: { max: 3, windowMs: 60_000 } });
    const roots = Array.from({ length: 3 }, (_, i) => t.root(`o${i}`, at(17, 9, i)));
    const now = at(17, 12, 0);
    t.next('spam', roots[0], now);
    t.next('spam', roots[1], now + 1);
    t.next('spam', roots[2], now + 2);
    const extra = t.root('o9', at(17, 12, 0));
    expect(code(() => t.next('spam', extra, now + 3))).toBe('RATE_LIMITED');
    expect(code(() => t.next('spam', extra, now + 61_000))).toBe('OK');
  });
});

describe('événements de notification', () => {
  it('prévient l’auteur du parent d’une continuation directe', () => {
    const t = new Table();
    const a = t.root('alice', at(17));
    const { events } = t.publish({ userId: 'bob', parentId: a.id }, at(17));
    expect(events).toEqual([expect.objectContaining({ userId: 'alice', kind: 'continuation', groupKey: `cont:${a.id}` })]);
  });

  it('signale une nouvelle branche aux auteurs du chemin, sans doublon', () => {
    const t = new Table();
    const a = t.root('alice', at(17));
    const b = t.next('bob', a, at(17));
    t.next('chloe', b, at(17));
    const { events } = t.publish({ userId: 'dan', parentId: b.id }, at(17));
    const byUser = Object.fromEntries(events.map((e) => [e.userId, e.kind]));
    expect(byUser).toEqual({ bob: 'continuation', alice: 'new_branch' });
  });

  it('prévient les participants quand une histoire atteint quatre cases', () => {
    const t = new Table();
    const a = t.root('alice', at(17));
    const b = t.next('bob', a, at(17));
    const c = t.next('chloe', b, at(17));
    const { events } = t.publish({ userId: 'dan', parentId: c.id }, at(17));
    expect(events.map((e) => [e.userId, e.kind]).sort()).toEqual([
      ['alice', 'story_completed'],
      ['bob', 'story_completed'],
      ['chloe', 'story_completed'],
    ]);
  });

  it('n’émet rien pour une case 1 et prépare l’événement de nouveau thème', () => {
    const t = new Table();
    const game = t.game(at(17));
    const room = t.engine.join(game.id, 'alice');
    expect(t.publish({ userId: 'alice', roomId: room.id }, at(17)).events).toEqual([]);
    expect(t.engine.themeEvent(game)).toMatchObject({ userId: null, kind: 'new_theme' });
  });
});

describe('persistance', () => {
  it('restaure un état identique après sauvegarde', () => {
    const t = new Table();
    t.root('a', at(17));
    const copy = new GameEngine();
    copy.restore(t.engine.snapshot());
    expect(copy.snapshot()).toEqual(t.engine.snapshot());
  });
});
