// MySQL / MariaDB storage (used when DB_NAME or DATABASE_URL is set — see storage.js).
//
// The app keeps working on in-memory objects (store.js `db`, platform.js `platform`); this module
// loads them from MySQL at startup and writes back only what changed (row-level diff), so a
// contact edit updates one row in `contacts`, not the whole workspace.
//
// Tables (created automatically):
//   one table per list, one row per item:  contacts, messages, campaigns, tickets, users, ...
//       (tenant_id, id, seq, data)  — data = the item as JSON, seq keeps the original order
//   tenant_kv / platform_kv:  everything else (settings, counters, maps), one row per key
//   wa_auth:  WhatsApp logins (Baileys credentials and signal keys), one row per key
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

/* ---------- what goes where ---------- */
// workspace lists -> table
const TENANT_LISTS = {
  apiKeys: 'api_keys', contacts: 'contacts', campaigns: 'campaigns', messages: 'messages', tickets: 'tickets',
  users: 'users', departments: 'departments', flows: 'flows', authTokens: 'auth_tokens',
  webhookOutbox: 'webhook_outbox',
};
// platform lists -> table (audit has no ids and is capped, so it is kept in platform_kv)
const PLATFORM_LISTS = {
  tenants: 'tenants', superAdmins: 'super_admins', payments: 'payments', requests: 'plan_requests', authTokens: 'admin_tokens',
  suiteInbox: 'suite_inbox',
};
const TENANT_KV = 'tenant_kv';
const PLATFORM_KV = 'platform_kv';
const AUTH = 'wa_auth';

/* ---------- connection ---------- */
let pool = null;

function config() {
  const common = {
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5), // shared hosting limits connections per user
    maxIdle: 2,
    idleTimeout: 60000, // drop idle connections before the server's wait_timeout does
    enableKeepAlive: true,
    charset: 'utf8mb4',
    supportBigNumbers: true,
    dateStrings: true,
  };
  if (process.env.DATABASE_URL) return { uri: process.env.DATABASE_URL, ...common };
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ...common,
  };
}

const q = (sql, params) => pool.query(sql, params);

async function inTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';

export async function init() {
  const cfg = config();
  if (!cfg.uri && (!cfg.user || !cfg.database)) throw new Error('MySQL: set DB_USER, DB_PASSWORD and DB_NAME (or DATABASE_URL)');
  pool = mysql.createPool(cfg);
  await q('SELECT 1');
  for (const t of Object.values(TENANT_LISTS)) {
    await q(`CREATE TABLE IF NOT EXISTS \`${t}\` (
      tenant_id VARCHAR(64) NOT NULL,
      id VARCHAR(191) NOT NULL,
      seq BIGINT NOT NULL AUTO_INCREMENT,
      data LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, id),
      KEY seq (seq)
    ) ${TABLE_OPTS}`);
  }
  for (const t of Object.values(PLATFORM_LISTS)) {
    await q(`CREATE TABLE IF NOT EXISTS \`${t}\` (
      id VARCHAR(191) NOT NULL,
      seq BIGINT NOT NULL AUTO_INCREMENT,
      data LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY seq (seq)
    ) ${TABLE_OPTS}`);
  }
  await q(`CREATE TABLE IF NOT EXISTS \`${TENANT_KV}\` (
    tenant_id VARCHAR(64) NOT NULL,
    id VARCHAR(64) NOT NULL,
    data LONGTEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, id)
  ) ${TABLE_OPTS}`);
  await q(`CREATE TABLE IF NOT EXISTS \`${PLATFORM_KV}\` (
    id VARCHAR(64) NOT NULL,
    data LONGTEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  ) ${TABLE_OPTS}`);
  await q(`CREATE TABLE IF NOT EXISTS \`${AUTH}\` (
    tenant_id VARCHAR(64) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    id VARCHAR(191) NOT NULL,
    data LONGTEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, session_id, id)
  ) ${TABLE_OPTS}`);
  // which numbers have a saved login (read synchronously by the app)
  const [rows] = await q(`SELECT tenant_id, session_id FROM \`${AUTH}\` WHERE id = 'creds'`);
  for (const r of rows) authSet(r.tenant_id).add(r.session_id);
}

export async function close() {
  await pool?.end().catch(() => {});
}

// True when nothing has been stored yet (used to import existing JSON files once).
export async function isEmpty() {
  const [[a]] = await q(`SELECT COUNT(*) AS n FROM \`${PLATFORM_KV}\``);
  const [[b]] = await q(`SELECT COUNT(*) AS n FROM \`${TENANT_KV}\``);
  return Number(a.n) === 0 && Number(b.n) === 0;
}

/* ---------- object <-> rows ---------- */
// Turns { contacts: [...], settings: {...}, ... } into { tableName: Map(id -> json) }.
function serialize(data, lists, kvTable) {
  const out = { [kvTable]: new Map() };
  for (const t of Object.values(lists)) out[t] = new Map();
  for (const [k, v] of Object.entries(data)) {
    const table = lists[k];
    if (table && Array.isArray(v)) {
      for (const item of v) {
        if (item == null || typeof item !== 'object') continue;
        let key = item.id ?? item.hash;
        if (key == null) key = item.id = crypto.randomUUID();
        out[table].set(String(key), JSON.stringify(item));
      }
    } else if (v !== undefined) {
      out[kvTable].set(k, JSON.stringify(v));
    }
  }
  return out;
}

const parse = (s) => JSON.parse(s);
const BATCH_BYTES = 2 * 1024 * 1024; // keep each statement well under max_allowed_packet

// Writes the difference between two serialized snapshots.
async function writeDiff(conn, prev, next, scopeId) {
  const scoped = scopeId != null;
  for (const [table, rows] of Object.entries(next)) {
    const before = prev[table] || new Map();
    const upserts = [];
    for (const [id, json] of rows) if (before.get(id) !== json) upserts.push([id, json]);
    const deletes = [];
    for (const id of before.keys()) if (!rows.has(id)) deletes.push(id);

    for (let i = 0; i < deletes.length; i += 500) {
      const ids = deletes.slice(i, i + 500);
      if (scoped) await conn.query(`DELETE FROM \`${table}\` WHERE tenant_id = ? AND id IN (?)`, [scopeId, ids]);
      else await conn.query(`DELETE FROM \`${table}\` WHERE id IN (?)`, [ids]);
    }
    let batch = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const values = batch.map(([id, json]) => (scoped ? [scopeId, id, json] : [id, json]));
      await conn.query(
        `INSERT INTO \`${table}\` (${scoped ? 'tenant_id, ' : ''}id, data) VALUES ? ON DUPLICATE KEY UPDATE data = VALUES(data)`,
        [values],
      );
      batch = []; bytes = 0;
    };
    for (const row of upserts) {
      batch.push(row);
      bytes += row[1].length;
      if (bytes >= BATCH_BYTES || batch.length >= 1000) await flush();
    }
    await flush();
  }
}

// One write at a time per workspace / platform, in call order.
const snapshots = new Map(); // scopeKey -> serialized snapshot last written
const chains = new Map();    // scopeKey -> promise of the last queued write
function enqueue(scopeKey, fn) {
  const run = (chains.get(scopeKey) || Promise.resolve()).then(fn, fn);
  chains.set(scopeKey, run.catch(() => {}));
  return run;
}

/* ---------- platform ---------- */
export async function loadPlatform() {
  const data = {};
  const [kv] = await q(`SELECT id, data FROM \`${PLATFORM_KV}\``);
  for (const r of kv) data[r.id] = parse(r.data);
  for (const [k, t] of Object.entries(PLATFORM_LISTS)) {
    const [rows] = await q(`SELECT data FROM \`${t}\` ORDER BY seq`);
    if (rows.length || k in data) data[k] = rows.map((r) => parse(r.data));
  }
  if (!kv.length && Object.keys(PLATFORM_LISTS).every((k) => !data[k]?.length)) return null;
  snapshots.set('platform', serialize(data, PLATFORM_LISTS, PLATFORM_KV));
  return data;
}

export function writePlatform(platform) {
  return enqueue('platform', async () => {
    const next = serialize(platform, PLATFORM_LISTS, PLATFORM_KV);
    await inTransaction((conn) => writeDiff(conn, snapshots.get('platform') || {}, next, null));
    snapshots.set('platform', next);
  });
}

/* ---------- workspaces ---------- */
export async function loadTenants() {
  const out = new Map();
  const get = (id) => { if (!out.has(id)) out.set(id, {}); return out.get(id); };
  const [kv] = await q(`SELECT tenant_id, id, data FROM \`${TENANT_KV}\``);
  for (const r of kv) get(r.tenant_id)[r.id] = parse(r.data);
  for (const [k, t] of Object.entries(TENANT_LISTS)) {
    const [rows] = await q(`SELECT tenant_id, data FROM \`${t}\` ORDER BY seq`);
    for (const r of rows) (get(r.tenant_id)[k] ||= []).push(parse(r.data));
  }
  for (const [id, data] of out) snapshots.set(`t:${id}`, serialize(data, TENANT_LISTS, TENANT_KV));
  return out;
}

export function writeTenant(id, data) {
  return enqueue(`t:${id}`, async () => {
    const next = serialize(data, TENANT_LISTS, TENANT_KV);
    await inTransaction((conn) => writeDiff(conn, snapshots.get(`t:${id}`) || {}, next, id));
    snapshots.set(`t:${id}`, next);
  });
}

export function removeTenant(id) {
  return enqueue(`t:${id}`, async () => {
    await inTransaction(async (conn) => {
      for (const t of [...Object.values(TENANT_LISTS), TENANT_KV]) {
        await conn.query(`DELETE FROM \`${t}\` WHERE tenant_id = ?`, [id]);
      }
    });
    snapshots.delete(`t:${id}`);
  });
}

/* ---------- WhatsApp logins (replaces Baileys' useMultiFileAuthState) ---------- */
const authIndex = new Map(); // tenantId -> Set(sessionId) with saved credentials
const authSet = (tenantId) => { if (!authIndex.has(tenantId)) authIndex.set(tenantId, new Set()); return authIndex.get(tenantId); };
export const hasAuth = (tenantId, sessionId) => !!authIndex.get(tenantId)?.has(sessionId);
export const authSessionIds = (tenantId) => [...(authIndex.get(tenantId) || [])];

// Same key names as Baileys' file store, so imported session folders map 1:1 (file name minus ".json").
const fixKey = (k) => k.replace(/\//g, '__').replace(/:/g, '-');

export async function useAuthState(tenantId, sessionId) {
  const scope = `auth:${tenantId}:${sessionId}`;
  const where = 'tenant_id = ? AND session_id = ?';
  const read = (ids) => enqueue(scope, async () => {
    if (!ids.length) return new Map();
    const [rows] = await q(`SELECT id, data FROM \`${AUTH}\` WHERE ${where} AND id IN (?)`, [tenantId, sessionId, ids]);
    return new Map(rows.map((r) => [r.id, JSON.parse(r.data, BufferJSON.reviver)]));
  });
  const write = (upserts, deletes) => enqueue(scope, async () => {
    if (deletes.length) await q(`DELETE FROM \`${AUTH}\` WHERE ${where} AND id IN (?)`, [tenantId, sessionId, deletes]);
    for (let i = 0; i < upserts.length; i += 200) {
      const values = upserts.slice(i, i + 200).map(([id, v]) => [tenantId, sessionId, id, JSON.stringify(v, BufferJSON.replacer)]);
      await q(`INSERT INTO \`${AUTH}\` (tenant_id, session_id, id, data) VALUES ? ON DUPLICATE KEY UPDATE data = VALUES(data)`, [values]);
    }
  });

  const creds = (await read(['creds'])).get('creds') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const found = await read(ids.map((id) => fixKey(`${type}-${id}`)));
          const data = {};
          for (const id of ids) {
            let value = found.get(fixKey(`${type}-${id}`)) ?? null;
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const upserts = [], deletes = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) upserts.push([fixKey(`${type}-${id}`), value]);
              else deletes.push(fixKey(`${type}-${id}`));
            }
          }
          await write(upserts, deletes);
        },
      },
    },
    saveCreds: async () => {
      await write([['creds', creds]], []);
      authSet(tenantId).add(sessionId);
    },
  };
}

// Removes one number's login, or all of a workspace's logins (sessionId omitted).
export async function removeAuth(tenantId, sessionId) {
  if (sessionId == null) {
    authIndex.delete(tenantId);
    await q(`DELETE FROM \`${AUTH}\` WHERE tenant_id = ?`, [tenantId]);
    return;
  }
  authIndex.get(tenantId)?.delete(sessionId);
  await enqueue(`auth:${tenantId}:${sessionId}`, () =>
    q(`DELETE FROM \`${AUTH}\` WHERE tenant_id = ? AND session_id = ?`, [tenantId, sessionId]));
}

// Imports one Baileys session folder's files ({ "creds.json": text, ... }) as-is.
export async function importAuthFiles(tenantId, sessionId, files) {
  const values = Object.entries(files).map(([name, text]) => [tenantId, sessionId, name.replace(/\.json$/, ''), text]);
  for (let i = 0; i < values.length; i += 200) {
    await q(`INSERT INTO \`${AUTH}\` (tenant_id, session_id, id, data) VALUES ? ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [values.slice(i, i + 200)]);
  }
  if (files['creds.json']) authSet(tenantId).add(sessionId);
}

/* ---------- one active copy per database ---------- */
// Hosts may run more than one copy of the app (Hostinger runs one for domain.com and one for
// www.domain.com). Only the copy holding this lock loads data, connects WhatsApp and runs background
// jobs; the others stay idle. GET_LOCK is held by one dedicated connection and released by MySQL as
// soon as that connection ends (process exit, crash), so a waiting copy can take over.
let lockConn = null;
const lockName = () => `wbportal:${process.env.DB_NAME || config().uri || ''}`.slice(0, 64);

async function openLockConn() {
  const { waitForConnections, connectionLimit, maxIdle, idleTimeout, ...cfg } = config();
  const conn = await mysql.createConnection(cfg);
  conn.on('error', () => {}); // a dropped connection is noticed by the keep-alive below
  return conn;
}

// Waits (up to `waitSec`) for the lock. Returns true when this process holds it.
export async function acquireInstanceLock(waitSec = 0) {
  lockConn ||= await openLockConn();
  const [[row]] = await lockConn.query('SELECT GET_LOCK(?, ?) AS ok', [lockName(), waitSec]);
  return Number(row.ok) === 1;
}

// Keeps the lock connection alive. If it drops and the lock can't be taken back (another copy has it),
// onLost() is called: this copy must stop, or two copies would write the same data.
export function keepInstanceLock(onLost) {
  const t = setInterval(async () => {
    try {
      await lockConn.query('SELECT 1');
    } catch {
      try {
        lockConn?.destroy();
        lockConn = null;
        if (!(await acquireInstanceLock(15))) { clearInterval(t); onLost(); }
      } catch { /* MySQL unreachable: try again on the next tick */ }
    }
  }, 20000);
  t.unref?.();
}
