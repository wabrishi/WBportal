// SaaS platform data: customer workspaces (tenants), plans, payments, super admins.
// Stored in data/platform.json, separate from each workspace's own data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DATA_DIR, db, uid, now, monthKey, createTenantStore, deleteTenantStore, runAsTenant, currentTenantId,
} from './store.js';
import { SESSIONS_DIR } from './paths.js';

const FILE = path.join(DATA_DIR, 'platform.json');
const DAY = 24 * 60 * 60 * 1000;
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Default plans (prices in INR / month). Editable by the super admin. -1 = unlimited.
const DEFAULT_PLANS = [
  { id: 'starter', name: 'Starter', price: 999, active: true,
    limits: { numbers: 1, users: 2, contacts: 2000, messagesPerMonth: 5000, flows: 3 } },
  { id: 'growth', name: 'Growth', price: 2499, active: true, popular: true,
    limits: { numbers: 3, users: 5, contacts: 10000, messagesPerMonth: 25000, flows: 20 } },
  { id: 'business', name: 'Business', price: 5999, active: true,
    limits: { numbers: 10, users: 20, contacts: 50000, messagesPerMonth: 100000, flows: -1 } },
];
const DEFAULT_SETTINGS = {
  brandName: 'WA Marketing',
  trialDays: 14,
  trialPlan: 'growth',
  graceDays: 3, // days after the paid period ends before the account is blocked
  currency: '₹',
  supportEmail: '',
  paymentInstructions: 'Pay by UPI or bank transfer and share the transaction reference with us.\nUPI: yourbusiness@upi\nBank: Your Bank · A/C 0000000000 · IFSC XXXX0000000',
};

const empty = () => ({
  settings: DEFAULT_SETTINGS, plans: DEFAULT_PLANS, tenants: [], superAdmins: [], userIndex: {},
  payments: [], requests: [], authTokens: [], audit: [],
});

fs.mkdirSync(DATA_DIR, { recursive: true });
export const platform = fs.existsSync(FILE) ? { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) } : empty();
platform.settings = { ...DEFAULT_SETTINGS, ...platform.settings };

let timer = null;
export function savePlatform() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(platform, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
  }, 200);
}
export function flushPlatform() {
  clearTimeout(timer);
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(platform, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}
export function audit(by, action, details = {}) {
  platform.audit = [...platform.audit, { at: now(), by, action, ...details }].slice(-2000);
  savePlatform();
}

/* ---------- tenants ---------- */
export const findTenant = (id) => platform.tenants.find((t) => t.id === id);
export const findPlan = (id) => platform.plans.find((p) => p.id === id);
export const currentTenant = () => findTenant(currentTenantId());

const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';
function newTenantId(name) {
  const base = slugify(name);
  let id = base.length >= 3 ? base : `${base}-ws`;
  while (findTenant(id) || id.length < 3) id = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  return id;
}

// Effective subscription state, computed from dates.
export function tenantStatus(t) {
  if (!t) return { state: 'missing', canUse: false };
  const nowMs = Date.now();
  if (t.status === 'suspended') return { state: 'suspended', canUse: false, canLogin: false, message: 'This account is suspended. Please contact support.' };
  if (t.status === 'trial') {
    const left = Math.ceil((new Date(t.trialEndsAt).getTime() - nowMs) / DAY);
    return left > 0
      ? { state: 'trial', canUse: true, canLogin: true, daysLeft: left }
      : { state: 'expired', canUse: false, canLogin: true, message: 'Your free trial has ended. Choose a plan to continue.' };
  }
  if (t.status === 'active') {
    const end = new Date(t.paidUntil).getTime();
    const left = Math.ceil((end - nowMs) / DAY);
    if (left > 0) return { state: 'active', canUse: true, canLogin: true, daysLeft: left };
    if (nowMs < end + platform.settings.graceDays * DAY) {
      return { state: 'grace', canUse: true, canLogin: true, daysLeft: 0, message: 'Your subscription has ended. Renew now to avoid interruption.' };
    }
    return { state: 'expired', canUse: false, canLogin: true, message: 'Your subscription has expired. Renew to continue.' };
  }
  return { state: t.status, canUse: false, canLogin: true };
}

export function tenantSummary(t) {
  const st = tenantStatus(t);
  const plan = findPlan(t.plan);
  return {
    id: t.id, name: t.name, plan: plan ? { id: plan.id, name: plan.name, price: plan.price, limits: plan.limits } : null,
    status: t.status, state: st.state, canUse: st.canUse, daysLeft: st.daysLeft ?? null, message: st.message || null,
    trialEndsAt: t.trialEndsAt || null, paidUntil: t.paidUntil || null, createdAt: t.createdAt,
  };
}

// Creates a workspace with its owner (admin) account. Used by signup, the super admin and migration.
export function createTenant({ company, name, email, password, plan, status = 'trial', trialDays, passwordHash, id }, hashPassword) {
  const login = String(email || '').trim().toLowerCase();
  if (!String(company || '').trim()) throw fail('Company name is required');
  if (!String(name || '').trim()) throw fail('Your name is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login) && !id) throw fail('Enter a valid email address');
  if (platform.userIndex[login]) throw fail('An account with this email already exists. Please log in.');
  if (!passwordHash && String(password || '').length < 8) throw fail('Password must be at least 8 characters');
  const s = platform.settings;
  const tenant = {
    id: id || newTenantId(company),
    name: String(company).trim(),
    ownerEmail: login,
    plan: plan || s.trialPlan,
    status,
    trialEndsAt: status === 'trial' ? new Date(Date.now() + (trialDays ?? s.trialDays) * DAY).toISOString() : null,
    paidUntil: null,
    createdAt: now(),
    notes: '',
  };
  if (!id) {
    createTenantStore(tenant.id, {
      users: [{
        id: uid(), username: login, email: login, name: String(name).trim(), role: 'admin', departmentIds: [],
        active: true, passwordHash: passwordHash || hashPassword(password), createdAt: now(),
      }],
    });
  }
  platform.tenants.push(tenant);
  platform.userIndex[login] = tenant.id;
  savePlatform();
  return tenant;
}

export function deleteTenant(id) {
  const t = findTenant(id);
  if (!t) throw fail('Workspace not found', 404);
  platform.tenants = platform.tenants.filter((x) => x !== t);
  platform.requests = platform.requests.filter((x) => x.tenantId !== id); // payments are kept for your accounts
  for (const [login, tid] of Object.entries(platform.userIndex)) if (tid === id) delete platform.userIndex[login];
  platform.authTokens = platform.authTokens.filter((x) => x.tenantId !== id);
  savePlatform();
  deleteTenantStore(id);
}

/* ---------- logins are unique across the whole platform ---------- */
export const tenantForLogin = (login) => platform.userIndex[String(login || '').trim().toLowerCase()];
export function reserveLogin(login, tenantId) {
  const k = String(login).trim().toLowerCase();
  if (platform.userIndex[k] && platform.userIndex[k] !== tenantId) throw fail('This email is already used by another account');
  platform.userIndex[k] = tenantId;
  savePlatform();
}
export function releaseLogin(login) {
  delete platform.userIndex[String(login).trim().toLowerCase()];
  savePlatform();
}

/* ---------- plan limits (call inside a tenant context) ---------- */
export function usage() {
  const sessionsDir = path.join(SESSIONS_DIR, currentTenantId());
  const numbers = new Set([
    ...(fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []),
    ...Object.keys(db.sessionMeta || {}),
  ]).size;
  return {
    numbers,
    users: db.users.filter((u) => u.active).length,
    contacts: db.contacts.length,
    messagesPerMonth: db.usage?.[monthKey()] || 0,
    flows: db.flows.length,
  };
}

const LIMIT_LABEL = {
  numbers: 'WhatsApp numbers', users: 'users', contacts: 'contacts', messagesPerMonth: 'messages this month', flows: 'chatbot flows',
};

// Throws a friendly 402 error if the workspace can't do this. `adding` = how many will be added.
export function assertAllowed(kind, adding = 1) {
  const t = currentTenant();
  const st = tenantStatus(t);
  if (!st.canUse) throw fail(st.message || 'Your subscription is not active.', 402);
  if (!kind) return;
  const limit = findPlan(t.plan)?.limits?.[kind];
  if (limit == null || limit < 0) return;
  const used = usage()[kind];
  if (used + adding > limit) {
    throw fail(`Your ${findPlan(t.plan).name} plan allows ${limit.toLocaleString()} ${LIMIT_LABEL[kind]}` +
      ` (you have ${used.toLocaleString()}). Upgrade your plan on the Subscription page.`, 402);
  }
}

/* ---------- payments & upgrade requests (manual billing) ---------- */
export function recordPayment(tenantId, { planId, months = 1, amount, method = 'manual', reference = '' }, by) {
  const t = findTenant(tenantId);
  if (!t) throw fail('Workspace not found', 404);
  const plan = findPlan(planId || t.plan);
  if (!plan) throw fail('Plan not found');
  const m = Math.round(Number(months));
  if (!(m >= 1 && m <= 36)) throw fail('Months must be between 1 and 36');
  // extend from the later of now / current paid-until
  const from = Math.max(Date.now(), t.status === 'active' && t.paidUntil ? new Date(t.paidUntil).getTime() : 0);
  const until = new Date(from);
  until.setMonth(until.getMonth() + m);
  const p = {
    id: uid(), tenantId, tenantName: t.name, planId: plan.id, planName: plan.name, months: m,
    amount: amount === '' || amount == null ? plan.price * m : Number(amount),
    method, reference: String(reference || ''), periodFrom: new Date(from).toISOString(), periodTo: until.toISOString(), at: now(), by,
  };
  platform.payments.push(p);
  t.plan = plan.id;
  t.status = 'active';
  t.paidUntil = until.toISOString();
  for (const r of platform.requests) if (r.tenantId === tenantId && r.status === 'open') { r.status = 'done'; r.closedAt = now(); }
  audit(by, 'payment.recorded', { tenantId, amount: p.amount, planId: plan.id, months: m });
  return p;
}

export function createUpgradeRequest(tenantId, { planId, months = 1, message = '', reference = '' }, user) {
  const plan = findPlan(planId);
  if (!plan || !plan.active) throw fail('Choose a valid plan');
  const open = platform.requests.find((r) => r.tenantId === tenantId && r.status === 'open');
  if (open) Object.assign(open, { planId, planName: plan.name, months, message, reference, updatedAt: now() });
  const t = findTenant(tenantId);
  const r = open || {
    id: uid(), tenantId, tenantName: t.name, planId, planName: plan.name, months: Number(months) || 1,
    message: String(message || ''), reference: String(reference || ''), requestedBy: `${user.name} <${user.username}>`,
    status: 'open', createdAt: now(),
  };
  if (!open) platform.requests.push(r);
  savePlatform();
  return r;
}

/* ---------- one-time migration from the single-company version ---------- */
// Moves data/db.json → data/tenants/<id>/db.json and sessions/<number> → sessions/<id>/<number>.
export function migrateLegacy() {
  const legacy = path.join(DATA_DIR, 'db.json');
  if (!fs.existsSync(legacy) || platform.tenants.length) return null;
  const data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  const admin = (data.users || []).find((u) => u.role === 'admin') || {};
  const tenant = createTenant({
    id: 'main', company: process.env.COMPANY_NAME || 'My Company', name: admin.name || 'Administrator',
    email: admin.username || 'admin', passwordHash: admin.passwordHash || 'x', status: 'active',
  });
  tenant.paidUntil = new Date(Date.now() + 3650 * DAY).toISOString(); // your own workspace: 10 years
  tenant.plan = 'business';
  tenant.notes = 'Migrated from the single-company version';
  // logins of all existing users point to this workspace
  for (const u of data.users || []) platform.userIndex[String(u.username).toLowerCase()] = tenant.id;
  data.workspace = { webhookUrl: process.env.WEBHOOK_URL || '' };
  data.authTokens = []; // tokens now carry the workspace id; everyone signs in again once
  const dir = path.join(DATA_DIR, 'tenants', tenant.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(data, null, 2));
  fs.renameSync(legacy, path.join(DATA_DIR, 'db.legacy-backup.json'));
  // WhatsApp logins
  const sDir = SESSIONS_DIR;
  if (fs.existsSync(sDir)) {
    fs.mkdirSync(path.join(sDir, tenant.id), { recursive: true });
    for (const d of fs.readdirSync(sDir)) {
      const from = path.join(sDir, d);
      if (d !== tenant.id && fs.existsSync(path.join(from, 'creds.json'))) fs.renameSync(from, path.join(sDir, tenant.id, d));
    }
  }
  flushPlatform();
  return tenant;
}

// Plans list for the public pricing page.
export const publicPlans = () => platform.plans.filter((p) => p.active)
  .map(({ id, name, price, limits, popular }) => ({ id, name, price, limits, popular: !!popular }));

export { runAsTenant };
