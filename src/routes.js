import { Router } from 'express';
import multer from 'multer';
import { db, save, uid, now, normalizePhone, logMessage, runAsTenant } from './store.js';
import {
  platform, savePlatform, findTenant, tenantSummary, createTenant, publicPlans, usage, assertAllowed,
  reserveLogin, releaseLogin, createUpgradeRequest, audit,
} from './platform.js';
import {
  ROLES, login, logout, requireAuth, requireRole, requireAdminUser, newApiKey, hashPassword, verifyPassword, validatePassword,
  publicUser, revokeUserTokens,
} from './auth.js';
import {
  listSessions, getSession, startSession, stopSession, sendText, sendMedia, sendButtons, isOnWhatsApp,
} from './whatsapp.js';
import { validateButtons } from './buttons.js';
import { createCampaign, startCampaign, pauseCampaign } from './campaigns.js';
import {
  listTickets, getTicketFor, createTicket, replyToTicket, addNote, updateTicket, ticketStats, withNames,
} from './tickets.js';
import { findDepartment, findUser } from './departments.js';
import { dashboard } from './analytics.js';
import { healthReport, sessionMeta } from './health.js';
import {
  createFlow, updateFlow, deleteFlow, duplicateFlow, findFlow, validateFlow, simulate, TEMPLATE_LIST,
} from './flows.js';
import { getSettings, updateSettings, RECOMMENDED } from './settings.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
const r = Router();

// Wrap async handlers so thrown errors become JSON responses. The handler runs inside the request's
// workspace (multer and other stream callbacks can lose the async context, so we re-enter it here).
const h = (fn) => async (req, res) => {
  try {
    const run = () => fn(req, res);
    const out = await (req.tenantId ? runAsTenant(req.tenantId, run) : run());
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 400).json({ error: e.message });
  }
};
const notFound = (what) => Object.assign(new Error(`${what} not found`), { status: 404 });
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ADMIN = requireRole('admin');
const STAFF = requireRole('admin', 'manager'); // admins and managers

/* ---------- Public (no login): pricing, signup, login ---------- */
r.get('/public/info', h(() => ({
  brandName: platform.settings.brandName, currency: platform.settings.currency, trialDays: platform.settings.trialDays,
  supportEmail: platform.settings.supportEmail, plans: publicPlans(),
})));

// max 5 signups per IP per hour
const signups = new Map();
r.post('/public/signup', h((req) => {
  const ip = req.ip;
  const recent = (signups.get(ip) || []).filter((t) => Date.now() - t < 3600000);
  if (recent.length >= 5) throw Object.assign(new Error('Too many signups from your network. Try again later.'), { status: 429 });
  const { company, name, email, password, website } = req.body || {};
  if (website) throw bad('Signup failed'); // hidden honeypot field — bots fill it in
  const tenant = createTenant({ company, name, email, password }, hashPassword);
  signups.set(ip, [...recent, Date.now()]);
  audit(email, 'tenant.signup', { tenantId: tenant.id, company: tenant.name });
  return login(email, password, ip);
}));

r.post('/auth/login', h((req) => login(req.body?.username || req.body?.email, req.body?.password, req.ip)));

/* Everything below needs a signed-in user or an API key, and runs inside that user's workspace */
r.use(requireAuth);

r.post('/auth/logout', h((req) => {
  logout((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
}));
r.get('/auth/me', h((req) => ({
  ...req.user, tenant: tenantSummary(findTenant(req.tenantId)), brandName: platform.settings.brandName,
})));
r.post('/auth/password', h((req) => {
  const u = findUser(req.user.id);
  if (!u) throw bad('Not available for API keys');
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(currentPassword, u.passwordHash)) throw bad('Current password is wrong');
  validatePassword(newPassword);
  u.passwordHash = hashPassword(newPassword);
  save();
}));

/* ---------- Users (admin) ---------- */
function cleanDeptIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => findDepartment(id)))];
}
const activeAdmins = () => db.users.filter((u) => u.role === 'admin' && u.active);

// Minimal list everyone can read, for "assign to" pickers
r.get('/users/directory', h(() => db.users.filter((u) => u.active)
  .map(({ id, name, role, departmentIds }) => ({ id, name, role, departmentIds }))));

r.get('/users', ADMIN, h(() => db.users.map(publicUser)));
r.post('/users', ADMIN, h((req) => {
  const { name, username, email, password, role = 'agent', departmentIds } = req.body || {};
  const login = String(email || username || '').trim().toLowerCase();
  if (!String(name || '').trim()) throw bad('Name is required');
  if (!EMAIL_RE.test(login)) throw bad('Enter a valid email address (it is used to log in)');
  if (db.users.some((u) => u.username === login)) throw bad('A user with this email already exists');
  if (!ROLES.includes(role)) throw bad(`role must be one of ${ROLES.join(', ')}`);
  validatePassword(password);
  assertAllowed('users');
  reserveLogin(login, req.tenantId); // emails are unique across all workspaces
  const u = {
    id: uid(), username: login, email: login, name: String(name).trim(), role, departmentIds: cleanDeptIds(departmentIds),
    active: true, passwordHash: hashPassword(password), createdAt: now(),
  };
  db.users.push(u);
  save();
  return publicUser(u);
}));
r.patch('/users/:id', ADMIN, h((req) => {
  const u = findUser(req.params.id);
  if (!u) throw notFound('User');
  const b = req.body || {};
  const losesAdmin = u.role === 'admin' && ((b.role && b.role !== 'admin') || b.active === false);
  if (losesAdmin && activeAdmins().length <= 1) throw bad('There must be at least one active admin');
  if (b.name !== undefined) u.name = String(b.name).trim() || u.name;
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) throw bad(`role must be one of ${ROLES.join(', ')}`);
    u.role = b.role;
  }
  if (b.departmentIds !== undefined) u.departmentIds = cleanDeptIds(b.departmentIds);
  if (b.active !== undefined) {
    if (b.active && !u.active) assertAllowed('users');
    u.active = !!b.active;
    if (!u.active) revokeUserTokens(u.id);
  }
  if (b.password) {
    validatePassword(b.password);
    u.passwordHash = hashPassword(b.password);
    revokeUserTokens(u.id);
  }
  save();
  return publicUser(u);
}));
r.delete('/users/:id', ADMIN, h((req) => {
  const u = findUser(req.params.id);
  if (!u) throw notFound('User');
  if (u.id === req.user.id) throw bad("You can't delete your own account");
  if (u.role === 'admin' && activeAdmins().length <= 1) throw bad('There must be at least one active admin');
  for (const t of db.tickets) if (t.assignee === u.id) t.assignee = '';
  revokeUserTokens(u.id);
  db.users = db.users.filter((x) => x !== u);
  releaseLogin(u.username);
  save();
}));

/* ---------- Departments ---------- */
function deptInput(b, d = {}) {
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) throw bad('Department name is required');
    if (db.departments.some((x) => x.id !== d.id && x.name.toLowerCase() === name.toLowerCase())) throw bad('A department with this name exists');
    d.name = name;
  }
  if (b.description !== undefined) d.description = String(b.description);
  if (b.sessionIds !== undefined) d.sessionIds = list(b.sessionIds);
  if (b.keywords !== undefined) d.keywords = list(b.keywords).map((k) => k.toLowerCase());
  if (b.autoAssign !== undefined) d.autoAssign = !!b.autoAssign;
  if (b.isDefault !== undefined) {
    d.isDefault = !!b.isDefault;
    if (d.isDefault) for (const x of db.departments) if (x.id !== d.id) x.isDefault = false;
  }
  return d;
}
r.get('/departments', h(() => db.departments.map((d) => ({
  ...d,
  members: db.users.filter((u) => u.departmentIds?.includes(d.id)).map((u) => ({ id: u.id, name: u.name, role: u.role })),
  activeTickets: db.tickets.filter((t) => t.departmentId === d.id && (t.status === 'open' || t.status === 'pending')).length,
}))));
r.post('/departments', ADMIN, h((req) => {
  if (!req.body?.name) throw bad('Department name is required');
  const d = deptInput(req.body, {
    id: uid(), name: '', description: '', sessionIds: [], keywords: [], autoAssign: false, isDefault: false, createdAt: now(),
  });
  db.departments.push(d);
  save();
  return d;
}));
r.patch('/departments/:id', ADMIN, h((req) => {
  const d = findDepartment(req.params.id);
  if (!d) throw notFound('Department');
  deptInput(req.body || {}, d);
  save();
  return d;
}));
r.delete('/departments/:id', ADMIN, h((req) => {
  const d = findDepartment(req.params.id);
  if (!d) throw notFound('Department');
  for (const t of db.tickets) if (t.departmentId === d.id) t.departmentId = null;
  for (const u of db.users) u.departmentIds = (u.departmentIds || []).filter((x) => x !== d.id);
  db.departments = db.departments.filter((x) => x !== d);
  save();
}));

/* ---------- API keys (admin signed in on the dashboard) ---------- */
r.get('/keys', requireAdminUser, h(() => db.apiKeys.map((k) => ({ ...k, key: k.key.slice(0, 10) + '…' }))));
r.post('/keys', requireAdminUser, h((req) => {
  const k = { id: uid(), name: req.body?.name || 'API key', key: newApiKey(req.tenantId), createdAt: now() };
  db.apiKeys.push(k);
  save();
  return k; // full key shown only once
}));
r.delete('/keys/:id', requireAdminUser, h((req) => {
  db.apiKeys = db.apiKeys.filter((k) => k.id !== req.params.id);
  save();
}));

/* ---------- Sessions (WhatsApp numbers) ---------- */
r.get('/sessions', h(() => listSessions()));
r.post('/sessions', ADMIN, h((req) => startSession(String(req.body?.id || '').trim())));
r.get('/sessions/:id', ADMIN, h((req) => {
  const s = getSession(req.params.id);
  if (!s) throw notFound('Session');
  return { id: s.id, status: s.status, user: s.user || null, qr: s.qrDataUrl || null };
}));
r.get('/sessions/:id/qr', ADMIN, h((req, res) => {
  const s = getSession(req.params.id);
  if (!s) throw notFound('Session');
  if (!s.qrDataUrl) return { status: s.status, qr: null };
  if (req.query.format === 'image') {
    res.type('png').send(Buffer.from(s.qrDataUrl.split(',')[1], 'base64'));
    return;
  }
  return { status: s.status, qr: s.qrDataUrl };
}));
r.delete('/sessions/:id', ADMIN, h((req) => stopSession(req.params.id, { logout: req.query.logout === 'true' })));

/* ---------- Messaging, contacts, campaigns: admins and managers ---------- */
for (const p of ['/check', '/messages', '/contacts', '/campaigns']) r.use(p, STAFF);

r.get('/check/:sessionId/:phone', h(async (req) => ({
  phone: normalizePhone(req.params.phone),
  exists: await isOnWhatsApp(req.params.sessionId, req.params.phone),
})));

r.post('/messages/text', h(async (req) => {
  const { sessionId, to, text } = req.body || {};
  if (!sessionId || !to || !text) throw new Error('sessionId, to and text are required');
  const phone = normalizePhone(to);
  if (db.contacts.find((c) => c.phone === phone)?.optedOut) throw new Error('Contact has opted out');
  try {
    const res = await sendText(sessionId, phone, text);
    logMessage({ sessionId, to: phone, text, status: 'sent', waId: res?.key?.id });
    return { ok: true, messageId: res?.key?.id };
  } catch (e) {
    logMessage({ sessionId, to: phone, text, status: 'failed', error: e.message });
    throw e;
  }
}));

// JSON body with mediaUrl, or multipart/form-data with a "file" field
r.post('/messages/media', upload.single('file'), h(async (req) => {
  const { sessionId, to, caption, mediaUrl, mimetype, fileName } = req.body || {};
  if (!sessionId || !to || (!mediaUrl && !req.file)) throw new Error('sessionId, to and mediaUrl or file are required');
  const phone = normalizePhone(to);
  if (db.contacts.find((c) => c.phone === phone)?.optedOut) throw new Error('Contact has opted out');
  const media = req.file
    ? { buffer: req.file.buffer, mimetype: req.file.mimetype, fileName: req.file.originalname, caption }
    : { url: mediaUrl, mimetype, fileName, caption };
  try {
    const res = await sendMedia(sessionId, phone, media);
    logMessage({ sessionId, to: phone, text: caption || `[media] ${media.fileName || mediaUrl}`, status: 'sent', waId: res?.key?.id });
    return { ok: true, messageId: res?.key?.id };
  } catch (e) {
    logMessage({ sessionId, to: phone, text: caption || '[media]', status: 'failed', error: e.message });
    throw e;
  }
}));

// Image + text + buttons. JSON with imageUrl, or multipart/form-data with an "image" file
// (then send "buttons" as a JSON string).
r.post('/messages/buttons', upload.single('image'), h(async (req) => {
  const { sessionId, to, text, footer, imageUrl } = req.body || {};
  if (!sessionId || !to || !text) throw bad('sessionId, to and text are required');
  const buttons = validateButtons(req.body.buttons);
  const phone = normalizePhone(to);
  if (db.contacts.find((c) => c.phone === phone)?.optedOut) throw bad('Contact has opted out');
  if (req.file && !req.file.mimetype.startsWith('image/')) throw bad('The attachment must be an image');
  const image = req.file ? { buffer: req.file.buffer } : imageUrl ? { url: imageUrl } : null;
  const label = `${image ? '[image] ' : ''}${text}\n[buttons: ${buttons.map((b) => b.title).join(' | ')}]`;
  try {
    const res = await sendButtons(sessionId, phone, { text, footer, image, buttons });
    logMessage({ sessionId, to: phone, text: label, status: 'sent', waId: res?.key?.id });
    return { ok: true, messageId: res?.key?.id };
  } catch (e) {
    logMessage({ sessionId, to: phone, text: label, status: 'failed', error: e.message });
    throw e;
  }
}));

r.get('/messages', h((req) => {
  const { sessionId, campaignId, direction, status, q, from, to, limit = 200 } = req.query;
  const search = String(q || '').toLowerCase();
  const fromTs = from ? new Date(from).getTime() : null;
  const toTs = to ? new Date(to).getTime() : null;
  const matches = db.messages.filter((m) => {
    const ts = new Date(m.createdAt).getTime();
    return (!sessionId || m.sessionId === sessionId) &&
      (!campaignId || m.campaignId === campaignId) &&
      (!direction || m.direction === direction) &&
      (!status || m.status === status) &&
      (!fromTs || ts >= fromTs) &&
      (!toTs || ts <= toTs) &&
      (!search || m.to?.includes(search) || m.text?.toLowerCase().includes(search));
  });
  return { total: matches.length, messages: matches.slice(-Number(limit)).reverse() };
}));

/* ---------- Contacts ---------- */
function upsertContact({ phone, name, tags }) {
  phone = normalizePhone(phone);
  if (phone.length < 8) return null;
  const tagList = (Array.isArray(tags) ? tags : String(tags || '').split(/[;,|]/))
    .map((t) => t.trim()).filter(Boolean);
  let c = db.contacts.find((x) => x.phone === phone);
  if (c) {
    if (name) c.name = name;
    c.tags = [...new Set([...(c.tags || []), ...tagList])];
  } else {
    c = { id: uid(), phone, name: name || '', tags: tagList, optedOut: false, createdAt: now() };
    db.contacts.push(c);
  }
  return c;
}

r.get('/contacts', h((req) => {
  const { tag, q, limit } = req.query;
  const text = String(q || '').trim().toLowerCase();
  const digits = normalizePhone(text);
  const list = db.contacts.filter((c) =>
    (!tag || c.tags?.includes(tag)) &&
    (!text || (digits && c.phone.includes(digits)) || c.name?.toLowerCase().includes(text) ||
      c.tags?.some((t) => t.toLowerCase().includes(text))));
  return limit ? list.slice(0, Number(limit)) : list;
}));
// How many of these phone numbers would be new contacts (for the plan's contact limit)
function newContactCount(phones) {
  const existing = new Set(db.contacts.map((c) => c.phone));
  return new Set(phones.map(normalizePhone).filter((p) => p.length >= 8 && !existing.has(p))).size;
}

r.post('/contacts', h((req) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  assertAllowed('contacts', newContactCount(items.map((i) => i?.phone)));
  const saved = items.map(upsertContact).filter(Boolean);
  save();
  return { saved: saved.length, contacts: saved };
}));

// CSV columns: phone,name,tags  (header row required; tags separated by ; or |)
r.post('/contacts/import', upload.single('file'), h((req) => {
  const csv = req.file ? req.file.buffer.toString('utf8') : String(req.body?.csv || '');
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error('CSV is empty');
  const header = rows.shift().map((x) => x.trim().toLowerCase());
  const idx = (k) => header.indexOf(k);
  if (idx('phone') < 0) throw new Error('CSV needs a "phone" column');
  const extraTags = req.body?.tags || '';
  assertAllowed('contacts', newContactCount(rows.map((row) => row[idx('phone')])));
  let saved = 0;
  for (const row of rows) {
    const tags = [row[idx('tags')] || '', extraTags].join(';');
    if (upsertContact({ phone: row[idx('phone')], name: row[idx('name')] || '', tags })) saved++;
  }
  save();
  return { imported: saved, skipped: rows.length - saved };
}));
r.patch('/contacts/:id', h((req) => {
  const c = db.contacts.find((x) => x.id === req.params.id);
  if (!c) throw notFound('Contact');
  for (const k of ['name', 'tags', 'optedOut']) if (k in req.body) c[k] = req.body[k];
  save();
  return c;
}));
r.delete('/contacts/:id', h((req) => {
  db.contacts = db.contacts.filter((c) => c.id !== req.params.id);
  save();
}));

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/* ---------- Campaigns ---------- */
const summary = ({ recipients, ...c }) => c;
r.get('/campaigns', h(() => db.campaigns.map(summary).reverse()));
r.get('/campaigns/:id', h((req) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) throw notFound('Campaign');
  return c;
}));
r.post('/campaigns', h((req) => {
  const b = req.body || {};
  const hasButtons = Array.isArray(b.buttons) ? b.buttons.length : !!b.buttons;
  const c = createCampaign({
    ...b,
    tags: Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    phones: (Array.isArray(b.phones) ? b.phones : []).map(normalizePhone),
    buttons: hasButtons ? validateButtons(b.buttons) : null,
  });
  if (b.startNow) startCampaign(c.id);
  return summary(c);
}));
r.post('/campaigns/:id/start', h((req) => summary(startCampaign(req.params.id))));
r.post('/campaigns/:id/pause', h((req) => summary(pauseCampaign(req.params.id))));
r.delete('/campaigns/:id', h((req) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (c?.status === 'running') pauseCampaign(c.id);
  db.campaigns = db.campaigns.filter((x) => x.id !== req.params.id);
  save();
}));

/* ---------- Tickets (everyone; non-admins only see their departments) ---------- */
// API keys may name the person acting via "by"; signed-in users always act as themselves.
const actor = (req) => (req.user.apiKey && req.body?.by ? { id: req.user.id, name: String(req.body.by) } : req.user);

r.get('/tickets', h((req) => listTickets(req.user, req.query)));
r.get('/tickets/stats', h((req) => ticketStats(req.user)));
r.get('/tickets/:id', h((req) => withNames(getTicketFor(req.user, req.params.id))));
r.post('/tickets', h(async (req) => {
  const b = req.body || {};
  const u = req.user;
  let departmentId = b.departmentId === undefined ? undefined : (b.departmentId || null);
  if (u.role !== 'admin') {
    // non-admins create tickets in their own departments only
    if (departmentId === undefined || departmentId === null) departmentId = u.departmentIds[0] || null;
    if (departmentId ? !u.departmentIds.includes(departmentId) : u.role !== 'manager') {
      throw bad('You can only create tickets in your own departments');
    }
  }
  const t = createTicket({ ...b, departmentId }, actor(req));
  if (b.message && b.sendMessage) await replyToTicket(t, { text: b.message }, actor(req));
  else if (b.message) addNote(t, { text: b.message }, actor(req));
  return withNames(t);
}));
r.patch('/tickets/:id', h(async (req) =>
  withNames(await updateTicket(getTicketFor(req.user, req.params.id), req.body || {}, actor(req)))));
r.post('/tickets/:id/reply', upload.single('file'), h(async (req) =>
  withNames(await replyToTicket(getTicketFor(req.user, req.params.id), { text: req.body?.text || '', file: req.file }, actor(req)))));
r.post('/tickets/:id/notes', h((req) =>
  withNames(addNote(getTicketFor(req.user, req.params.id), { text: req.body?.text }, actor(req)))));
r.post('/tickets/:id/read', h((req) => {
  getTicketFor(req.user, req.params.id).unread = 0;
  save();
}));
r.delete('/tickets/:id', STAFF, h((req) => {
  const ticket = getTicketFor(req.user, req.params.id);
  db.tickets = db.tickets.filter((t) => t !== ticket);
  save();
}));

/* ---------- Workspace & subscription (workspace admins) ---------- */
r.get('/workspace', ADMIN, h((req) => {
  const t = findTenant(req.tenantId);
  return {
    tenant: tenantSummary(t),
    usage: usage(),
    webhookUrl: db.workspace?.webhookUrl || '',
    plans: publicPlans(),
    currency: platform.settings.currency,
    paymentInstructions: platform.settings.paymentInstructions,
    supportEmail: platform.settings.supportEmail,
    request: platform.requests.find((x) => x.tenantId === t.id && x.status === 'open') || null,
    payments: platform.payments.filter((p) => p.tenantId === t.id).reverse()
      .map(({ at, planName, months, amount, method, reference, periodTo }) => ({ at, planName, months, amount, method, reference, periodTo })),
  };
}));
r.put('/workspace', ADMIN, h((req) => {
  const { name, webhookUrl } = req.body || {};
  if (webhookUrl && !/^https:\/\/\S+$/i.test(webhookUrl)) throw bad('Webhook URL must start with https://');
  if (name !== undefined) {
    if (!String(name).trim()) throw bad('Company name is required');
    findTenant(req.tenantId).name = String(name).trim().slice(0, 80);
    savePlatform();
  }
  if (webhookUrl !== undefined) db.workspace = { ...db.workspace, webhookUrl: String(webhookUrl).trim() };
  save();
}));
r.post('/workspace/upgrade-request', ADMIN, h((req) => {
  const r2 = createUpgradeRequest(req.tenantId, req.body || {}, req.user);
  audit(req.user.username, 'tenant.upgrade_request', { tenantId: req.tenantId, planId: r2.planId });
  return r2;
}));

/* ---------- Chatbot flows (admins and managers) ---------- */
r.use('/flows', STAFF);
r.get('/flows', h(() => db.flows.map(({ nodes, ...f }) => ({ ...f, steps: Object.keys(nodes).length - 1 })).reverse()));
r.get('/flows/templates', h(() => TEMPLATE_LIST));
r.get('/flows/:id', h((req) => {
  const f = findFlow(req.params.id);
  if (!f) throw notFound('Flow');
  return { flow: f, issues: validateFlow(f) };
}));
r.post('/flows', h((req) => createFlow(req.body || {}, req.user)));
r.put('/flows/:id', h((req) => updateFlow(req.params.id, req.body || {})));
r.post('/flows/:id/duplicate', h((req) => duplicateFlow(req.params.id, req.user)));
r.delete('/flows/:id', h((req) => deleteFlow(req.params.id)));
// Test chat: runs the (possibly unsaved) flow without sending anything
r.post('/flows/simulate', h((req) => {
  const { flow, state, input } = req.body || {};
  if (!flow?.nodes) throw bad('flow is required');
  return simulate(flow, state, input);
}));

/* ---------- Block risk & protection settings (admin) ---------- */
r.get('/health', ADMIN, h(() => ({ ...healthReport(), recommended: RECOMMENDED })));
r.get('/settings', ADMIN, h(() => getSettings()));
r.put('/settings', ADMIN, h((req) => updateSettings(req.body || {})));
// Tell the system how old a number really is (for the warm-up schedule)
r.patch('/sessions/:id/meta', ADMIN, h((req) => {
  const meta = sessionMeta(req.params.id);
  const since = req.body?.numberSince;
  if (since && Number.isNaN(Date.parse(since))) throw bad('numberSince must be a date (YYYY-MM-DD)');
  if (since && Date.parse(since) > Date.now()) throw bad('numberSince cannot be in the future');
  meta.numberSince = since ? new Date(since).toISOString() : null;
  save();
  return meta;
}));

/* ---------- Dashboard ---------- */
r.get('/dashboard', h((req) => dashboard(req.user, req.query.days)));

/* ---------- Stats ---------- */
r.get('/stats', h((req) => {
  if (req.user.role === 'agent') return { tickets: ticketStats(req.user) };
  const today = new Date().toISOString().slice(0, 10);
  const todays = db.messages.filter((m) => m.createdAt.startsWith(today));
  return {
    sessions: listSessions().length,
    connected: listSessions().filter((s) => s.status === 'connected').length,
    contacts: db.contacts.length,
    optedOut: db.contacts.filter((c) => c.optedOut).length,
    campaigns: db.campaigns.length,
    sentToday: todays.filter((m) => m.status === 'sent').length,
    failedToday: todays.filter((m) => m.status === 'failed').length,
    receivedToday: todays.filter((m) => m.direction === 'in').length,
    tickets: ticketStats(req.user),
  };
}));

export default r;
