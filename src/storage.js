// Where data is saved. One interface, two backends:
//   - MySQL / MariaDB (src/mysql.js) when DB_NAME or DATABASE_URL is set — recommended, required for
//     Hostinger web hosting if you want data in a database instead of files;
//   - JSON files under STORAGE_DIR (data/ + sessions/) otherwise — handy for local development.
// The first time the app starts with an empty MySQL database, existing JSON data and WhatsApp
// logins found in STORAGE_DIR are imported automatically (the files are left untouched as a backup).
import fs from 'node:fs';
import path from 'node:path';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { DATA_DIR, SESSIONS_DIR } from './paths.js';
import * as my from './mysql.js';

export const USE_MYSQL = !!(process.env.DATABASE_URL || process.env.DB_NAME);
export const STORAGE_KIND = USE_MYSQL ? 'mysql' : 'files';

const PLATFORM_FILE = path.join(DATA_DIR, 'platform.json');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const tenantFile = (id) => path.join(TENANTS_DIR, id, 'db.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}
const listDirs = (dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);

/* ---------- file backend ---------- */
const files = {
  async init() { fs.mkdirSync(DATA_DIR, { recursive: true }); },
  async close() {},
  async loadPlatform() { return fs.existsSync(PLATFORM_FILE) ? readJson(PLATFORM_FILE) : null; },
  async writePlatform(data) { writeJson(PLATFORM_FILE, data); },
  async loadTenants() {
    const out = new Map();
    for (const id of listDirs(TENANTS_DIR)) if (fs.existsSync(tenantFile(id))) out.set(id, readJson(tenantFile(id)));
    return out;
  },
  async writeTenant(id, data) { writeJson(tenantFile(id), data); },
  async removeTenant(id) { fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true }); },

  hasAuth: (tenantId, sessionId) => fs.existsSync(path.join(SESSIONS_DIR, tenantId, sessionId, 'creds.json')),
  authSessionIds: (tenantId) => listDirs(path.join(SESSIONS_DIR, tenantId))
    .filter((id) => fs.existsSync(path.join(SESSIONS_DIR, tenantId, id, 'creds.json'))),
  useAuthState: (tenantId, sessionId) => useMultiFileAuthState(path.join(SESSIONS_DIR, tenantId, sessionId)),
  async removeAuth(tenantId, sessionId) {
    fs.rmSync(path.join(SESSIONS_DIR, tenantId, ...(sessionId == null ? [] : [sessionId])), { recursive: true, force: true });
  },
  async importAuthFiles(tenantId, sessionId, map) {
    const dir = path.join(SESSIONS_DIR, tenantId, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(map)) fs.writeFileSync(path.join(dir, name), text);
  },
};

const backend = USE_MYSQL ? my : files;

export const {
  close, loadPlatform, writePlatform, loadTenants, writeTenant, removeTenant,
  hasAuth, authSessionIds, useAuthState, removeAuth, importAuthFiles,
} = backend;

// Reads a Baileys session folder into { fileName: text }.
export function readSessionDir(dir) {
  const map = {};
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) map[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  return map;
}

export async function init() {
  await backend.init();
  if (USE_MYSQL && await my.isEmpty()) await importFiles();
}

// One-time copy of JSON data + WhatsApp logins from STORAGE_DIR into an empty MySQL database.
async function importFiles() {
  const platform = await files.loadPlatform();
  const tenants = await files.loadTenants();
  if (!platform && !tenants.size) return;
  console.log(`Importing existing data from ${DATA_DIR} into MySQL…`);
  if (platform) await my.writePlatform(platform);
  for (const [id, data] of tenants) {
    await my.writeTenant(id, data);
    let numbers = 0;
    for (const sessionId of files.authSessionIds(id)) {
      await my.importAuthFiles(id, sessionId, readSessionDir(path.join(SESSIONS_DIR, id, sessionId)));
      numbers++;
    }
    console.log(`  workspace "${id}": imported${numbers ? `, ${numbers} WhatsApp login(s)` : ''}`);
  }
  console.log('Import finished. The JSON files were left in place as a backup; MySQL is used from now on.');
}
