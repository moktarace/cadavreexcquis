/** Parcours « Jouer »: propositions, messages et partage, indépendants du réseau. */

export interface Progress {
  /** Cases publiées en dessous de celle-ci, tous niveaux confondus. */
  descendants: number;
  /** Histoires terminées (case 4) qui descendent de celle-ci. */
  finished: number;
  /** Dernière case 4 issue de celle-ci, pour lire l'histoire complète. */
  finishedLeaf: string | null;
}

/** Ce qui est arrivé à un dessin du joueur, en une phrase sans vocabulaire technique. */
export function progressMessage(caseNumber: number, childCount: number, progress?: Progress): string {
  if (caseNumber === 4) return 'Ton histoire est terminée !';
  if ((progress?.finished ?? 0) > 0) return 'Une histoire complète est née de ton dessin !';
  if (childCount === 0) return 'Personne n’a encore continué ton dessin.';
  if (childCount === 1) return '1 personne a imaginé une suite !';
  return `${childCount} personnes ont imaginé une suite !`;
}

export interface PublishedCopy {
  title: string;
  text: string;
  /** Précision discrète: où retrouver la suite, ou ce qui reste possible. */
  note: string;
}

/** Message après publication, selon la case publiée. */
export function publishedCopy(caseNumber: number): PublishedCopy {
  if (caseNumber >= STORY_LENGTH) {
    return {
      title: 'Votre histoire est terminée !',
      text: 'Vous avez créé une BD en quatre cases !',
      note: 'D’autres joueurs peuvent encore imaginer des suites différentes à partir des cases précédentes.',
    };
  }
  if (caseNumber === 1) {
    return {
      title: 'Ta première case est publiée !',
      text: 'Elle attend maintenant qu’un autre joueur imagine la suite.',
      note: 'Retrouve ton dessin dans Mes dessins pour voir ce que les autres en feront.',
    };
  }
  return {
    title: 'Ta suite est publiée !',
    text: 'Ton dessin rejoint l’histoire. Un autre joueur peut maintenant continuer !',
    note: 'Les continuations imaginées par les autres apparaîtront dans Mes dessins.',
  };
}

export const STORY_LENGTH = 4;

export interface CaseRole {
  /** « Case 3 sur 4 » */
  position: string;
  /** Ce qu'on attend du joueur à cette étape de l'histoire. */
  prompt: string;
  /** Dernière case de ce chemin: l'histoire s'y termine. */
  final: boolean;
}

/** Rôle narratif de la case que le joueur s'apprête à dessiner. */
export function caseRole(caseNumber: number): CaseRole {
  const position = `Case ${caseNumber} sur ${STORY_LENGTH}`;
  switch (caseNumber) {
    case 1:
      return { position, prompt: 'Imagine le début de l’histoire !', final: false };
    case 2:
      return { position, prompt: 'Dessine ce qui se passe ensuite !', final: false };
    case 3:
      return { position, prompt: 'L’histoire approche de sa fin !', final: false };
    default:
      return { position, prompt: 'C’est la dernière case ! Imagine la fin de l’histoire.', final: true };
  }
}

/** « Case 3 sur 4 · Un boulanger jaloux » (le thème d'origine de l'histoire). */
export function briefTitle(caseNumber: number, themeText?: string | null): string {
  const { position } = caseRole(caseNumber);
  return themeText ? `${position} · ${themeText}` : position;
}

/** Libellé du bouton qui ouvre l'éditeur pour continuer une case: la quatrième est une conclusion. */
export function drawLabel(parentCaseNumber: number): string {
  return parentCaseNumber + 1 >= STORY_LENGTH ? 'Dessiner la fin' : 'Dessiner la suite';
}

/** Ce que le joueur doit inventer, à partir de la case qu'on lui propose. */
export function askLabel(caseNumber: number): string {
  return `À toi de dessiner la case ${caseNumber + 1} !`;
}

/** Dessins du joueur dont le nombre de suites a augmenté depuis sa dernière visite à « Mes dessins ». */
export function newContinuations<T extends { id: string; childCount: number }>(cards: readonly T[], seen: Readonly<Record<string, number>>): T[] {
  return cards.filter((c) => c.childCount > (seen[c.id] ?? 0));
}

/** Mélange déterministe pour un générateur donné (Fisher-Yates). */
export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface WindowPlan {
  onlyOpen: boolean;
  offset: number;
}

/**
 * Fenêtre de propositions: parmi les dessins sans suite s'il y en a, sinon parmi tous.
 * La position de départ est tirée au sort; la lecture reste une page de l'ordre total habituel.
 */
export function planWindow(openTotal: number, total: number, size: number, rng: () => number = Math.random): WindowPlan | null {
  const n = openTotal > 0 ? openTotal : total;
  if (n <= 0) return null;
  const offset = n <= size ? 0 : Math.min(n - size, Math.floor(rng() * (n - size + 1)));
  return { onlyOpen: openTotal > 0, offset };
}

/** Prochaine proposition: on évite de rejouer celle qui est affichée, sauf s'il n'y en a pas d'autre. */
export function nextProposals<T extends { id: string }>(pool: readonly T[], currentId: string | null, rng: () => number = Math.random): T[] {
  return shuffle(pool.filter((c) => c.id !== currentId), rng);
}
