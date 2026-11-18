/** Partage d'un dessin: un vrai lien vers la case, que quiconque peut ouvrir pour imaginer la suite. */

export function caseShareUrl(origin: string, pathname: string, id: string): string {
  return `${origin}${pathname}#/case/${id}`;
}

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'unavailable';

interface ShareEnv {
  location: Pick<Location, 'origin' | 'pathname'>;
  navigator: Pick<Navigator, 'share' | 'clipboard'>;
}

/** Ouvre le partage du système s'il existe, sinon copie le lien. */
export async function shareCase(id: string, env: ShareEnv = { location: window.location, navigator: window.navigator }): Promise<ShareOutcome> {
  const url = caseShareUrl(env.location.origin, env.location.pathname, id);
  const nav = env.navigator;
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title: 'Cadavre Exquis', text: 'Imagine la suite de mon dessin !', url });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }
  if (nav.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(url);
      return 'copied';
    } catch {
      // presse-papiers refusé
    }
  }
  return 'unavailable';
}

export const SHARE_MESSAGES: Record<ShareOutcome, string | null> = {
  shared: null,
  cancelled: null,
  copied: 'Lien copié ! Envoie-le à quelqu’un pour qu’il imagine la suite.',
  unavailable: 'Le partage n’est pas disponible sur cet appareil.',
};
