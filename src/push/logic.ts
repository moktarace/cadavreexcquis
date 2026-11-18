/** Logique pure du service worker et de l'abonnement, séparée pour être testée sans navigateur. */

export interface PushData {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** Accepte uniquement un chemin interne; tout le reste ramène à l'accueil. */
export function internalPath(url: unknown): string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\') ? url : '/';
}

/** Lit le contenu d'une notification reçue; retourne null si elle est illisible (rien n'est alors affiché). */
export function parsePush(raw: string | null | undefined): PushData | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d.title !== 'string' || typeof d.body !== 'string') return null;
    return {
      title: d.title.slice(0, 80),
      body: d.body.slice(0, 240),
      url: internalPath(d.url),
      tag: typeof d.tag === 'string' ? d.tag.slice(0, 120) : 'case-ludique',
    };
  } catch {
    return null;
  }
}

/** Conversion de la clé publique VAPID (base64url) attendue par `pushManager.subscribe`. */
export function urlBase64ToBytes(base64: string): Uint8Array {
  const padded = base64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export type PushSupport =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'ios-not-installed' | 'insecure' | 'no-service-worker' };

export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isSecureContext: boolean;
  isIos: boolean;
  standalone: boolean;
}

/**
 * Sur iPhone et iPad, le Web Push n'existe que pour une application installée sur l'écran d'accueil.
 * On n'affiche jamais de simulation quand une fonction manque.
 */
export function pushSupport(env: PushEnv): PushSupport {
  if (env.isIos && !env.standalone) return { ok: false, reason: 'ios-not-installed' };
  if (!env.isSecureContext) return { ok: false, reason: 'insecure' };
  if (!env.hasServiceWorker) return { ok: false, reason: 'no-service-worker' };
  if (!env.hasPushManager || !env.hasNotification) return { ok: false, reason: 'unsupported' };
  return { ok: true };
}

export const PUSH_SUPPORT_MESSAGES: Record<Exclude<PushSupport, { ok: true }>['reason'], string> = {
  'ios-not-installed':
    'Sur iPhone et iPad, les notifications ne fonctionnent que si Cadavre Exquis est installé sur l’écran d’accueil (Partager > Sur l’écran d’accueil), puis ouvert depuis son icône.',
  insecure: 'Les notifications exigent une connexion sécurisée (HTTPS).',
  'no-service-worker': 'Ce navigateur ne permet pas le fonctionnement hors ligne ni les notifications.',
  unsupported: 'Ce navigateur ne prend pas en charge les notifications Web Push.',
};
