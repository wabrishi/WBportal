// Storage. Every customer workspace ("tenant") has its own JSON file: data/tenants/<tenantId>/db.json.
// `db` always points at the *current* tenant's data, chosen by AsyncLocalStorage: each request,
// WhatsApp event and background job runs inside runAsTenant(tenantId, …). Using `db` outside a tenant
// context throws, so one customer's code path can never read another customer's data by accident.
// Platform-wide data (tenants, plans, super admins) lives in data/platform.json — see platform.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { DATA_DIR } from './paths.js';

export { DATA_DIR };
export const TENANTS_DIR = path.join(DATA_DIR, 'tenants');

const empty = () => ({
  apiKeys: [],     // { id, name, key, createdAt }
  contacts: [],    // { id, phone, name, tags[], optedOut, fields{}, createdAt }
  campaigns: [],   // { id, name, sessionId, message, mediaUrl, tags[], status, stats, createdAt }
  messages: [],    // { id, sessionId, to, text, status, error, campaignId, direction, createdAt }
  dailyCounts: {}, // { "<sessionId>:<YYYY-MM-DD>": n }
  usage: {},       // { "YYYY-MM": messages sent } — for plan limits
  tickets: [],     // see src/tickets.js
  ticketSeq: 1000, // last ticket number issued
  users: [],       // { id, username, name, role, departmentIds[], active, passwordHash, createdAt }
  departments: [], // { id, name, description, sessionIds[], keywords[], autoAssign, isDefault, createdAt }
  authTokens: [],  // { hash, userId, exp } — dashboard logins
  menus: {},       // "<sessionId>:<phone>" -> last button menu sent { buttons, campaignId, sentAt }
  settings: null,  // anti-block protection settings (src/settings.js)
  workspace: {},   // { webhookUrl } — workspace settings
  sessionMeta: {}, // sessionId -> { firstSeenAt, numberSince, events: [{ type, at }] }
  flows: [],       // chatbot flows (src/flows.js)
  flowRuns: {},    // "<sessionId>:<phone>" -> active chatbot conversation
  flowLast: {},    // "<sessionId>:<phone>:<flowId>" -> when that flow last ended (cooldown)
});

/* ---------- tenant context ---------- */
const als = new AsyncLocalStorage();
export const runAsTenant = (tenantId, fn) => als.run(tenantId, fn);
export const currentTenantId = () => als.getStore();

const stores = new Map(); // tenantId -> { data, timer }
const tenantFile = (id) => path.join(TENANTS_DIR, id, 'db.json');
const validId = (id) => /^[a-z0-9-]{3,64}$/.test(String(id));

function storeFor(id) {
  let s = stores.get(id);
  if (!s) {
    if (!validId(id)) throw new Error('Invalid workspace id');
    const file = tenantFile(id);
    const data = fs.existsSync(file) ? { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : empty();
    s = { data, timer: null };
    stores.set(id, s);
  }
  return s;
}
function current() {
  const id = als.getStore();
  if (!id) throw new Error('No workspace selected (tenant context missing)');
  return storeFor(id);
}

// `db.x` reads/writes the current tenant's data.
export const db = new Proxy({}, {
  get: (_, k) => current().data[k],
  set: (_, k, v) => { current().data[k] = v; return true; },
  has: (_, k) => k in current().data,
  ownKeys: () => Reflect.ownKeys(current().data),
  getOwnPropertyDescriptor: (_, k) => ({ ...Reflect.getOwnPropertyDescriptor(current().data, k), configurable: true }),
});

function writeTenant(id) {
  const s = stores.get(id);
  if (!s) return;
  if (s.data.messages.length > 20000) s.data.messages = s.data.messages.slice(-20000); // keep the log bounded
  const file = tenantFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(s.data, null, 2));
  fs.renameSync(file + '.tmp', file);
}

export function save() {
  const id = als.getStore();
  if (!id) throw new Error('No workspace selected (tenant context missing)');
  const s = storeFor(id);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { s.timer = null; writeTenant(id); }, 200);
}

// Write everything now (used on shutdown).
export function flushAll() {
  for (const [id, s] of stores) { clearTimeout(s.timer); writeTenant(id); }
}

export function createTenantStore(id, init = {}) {
  if (!validId(id)) throw new Error('Invalid workspace id');
  if (fs.existsSync(tenantFile(id))) throw new Error('Workspace already exists');
  stores.set(id, { data: { ...empty(), ...init }, timer: null });
  writeTenant(id);
}
export function deleteTenantStore(id) {
  stores.delete(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
}
export const listTenantIds = () =>
  (fs.existsSync(TENANTS_DIR) ? fs.readdirSync(TENANTS_DIR).filter((d) => fs.existsSync(tenantFile(d))) : []);

// Run fn once inside every tenant (startup tasks, background loops).
export async function forEachTenant(fn) {
  for (const id of listTenantIds()) {
    try { await runAsTenant(id, () => fn(id)); } catch (e) { console.error(`[${id}]`, e.message); }
  }
}

/* ---------- helpers (operate on the current tenant) ---------- */
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export function normalizePhone(input) {
  return String(input || '').replace(/\D/g, '');
}

export function logMessage(entry) {
  const msg = { id: uid(), createdAt: now(), direction: 'out', ...entry };
  db.messages.push(msg);
  if (msg.direction === 'out' && msg.status === 'sent') {
    const m = monthKey();
    db.usage[m] = (db.usage[m] || 0) + 1;
  }
  save();
  return msg;
}

export function bumpDaily(sessionId) {
  const key = `${sessionId}:${new Date().toISOString().slice(0, 10)}`;
  db.dailyCounts[key] = (db.dailyCounts[key] || 0) + 1;
  save();
  return db.dailyCounts[key];
}

export function dailyCount(sessionId) {
  return db.dailyCounts[`${sessionId}:${new Date().toISOString().slice(0, 10)}`] || 0;
}
