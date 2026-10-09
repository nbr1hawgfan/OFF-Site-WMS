// admin-users: create and manage WMS logins from inside the app.
// Runs server-side with the project's secret key (never sent to the browser).
// Every request is checked: the caller must be an active admin or manager,
// and the rules in users-core.js decide what they may change.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle, HttpError } from './users-core.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    if (keys.default) return keys.default;
  } catch { /* fall back to legacy key */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // who is calling? (verify the signed-in user's own token)
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json(401, { error: 'Please sign in again.' });

  const ok = <T>(r: { data: T; error: { message: string } | null }) => {
    if (r.error) throw new HttpError(400, r.error.message);
    return r.data;
  };

  const db = {
    getAppUser: async (id: string) =>
      ok(await admin.from('app_users').select('*').eq('id', id).maybeSingle()),
    listAppUsers: async () => ok(await admin.from('app_users').select('*')),
    authInfo: async (ids: string[]) => {
      const out: Record<string, { email: string; last_sign_in_at: string | null }> = {};
      for (let page = 1; page < 20; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw new HttpError(400, error.message);
        for (const u of data.users) if (ids.includes(u.id)) out[u.id] = { email: u.email || '', last_sign_in_at: u.last_sign_in_at || null };
        if (data.users.length < 200) break;
      }
      return out;
    },
    createAuthUser: async (email: string, password: string) => {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) {
        const m = /already.*registered|already exists/i.test(error.message) ? 'That login is already in use.' : error.message;
        throw new HttpError(400, m);
      }
      return data.user.id;
    },
    deleteAuthUser: async (id: string) => { await admin.auth.admin.deleteUser(id); },
    insertAppUser: async (row: Record<string, unknown>) => { ok(await admin.from('app_users').insert(row)); },
    updateAppUser: async (id: string, patch: Record<string, unknown>) => { ok(await admin.from('app_users').update(patch).eq('id', id)); },
    setPassword: async (id: string, password: string) => {
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) throw new HttpError(400, error.message);
    },
    setBanned: async (id: string, banned: boolean) => {
      const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: banned ? '876000h' : 'none' });
      if (error) throw new HttpError(400, error.message);
    },
    countActiveAdmins: async () => {
      const r = await admin.from('app_users').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('active', true);
      if (r.error) throw new HttpError(400, r.error.message);
      return r.count || 0;
    },
    loginTaken: async (login: string) => {
      const r = await admin.from('app_users').select('id').eq('login', login.toLowerCase()).limit(1);
      if (r.error) throw new HttpError(400, r.error.message);
      return (r.data || []).length > 0;
    }
  };

  try {
    const body = await req.json().catch(() => ({}));
    return json(200, await handle(body, who.user.id, db));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json(status, { error: e instanceof Error ? e.message : 'Something went wrong.' });
  }
});
