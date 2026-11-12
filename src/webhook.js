// Forwards events to the current workspace's webhook URL (set on the Subscription & Workspace page).
import { db, currentTenantId } from './store.js';

export function emitWebhook(event, data) {
  const url = db.workspace?.webhookUrl;
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, workspace: currentTenantId(), data, timestamp: new Date().toISOString() }),
    signal: AbortSignal.timeout(10000),
  }).catch((e) => console.warn(`[${currentTenantId()}] webhook ${event} failed: ${e.message}`));
}
