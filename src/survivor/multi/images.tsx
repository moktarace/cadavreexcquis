import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ToyButton } from '../../ui';
import { signedUrls } from './api';

/** Durée de vie des URL signées demandées par `signedUrls` (1 h): on les renouvelle avant l'échéance. */
export const RENEW_AFTER_MS = 50 * 60_000;

export type ImgStatus = 'loading' | 'ready' | 'error';

/** Un vote n'est possible que sur une image effectivement affichée (améliore le parcours normal; le serveur ne prouve pas que l'arbitre a regardé). */
export const voteEnabled = (status: ImgStatus | undefined) => status === 'ready';

export const IMAGE_HINTS: Record<ImgStatus, string> = {
  loading: 'Chargement du dessin… tu pourras voter dès qu’il s’affiche.',
  ready: '',
  error: 'Dessin indisponible: les votes sont suspendus. Réessaie, ou reviens plus tard (tes votes déjà enregistrés sont conservés).',
};

type Sign = (paths: string[]) => Promise<Record<string, string>>;

/** URL signées en cache: demandées par lot, renouvelées après échéance ou sur demande, jamais en boucle. */
export class UrlCache {
  readonly urls = new Map<string, { url: string; at: number }>();
  /** Chemins pour lesquels le serveur n'a pas donné d'URL (droits, réseau). */
  readonly failed = new Set<string>();
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly sign: Sign = signedUrls,
    private readonly now: () => number = Date.now,
  ) {}

  isStale(path: string) {
    const e = this.urls.get(path);
    return !e || this.now() - e.at > RENEW_AFTER_MS;
  }

  /** Demande les URL manquantes ou périmées (toutes si `force`); une même demande en cours n'est pas répétée. Renvoie vrai si quelque chose a changé. */
  async ensure(paths: readonly string[], force = false): Promise<boolean> {
    const need = [...new Set(paths)].filter((p) => (force || this.isStale(p)) && !this.inflight.has(p));
    if (!need.length) return false;
    const run = (async () => {
      try {
        const got = await this.sign(need);
        const at = this.now();
        for (const p of need) {
          if (got[p]) {
            this.urls.set(p, { url: got[p], at });
            this.failed.delete(p);
          } else this.failed.add(p);
        }
      } catch {
        for (const p of need) this.failed.add(p);
      } finally {
        for (const p of need) this.inflight.delete(p);
      }
    })();
    for (const p of need) this.inflight.set(p, run);
    await run;
    return true;
  }
}

export interface SignedImages {
  url: (path: string) => string | undefined;
  failed: (path: string) => boolean;
  /** Nouvelle URL signée pour un chemin (nouvel essai manuel ou renouvellement après échéance). */
  renew: (path: string) => Promise<void>;
}

export function useSignedImages(paths: readonly string[]): SignedImages {
  const cache = useMemo(() => new UrlCache(), []);
  const [, setTick] = useState(0);
  const key = paths.join('|');
  useEffect(() => {
    let alive = true;
    void cache.ensure(paths).then((changed) => alive && changed && setTick((n) => n + 1));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cache]);
  const renew = useCallback(
    async (path: string) => {
      await cache.ensure([path], true);
      setTick((n) => n + 1);
    },
    [cache],
  );
  return { url: (p) => cache.urls.get(p)?.url, failed: (p) => cache.failed.has(p), renew };
}

/** Image d'une case: signale son état réel (chargement, affichée, erreur), se renouvelle une fois seule, puis propose « Réessayer ». */
export function CaseImage({ path, images, alt, className, onStatus }: { path: string; images: SignedImages; alt: string; className: string; onStatus?: (path: string, status: ImgStatus) => void }) {
  const url = images.url(path);
  // Le résultat est lié à l'URL qui l'a produit: une image déjà en cache peut se charger avant tout effet, rien n'est à remettre à zéro.
  const [result, setResult] = useState<{ url: string; ok: boolean } | null>(null);
  const retried = useRef(false);
  const status: ImgStatus = url && result?.url === url ? (result.ok ? 'ready' : 'error') : images.failed(path) && !url ? 'error' : 'loading';
  const report = useRef(onStatus);
  report.current = onStatus;
  useEffect(() => report.current?.(path, status), [path, status]);

  const onError = () => {
    // Une URL périmée donne une erreur: un seul renouvellement automatique, ensuite c'est au joueur de relancer.
    if (!retried.current) {
      retried.current = true;
      void images.renew(path);
      return;
    }
    setResult({ url: url!, ok: false });
  };
  return (
    <div className="sv-img">
      {url ? (
        <img key={url} className={className} src={url} alt={alt} onLoad={() => { retried.current = false; setResult({ url, ok: true }); }} onError={onError} />
      ) : (
        <div className={`${className} sv-thumb--empty`} role="img" aria-label={status === 'error' ? 'Dessin indisponible' : 'Chargement du dessin'} />
      )}
      {status === 'error' && (
        <div className="sv-img__retry" role="alert">
          <span>Dessin indisponible.</span>
          <ToyButton variant="soft" size="s" icon="rotate" onClick={() => void images.renew(path)}>Réessayer</ToyButton>
        </div>
      )}
    </div>
  );
}
