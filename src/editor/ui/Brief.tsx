import { cardPath, gameTheme } from '../../backend/api';
import { useGame } from '../../app/game';
import { briefTitle, caseRole, STORY_LENGTH } from '../../domain/play';
import { useAsync } from '../../pages/shared';

export interface BriefInfo {
  /** Rang de la case qu'on est en train de dessiner. */
  caseNumber: number;
  /** Thème d'origine de l'histoire (celui de la semaine pour une case 1, même plusieurs semaines après). */
  themeText: string | null;
}

/** Où se place ce dessin dans l'histoire, et sur quel thème. Null tant que le fil n'est pas connu. */
export function useBrief(parentId: string | null): BriefInfo | null {
  const { game } = useGame();
  const parent = useAsync(async () => {
    if (!parentId) return null;
    const path = await cardPath(parentId);
    return path[path.length - 1] ?? null;
  }, [parentId]);
  const theme = useAsync(async () => (parent.data ? (await gameTheme(parent.data.gameId)).themeText : null), [parent.data?.gameId]);
  if (!parentId) return { caseNumber: 1, themeText: game?.themeText ?? null };
  if (!parent.data) return null;
  return { caseNumber: Math.min(parent.data.caseNumber + 1, STORY_LENGTH), themeText: theme.data };
}

/** Repère discret: « Case 3 sur 4 · thème » puis la consigne de cette étape. */
export function Brief({ info }: { info: BriefInfo }) {
  const role = caseRole(info.caseNumber);
  return (
    <div className={`ed-brief ${role.final ? 'is-final' : ''}`} role="note">
      <strong>{briefTitle(info.caseNumber, info.themeText)}</strong>
      <span>{role.prompt}</span>
    </div>
  );
}
