export interface Claimed {
  notification_id: string;
  kind: string;
  count: number;
  payload: Record<string, unknown>;
  attempts: number;
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface Deps {
  claim(limit: number): Promise<Claimed[]>;
  /** Envoie une notification chiffrée; retourne le statut HTTP du service push. Peut lever en cas de panne réseau. */
  send(sub: { endpoint: string; p256dh: string; auth: string }, body: string, notificationId: string): Promise<{ status: number }>;
  buildBody(row: Claimed): string;
  removeSubscription(id: string): Promise<void>;
  release(notificationId: string): Promise<void>;
}

export interface DispatchResult {
  notifications: number;
  sent: number;
  removedSubscriptions: number;
  retried: number;
}

/** Comparaison en temps constant pour le secret partagé avec pg_cron. */
export function timingSafeEqual(a: string | null, b: string): boolean {
  if (a === null || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Envoie les notifications réservées. Un abonnement expiré (404/410) est supprimé; une panne temporaire
 * (réseau, 429, 5xx) remet la notification en attente seulement si aucun appareil n'a pu la recevoir.
 */
export async function dispatch(deps: Deps, limit = 100): Promise<DispatchResult> {
  const rows = await deps.claim(limit);
  const byNotification = new Map<string, Claimed[]>();
  for (const r of rows) byNotification.set(r.notification_id, [...(byNotification.get(r.notification_id) ?? []), r]);

  const result: DispatchResult = { notifications: byNotification.size, sent: 0, removedSubscriptions: 0, retried: 0 };

  for (const [notificationId, targets] of byNotification) {
    let delivered = 0;
    let temporaryFailure = false;
    await Promise.all(
      targets.map(async (t) => {
        try {
          const { status } = await deps.send(t, deps.buildBody(t), notificationId);
          if (status >= 200 && status < 300) delivered++;
          else if (status === 404 || status === 410) {
            await deps.removeSubscription(t.subscription_id);
            result.removedSubscriptions++;
          } else temporaryFailure = true;
        } catch {
          temporaryFailure = true;
        }
      }),
    );
    result.sent += delivered;
    if (delivered === 0 && temporaryFailure) {
      await deps.release(notificationId);
      result.retried++;
    }
  }
  return result;
}
