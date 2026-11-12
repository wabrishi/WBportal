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
import { startWebhookDispatcher, dispatchWebhooks } from './src/webhook.js';
import { hubLogin, hubCallback, hubEvents } from './src/hub.js';
import { hubMode, hubUrl, checkHubConfig } from './src/suite.js';
import { migrateLegacy, flushPlatform, loadPlatform, platform } from './src/platform.js';
import { listTenantIds, runAsTenant, flushAll, loadStores } from './src/store.js';
import * as storage from './src/storage.js';
import { acquireInstanceLock, keepInstanceLock } from './src/mysql.js';
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

/* ---------- one active copy (see startup at the bottom) ----------
   ready      this copy holds the data, WhatsApp connections and background jobs
   booting    loading; requests wait for it (up to 30 s)
   standby    another copy is active (MySQL lock); this one waits to take over and only answers 503
   redirect   this copy was started for another host name (e.g. www.) than APP_URL: it redirects there */
let state = 'booting';
let markReady;
const whenReady = new Promise((r) => { markReady = r; });
let firstHost = null, gotFirstHost;
const firstRequest = new Promise((r) => { gotFirstHost = r; });
const canonical = (() => { try { return process.env.APP_URL ? new URL(process.env.APP_URL) : null; } catch { return null; } })();
const toCanonical = (req, res) => res.redirect(308, `${canonical.origin}${req.originalUrl}`);
const startedAt = Date.now();
// Health / uptime checks: also wakes the app if the host stopped it. Answers in every state.
app.get('/api/health', (req, res) => res.json({
  ok: true, state, uptimeSec: Math.round((Date.now() - startedAt) / 1000), workspaces: platform.tenants.length, storage: storage.STORAGE_KIND,
}));
app.use(async (req, res, next) => {
  if (!firstHost) { firstHost = req.hostname; gotFirstHost(); }
  if (canonical && req.hostname !== canonical.hostname && state !== 'booting') return toCanonical(req, res);
  if (state === 'booting') await Promise.race([whenReady, new Promise((r) => setTimeout(r, 30000))]);
  if (state === 'ready') return next();
  if (state === 'redirect' && canonical) return toCanonical(req, res);
  res.set('Retry-After', '10').status(503).json({ error: 'The app is starting. Please try again in a few seconds.' });
});
// Suite Hub events: signed over the raw body, so this route reads it before the JSON parser does.
app.post('/api/suite/events', express.raw({ type: '*/*', limit: '1mb' }), hubEvents);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
// Cron: reconnect WhatsApp numbers that dropped. Enabled only when CRON_KEY is set.
// e.g. every 5 minutes: curl -s "https://yourdomain.com/api/cron?key=YOUR_CRON_KEY"
app.get('/api/cron', async (req, res) => {
  const key = process.env.CRON_KEY;
  const given = String(req.query.key || '');
  if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
    return res.status(404).json({ error: 'Not found' });
  }
  await restoreSessions().catch((e) => console.error('cron restore:', e.message));
  await dispatchWebhooks().catch((e) => console.error('cron webhooks:', e.message));
  await saveEverything();
  res.json({ ok: true, at: new Date().toISOString() });
});
app.use('/api/super', superRoutes);
app.use('/api', routes);

// Pages: landing (/), signup (/signup), customer dashboard (/app), platform owner panel (/admin)
const pub = PUBLIC_DIR;
app.get('/app', (req, res) => res.sendFile(path.join(pub, 'app.html')));
app.get('/signup', (req, res) => (hubMode() ? res.redirect(`${hubUrl()}/signup`) : res.sendFile(path.join(pub, 'signup.html'))));
// "Sign in with Hub" (AUTH_MODE=hub)
app.get('/auth/hub/login', hubLogin);
app.get('/auth/hub/callback', hubCallback);
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.use(express.static(pub));

const port = Number(process.env.PORT || 3000);
// Listen right away (the host expects it); requests wait in the gate above until the data is loaded.
const server = app.listen(port, () => console.log(`Running at http://localhost:${port}  ·  dashboard /app  ·  super admin /admin`));

async function start() {
  checkHubConfig(); // AUTH_MODE=hub needs HUB_URL, HUB_CLIENT_ID, HUB_CLIENT_SECRET, SUITE_EVENTS_SECRET
  if (hubMode()) console.log(`Sign-in: Suite Hub at ${hubUrl()}`);
  // A copy started for another host name than APP_URL (Hostinger starts one for www.) only redirects:
  // no data, no WhatsApp, no background jobs. The host is known from the request that started it.
  if (canonical) {
    await Promise.race([firstRequest, new Promise((r) => setTimeout(r, 1500))]);
    if (firstHost && firstHost !== canonical.hostname) {
      state = 'redirect';
      markReady();
      console.log(`This copy serves ${firstHost}: redirecting everything to ${canonical.origin} (APP_URL).`);
      return;
    }
  }
  // Only one copy per database may be active (MySQL lock); the others wait to take over.
  if (storage.USE_MYSQL && !(await acquireInstanceLock(0))) {
    state = 'standby';
    markReady();
    console.log('Another copy of this app is active on this database: standing by (no WhatsApp, no background jobs).');
    while (!(await acquireInstanceLock(30).catch(() => false))) { /* wait for the active copy to stop */ }
    console.log('The other copy stopped: this copy is now active.');
    state = 'booting';
  }
  if (storage.USE_MYSQL) {
    keepInstanceLock(() => {
      console.error('Lost the database lock to another copy: stopping this one.');
      process.exit(1);
    });
  }
  await boot();
  state = 'ready';
  markReady();
  startFlowTimers();
  startWebhookDispatcher(); // retries failed webhooks (also run by /api/cron)
  await restoreSessions();
}
start().catch((e) => {
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
    if (state === 'ready') await saveEverything(); // a standby / redirect copy has nothing to save
    await storage.close();
    server?.close();
    process.exit(0);
  });
}
