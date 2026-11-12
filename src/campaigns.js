// Bulk campaign runner: throttled, personalised, respects opt-outs and daily limits.
import { db, save, uid, now, logMessage, bumpDaily, dailyCount } from './store.js';
import { sendText, sendMedia, sendButtons, isOnWhatsApp, getSession } from './whatsapp.js';
import { emitWebhook } from './webhook.js';
import { getSettings, inQuietHours } from './settings.js';
import { effectiveDailyLimit } from './health.js';
import { assertAllowed } from './platform.js';

const running = new Map(); // campaignId -> { cancel: bool }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

// {{name}}, {{phone}}, saved contact fields like {{email}} (e.g. collected by a chatbot), and spintax {Hi|Hello|Hey}
export function renderTemplate(tpl, contact) {
  return tpl
    .replace(/\{\{\s*name\s*\}\}/gi, contact.name || 'there')
    .replace(/\{\{\s*phone\s*\}\}/gi, contact.phone)
    .replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (_, k) => contact.fields?.[k] ?? '')
    .replace(/\{([^{}]+\|[^{}]+)\}/g, (_, opts) => {
      const parts = opts.split('|');
      return parts[Math.floor(Math.random() * parts.length)];
    });
}

export function createCampaign({ name, sessionId, message, mediaUrl, footer, buttons = null, tags = [], phones = [] }) {
  if (!name || !sessionId || !message) throw new Error('name, sessionId and message are required');
  const audience = resolveAudience(tags, phones);
  const c = {
    id: uid(),
    name,
    sessionId,
    message,
    mediaUrl: mediaUrl || null,
    footer: footer || '',
    buttons, // validated button list, or null for a plain message
    tags,
    recipients: audience.map((x) => ({ phone: x.phone, name: x.name || '', status: 'pending' })),
    status: 'draft', // draft | running | paused | completed | stopped_limit
    stats: { total: audience.length, sent: 0, failed: 0, skipped: 0 },
    createdAt: now(),
  };
  db.campaigns.push(c);
  save();
  return c;
}

function resolveAudience(tags, phones) {
  const optedOut = new Set(db.contacts.filter((c) => c.optedOut).map((c) => c.phone));
  let list = phones.length
    ? phones.map((p) => db.contacts.find((c) => c.phone === p) || { phone: p, name: '' })
    : db.contacts.filter((c) => !tags.length || c.tags?.some((t) => tags.includes(t)));
  const seen = new Set();
  return list.filter((c) => c.phone && !optedOut.has(c.phone) && !seen.has(c.phone) && seen.add(c.phone));
}

export function startCampaign(id) {
  const c = db.campaigns.find((x) => x.id === id);
  if (!c) throw new Error('Campaign not found');
  if (running.has(id)) return c;
  assertAllowed('messagesPerMonth');
  if (getSession(c.sessionId)?.status !== 'connected') throw new Error(`Session "${c.sessionId}" is not connected`);
  c.status = 'running';
  save();
  const ctl = { cancel: false };
  running.set(id, ctl);
  run(c, ctl).finally(() => running.delete(id));
  return c;
}

export function pauseCampaign(id) {
  const c = db.campaigns.find((x) => x.id === id);
  if (!c) throw new Error('Campaign not found');
  const ctl = running.get(id);
  if (ctl) ctl.cancel = true;
  c.status = 'paused';
  c.pauseReason = null;
  save();
  return c;
}

function stop(c, status, reason) {
  c.status = status;
  c.pauseReason = reason || null;
  save();
  if (reason) emitWebhook('campaign.paused', { campaignId: c.id, status, reason });
}

// Anti-block auto-pause: too many failures/invalid numbers or opt-outs in this run.
function autoPauseReason(c, s) {
  if (!s.autoPause.enabled) return null;
  const done = c.recipients.filter((r) => r.at && new Date(r.at) >= new Date(c.startedAt));
  const sent = done.filter((r) => r.status === 'sent');
  const bad = done.filter((r) => r.status === 'failed' || r.error === 'Not on WhatsApp');
  const attempts = sent.length + bad.length;
  if (attempts >= s.autoPause.minSample && (bad.length / attempts) * 100 > s.autoPause.failRate) {
    return `Auto-paused: ${Math.round((bad.length / attempts) * 100)}% of numbers failed or are not on WhatsApp (limit ${s.autoPause.failRate}%). Clean the list before resuming.`;
  }
  if (sent.length >= s.autoPause.minSample) {
    const phones = new Set(sent.map((r) => r.phone));
    const optOuts = db.contacts.filter((x) => phones.has(x.phone) && x.optedOutAt && x.optedOutAt >= c.startedAt).length;
    if ((optOuts / sent.length) * 100 > s.autoPause.optOutRate) {
      return `Auto-paused: ${optOuts} of ${sent.length} people replied STOP (limit ${s.autoPause.optOutRate}%). Review the message and audience before resuming.`;
    }
  }
  return null;
}

async function run(c, ctl) {
  c.startedAt = now();
  c.pauseReason = null;
  save();

  for (const r of c.recipients) {
    if (ctl.cancel) return;
    if (r.status !== 'pending') continue;
    const s = getSettings(); // re-read each time so changes on the Block Risk screen apply immediately

    // quiet hours: wait (without sending) until the window ends
    while (inQuietHours(new Date(), s) && !ctl.cancel) {
      if (c.status !== 'waiting_quiet') { c.status = 'waiting_quiet'; save(); }
      await sleep(60 * 1000);
    }
    if (ctl.cancel) return;
    if (c.status === 'waiting_quiet') { c.status = 'running'; save(); }

    const limit = effectiveDailyLimit(c.sessionId, s);
    if (dailyCount(c.sessionId) >= limit) {
      stop(c, 'stopped_limit', `Daily limit of ${limit} messages reached for "${c.sessionId}"${limit < s.dailyLimit ? ' (warm-up limit for a young number)' : ''}. Resume tomorrow.`);
      return;
    }
    const reason = autoPauseReason(c, s);
    if (reason) return stop(c, 'paused', reason);

    const contact = db.contacts.find((x) => x.phone === r.phone);
    if (contact?.optedOut) {
      r.status = 'skipped';
      r.at = now();
      c.stats.skipped++;
      save();
      continue;
    }

    try {
      if (!(await isOnWhatsApp(c.sessionId, r.phone))) {
        r.status = 'skipped';
        r.error = 'Not on WhatsApp';
        r.at = now();
        c.stats.skipped++;
        save();
        continue;
      }
      const text = renderTemplate(c.message, contact || r);
      if (c.buttons?.length) {
        const image = c.mediaUrl ? { url: c.mediaUrl } : null;
        await sendButtons(c.sessionId, r.phone, { text, footer: c.footer, image, buttons: c.buttons, campaignId: c.id });
      } else if (c.mediaUrl) await sendMedia(c.sessionId, r.phone, { url: c.mediaUrl, caption: text });
      else await sendText(c.sessionId, r.phone, text);
      r.status = 'sent';
      r.at = now();
      c.stats.sent++;
      bumpDaily(c.sessionId);
      logMessage({ sessionId: c.sessionId, to: r.phone, text, status: 'sent', campaignId: c.id });
    } catch (e) {
      r.status = 'failed';
      r.error = e.message;
      r.at = now();
      c.stats.failed++;
      logMessage({ sessionId: c.sessionId, to: r.phone, text: c.message, status: 'failed', error: e.message, campaignId: c.id });
      if (e.status === 402) { // plan limit reached / subscription inactive
        r.status = 'pending';
        r.error = undefined;
        c.stats.failed--;
        db.messages.pop(); // don't log it as a failed send
        return stop(c, 'paused', e.message);
      }
      if (/not connected/i.test(e.message)) {
        r.status = 'pending'; // retry this one on resume
        c.stats.failed--;
        c.status = 'paused';
        save();
        return;
      }
    }
    save();
    await sleep(rand(s.minDelayMs, s.maxDelayMs));
  }
  c.status = 'completed';
  c.pauseReason = null;
  save();
  emitWebhook('campaign.completed', { campaignId: c.id, stats: c.stats });
}

// Campaigns that were running when the server stopped are marked paused; resume them from the dashboard.
export function pauseInterruptedCampaigns() {
  for (const c of db.campaigns.filter((x) => x.status === 'running' || x.status === 'waiting_quiet')) {
    c.status = 'paused';
  }
  save();
}
