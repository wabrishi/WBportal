// Block-risk analysis per WhatsApp number. WhatsApp bans numbers mostly from user reactions
// (blocks/reports) and from patterns typical of spam. We can't see blocks/reports directly, so we
// measure the signals that predict them from our own message history.
import { db, dailyCount } from './store.js';
import { listSessions } from './whatsapp.js';
import { getSettings, inQuietHours } from './settings.js';

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;
const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'optout', 'opt out', 'cancel'];
const MIN_SAMPLE = 20; // below this many sends, rate-based signals aren't meaningful

/* ---------- number age & warm-up ---------- */
export function sessionMeta(id) {
  db.sessionMeta[id] ||= { firstSeenAt: new Date().toISOString(), numberSince: null, events: [] };
  return db.sessionMeta[id];
}
export function numberAgeDays(id) {
  const m = sessionMeta(id);
  return Math.floor((Date.now() - new Date(m.numberSince || m.firstSeenAt).getTime()) / DAY);
}
// Safe daily volume for a number of this age (recommended warm-up schedule).
export function warmupLimit(ageDays) {
  if (ageDays < 7) return 20;
  if (ageDays < 14) return 50;
  if (ageDays < 21) return 100;
  if (ageDays < 30) return 200;
  if (ageDays < 60) return 350;
  return Infinity;
}
export function effectiveDailyLimit(id, s = getSettings()) {
  return s.warmup ? Math.min(s.dailyLimit, warmupLimit(numberAgeDays(id))) : s.dailyLimit;
}

/* ---------- helpers ---------- */
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
// 0 at `good`, 0.5 at `warn`, 1 at `bad`; works for "higher is worse" or "lower is worse"
function riskOf(value, good, warn, bad) {
  const lowerIsWorse = bad < good;
  const v = lowerIsWorse ? -value : value, g = lowerIsWorse ? -good : good, w = lowerIsWorse ? -warn : warn, b = lowerIsWorse ? -bad : bad;
  if (v <= g) return 0;
  if (v <= w) return 0.5 * ((v - g) / (w - g));
  if (v <= b) return 0.5 + 0.5 * ((v - w) / (b - w));
  return 1;
}
const statusOf = (risk) => (risk >= 0.75 ? 'critical' : risk >= 0.5 ? 'serious' : risk > 0.15 ? 'warning' : 'good');
const maxInWindow = (times, ms) => {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] > ms) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
};

export function sessionHealth(sessionId) {
  const s = getSettings();
  const since = Date.now() - WINDOW_DAYS * DAY;
  const all = db.messages.filter((m) => m.sessionId === sessionId);
  const recent = all.filter((m) => new Date(m.createdAt).getTime() >= since);
  // "marketing" sends = outbound messages that aren't replies inside a support ticket
  const outbound = recent.filter((m) => m.direction !== 'in' && !m.ticketId && !m.flowId);
  const sent = outbound.filter((m) => m.status === 'sent');
  const failed = outbound.filter((m) => m.status === 'failed');
  const inbound = recent.filter((m) => m.direction === 'in');

  // invalid numbers come from campaign checks ("Not on WhatsApp")
  const recips = db.campaigns.filter((c) => c.sessionId === sessionId).flatMap((c) => c.recipients || [])
    .filter((r) => r.at && new Date(r.at).getTime() >= since);
  const invalid = recips.filter((r) => r.error === 'Not on WhatsApp').length;

  // engagement: of the people we messaged, how many are in a two-way chat with us
  // (wrote back afterwards, or wrote to us in the week before — e.g. a support conversation)
  const firstOut = new Map();
  for (const m of sent) if (!firstOut.has(m.to)) firstOut.set(m.to, m.createdAt);
  const lastIn = new Map();
  for (const m of all) if (m.direction === 'in') lastIn.set(m.to, m.createdAt);
  const firstInEver = new Map();
  for (const m of all) if (m.direction === 'in' && !firstInEver.has(m.to)) firstInEver.set(m.to, m.createdAt);
  const people = [...firstOut.keys()];
  const weekBefore = (iso) => new Date(new Date(iso).getTime() - 7 * DAY).toISOString();
  const replied = people.filter((p) => lastIn.get(p) && lastIn.get(p) >= weekBefore(firstOut.get(p))).length;
  const cold = people.filter((p) => !firstInEver.get(p) || firstInEver.get(p) > firstOut.get(p)).length;

  const optOuts = inbound.filter((m) => OPT_OUT_WORDS.includes(String(m.text).trim().toLowerCase())).length;

  const texts = new Map();
  for (const m of sent) texts.set(m.text, (texts.get(m.text) || 0) + 1);
  const topSame = Math.max(0, ...texts.values());

  const times = sent.map((m) => new Date(m.createdAt).getTime()).sort((a, b) => a - b);
  const perHourPeak = maxInWindow(times, 60 * 60 * 1000);
  const night = sent.filter((m) => inQuietHours(new Date(m.createdAt), { quietHours: { enabled: true, start: 21, end: 9 } })).length;
  const withLinks = sent.filter((m) => /https?:\/\/|www\./i.test(m.text)).length;
  const shortLinks = sent.filter((m) => /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|rb\.gy|is\.gd)\//i.test(m.text)).length;

  const ageDays = numberAgeDays(sessionId);
  const recommended = warmupLimit(ageDays);
  const todaySent = dailyCount(sessionId);
  const days = new Map();
  for (const m of sent) { const d = m.createdAt.slice(0, 10); days.set(d, (days.get(d) || 0) + 1); }
  const peakDay = Math.max(0, ...days.values(), todaySent);

  const events = (sessionMeta(sessionId).events || []).filter((e) => new Date(e.at).getTime() >= since);
  const loggedOut = events.filter((e) => e.type === 'logged_out').length;
  const drops = events.filter((e) => e.type === 'disconnected').length;

  const enough = sent.length >= MIN_SAMPLE;
  const attempts = sent.length + failed.length + invalid;
  const lim = recommended === Infinity ? s.dailyLimit : recommended;

  /* ---- signals: value, safe range, risk 0..1, weight, fix ---- */
  const signals = [
    {
      key: 'replyRate', label: 'Reply / two-way chat rate', weight: 18, enough,
      value: pct(replied, people.length), unit: '%', safe: '≥ 20%',
      risk: enough ? riskOf(pct(replied, people.length), 25, 10, 3) : 0,
      why: 'Few replies tell WhatsApp people don\'t want your messages. This is the strongest predictor of a ban.',
      fix: 'Message only people who opted in. Ask a question or add a quick-reply button ("Reply 1 for prices") so people answer.',
    },
    {
      key: 'optOutRate', label: 'Opt-out (STOP) rate', weight: 15, enough,
      value: pct(optOuts, people.length), unit: '%', safe: '< 1%',
      risk: enough ? riskOf(pct(optOuts, people.length), 0.5, 1.5, 3) : 0,
      why: 'Each STOP is someone who might have pressed Block or Report instead.',
      fix: 'Clean your list, remove old/unknown contacts, send less often and make the offer relevant to the tag you target.',
    },
    {
      key: 'invalidRate', label: 'Invalid / failed numbers', weight: 12, enough: attempts >= MIN_SAMPLE,
      value: pct(failed.length + invalid, attempts), unit: '%', safe: '< 3%',
      risk: attempts >= MIN_SAMPLE ? riskOf(pct(failed.length + invalid, attempts), 2, 6, 12) : 0,
      why: 'Many numbers that aren\'t on WhatsApp is a typical sign of a bought or scraped list.',
      fix: 'Never use purchased lists. Verify numbers with GET /api/check before importing, and delete invalid ones.',
    },
    {
      key: 'volume', label: 'Volume vs number age', weight: 15, enough: true,
      value: peakDay, unit: '/day peak', safe: recommended === Infinity ? `≤ ${s.dailyLimit}/day` : `≤ ${recommended}/day (number is ${ageDays} days old)`,
      risk: riskOf(peakDay / lim, 0.8, 1.2, 2),
      why: 'A sudden jump in volume from a young number is the most common reason new numbers get banned.',
      fix: 'Keep warm-up mode on: about 20/day in week 1, 50 in week 2, 100 in week 3, then grow gradually.',
    },
    {
      key: 'coldShare', label: 'Messages to people who never wrote to you', weight: 10, enough,
      value: pct(cold, people.length), unit: '%', safe: '< 50%',
      risk: enough ? riskOf(pct(cold, people.length), 40, 70, 90) : 0,
      why: 'Cold messages are far more likely to be reported than messages to people who chatted with you before.',
      fix: 'Get people to message you first (QR code, website click-to-chat link, "WhatsApp us" on invoices), then follow up.',
    },
    {
      key: 'sameText', label: 'Identical message text', weight: 8, enough,
      value: pct(topSame, sent.length), unit: '%', safe: '< 30%',
      risk: enough ? riskOf(pct(topSame, sent.length), 30, 60, 90) : 0,
      why: 'The same text sent to many people is how spam filters spot bulk messages.',
      fix: 'Use {{name}} and spintax like {Hi|Hello|Hey} so each message is different.',
    },
    {
      key: 'speed', label: 'Peak messages in one hour', weight: 8, enough: true,
      value: perHourPeak, unit: '/hour', safe: `≤ ${Math.round(3600000 / ((s.minDelayMs + s.maxDelayMs) / 2))}/hour at your delay settings`,
      risk: riskOf(perHourPeak, 60, 120, 240),
      why: 'Fast, machine-like bursts look automated.',
      fix: 'Use delays of 15–45 seconds between messages and spread campaigns over the day.',
    },
    {
      key: 'connection', label: 'Logouts / disconnections (7 days)', weight: 8, enough: true,
      value: loggedOut ? `${loggedOut} logout${loggedOut > 1 ? 's' : ''}` : `${drops} drop${drops === 1 ? '' : 's'}`, unit: '', safe: '0 logouts',
      risk: loggedOut ? 1 : riskOf(drops, 2, 6, 15),
      why: 'An unexpected logout often means WhatsApp restricted or flagged the number.',
      fix: 'If you were logged out unexpectedly, stop campaigns for 48 hours and use the number only for normal chats.',
    },
    {
      key: 'night', label: 'Sent at night (21:00–09:00)', weight: 3, enough,
      value: pct(night, sent.length), unit: '%', safe: '< 5%',
      risk: enough ? riskOf(pct(night, sent.length), 5, 20, 50) : 0,
      why: 'Late-night marketing messages annoy people and get reported more.',
      fix: 'Turn on quiet hours so campaigns wait until morning.',
    },
    {
      key: 'links', label: 'Messages with links', weight: 3, enough,
      value: pct(withLinks, sent.length), unit: '%', safe: '< 40%, no short links',
      risk: enough ? Math.max(riskOf(pct(withLinks, sent.length), 40, 70, 95), shortLinks ? 0.75 : 0) : 0,
      why: 'Links — especially shortened ones like bit.ly — are common in spam.',
      fix: 'Use your own full domain, add links only when needed, or use a "Website link" button.',
    },
  ];
  for (const x of signals) {
    x.status = x.enough ? statusOf(x.risk) : 'info';
    // minor signals (low weight) never show as "Danger" on their own
    if (x.weight < 8 && x.status === 'critical') x.status = 'serious';
  }

  let score = Math.round(signals.reduce((sum, x) => sum + x.weight * x.risk, 0));
  if (loggedOut) score = Math.max(score, 60);
  const level = score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';

  return {
    sessionId,
    ageDays,
    numberSince: sessionMeta(sessionId).numberSince,
    score,
    level,
    stats: { sent: sent.length, failed: failed.length, invalid, people: people.length, replied, optOuts, todaySent },
    limits: { recommended: recommended === Infinity ? null : recommended, effective: effectiveDailyLimit(sessionId, s), configured: s.dailyLimit },
    signals: signals.sort((a, b) => b.weight * b.risk - a.weight * a.risk),
  };
}

export function healthReport() {
  const s = getSettings();
  const ids = [...new Set([...listSessions().map((x) => x.id), ...Object.keys(db.sessionMeta)])];
  const status = Object.fromEntries(listSessions().map((x) => [x.id, x]));
  return {
    windowDays: WINDOW_DAYS,
    settings: s,
    sessions: ids.map((id) => ({ ...sessionHealth(id), status: status[id]?.status || 'not running', user: status[id]?.user || null })),
  };
}
