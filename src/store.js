// Storage. Every customer workspace ("tenant") has its own data, saved in MySQL (or JSON files when no
// database is configured — see storage.js). It is loaded into memory at startup (loadStores) and
// written back shortly after each change (save).
// `db` always points at the *current* tenant's data, chosen by AsyncLocalStorage: each request,
// WhatsApp event and background job runs inside runAsTenant(tenantId, …). Using `db` outside a tenant
// context throws, so one customer's code path can never read another customer's data by accident.
// Platform-wide data (tenants, plans, super admins) is kept separately — see platform.js.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { DATA_DIR } from './paths.js';
import * as storage from './storage.js';

export { DATA_DIR };

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
  workspace: {},   // { webhookUrl, webhookSecret } — workspace settings
  webhookOutbox: [], // outgoing webhook events waiting for (re)delivery, see src/webhook.js
  sessionMeta: {}, // sessionId -> { firstSeenAt, numberSince, events: [{ type, at }] }
  flows: [],       // chatbot flows (src/flows.js)
  flowRuns: {},    // "<sessionId>:<phone>" -> active chatbot conversation
  flowLast: {},    // "<sessionId>:<phone>:<flowId>" -> when that flow last ended (cooldown)
});

/* ---------- tenant context ---------- */
const als = new AsyncLocalStorage();
export const runAsTenant = (tenantId, fn) => als.run(tenantId, fn);
export const currentTenantId = () => als.getStore();

const stores = new Map(); // tenantId -> { data, timer, exists }
const validId = (id) => /^[a-z0-9-]{3,64}$/.test(String(id));
// Batch changes: a campaign or a chat burst touches the data many times a second.
const SAVE_DELAY_MS = storage.USE_MYSQL ? 1000 : 200;

// Loads every workspace into memory. Called once at startup, before anything else uses `db`.
export async function loadStores() {
  for (const [id, data] of await storage.loadTenants()) {
    if (validId(id)) stores.set(id, { data: { ...empty(), ...data }, timer: null, exists: true });
  }
}

function storeFor(id) {
  let s = stores.get(id);
  if (!s) {
    if (!validId(id)) throw new Error('Invalid workspace id');
    s = { data: empty(), timer: null, exists: false };
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

async function writeTenant(id) {
  const s = stores.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = null;
  if (s.data.messages.length > 20000) s.data.messages = s.data.messages.slice(-20000); // keep the log bounded
  s.exists = true;
  try {
    await storage.writeTenant(id, s.data);
  } catch (e) {
    console.error(`[${id}] saving failed, retrying in 5s:`, e.message);
    if (stores.get(id) === s && !s.timer) s.timer = setTimeout(() => { s.timer = null; writeTenant(id); }, 5000);
    throw e;
  }
}

export function save() {
  const id = als.getStore();
  if (!id) throw new Error('No workspace selected (tenant context missing)');
  const s = storeFor(id);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { s.timer = null; writeTenant(id).catch(() => {}); }, SAVE_DELAY_MS);
}

// Write everything now (used on shutdown and by /api/cron).
export async function flushAll() {
  const ids = [...stores].filter(([, s]) => s.exists || s.timer).map(([id]) => id);
  await Promise.allSettled(ids.map((id) => writeTenant(id)));
}

export function createTenantStore(id, init = {}) {
  if (!validId(id)) throw new Error('Invalid workspace id');
  if (stores.get(id)?.exists) throw new Error('Workspace already exists');
  stores.set(id, { data: { ...empty(), ...init }, timer: null, exists: true });
  writeTenant(id).catch(() => {});
}
export function deleteTenantStore(id) {
  const s = stores.get(id);
  if (s) clearTimeout(s.timer);
  stores.delete(id);
  storage.removeTenant(id).catch((e) => console.error(`[${id}] delete failed:`, e.message));
}
export const listTenantIds = () => [...stores].filter(([, s]) => s.exists).map(([id]) => id);

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
