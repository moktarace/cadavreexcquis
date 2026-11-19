// Edge Function Deno: supprime des fichiers Supabase Storage listés dans `storage_deletions`.
// Appelée par pg_cron (en-tête `x-dispatch-secret`) ou par un administrateur depuis /admin (jeton de session).
// Déployer avec `--no-verify-jwt`: l'autorisation est vérifiée ici.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { drainQueue, isAuthorized } from '../_shared/purge.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

async function isAdmin(jwt: string): Promise<boolean> {
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data, error } = await asUser.rpc('is_admin');
  return !error && data === true;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const ok = await isAuthorized({
    secretHeader: req.headers.get('x-dispatch-secret'),
    secret: Deno.env.get('DISPATCH_SECRET'),
    authorization: req.headers.get('authorization'),
    isAdmin,
  });
  if (!ok) return new Response('Unauthorized', { status: 401 });

  const result = await drainQueue({
    async claim(limit) {
      const { data, error } = await service.rpc('claim_storage_deletions', { p_limit: limit });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    async remove(bucket, paths) {
      const { error } = await service.storage.from(bucket).remove(paths);
      if (error) throw new Error(error.message);
    },
    async complete(ids) {
      const { error } = await service.rpc('complete_storage_deletions', { p_ids: ids });
      if (error) throw new Error(error.message);
    },
    async fail(id, message) {
      await service.rpc('fail_storage_deletion', { p_id: id, p_error: message });
    },
  });

  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
});
