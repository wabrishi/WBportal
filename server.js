import './src/env.js'; // must stay the first import
import path from 'node:path';
import express from 'express';
import routes from './src/routes.js';
import superRoutes from './src/super.js';
import { restoreSessions } from './src/whatsapp.js';
import { pauseInterruptedCampaigns } from './src/campaigns.js';
import { ensureSuperAdmin } from './src/auth.js';
import { migrateTickets } from './src/departments.js';
import { pruneMenus } from './src/buttons.js';
import { startFlowTimers } from './src/flows.js';
import { migrateLegacy, flushPlatform, loadPlatform, platform } from './src/platform.js';
import { listTenantIds, runAsTenant, flushAll, loadStores } from './src/store.js';
import * as storage from './src/storage.js';
import { STORAGE_DIR, PUBLIC_DIR, ON_HOSTINGER_WEB } from './src/paths.js';
import crypto from 'node:crypto';

if (storage.USE_MYSQL) {
  console.log(`Storage: MySQL database "${process.env.DB_NAME || '(from DATABASE_URL)'}"`);
} else {
  console.log(`Storage: JSON files in ${STORAGE_DIR}${ON_HOSTINGER_WEB ? ' (outside the deploy folder, survives redeploys)' : ''}`);
  console.log('         Set DB_HOST, DB_USER, DB_PASSWORD and DB_NAME to use MySQL instead.');
}

// Loads all data, then runs one-time upgrades and startup clean-ups.
// No top-level `await` in this file: Hostinger (LiteSpeed lsnode) loads the app with require(),
// which can't load ES modules that use top-level await (ERR_REQUIRE_ASYNC_MODULE).
async function boot() {
  await storage.init(); // connects to MySQL, creates tables, imports existing JSON data once
  await loadPlatform();
  await loadStores();
  // One-time upgrade from the single-company version: your data becomes the first workspace ("main").
  const migrated = await migrateLegacy();
  if (migrated) console.log(`Migrated existing data into workspace "${migrated.id}". Log in with your existing username and password.`);
  ensureSuperAdmin();
  for (const id of listTenantIds()) {
    try { runAsTenant(id, () => { migrateTickets(); pruneMenus(); pauseInterruptedCampaigns(); }); }
    catch (e) { console.error(`[${id}] startup:`, e.message); }
  }
}
const saveEverything = () => Promise.allSettled([flushAll(), flushPlatform()]);

const app = express();
// Which proxy in front of us tells us the visitor's real IP (used for login/signup rate limits).
// Default: nginx on the same server ("loopback"); Hostinger web hosting and Docker/Traefik: 1 hop.
const tp = process.env.TRUST_PROXY;
app.set('trust proxy', tp === undefined || tp === '' ? (ON_HOSTINGER_WEB ? 1 : 'loopback')
  : /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp === 'false' ? false : tp);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
// Uptime checks: also wakes the app if the host stopped it (use with a cron job / uptime monitor)
const startedAt = Date.now();
app.get('/api/health', (req, res) => res.json({
  ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), workspaces: platform.tenants.length, storage: storage.STORAGE_KIND,
}));
// Cron: reconnect WhatsApp numbers that dropped. Enabled only when CRON_KEY is set.
// e.g. every 5 minutes: curl -s "https://yourdomain.com/api/cron?key=YOUR_CRON_KEY"
app.get('/api/cron', async (req, res) => {
  const key = process.env.CRON_KEY;
  const given = String(req.query.key || '');
  if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
    return res.status(404).json({ error: 'Not found' });
  }
  await restoreSessions().catch((e) => console.error('cron restore:', e.message));
  await saveEverything();
  res.json({ ok: true, at: new Date().toISOString() });
});
app.use('/api/super', superRoutes);
app.use('/api', routes);

// Pages: landing (/), signup (/signup), customer dashboard (/app), platform owner panel (/admin)
const pub = PUBLIC_DIR;
app.get('/app', (req, res) => res.sendFile(path.join(pub, 'app.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(pub, 'signup.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.use(express.static(pub));

const port = Number(process.env.PORT || 3000);
let server;
boot().then(() => {
  server = app.listen(port, async () => {
    console.log(`Running at http://localhost:${port}  ·  dashboard /app  ·  super admin /admin`);
    startFlowTimers();
    await restoreSessions();
  });
}).catch((e) => {
  console.error('Startup failed:', e.message);
  if (storage.USE_MYSQL) console.error('Check DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME (hPanel → Databases → MySQL Databases).');
  process.exit(1);
});

// Save everything before exiting (pm2 restart, Ctrl+C, host redeploy)
let exiting = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (exiting) return;
    exiting = true;
    await saveEverything();
    await storage.close();
    server?.close();
    process.exit(0);
  });
}
