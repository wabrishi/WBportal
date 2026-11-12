// Outgoing webhooks to the current workspace's webhook URL (set on the Subscription & Workspace page).
//
// Reliable + signed (suite event contract, see LeadManager/docs/ARCHITECTURE.md §5):
// - every event is written to the workspace's outbox (db.webhookOutbox → MySQL table `webhook_outbox`,
//   or the JSON file without a database) and saved with the change that caused it;
// - delivery is tried right away, then retried on non-2xx / timeout after 1 m, 5 m, 30 m, 2 h, 12 h,
//   after which the event is marked dead. Retries run from a timer and from /api/cron.
// - at-least-once: the same event (same id, same body) can arrive more than once; receivers dedupe by id.
//
// Body:    { event, workspace, data, timestamp, id, type, source: "wa", workspaceId, occurredAt }
// Headers: X-Suite-Event-Id, X-Suite-Timestamp (unix s),
//          X-Suite-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
import crypto from 'node:crypto';
import { db, save, currentTenantId, forEachTenant, runAsTenant } from './store.js';

const RETRY_DELAYS_MS = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3, 12 * 3600e3];
const TIMEOUT_MS = 10000;
const KEEP_DEAD = 200;     // dead events kept per workspace for inspection
const MAX_PENDING = 5000;  // per workspace; oldest are dropped beyond this (receiver down for a long time)
const TICK_MS = 30000;

const inFlight = new Set(); // "<tenantId>:<eventId>" being delivered right now (timer + cron overlap)

const newEventId = () => `evt_${Date.now().toString(36)}${crypto.randomBytes(10).toString('hex')}`;
export const newWebhookSecret = () => `whsec_${crypto.randomBytes(24).toString('hex')}`;

// The workspace's signing secret, created on first use. Call inside a tenant context.
export function webhookSecret() {
  if (!db.workspace?.webhookSecret) {
    db.workspace = { ...db.workspace, webhookSecret: newWebhookSecret() };
    save();
  }
  return db.workspace.webhookSecret;
}

export function signature(secret, timestamp, rawBody) {
  return 'v1=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

// Queues an event for the current workspace and starts delivering it. Never throws.
export function emitWebhook(event, data) {
  try {
    const url = db.workspace?.webhookUrl;
    if (!url) return;
    const tenantId = currentTenantId();
    const id = newEventId();
    const at = new Date().toISOString();
    // existing fields first (unchanged), then the suite envelope fields
    const body = JSON.stringify({
      event, workspace: tenantId, data, timestamp: at,
      id, type: event, source: 'wa', workspaceId: tenantId, occurredAt: at,
    });
    webhookSecret(); // make sure one exists before the first delivery
    const outbox = db.webhookOutbox || (db.webhookOutbox = []);
    outbox.push({ id, event, url, body, status: 'pending', attempts: 0, nextAttemptAt: Date.now(), createdAt: at });
    trim(outbox);
    save();
    deliver(tenantId, id).catch(() => {});
  } catch (e) {
    console.warn(`[${currentTenantId()}] webhook ${event} not queued: ${e.message}`);
  }
}

function trim(outbox) {
  const dead = outbox.filter((x) => x.status === 'dead');
  if (dead.length > KEEP_DEAD) {
    const drop = new Set(dead.slice(0, dead.length - KEEP_DEAD));
    db.webhookOutbox = outbox.filter((x) => !drop.has(x));
  }
  const pending = db.webhookOutbox.filter((x) => x.status === 'pending');
  if (pending.length > MAX_PENDING) {
    const drop = new Set(pending.slice(0, pending.length - MAX_PENDING));
    console.warn(`[${currentTenantId()}] webhook outbox full: dropping ${drop.size} oldest event(s)`);
    db.webhookOutbox = db.webhookOutbox.filter((x) => !drop.has(x));
  }
}

// One delivery attempt of one event (runs inside its workspace).
function deliver(tenantId, eventId) {
  return runAsTenant(tenantId, async () => {
    const key = `${tenantId}:${eventId}`;
    const e = (db.webhookOutbox || []).find((x) => x.id === eventId);
    if (!e || e.status !== 'pending' || inFlight.has(key)) return;
    inFlight.add(key);
    let error = null;
    try {
      const ts = Math.floor(Date.now() / 1000);
      const res = await fetch(e.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'WBportal-Webhooks/1',
          'X-Suite-Event-Id': e.id,
          'X-Suite-Timestamp': String(ts),
          'X-Suite-Signature': signature(webhookSecret(), ts, e.body),
        },
        body: e.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) error = `HTTP ${res.status}`;
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      error = err.name === 'TimeoutError' ? 'timeout' : err.message;
    } finally {
      inFlight.delete(key);
    }
    e.attempts++;
    e.lastAttemptAt = new Date().toISOString();
    if (!error) {
      db.webhookOutbox = db.webhookOutbox.filter((x) => x !== e); // delivered: drop it
    } else if (e.attempts > RETRY_DELAYS_MS.length) {
      e.status = 'dead';
      e.lastError = error;
      console.warn(`[${tenantId}] webhook ${e.event} ${e.id} gave up after ${e.attempts} attempts: ${error}`);
    } else {
      e.lastError = error;
      e.nextAttemptAt = Date.now() + RETRY_DELAYS_MS[e.attempts - 1];
      console.warn(`[${tenantId}] webhook ${e.event} ${e.id} failed (${error}), retry #${e.attempts} at ${new Date(e.nextAttemptAt).toISOString()}`);
    }
    save();
  });
}

// Delivers every due event of every workspace. Used by the timer and by /api/cron.
export async function dispatchWebhooks() {
  await forEachTenant(async (tenantId) => {
    const due = (db.webhookOutbox || []).filter((x) => x.status === 'pending' && x.nextAttemptAt <= Date.now());
    for (const e of due) await deliver(tenantId, e.id).catch(() => {});
  });
}

let timer = null;
export function startWebhookDispatcher() {
  if (timer) return;
  timer = setInterval(() => dispatchWebhooks().catch((e) => console.error('webhook dispatch:', e.message)), TICK_MS);
  timer.unref?.();
  dispatchWebhooks().catch(() => {}); // events left pending from before a restart
}

// A message our side sent (dashboard, campaign or agent ticket reply). Messages sent through the REST API
// with an API key are not reported: the caller (e.g. Lead Manager) already knows about them.
export function emitMessageSent({ sessionId, to, text, messageId, via }) {
  emitWebhook('message.sent', { sessionId, to, text, messageId: messageId || null, via });
}

// Summary for the workspace page.
export function outboxStats() {
  const o = db.webhookOutbox || [];
  const dead = o.filter((x) => x.status === 'dead');
  return {
    pending: o.filter((x) => x.status === 'pending').length,
    failed: dead.length,
    lastError: dead.at(-1)?.lastError || o.filter((x) => x.lastError).at(-1)?.lastError || null,
  };
}
