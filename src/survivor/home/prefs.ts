const PREFIX = 'cl.survivor.';

/** Mémoire locale des aides déjà vues; sans stockage disponible, l'aide revient simplement. */
export function seen(id: string): boolean {
  try {
    return localStorage.getItem(PREFIX + id) === '1';
  } catch {
    return false;
  }
}

export function markSeen(id: string) {
  try {
    localStorage.setItem(PREFIX + id, '1');
  } catch {
    /* sans stockage, l'aide se réaffichera */
  }
}

export function forget(id: string) {
  try {
    localStorage.removeItem(PREFIX + id);
  } catch {
    /* rien à effacer */
  }
}

export const TUTORIAL = 'tutorial';
