// Users, logins and permissions.
// - Workspace users sign in with email/password and get a Bearer token "<workspaceId>.<secret>".
// - Integrations use API keys "wak_<workspaceId>_<secret>" (x-api-key), which act with admin rights.
// - Super admins (you, the platform owner) have separate accounts and "sa.<secret>" tokens.
// Every authenticated request then runs inside its workspace (runAsTenant), so `db` is that workspace's data.
import crypto from 'node:crypto';
import { db, save, uid, now, runAsTenant, listTenantIds } from './store.js';
import { platform, savePlatform, tenantForLogin, findTenant, tenantStatus } from './platform.js';

export const ROLES = ['admin', 'manager', 'agent'];
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const fail = (msg, status) => Object.assign(new Error(msg), { status });

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  return safeEqual(crypto.scryptSync(String(pw), salt, 64).toString('hex'), hash);
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

export const publicUser = ({ passwordHash, ...u }) => u;

export function validatePassword(pw) {
  if (String(pw || '').length < 8) throw fail('Password must be at least 8 characters', 400);
}

/* ---------- brute-force protection: max 10 failed logins per email+IP per 15 minutes ---------- */
const attempts = new Map();
function checkAttempts(key) {
  const a = attempts.get(key);
  if (a && a.count >= 10 && Date.now() - a.first < 15 * 60 * 1000) throw fail('Too many failed attempts. Try again in 15 minutes.', 429);
}
function noteFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > 15 * 60 * 1000) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}

/* ---------- workspace users ---------- */
export function issueToken(tenantId, userId, extra = {}) {
  const secret = crypto.randomBytes(32).toString('hex');
  db.authTokens = db.authTokens.filter((t) => t.exp > Date.now());
  db.authTokens.push({ hash: sha256(secret), userId, exp: Date.now() + TOKEN_TTL_MS, ...extra });
  save();
  return `${tenantId}.${secret}`;
}

export function login(loginName, password, ip = '') {
  const name = String(loginName || '').trim().toLowerCase();
  const key = `${name}|${ip}`;
  checkAttempts(key);
  const tenantId = tenantForLogin(name);
  const tenant = tenantId && findTenant(tenantId);
  const result = tenant && runAsTenant(tenantId, () => {
    const u = db.users.find((x) => x.username === name || x.email === name);
    const ok = verifyPassword(password, u?.passwordHash || DUMMY_HASH);
    if (!u || !ok || !u.active) return null;
    u.lastLoginAt = now();
    return { token: issueToken(tenantId, u.id), user: publicUser(u) };
  });
  if (!tenant) verifyPassword(password, DUMMY_HASH); // same timing whether or not the account exists
  if (!result) { noteFailure(key); throw fail('Invalid email or password', 401); }
  const st = tenantStatus(tenant);
  if (!st.canLogin) throw fail(st.message, 403);
  attempts.delete(key);
  return result;
}

// Super admin "log in as" a workspace's owner, for support.
export function impersonate(tenantId, adminEmail) {
  return runAsTenant(tenantId, () => {
    const owner = db.users.find((u) => u.role === 'admin' && u.active);
    if (!owner) throw fail('This workspace has no active admin user', 400);
    return { token: issueToken(tenantId, owner.id, { impersonatedBy: adminEmail }), user: publicUser(owner) };
  });
}

const splitToken = (token) => {
  const i = token.indexOf('.');
  return i > 0 ? [token.slice(0, i), token.slice(i + 1)] : [null, token];
};

export function logout(token) {
  const [, secret] = splitToken(token);
  const hash = sha256(secret);
  db.authTokens = db.authTokens.filter((t) => t.hash !== hash);
  save();
}

export function revokeUserTokens(userId) {
  db.authTokens = db.authTokens.filter((t) => t.userId !== userId);
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

// Which workspace (and user) is this request for?
function identify(req) {
  const token = bearer(req);
  if (token && !token.startsWith('sa.')) {
    const [tenantId, secret] = splitToken(token);
    if (tenantId && findTenant(tenantId)) {
      const user = runAsTenant(tenantId, () => {
        const hash = sha256(secret);
        const t = db.authTokens.find((x) => x.hash === hash && x.exp > Date.now());
        const u = t && db.users.find((x) => x.id === t.userId && x.active);
        return u ? { ...publicUser(u), ...(t.impersonatedBy ? { impersonatedBy: t.impersonatedBy } : {}) } : null;
      });
      if (user) return { tenantId, user };
    }
  }
  const key = String(req.headers['x-api-key'] || '');
  if (key) {
    const m = key.match(/^wak_([a-z0-9-]+)_[a-f0-9]+$/);
    const candidates = m ? [m[1]] : listTenantIds(); // keys made before workspaces existed carry no id
    for (const tenantId of candidates) {
      if (!findTenant(tenantId)) continue;
      const k = runAsTenant(tenantId, () => db.apiKeys.find((x) => safeEqual(x.key, key)));
      if (k) return { tenantId, user: { id: `api:${k.id}`, name: `API: ${k.name}`, role: 'admin', departmentIds: [], apiKey: true } };
    }
  }
  return null;
}

export function requireAuth(req, res, next) {
  const who = identify(req);
  if (!who) return res.status(401).json({ error: 'Unauthorized: send "Authorization: Bearer <token>" or "x-api-key: <key>"' });
  const st = tenantStatus(findTenant(who.tenantId));
  if (!st.canLogin) return res.status(403).json({ error: st.message });
  req.user = who.user;
  req.tenantId = who.tenantId;
  runAsTenant(who.tenantId, next); // everything after this runs inside the workspace
}

// Use after requireAuth.
export const requireRole = (...roles) => (req, res, next) => {
  if (roles.includes(req.user?.role)) return next();
  res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
};

// Dashboard admin signed in as a person (not an API key), e.g. for managing API keys.
export function requireAdminUser(req, res, next) {
  if (req.user?.role === 'admin' && !req.user.apiKey) return next();
  res.status(403).json({ error: 'Admin login required' });
}

export const newApiKey = (tenantId) => `wak_${tenantId}_${crypto.randomBytes(24).toString('hex')}`;

/* ---------- super admins (platform owner) ---------- */
// The first super admin comes from SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD if both are set;
// otherwise you create it in the browser on the first visit to /admin (see setupSuperAdmin).
export function ensureSuperAdmin() {
  if (platform.superAdmins.length) return;
  const email = String(process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD;
  if (!email || !password) {
    console.log('No super admin yet: open /admin in your browser to create one.');
    return;
  }
  platform.superAdmins.push({ id: uid(), email, name: 'Platform owner', passwordHash: hashPassword(password), createdAt: now() });
  savePlatform();
}

export const needsSetup = () => platform.superAdmins.length === 0;

// One-time browser setup. Only works while no super admin exists. If SETUP_KEY is set in the
// environment, it must be entered too (protects a fresh deployment before you get to it).
export function setupSuperAdmin({ email, password, name, setupKey }, ip = '') {
  if (!needsSetup()) throw fail('Setup is already complete. Log in instead.', 409);
  if (process.env.SETUP_KEY && !safeEqual(String(setupKey || ''), process.env.SETUP_KEY)) throw fail('Wrong setup key', 403);
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw fail('Enter a valid email address', 400);
  if (String(password || '').length < 10) throw fail('Use a password of at least 10 characters', 400);
  platform.superAdmins.push({ id: uid(), email: e, name: String(name || 'Platform owner').trim(), passwordHash: hashPassword(password), createdAt: now() });
  savePlatform();
  return superLogin(e, password, ip);
}

export function superLogin(email, password, ip = '') {
  const e = String(email || '').trim().toLowerCase();
  const key = `sa|${e}|${ip}`;
  checkAttempts(key);
  const a = platform.superAdmins.find((x) => x.email === e);
  if (!verifyPassword(password, a?.passwordHash || DUMMY_HASH) || !a) { noteFailure(key); throw fail('Invalid email or password', 401); }
  attempts.delete(key);
  const secret = crypto.randomBytes(32).toString('hex');
  platform.authTokens = platform.authTokens.filter((t) => t.exp > Date.now());
  platform.authTokens.push({ hash: sha256(secret), adminId: a.id, exp: Date.now() + TOKEN_TTL_MS });
  savePlatform();
  return { token: `sa.${secret}`, admin: { id: a.id, email: a.email, name: a.name } };
}

export function requireSuperAdmin(req, res, next) {
  const token = bearer(req);
  if (token.startsWith('sa.')) {
    const hash = sha256(token.slice(3));
    const t = platform.authTokens.find((x) => x.hash === hash && x.exp > Date.now());
    const a = t && platform.superAdmins.find((x) => x.id === t.adminId);
    if (a) { req.admin = { id: a.id, email: a.email, name: a.name }; return next(); }
  }
  res.status(401).json({ error: 'Super admin login required' });
}
export function superLogout(token) {
  const hash = sha256(String(token).slice(3));
  platform.authTokens = platform.authTokens.filter((t) => t.hash !== hash);
  savePlatform();
}
export function changeSuperPassword(adminId, current, next) {
  const a = platform.superAdmins.find((x) => x.id === adminId);
  if (!a || !verifyPassword(current, a.passwordHash)) throw fail('Current password is wrong', 400);
  validatePassword(next);
  a.passwordHash = hashPassword(next);
  savePlatform();
}
