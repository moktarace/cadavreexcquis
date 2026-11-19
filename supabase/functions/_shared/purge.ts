// Logique de la fonction `purge`, sans dépendance Deno: testable avec Vitest.
import { timingSafeEqual } from './dispatch.ts';

export interface QueueItem {
  id: string;
  bucket: string;
  path: string;
}

export interface PurgeDeps {
  claim(limit: number): Promise<QueueItem[]>;
  /** Retire les fichiers du Storage; lève une erreur si l'appel échoue. Supprimer un fichier absent n'est pas une erreur. */
  remove(bucket: string, paths: string[]): Promise<void>;
  complete(ids: string[]): Promise<void>;
  fail(id: string, error: string): Promise<void>;
}

export interface PurgeResult {
  removed: number;
  failed: number;
  batches: number;
}

/** Vide la file de suppression par lots. Un lot qui n'avance pas arrête la boucle: la reprise se fait au passage suivant. */
export async function drainQueue(deps: PurgeDeps, batchSize = 100, maxBatches = 20): Promise<PurgeResult> {
  const result: PurgeResult = { removed: 0, failed: 0, batches: 0 };
  for (let i = 0; i < maxBatches; i++) {
    const items = await deps.claim(batchSize);
    if (items.length === 0) break;
    result.batches++;
    const byBucket = new Map<string, QueueItem[]>();
    for (const item of items) byBucket.set(item.bucket, [...(byBucket.get(item.bucket) ?? []), item]);
    let progress = 0;
    for (const [bucket, group] of byBucket) {
      try {
        await deps.remove(bucket, group.map((g) => g.path));
        await deps.complete(group.map((g) => g.id));
        result.removed += group.length;
        progress += group.length;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        for (const g of group) await deps.fail(g.id, message);
        result.failed += group.length;
      }
    }
    if (progress === 0) break;
  }
  return result;
}

export interface AuthInput {
  secretHeader: string | null;
  secret: string | undefined;
  authorization: string | null;
  isAdmin: (jwt: string) => Promise<boolean>;
}

/** Appel planifié (secret partagé) ou appel d'un administrateur (jeton de session vérifié côté serveur). */
export async function isAuthorized({ secretHeader, secret, authorization, isAdmin }: AuthInput): Promise<boolean> {
  if (secret && secretHeader && timingSafeEqual(secretHeader, secret)) return true;
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  if (!match) return false;
  try {
    return await isAdmin(match[1]);
  } catch {
    return false;
  }
}
