export type NotificationKind = 'new_theme' | 'continuation' | 'new_branch' | 'story_completed';

export interface PushMessage {
  title: string;
  body: string;
  /** Chemin relatif ouvert au clic (jamais une URL externe). */
  url: string;
  /** Les notifications de même étiquette se remplacent au lieu de s'empiler. */
  tag: string;
}

export interface NotificationPayload {
  url?: unknown;
  theme?: unknown;
}

export function safePath(url: unknown): string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\') ? url : '/';
}

const many = (n: number, one: string, plural: string) => (n > 1 ? `${n} ${plural}` : one);

/** Texte final d'une notification; le compteur reflète les événements regroupés. */
export function buildMessage(kind: NotificationKind, count: number, payload: NotificationPayload): PushMessage {
  const url = safePath(payload.url);
  const n = Math.max(1, Math.floor(count) || 1);
  switch (kind) {
    case 'new_theme': {
      const theme = typeof payload.theme === 'string' ? payload.theme.slice(0, 120) : 'un nouveau thème';
      return {
        title: 'Nouveau thème',
        body: `Nouvelle histoire cette semaine : ${theme}. À toi de commencer !`,
        url,
        tag: 'new_theme',
      };
    }
    case 'continuation':
      return {
        title: 'Ton dessin a une suite',
        body: `${many(n, 'Quelqu’un a', 'personnes ont')} continué ton dessin ! Découvre ce qui est arrivé à ton personnage.`,
        url,
        tag: `continuation:${url}`,
      };
    case 'new_branch':
      return {
        title: 'Une histoire se ramifie',
        body: `${many(n, 'Une nouvelle branche est apparue', 'nouvelles branches sont apparues')} dans une histoire à laquelle tu as participé.`,
        url,
        tag: `new_branch:${url}`,
      };
    case 'story_completed':
      return {
        title: 'Histoire terminée',
        body:
          n > 1
            ? `${n} histoires contenant ton dessin ont atteint quatre cases !`
            : 'Une histoire contenant ton dessin vient d’atteindre quatre cases !',
        url,
        tag: `story_completed:${url}`,
      };
  }
}
