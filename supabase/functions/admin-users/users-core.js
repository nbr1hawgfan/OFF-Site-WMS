// Shared rules for creating and managing app logins.
// Used by the admin-users Edge Function (Deno) and by the local test harness (Node),
// so the permission rules that are tested are exactly the ones that run.

export const ROLES = ['admin', 'manager', 'operator', 'lift', 'viewer', 'customer'];
const RANK = { customer: 0.5, viewer: 1, lift: 1.5, operator: 2, manager: 3, admin: 4 };
// roles a manager may hand out / manage
const MANAGER_CAN_MANAGE = ['operator', 'lift', 'viewer', 'customer'];

export const LOGIN_DOMAIN = 'wms.logistics-warehouse.com';
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,29}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = msg => new HttpError(400, msg);
const forbidden = msg => new HttpError(403, msg);

// "Mike.Dock" -> { login: "mike.dock", email: "mike.dock@wms.logistics-warehouse.com" }
export function normalizeLogin(raw, domain = LOGIN_DOMAIN) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) throw bad('Enter a username or email.');
  if (v.includes('@')) {
    if (!EMAIL_RE.test(v)) throw bad('That email address does not look right.');
    return { login: v, email: v, isUsername: false };
  }
  if (!USERNAME_RE.test(v)) {
    throw bad('Usernames are 2-30 characters: letters, numbers, dot, dash or underscore.');
  }
  return { login: v, email: `${v}@${domain}`, isUsername: true };
}

function checkPassword(pw) {
  const p = String(pw || '');
  if (p.length < 6) throw bad('Passwords need at least 6 characters.');
  if (p.length > 72) throw bad('Passwords can be at most 72 characters.');
  return p;
}

function canManageRole(callerRole, targetRole) {
  if (callerRole === 'admin') return true;
  if (callerRole === 'manager') return MANAGER_CAN_MANAGE.includes(targetRole);
  return false;
}

/*
  db adapter (implemented differently in Deno and in tests):
    getAppUser(id)                       -> app_users row or null
    listAppUsers()                       -> [app_users rows]
    authInfo(ids)                        -> { [id]: { email, last_sign_in_at } }
    createAuthUser(email, password)      -> id         (confirmed, no email sent)
    deleteAuthUser(id)
    insertAppUser({ id, full_name, role, login })
    updateAppUser(id, patch)
    setPassword(id, password)
    setBanned(id, banned)
    countActiveAdmins()                  -> number
    loginTaken(login)                    -> boolean
*/
export async function handle(body, callerId, db) {
  const caller = await db.getAppUser(callerId);
  if (!caller || !caller.active || !['admin', 'manager'].includes(caller.role)) {
    throw forbidden('Only admins and managers can manage users.');
  }
  const action = body && body.action;

  if (action === 'list') {
    const rows = await db.listAppUsers();
    const info = await db.authInfo(rows.map(r => r.id));
    return {
      users: rows
        .map(r => ({
          id: r.id, full_name: r.full_name, role: r.role, active: r.active, owner_id: r.owner_id || null,
          login: r.login || info[r.id]?.email || '',
          last_sign_in_at: info[r.id]?.last_sign_in_at || null,
          can_manage: r.id !== caller.id && canManageRole(caller.role, r.role)
        }))
        .sort((a, b) => (b.active - a.active) || (RANK[b.role] - RANK[a.role]) || a.full_name.localeCompare(b.full_name)),
      assignable_roles: ROLES.filter(r => canManageRole(caller.role, r)),
      login_domain: LOGIN_DOMAIN
    };
  }

  if (action === 'create') {
    const fullName = String(body.full_name || '').trim();
    if (!fullName) throw bad('Enter the person\'s name.');
    const role = String(body.role || '');
    if (!ROLES.includes(role)) throw bad('Pick a role.');
    if (!canManageRole(caller.role, role)) throw forbidden(`A ${caller.role} cannot create ${role} accounts.`);
    const { login, email } = normalizeLogin(body.login);
    const password = checkPassword(body.password);
    if (await db.loginTaken(login)) throw bad(`${login} is already in use.`);
    const ownerId = role === 'customer' ? String(body.owner_id || '') : null;
    if (role === 'customer' && !ownerId) throw bad('Pick the customer account this login can see.');

    const id = await db.createAuthUser(email, password);
    try {
      await db.insertAppUser({ id, full_name: fullName, role, login, owner_id: ownerId });
    } catch (e) {
      await db.deleteAuthUser(id).catch(() => {});   // don't leave a half-made login behind
      throw e;
    }
    return { id, login, full_name: fullName, role };
  }

  if (action === 'update' || action === 'set_password') {
    const target = await db.getAppUser(body.id);
    if (!target) throw bad('User not found.');
    const self = target.id === caller.id;
    if (!self && !canManageRole(caller.role, target.role)) {
      throw forbidden(`A ${caller.role} cannot change ${target.role} accounts.`);
    }

    if (action === 'set_password') {
      if (self) throw bad('Change your own password from the sign-in screen (Forgot password).');
      await db.setPassword(target.id, checkPassword(body.password));
      return { ok: true };
    }

    const patch = {};
    if (body.full_name !== undefined) {
      const n = String(body.full_name).trim();
      if (!n) throw bad('Name cannot be blank.');
      patch.full_name = n;
    }
    if (body.role !== undefined && body.role !== target.role) {
      if (self) throw bad('You cannot change your own role.');
      if (!ROLES.includes(body.role)) throw bad('Pick a role.');
      if (!canManageRole(caller.role, body.role)) throw forbidden(`A ${caller.role} cannot assign the ${body.role} role.`);
      if (target.role === 'admin' && target.active && (await db.countActiveAdmins()) <= 1) {
        throw bad('This is the last admin. Make someone else an admin first.');
      }
      patch.role = body.role;
    }
    const newRole = patch.role || target.role;
    if (newRole === 'customer') {
      const o = body.owner_id !== undefined ? String(body.owner_id || '') : target.owner_id;
      if (!o) throw bad('Pick the customer account this login can see.');
      if (o !== target.owner_id) patch.owner_id = o;
    } else if (target.owner_id) patch.owner_id = null;
    if (body.active !== undefined && !!body.active !== target.active) {
      if (self) throw bad('You cannot deactivate yourself.');
      if (!body.active && target.role === 'admin' && (await db.countActiveAdmins()) <= 1) {
        throw bad('This is the last admin. Make someone else an admin first.');
      }
      patch.active = !!body.active;
    }
    if (Object.keys(patch).length) await db.updateAppUser(target.id, patch);
    if (patch.active !== undefined) await db.setBanned(target.id, !patch.active);
    return { ok: true, ...patch };
  }

  throw bad('Unknown action.');
}
