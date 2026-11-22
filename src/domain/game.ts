import type { GameMoment } from './calendar';
import { newThemeEvent, type NotificationEvent } from './notifications';

/** Thème d'une partie. En production il vient de la banque (tirage serveur, voir 0011_theme_bank.sql): ici, seule son identité compte. */
export interface Theme {
  seed: string;
  text: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Identifiant stable de la semaine; toutes les salles d'une même semaine partagent le même thème. */
export function weeklySeed(isoYear: number, isoWeek: number): string {
  return `case-ludique/${isoYear}-W${pad2(isoWeek)}`;
}

export const ROOM_CAPACITY = 99;
export const DEFAULT_ABUSE_LIMIT = { max: 60, windowMs: 3_600_000 };

export type CaseNumber = 1 | 2 | 3 | 4;
export const FINAL_CASE: CaseNumber = 4;

export interface WeeklyGame {
  id: string;
  isoYear: number;
  isoWeek: number;
  theme: Theme;
  /** Partie privée ou de test, créée avec un seed manuel. */
  seedOverridden: boolean;
}

export interface Room {
  id: string;
  gameId: string;
  number: number;
  capacity: number;
}

export interface Contribution {
  id: string;
  gameId: string;
  roomId: string;
  authorId: string;
  /** Profondeur dans la branche: 1 à 4. */
  caseNumber: CaseNumber;
  parentId: string | null;
  status: 'published' | 'hidden';
  publishedAt: number;
}

export type PublishErrorCode =
  | 'RATE_LIMITED'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'GAME_NOT_ACTIVE'
  | 'PARENT_NOT_FOUND'
  | 'PARENT_IS_FINAL'
  | 'CANNOT_CONTINUE_OWN';

export class PublishError extends Error {
  constructor(
    readonly code: PublishErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Snapshot {
  games: WeeklyGame[];
  rooms: Room[];
  members: { gameId: string; roomId: string; userId: string }[];
  contributions: Contribution[];
  counter: number;
}

export interface PublishInput {
  userId: string;
  /** Obligatoire pour une case 1; ignoré sinon (la salle est celle du parent). */
  roomId?: string;
  parentId?: string | null;
}

export interface PublishResult {
  contribution: Contribution;
  events: NotificationEvent[];
}

/**
 * Moteur de jeu pur (sans I/O), miroir de `publish_contribution` côté Postgres.
 * Aucune règle ne dépend du jour de la semaine: seule la profondeur de la branche compte.
 */
export class GameEngine {
  private games: WeeklyGame[] = [];
  private rooms: Room[] = [];
  private members: Snapshot['members'] = [];
  private contributions: Contribution[] = [];
  private counter = 0;

  constructor(
    private readonly options: { roomCapacity?: number; abuse?: { max: number; windowMs: number } } = {},
  ) {}

  private get capacity() {
    return this.options.roomCapacity ?? ROOM_CAPACITY;
  }

  private nextId(prefix: string) {
    return `${prefix}_${++this.counter}`;
  }

  snapshot(): Snapshot {
    return structuredClone({
      games: this.games,
      rooms: this.rooms,
      members: this.members,
      contributions: this.contributions,
      counter: this.counter,
    });
  }

  restore(s: Snapshot) {
    const c = structuredClone(s);
    this.games = c.games;
    this.rooms = c.rooms;
    this.members = c.members;
    this.contributions = c.contributions;
    this.counter = c.counter;
  }

  /** Crée la partie de la semaine si besoin (idempotent); un thème enregistré n'est jamais recalculé. */
  ensureGame(moment: Pick<GameMoment, 'isoYear' | 'isoWeek'>, seedOverride?: string): WeeklyGame {
    const seed = seedOverride || weeklySeed(moment.isoYear, moment.isoWeek);
    const existing = this.games.find(
      (g) => g.isoYear === moment.isoYear && g.isoWeek === moment.isoWeek && g.theme.seed === seed,
    );
    if (existing) return existing;
    const game: WeeklyGame = {
      id: this.nextId('game'),
      isoYear: moment.isoYear,
      isoWeek: moment.isoWeek,
      theme: { seed, text: `Thème ${seed}` },
      seedOverridden: !!seedOverride,
    };
    this.games.push(game);
    return game;
  }

  /** Événement à émettre quand `ensureGame` vient de créer le thème de la semaine. */
  themeEvent(game: WeeklyGame): NotificationEvent {
    return newThemeEvent(game.id);
  }

  getGame(id: string): WeeklyGame | undefined {
    return this.games.find((g) => g.id === id);
  }

  /** Une case 1 ne se crée que dans le thème actif (ou une partie privée/de test). */
  isActive(game: WeeklyGame, moment: Pick<GameMoment, 'isoYear' | 'isoWeek'>): boolean {
    return game.seedOverridden || (game.isoYear === moment.isoYear && game.isoWeek === moment.isoWeek);
  }

  /** Rejoint la partie: salle existante du joueur, sinon la première avec une place, sinon une nouvelle. */
  join(gameId: string, userId: string): Room {
    const already = this.members.find((m) => m.gameId === gameId && m.userId === userId);
    if (already) return this.rooms.find((r) => r.id === already.roomId)!;

    const gameRooms = this.rooms.filter((r) => r.gameId === gameId).sort((a, b) => a.number - b.number);
    let room = gameRooms.find((r) => this.memberCount(r.id) < r.capacity);
    if (!room) {
      room = { id: this.nextId('room'), gameId, number: gameRooms.length + 1, capacity: this.capacity };
      this.rooms.push(room);
    }
    this.members.push({ gameId, roomId: room.id, userId });
    return room;
  }

  memberCount(roomId: string): number {
    return this.members.filter((m) => m.roomId === roomId).length;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.find((r) => r.id === roomId);
  }

  roomsOf(gameId: string): Room[] {
    return this.rooms.filter((r) => r.gameId === gameId);
  }

  getContribution(id: string): Contribution | undefined {
    return this.contributions.find((c) => c.id === id);
  }

  isRoomEmpty(roomId: string): boolean {
    return !this.contributions.some((c) => c.roomId === roomId && c.status === 'published');
  }

  /**
   * Cases de la salle que ce joueur peut continuer: publiées, pas finales, pas de lui.
   * Les cases sans suite passent en premier (pas de classement par popularité).
   * Aucun emprunt aux autres salles.
   */
  eligibleParents(roomId: string, userId: string): Contribution[] {
    const childCount = (id: string) => this.children(id).length;
    return this.contributions
      .filter(
        (c) => c.roomId === roomId && c.status === 'published' && c.caseNumber < FINAL_CASE && c.authorId !== userId,
      )
      .sort((a, b) => childCount(a.id) - childCount(b.id) || a.publishedAt - b.publishedAt);
  }

  publish(input: PublishInput, nowMs: number, moment: Pick<GameMoment, 'isoYear' | 'isoWeek'>): PublishResult {
    const { userId } = input;
    const abuse = this.options.abuse ?? DEFAULT_ABUSE_LIMIT;
    const recent = this.contributions.filter((c) => c.authorId === userId && c.publishedAt > nowMs - abuse.windowMs);
    if (recent.length >= abuse.max) {
      throw new PublishError('RATE_LIMITED', 'Trop de publications en peu de temps, réessaie un peu plus tard.');
    }

    let room: Room;
    let parent: Contribution | null = null;
    if (input.parentId) {
      parent = this.getContribution(input.parentId) ?? null;
      if (!parent || parent.status !== 'published') throw new PublishError('PARENT_NOT_FOUND', 'Case introuvable.');
      if (parent.caseNumber >= FINAL_CASE) throw new PublishError('PARENT_IS_FINAL', 'Cette histoire est terminée.');
      if (parent.authorId === userId) {
        throw new PublishError('CANNOT_CONTINUE_OWN', 'Tu ne peux pas continuer ton propre dessin.');
      }
      room = this.getRoom(parent.roomId)!;
    } else {
      const found = input.roomId ? this.getRoom(input.roomId) : undefined;
      if (!found) throw new PublishError('ROOM_NOT_FOUND', 'Salle introuvable.');
      room = found;
      const game = this.getGame(room.gameId)!;
      if (!this.isActive(game, moment)) {
        throw new PublishError('GAME_NOT_ACTIVE', 'Une nouvelle première case se crée dans le thème actif.');
      }
    }

    const isMember = this.members.some((m) => m.roomId === room.id && m.userId === userId);
    if (!isMember) {
      if (this.memberCount(room.id) >= room.capacity) throw new PublishError('ROOM_FULL', 'Cette salle est complète.');
      this.members.push({ gameId: room.gameId, roomId: room.id, userId });
    }

    const contribution: Contribution = {
      id: this.nextId('c'),
      gameId: room.gameId,
      roomId: room.id,
      authorId: userId,
      caseNumber: parent ? ((parent.caseNumber + 1) as CaseNumber) : 1,
      parentId: parent?.id ?? null,
      status: 'published',
      publishedAt: nowMs,
    };
    const hadSiblings = parent ? this.children(parent.id).length > 0 : false;
    this.contributions.push(contribution);
    return { contribution, events: this.buildEvents(contribution, parent, hadSiblings) };
  }

  /** Un destinataire reçoit au plus un événement: terminée > continuation > nouvelle branche. */
  private buildEvents(c: Contribution, parent: Contribution | null, hadSiblings: boolean): NotificationEvent[] {
    if (!parent) return [];
    const path = this.pathTo(c.id);
    const events = new Map<string, NotificationEvent>();
    const add = (userId: string, e: Omit<NotificationEvent, 'userId'>) => {
      if (userId !== c.authorId && !events.has(userId)) events.set(userId, { userId, ...e });
    };

    if (c.caseNumber === FINAL_CASE) {
      for (const p of path) {
        add(p.authorId, { kind: 'story_completed', groupKey: `done:${path[0].id}`, url: `/story/${c.id}` });
      }
    }
    add(parent.authorId, { kind: 'continuation', groupKey: `cont:${parent.id}`, url: `/case/${c.id}` });
    if (hadSiblings) {
      for (const p of path) {
        add(p.authorId, { kind: 'new_branch', groupKey: `branch:${parent.id}`, url: `/story/${c.id}` });
      }
    }
    return [...events.values()];
  }

  children(id: string): Contribution[] {
    return this.contributions.filter((c) => c.parentId === id && c.status === 'published');
  }

  descendants(id: string): Contribution[] {
    const out: Contribution[] = [];
    const queue = [id];
    while (queue.length) {
      for (const child of this.children(queue.shift()!)) {
        out.push(child);
        queue.push(child.id);
      }
    }
    return out;
  }

  /** Chaîne racine -> case donnée. Les cases partagées ne sont jamais dupliquées. */
  pathTo(id: string): Contribution[] {
    const path: Contribution[] = [];
    let current = this.getContribution(id);
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.getContribution(current.parentId) : undefined;
    }
    return path;
  }

  /** Histoires complètes (4 cases) d'une partie, sous forme de chemins. */
  completeStories(gameId: string): Contribution[][] {
    return this.contributions
      .filter((c) => c.gameId === gameId && c.caseNumber === FINAL_CASE && c.status === 'published')
      .sort((a, b) => a.publishedAt - b.publishedAt)
      .map((leaf) => this.pathTo(leaf.id));
  }

  /** Branches inachevées: feuilles de rang < 4, toujours consultables et continuables. */
  unfinishedBranches(gameId: string): Contribution[] {
    return this.contributions.filter(
      (c) =>
        c.gameId === gameId &&
        c.caseNumber < FINAL_CASE &&
        c.status === 'published' &&
        this.children(c.id).length === 0,
    );
  }

  contributionsOf(gameId: string): Contribution[] {
    return this.contributions.filter((c) => c.gameId === gameId);
  }
}
