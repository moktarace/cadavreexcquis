import { describe, expect, it } from 'vitest';
import { drainQueue, isAuthorized, type PurgeDeps, type QueueItem } from './purge';

function fake(items: QueueItem[], failBucket?: string) {
  const queue = [...items];
  const log = { removed: [] as string[], completed: [] as string[], failed: [] as string[] };
  const deps: PurgeDeps = {
    async claim(limit) {
      return queue.splice(0, limit);
    },
    async remove(bucket, paths) {
      if (bucket === failBucket) throw new Error('storage indisponible');
      log.removed.push(...paths);
    },
    async complete(ids) {
      log.completed.push(...ids);
    },
    async fail(id) {
      log.failed.push(id);
    },
  };
  return { deps, log, queue };
}

const item = (n: number, bucket = 'previews'): QueueItem => ({ id: `i${n}`, bucket, path: `u/${n}.png` });

describe('file de suppression des fichiers', () => {
  it('retire puis confirme chaque fichier, par lots', async () => {
    const { deps, log } = fake([1, 2, 3, 4, 5].map((n) => item(n)));
    const r = await drainQueue(deps, 2);
    expect(r).toEqual({ removed: 5, failed: 0, batches: 3 });
    expect(log.completed).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
  });

  it('ne confirme jamais un fichier dont la suppression a échoué, et s’arrête sans tourner en boucle', async () => {
    const { deps, log } = fake([item(1, 'broken'), item(2, 'broken'), item(3)], 'broken');
    const r = await drainQueue(deps, 10);
    expect(log.completed).toEqual(['i3']);
    expect(log.failed).toEqual(['i1', 'i2']);
    expect(r.removed).toBe(1);
    expect(r.failed).toBe(2);
  });

  it('une file vide ne fait rien', async () => {
    const { deps } = fake([]);
    expect(await drainQueue(deps)).toEqual({ removed: 0, failed: 0, batches: 0 });
  });
});

describe('autorisation de la fonction purge', () => {
  const base = { secret: 's3cret', isAdmin: async (jwt: string) => jwt === 'admin-jwt' };

  it('accepte le secret partagé de la planification', async () => {
    expect(await isAuthorized({ ...base, secretHeader: 's3cret', authorization: null })).toBe(true);
  });

  it('accepte le jeton d’un administrateur, refuse celui d’un joueur ordinaire', async () => {
    expect(await isAuthorized({ ...base, secretHeader: null, authorization: 'Bearer admin-jwt' })).toBe(true);
    expect(await isAuthorized({ ...base, secretHeader: null, authorization: 'Bearer player-jwt' })).toBe(false);
  });

  it('refuse sans identifiants, avec un mauvais secret ou si la vérification échoue', async () => {
    expect(await isAuthorized({ ...base, secretHeader: null, authorization: null })).toBe(false);
    expect(await isAuthorized({ ...base, secretHeader: 'faux', authorization: null })).toBe(false);
    expect(await isAuthorized({ ...base, secret: undefined, secretHeader: 'x', authorization: null })).toBe(false);
    expect(await isAuthorized({ ...base, secretHeader: null, authorization: 'Bearer x', isAdmin: async () => { throw new Error('réseau'); } })).toBe(false);
  });
});
