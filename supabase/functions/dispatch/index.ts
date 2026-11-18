// Edge Function Deno. Déploiement: voir README (section Notifications).
// Appelée chaque minute par pg_cron (pg_net) avec l'en-tête `x-dispatch-secret`.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { dispatch, timingSafeEqual, type Claimed } from '../_shared/dispatch.ts';
import { buildMessage, type NotificationKind } from '../_shared/messages.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'mailto:contact@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const secret = Deno.env.get('DISPATCH_SECRET');
  if (!secret || !timingSafeEqual(req.headers.get('x-dispatch-secret'), secret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const result = await dispatch({
    async claim(limit) {
      const { data, error } = await supabase.rpc('claim_due_notifications', { p_limit: limit });
      if (error) throw new Error(error.message);
      return (data ?? []) as Claimed[];
    },
    buildBody: (row) => JSON.stringify(buildMessage(row.kind as NotificationKind, row.count, row.payload)),
    async send(sub, body) {
      try {
        const res = await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          { TTL: 60 * 60 * 24, urgency: 'normal' },
        );
        return { status: res.statusCode };
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (typeof status === 'number') return { status };
        throw e;
      }
    },
    async removeSubscription(id) {
      await supabase.from('push_subscriptions').delete().eq('id', id);
    },
    async release(id) {
      await supabase.rpc('release_notification', { p_id: id });
    },
  });

  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
});
