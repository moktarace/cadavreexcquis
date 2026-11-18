export type NotificationKind = 'new_theme' | 'continuation' | 'new_branch' | 'story_completed';

/** Événement à transmettre à la file `notifications`; le regroupement se fait sur (userId, groupKey). */
export interface NotificationEvent {
  /** `null` = diffusion à tous les abonnés au nouveau thème. */
  userId: string | null;
  kind: NotificationKind;
  groupKey: string;
  /** Cible exacte ouverte au clic. */
  url: string;
}

export function newThemeEvent(gameId: string): NotificationEvent {
  return { userId: null, kind: 'new_theme', groupKey: `theme:${gameId}`, url: `/` };
}
