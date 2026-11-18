import { supabase } from '../backend/client';
import { isIosDevice, isStandalone } from '../app/platform';
import { pushSupport, urlBase64ToBytes, type PushSupport } from './logic';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export interface Prefs {
  /** Rappel hebdomadaire: le nouveau thème. */
  newTheme: boolean;
  /** Activité sociale: continuation de mon dessin, nouvelle branche, histoire terminée. */
  social: boolean;
  /** Heures (0–23, heure de Paris) de la période de silence, ou null. */
  quietStart: number | null;
  quietEnd: number | null;
}

export const DEFAULT_PREFS: Prefs = { newTheme: true, social: true, quietStart: null, quietEnd: null };

export interface PushStatus {
  support: PushSupport;
  /** Clé VAPID publique renseignée dans l'environnement. */
  configured: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  prefs: Prefs | null;
}

function env() {
  return {
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    isSecureContext: window.isSecureContext,
    isIos: isIosDevice(),
    standalone: isStandalone(),
  };
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

function db() {
  if (!supabase) throw new Error('Serveur non configuré.');
  return supabase;
}

function rowOf(prefs: Prefs) {
  return { new_theme: prefs.newTheme, social: prefs.social, quiet_start: prefs.quietStart, quiet_end: prefs.quietEnd };
}

export async function getStatus(userId: string | null): Promise<PushStatus> {
  let support = pushSupport(env());
  const reg = support.ok ? await registration() : null;
  if (support.ok && !reg) support = { ok: false, reason: 'no-service-worker' };
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const sub = reg ? await reg.pushManager.getSubscription() : null;

  let prefs: Prefs | null = null;
  if (sub && userId && supabase) {
    const { data } = await supabase
      .from('push_subscriptions')
      .select('new_theme, social, quiet_start, quiet_end')
      .eq('endpoint', sub.endpoint)
      .eq('user_id', userId)
      .maybeSingle();
    if (data) prefs = { newTheme: data.new_theme, social: data.social, quietStart: data.quiet_start, quietEnd: data.quiet_end };
  }
  return { support, configured: !!VAPID_PUBLIC_KEY, permission, subscribed: !!sub && prefs !== null, prefs };
}

/** À appeler depuis un geste de l'utilisateur (iOS l'exige pour la demande d'autorisation). */
export async function enable(userId: string, prefs: Prefs): Promise<void> {
  if (!VAPID_PUBLIC_KEY) throw new Error('Notifications non configurées (clé VAPID manquante).');
  const reg = await registration();
  if (!reg) throw new Error('Les notifications ne sont disponibles que dans la version installée de l’application.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Autorisation refusée. Tu peux la modifier dans les réglages du navigateur ou du téléphone.');
  }
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(VAPID_PUBLIC_KEY) as BufferSource,
    }));
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('Abonnement invalide.');

  await db().from('push_subscriptions').delete().eq('endpoint', json.endpoint);
  const { error } = await db()
    .from('push_subscriptions')
    .insert({ user_id: userId, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, ...rowOf(prefs) });
  if (error) {
    await sub.unsubscribe();
    throw new Error(error.message);
  }
}

/** Désabonnement immédiat: côté navigateur puis côté serveur. */
export async function disable(userId: string): Promise<void> {
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await db().from('push_subscriptions').delete().eq('endpoint', sub.endpoint).eq('user_id', userId);
    await sub.unsubscribe();
  }
}

export async function savePrefs(userId: string, prefs: Prefs): Promise<void> {
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) throw new Error('Aucun abonnement actif sur cet appareil.');
  const { error } = await db().from('push_subscriptions').update(rowOf(prefs)).eq('endpoint', sub.endpoint).eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/** Au démarrage: garde le serveur aligné quand le navigateur a renouvelé l'abonnement. */
export async function syncSubscription(userId: string): Promise<void> {
  if (!pushSupport(env()).ok || !('Notification' in window) || Notification.permission !== 'granted' || !supabase) return;
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return;
  const { data } = await supabase.from('push_subscriptions').select('id').eq('endpoint', json.endpoint).eq('user_id', userId).maybeSingle();
  if (data) return;
  // Abonnement renouvelé: on ne l'enregistre que si l'utilisateur avait déjà un abonnement ici, avec les mêmes préférences
  const { data: previous } = await supabase
    .from('push_subscriptions')
    .select('new_theme, social, quiet_start, quiet_end')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  if (!previous) return;
  await supabase.from('push_subscriptions').insert({ user_id: userId, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, ...previous });
}
