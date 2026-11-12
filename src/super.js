// Super admin API (/api/super): you, the platform owner, manage customer workspaces, plans and billing.
import { Router } from 'express';
import { db, runAsTenant, monthKey } from './store.js';
import {
  platform, savePlatform, findTenant, findPlan, tenantSummary, tenantStatus, createTenant, deleteTenant, usage,
  recordPayment, audit,
} from './platform.js';
import {
  superLogin, superLogout, requireSuperAdmin, changeSuperPassword, impersonate, hashPassword, needsSetup, setupSuperAdmin,
} from './auth.js';
import { listSessions, stopTenantSessions, restoreTenantSessions, deleteTenantSessionFiles } from './whatsapp.js';

const r = Router();
const DAY = 24 * 60 * 60 * 1000;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 400).json({ error: e.message });
  }
};
const tenantOr404 = (id) => findTenant(id) || (() => { throw bad('Workspace not found', 404); })();

r.post('/login', h((req) => superLogin(req.body?.email, req.body?.password, req.ip)));
// First-run setup (create the first super admin in the browser)
r.get('/setup', h(() => ({ needed: needsSetup(), keyRequired: !!process.env.SETUP_KEY })));
r.post('/setup', h((req) => {
  const out = setupSuperAdmin(req.body || {}, req.ip);
  audit(out.admin.email, 'superadmin.setup');
  return out;
}));
r.use(requireSuperAdmin);
r.post('/logout', h((req) => superLogout((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))));
r.get('/me', h((req) => req.admin));
r.post('/password', h((req) => changeSuperPassword(req.admin.id, req.body?.currentPassword, req.body?.newPassword)));

/* ---------- workspaces ---------- */
function tenantRow(t) {
  return runAsTenant(t.id, () => {
    const sessions = listSessions();
    const owner = db.users.find((u) => u.role === 'admin') || {};
    return {
      ...tenantSummary(t),
      ownerEmail: t.ownerEmail, ownerName: owner.name || '', notes: t.notes || '',
      usage: usage(),
      connected: sessions.filter((s) => s.status === 'connected').length,
      lastLoginAt: db.users.map((u) => u.lastLoginAt).filter(Boolean).sort().pop() || null,
      openRequest: platform.requests.find((x) => x.tenantId === t.id && x.status === 'open') || null,
    };
  });
}

r.get('/overview', h(() => {
  const rows = platform.tenants.map(tenantRow);
  const by = (s) => rows.filter((x) => x.state === s).length;
  const paying = rows.filter((x) => x.state === 'active' || x.state === 'grace');
  const thisMonth = monthKey();
  const revenueThisMonth = platform.payments.filter((p) => p.at.startsWith(thisMonth)).reduce((s, p) => s + p.amount, 0);
  return {
    currency: platform.settings.currency,
    tenants: rows.length,
    states: { trial: by('trial'), active: by('active'), grace: by('grace'), expired: by('expired'), suspended: by('suspended') },
    mrr: paying.reduce((s, x) => s + (x.plan?.price || 0), 0),
    revenueThisMonth,
    messagesThisMonth: rows.reduce((s, x) => s + x.usage.messagesPerMonth, 0),
    connectedNumbers: rows.reduce((s, x) => s + x.connected, 0),
    signups30d: rows.filter((x) => Date.now() - new Date(x.createdAt).getTime() < 30 * DAY).length,
    trialsEndingSoon: rows.filter((x) => x.state === 'trial' && x.daysLeft <= 3)
      .map((x) => ({ id: x.id, name: x.name, daysLeft: x.daysLeft, ownerEmail: x.ownerEmail })),
    renewalsDue: rows.filter((x) => (x.state === 'active' && x.daysLeft <= 7) || x.state === 'grace')
      .map((x) => ({ id: x.id, name: x.name, daysLeft: x.daysLeft, state: x.state, ownerEmail: x.ownerEmail })),
    openRequests: platform.requests.filter((x) => x.status === 'open').length,
    recentPayments: platform.payments.slice(-5).reverse(),
  };
}));

r.get('/tenants', h(() => platform.tenants.map(tenantRow).reverse()));

r.get('/tenants/:id', h((req) => {
  const t = tenantOr404(req.params.id);
  return {
    ...tenantRow(t),
    users: runAsTenant(t.id, () => db.users.map(({ id, name, username, role, active, lastLoginAt }) => ({ id, name, email: username, role, active, lastLoginAt }))),
    numbers: runAsTenant(t.id, () => listSessions()),
    payments: platform.payments.filter((p) => p.tenantId === t.id).reverse(),
    requests: platform.requests.filter((p) => p.tenantId === t.id).reverse(),
  };
}));

r.post('/tenants', h((req) => {
  const b = req.body || {};
  if (b.plan && !findPlan(b.plan)) throw bad('Plan not found');
  const t = createTenant({
    company: b.company, name: b.name, email: b.email, password: b.password, plan: b.plan,
    status: 'trial', trialDays: b.trialDays !== undefined ? Number(b.trialDays) : undefined,
  }, hashPassword);
  audit(req.admin.email, 'tenant.created', { tenantId: t.id });
  return tenantRow(t);
}));

r.patch('/tenants/:id', h(async (req) => {
  const t = tenantOr404(req.params.id);
  const b = req.body || {};
  const before = tenantStatus(t).canUse;
  if (b.name !== undefined) t.name = String(b.name).trim() || t.name;
  if (b.notes !== undefined) t.notes = String(b.notes);
  if (b.plan !== undefined) { if (!findPlan(b.plan)) throw bad('Plan not found'); t.plan = b.plan; }
  if (b.status !== undefined) {
    if (!['trial', 'active', 'suspended'].includes(b.status)) throw bad('Invalid status');
    t.status = b.status;
    if (b.status === 'trial' && !t.trialEndsAt) t.trialEndsAt = new Date(Date.now() + 7 * DAY).toISOString();
    if (b.status === 'active' && !t.paidUntil) t.paidUntil = new Date(Date.now() + 30 * DAY).toISOString();
  }
  if (b.trialEndsAt !== undefined) t.trialEndsAt = new Date(b.trialEndsAt).toISOString();
  if (b.paidUntil !== undefined) t.paidUntil = new Date(b.paidUntil).toISOString();
  savePlatform();
  audit(req.admin.email, 'tenant.updated', { tenantId: t.id, changes: Object.keys(b) });
  const after = tenantStatus(t).canUse;
  if (before && !after) stopTenantSessions(t.id);
  if (!before && after) restoreTenantSessions(t.id).catch(() => {});
  return tenantRow(t);
}));

r.post('/tenants/:id/extend-trial', h((req) => {
  const t = tenantOr404(req.params.id);
  const days = Math.round(Number(req.body?.days));
  if (!(days >= 1 && days <= 365)) throw bad('Days must be between 1 and 365');
  const wasUsable = tenantStatus(t).canUse;
  const from = Math.max(Date.now(), t.trialEndsAt ? new Date(t.trialEndsAt).getTime() : 0);
  t.status = 'trial';
  t.trialEndsAt = new Date(from + days * DAY).toISOString();
  savePlatform();
  audit(req.admin.email, 'tenant.trial_extended', { tenantId: t.id, days });
  if (!wasUsable) restoreTenantSessions(t.id).catch(() => {});
  return tenantRow(t);
}));

r.post('/tenants/:id/payments', h((req) => {
  const t = tenantOr404(req.params.id);
  const wasUsable = tenantStatus(t).canUse;
  const p = recordPayment(t.id, req.body || {}, req.admin.email);
  if (!wasUsable) restoreTenantSessions(t.id).catch(() => {});
  return p;
}));

r.post('/tenants/:id/impersonate', h((req) => {
  const t = tenantOr404(req.params.id);
  audit(req.admin.email, 'tenant.impersonated', { tenantId: t.id });
  return impersonate(t.id, req.admin.email);
}));

r.delete('/tenants/:id', h((req) => {
  const t = tenantOr404(req.params.id);
  if (String(req.body?.confirm || '').trim() !== t.name) throw bad(`Type the workspace name "${t.name}" to confirm`);
  stopTenantSessions(t.id);
  deleteTenantSessionFiles(t.id);
  deleteTenant(t.id);
  audit(req.admin.email, 'tenant.deleted', { tenantId: t.id, name: t.name });
}));

/* ---------- billing ---------- */
r.get('/payments', h(() => platform.payments.slice().reverse()));
r.get('/requests', h(() => platform.requests.slice().reverse()));
r.post('/requests/:id/close', h((req) => {
  const x = platform.requests.find((q) => q.id === req.params.id);
  if (!x) throw bad('Request not found', 404);
  x.status = 'closed';
  x.closedAt = new Date().toISOString();
  savePlatform();
}));

/* ---------- plans ---------- */
r.get('/plans', h(() => platform.plans));
r.put('/plans', h((req) => {
  const list = req.body?.plans;
  if (!Array.isArray(list) || !list.length) throw bad('Send at least one plan');
  const ids = new Set();
  const clean = list.map((p) => {
    const id = String(p.id || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{2,30}$/.test(id) || ids.has(id)) throw bad(`Invalid or duplicate plan id "${p.id}"`);
    ids.add(id);
    if (!String(p.name || '').trim()) throw bad('Every plan needs a name');
    const lim = (k) => { const v = Math.round(Number(p.limits?.[k])); if (!Number.isFinite(v) || v < -1) throw bad(`${p.name}: invalid ${k}`); return v; };
    return {
      id, name: String(p.name).trim(), price: Math.max(0, Number(p.price) || 0), active: p.active !== false, popular: !!p.popular,
      limits: { numbers: lim('numbers'), users: lim('users'), contacts: lim('contacts'), messagesPerMonth: lim('messagesPerMonth'), flows: lim('flows') },
    };
  });
  for (const t of platform.tenants) if (!ids.has(t.plan)) throw bad(`Plan "${t.plan}" is used by ${t.name}; move them to another plan first`);
  if (!ids.has(platform.settings.trialPlan)) throw bad('The trial plan must exist (change it in Settings first)');
  platform.plans = clean;
  savePlatform();
  audit(req.admin.email, 'plans.updated');
  return platform.plans;
}));

/* ---------- platform settings ---------- */
r.get('/settings', h(() => platform.settings));
r.put('/settings', h((req) => {
  const b = req.body || {};
  const s = platform.settings;
  if (b.brandName !== undefined) s.brandName = String(b.brandName).trim().slice(0, 60) || s.brandName;
  if (b.trialDays !== undefined) { const d = Math.round(Number(b.trialDays)); if (!(d >= 0 && d <= 90)) throw bad('Trial days must be 0–90'); s.trialDays = d; }
  if (b.trialPlan !== undefined) { if (!findPlan(b.trialPlan)) throw bad('Trial plan not found'); s.trialPlan = b.trialPlan; }
  if (b.graceDays !== undefined) { const d = Math.round(Number(b.graceDays)); if (!(d >= 0 && d <= 30)) throw bad('Grace days must be 0–30'); s.graceDays = d; }
  if (b.currency !== undefined) s.currency = String(b.currency).slice(0, 5);
  if (b.supportEmail !== undefined) s.supportEmail = String(b.supportEmail).trim();
  if (b.paymentInstructions !== undefined) s.paymentInstructions = String(b.paymentInstructions).slice(0, 2000);
  savePlatform();
  audit(req.admin.email, 'settings.updated');
  return s;
}));

r.get('/audit', h(() => platform.audit.slice(-300).reverse()));

export default r;
