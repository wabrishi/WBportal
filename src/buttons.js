// Button messages (image + text + buttons) over the WhatsApp Web connection.
// NOTE: WhatsApp officially supports buttons only via the Business Cloud API. Over WhatsApp Web they
// may not render on every phone, so every message also lists the options as text ("Reply 1 …"),
// and a typed number is handled exactly like a button tap.
import { db, save, normalizePhone } from './store.js';

export const BUTTON_TYPES = ['reply', 'url', 'call', 'copy'];
const MAX_BUTTONS = 3;
const MENU_TTL_MS = 3 * 24 * 60 * 60 * 1000; // number replies count for 3 days after a menu is sent
const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣'];

const fail = (msg) => Object.assign(new Error(msg), { status: 400 });

// buttons: [{ type: 'reply', title, reply? } | { type: 'url', title, url } | { type: 'call', title, phone } | { type: 'copy', title, code }]
export function validateButtons(input) {
  let buttons = input;
  if (typeof buttons === 'string') {
    try { buttons = JSON.parse(buttons || '[]'); } catch { throw fail('buttons must be a JSON array'); }
  }
  if (!Array.isArray(buttons)) throw fail('buttons must be an array');
  buttons = buttons.filter((b) => b && String(b.title || '').trim());
  if (!buttons.length) throw fail('Add at least one button');
  if (buttons.length > MAX_BUTTONS) throw fail(`Maximum ${MAX_BUTTONS} buttons`);
  return buttons.map((b, i) => {
    const type = b.type || 'reply';
    const title = String(b.title).trim();
    if (!BUTTON_TYPES.includes(type)) throw fail(`Button ${i + 1}: type must be one of ${BUTTON_TYPES.join(', ')}`);
    if (title.length > 20) throw fail(`Button ${i + 1}: title must be 20 characters or less`);
    const out = { id: b.id || `btn_${i + 1}`, type, title };
    if (type === 'reply') out.reply = String(b.reply || '').trim(); // optional automatic answer when tapped
    if (type === 'url') {
      if (!/^https?:\/\/\S+$/i.test(b.url || '')) throw fail(`Button ${i + 1}: enter a valid http(s) URL`);
      out.url = b.url;
    }
    if (type === 'call') {
      const phone = normalizePhone(b.phone);
      if (phone.length < 8) throw fail(`Button ${i + 1}: enter a phone number with country code`);
      out.phone = phone;
    }
    if (type === 'copy') {
      if (!b.code) throw fail(`Button ${i + 1}: enter the code to copy`);
      out.code = String(b.code);
    }
    return out;
  });
}

// Plain-text version of the buttons, appended to the message so it works even where buttons don't show.
export function textOptions(buttons) {
  const lines = [];
  const replies = buttons.filter((b) => b.type === 'reply');
  if (replies.length) {
    lines.push('Reply with a number:');
    replies.forEach((b, i) => lines.push(`${NUM_EMOJI[i]} ${b.title}`));
  }
  for (const b of buttons) {
    if (b.type === 'url') lines.push(`🔗 ${b.title}: ${b.url}`);
    if (b.type === 'call') lines.push(`📞 ${b.title}: +${b.phone}`);
    if (b.type === 'copy') lines.push(`🏷️ ${b.title}: ${b.code}`);
  }
  return lines.join('\n');
}

export function nativeFlowButtons(buttons) {
  return buttons.map((b) => {
    if (b.type === 'url') return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: b.title, url: b.url, merchant_url: b.url }) };
    if (b.type === 'call') return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: b.title, phone_number: `+${b.phone}` }) };
    if (b.type === 'copy') return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: b.title, copy_code: b.code }) };
    return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: b.title, id: b.id }) };
  });
}

/* ---------- Remember the last menu per chat, so taps / number replies can be answered ---------- */
const menuKey = (sessionId, phone) => `${sessionId}:${phone}`;

export function rememberMenu(sessionId, phone, buttons, campaignId) {
  db.menus[menuKey(sessionId, phone)] = { buttons, campaignId: campaignId || null, sentAt: Date.now() };
  save();
}

// Returns the button the customer chose, from a tap (buttonId) or a typed number ("1", "1️⃣").
export function resolveChoice(sessionId, phone, { buttonId, text }) {
  const menu = db.menus[menuKey(sessionId, phone)];
  if (!menu || Date.now() - menu.sentAt > MENU_TTL_MS) return null;
  if (buttonId) return menu.buttons.find((b) => b.id === buttonId) || null;
  const t = String(text || '').trim();
  const idx = NUM_EMOJI.indexOf(t) >= 0 ? NUM_EMOJI.indexOf(t) : /^[1-9]$/.test(t) ? Number(t) - 1 : -1;
  const replies = menu.buttons.filter((b) => b.type === 'reply');
  return replies[idx] || null;
}

export function pruneMenus() {
  const cutoff = Date.now() - MENU_TTL_MS;
  for (const [k, m] of Object.entries(db.menus)) if (m.sentAt < cutoff) delete db.menus[k];
  save();
}
