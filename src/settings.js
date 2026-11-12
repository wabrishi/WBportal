// Anti-block protection settings. Saved in the database (editable on the Block Risk screen);
// values not set there fall back to .env, then to safe defaults.
import { db, save } from './store.js';

const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);

export const RECOMMENDED = {
  minDelayMs: 15000,
  maxDelayMs: 45000,
  dailyLimit: 300,
  warmup: true,
  quietHours: { enabled: true, start: 21, end: 9 },
  autoPause: { enabled: true, failRate: 10, optOutRate: 2, minSample: 20 },
};

export function getSettings() {
  const s = db.settings || {};
  return {
    minDelayMs: s.minDelayMs ?? num('MIN_DELAY_MS', 8000),
    maxDelayMs: s.maxDelayMs ?? num('MAX_DELAY_MS', 20000),
    dailyLimit: s.dailyLimit ?? num('DAILY_LIMIT_PER_SESSION', 500),
    warmup: s.warmup ?? true,
    quietHours: { enabled: false, start: 21, end: 9, ...s.quietHours },
    autoPause: { enabled: true, failRate: 10, optOutRate: 2, minSample: 20, ...s.autoPause },
  };
}

const int = (v, min, max, name) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw Object.assign(new Error(`${name} must be between ${min} and ${max}`), { status: 400 });
  return n;
};

export function updateSettings(b) {
  const cur = getSettings();
  const next = {
    minDelayMs: b.minDelayMs !== undefined ? int(b.minDelayMs, 1000, 600000, 'Minimum delay') : cur.minDelayMs,
    maxDelayMs: b.maxDelayMs !== undefined ? int(b.maxDelayMs, 1000, 600000, 'Maximum delay') : cur.maxDelayMs,
    dailyLimit: b.dailyLimit !== undefined ? int(b.dailyLimit, 1, 10000, 'Daily limit') : cur.dailyLimit,
    warmup: b.warmup !== undefined ? !!b.warmup : cur.warmup,
    quietHours: {
      enabled: b.quietHours?.enabled !== undefined ? !!b.quietHours.enabled : cur.quietHours.enabled,
      start: b.quietHours?.start !== undefined ? int(b.quietHours.start, 0, 23, 'Quiet hours start') : cur.quietHours.start,
      end: b.quietHours?.end !== undefined ? int(b.quietHours.end, 0, 23, 'Quiet hours end') : cur.quietHours.end,
    },
    autoPause: {
      enabled: b.autoPause?.enabled !== undefined ? !!b.autoPause.enabled : cur.autoPause.enabled,
      failRate: b.autoPause?.failRate !== undefined ? int(b.autoPause.failRate, 1, 100, 'Failure threshold') : cur.autoPause.failRate,
      optOutRate: b.autoPause?.optOutRate !== undefined ? int(b.autoPause.optOutRate, 1, 100, 'Opt-out threshold') : cur.autoPause.optOutRate,
      minSample: cur.autoPause.minSample,
    },
  };
  if (next.maxDelayMs < next.minDelayMs) throw Object.assign(new Error('Maximum delay must be at least the minimum delay'), { status: 400 });
  db.settings = next;
  save();
  return next;
}

// Is this hour inside the quiet window? (handles windows that cross midnight, e.g. 21 → 9)
export function inQuietHours(date = new Date(), s = getSettings()) {
  if (!s.quietHours.enabled || s.quietHours.start === s.quietHours.end) return false;
  const h = date.getHours();
  const { start, end } = s.quietHours;
  return start < end ? h >= start && h < end : h >= start || h < end;
}
