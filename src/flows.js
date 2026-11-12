// Chatbot flows: a trigger plus a graph of steps (nodes) that run an automated WhatsApp conversation.
// The same engine powers live chats and the editor's test chat (simulate), through an "io" adapter.
import { db, save, uid, now, normalizePhone, logMessage, forEachTenant } from './store.js';
import { assertAllowed, tenantStatus, currentTenant } from './platform.js';
import { sendText, sendMedia, sendButtons } from './whatsapp.js';
import { emitWebhook } from './webhook.js';
import { createTicket, addNote } from './tickets.js';
import { findDepartment } from './departments.js';

export const NODE_TYPES = ['start', 'message', 'menu', 'question', 'condition', 'action', 'delay', 'handoff', 'end'];
export const TRIGGERS = ['keyword', 'first_message', 'any'];
const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'optout', 'opt out', 'cancel'];
const MAX_STEPS = 50;    // loop guard per incoming message
const MAX_RETRIES = 3;   // invalid answers before the bot gives up
const VAR_RE = /^[a-z_][a-z0-9_]*$/i;
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ======================= validation ======================= */

// Returns { errors, warnings }; a flow with errors can be saved but not switched on.
export function validateFlow(f) {
  const errors = [], warnings = [];
  const nodes = f.nodes || {};
  const TYPE_NAMES = {
    start: 'Start', message: 'Send message', menu: 'Menu', question: 'Question', condition: 'Condition',
    action: 'Action', delay: 'Wait', handoff: 'Hand to a person', end: 'End',
  };
  const label = (id) => `"${nodes[id]?.label || `${TYPE_NAMES[nodes[id]?.type] || 'Unknown'} step`}"`;
  if (!String(f.name || '').trim()) errors.push('Give the flow a name.');
  if (!TRIGGERS.includes(f.trigger?.type)) errors.push('Choose a trigger.');
  if (f.trigger?.type === 'keyword' && !(f.trigger.keywords || []).filter(Boolean).length) errors.push('Add at least one trigger keyword.');
  if (!nodes.start) errors.push('The flow has no start step.');
  else if (!nodes.start.next) errors.push('Connect the start to the first step.');

  const ref = (from, to, what) => {
    if (to && !nodes[to]) errors.push(`${label(from)}: ${what} points to a step that no longer exists.`);
  };
  for (const [id, n] of Object.entries(nodes)) {
    if (!NODE_TYPES.includes(n.type)) { errors.push(`${label(id)}: unknown step type.`); continue; }
    const needText = ['message', 'menu', 'question'].includes(n.type);
    if (needText && !String(n.text || '').trim() && !(n.type === 'message' && n.imageUrl)) errors.push(`${label(id)}: write the message text.`);
    if (n.imageUrl && !/^https?:\/\/\S+$/i.test(n.imageUrl)) errors.push(`${label(id)}: image must be an http(s) URL.`);
    if (n.type === 'menu') {
      const opts = n.options || [];
      if (!opts.length) errors.push(`${label(id)}: add at least one option.`);
      if (opts.length > 10) errors.push(`${label(id)}: maximum 10 options.`);
      if (n.style === 'buttons' && opts.length > 3) errors.push(`${label(id)}: button menus allow up to 3 options (use "Numbered list" for more).`);
      opts.forEach((o, i) => {
        if (!String(o.title || '').trim()) errors.push(`${label(id)}: option ${i + 1} needs a title.`);
        if (n.style === 'buttons' && String(o.title || '').length > 20) errors.push(`${label(id)}: option ${i + 1} title must be 20 characters or less for buttons.`);
        if (!o.next) warnings.push(`${label(id)}: option "${o.title || i + 1}" isn't connected, so choosing it ends the flow.`);
        ref(id, o.next, `option "${o.title || i + 1}"`);
      });
    }
    if (n.type === 'question' && !VAR_RE.test(n.variable || '')) errors.push(`${label(id)}: save the answer in a variable (letters, numbers, _).`);
    if (n.type === 'condition') {
      if (!n.variable) errors.push(`${label(id)}: choose what to check.`);
      if (!n.yes && !n.no) warnings.push(`${label(id)}: neither "yes" nor "no" is connected.`);
      ref(id, n.yes, '"yes"');
      ref(id, n.no, '"no"');
    }
    if (n.type === 'action') {
      if (['add_tag', 'remove_tag'].includes(n.action) && !String(n.value || '').trim()) errors.push(`${label(id)}: enter the tag.`);
      if (n.action === 'set_variable' && !VAR_RE.test(n.variable || '')) errors.push(`${label(id)}: enter a variable name.`);
    }
    if (n.type === 'delay' && !(Number(n.seconds) >= 1 && Number(n.seconds) <= 86400)) errors.push(`${label(id)}: delay must be 1 second to 24 hours.`);
    if (n.type === 'handoff' && n.departmentId && !findDepartment(n.departmentId)) errors.push(`${label(id)}: the department no longer exists.`);
    if (['start', 'message', 'question', 'action', 'delay'].includes(n.type)) {
      ref(id, n.next, 'the next step');
      if (!n.next && n.type !== 'start') warnings.push(`${label(id)}: nothing comes after this step, so the flow ends here.`);
    }
  }
  // unreachable steps
  const seen = new Set();
  const visit = (id) => {
    if (!id || seen.has(id) || !nodes[id]) return;
    seen.add(id);
    const n = nodes[id];
    [n.next, n.yes, n.no, ...(n.options || []).map((o) => o.next)].forEach(visit);
  };
  visit('start');
  for (const id of Object.keys(nodes)) if (!seen.has(id)) warnings.push(`${label(id)} can't be reached from the start.`);
  return { errors, warnings };
}

function cleanFlow(b, existing = {}) {
  const trigger = b.trigger || existing.trigger || { type: 'keyword', keywords: [] };
  return {
    ...existing,
    name: String(b.name ?? existing.name ?? '').trim(),
    description: String(b.description ?? existing.description ?? ''),
    sessionIds: Array.isArray(b.sessionIds) ? b.sessionIds : existing.sessionIds || [],
    trigger: {
      type: trigger.type,
      match: trigger.match === 'exact' ? 'exact' : 'contains',
      keywords: (Array.isArray(trigger.keywords) ? trigger.keywords : String(trigger.keywords || '').split(','))
        .map((k) => String(k).trim().toLowerCase()).filter(Boolean),
    },
    timeoutMinutes: Math.min(1440, Math.max(5, Number(b.timeoutMinutes ?? existing.timeoutMinutes ?? 60))),
    cooldownMinutes: Math.min(10080, Math.max(0, Number(b.cooldownMinutes ?? existing.cooldownMinutes ?? 60))),
    nodes: b.nodes || existing.nodes || { start: { type: 'start', x: 40, y: 160, next: null } },
  };
}

/* ======================= CRUD ======================= */

export const findFlow = (id) => db.flows.find((f) => f.id === id);

export function createFlow(b, user) {
  assertAllowed('flows');
  const tpl = b.template && TEMPLATES[b.template] ? TEMPLATES[b.template]() : {};
  const f = {
    id: uid(), active: false, stats: { started: 0, completed: 0, handoffs: 0 },
    createdAt: now(), updatedAt: now(), createdBy: user?.name || '',
    ...cleanFlow({ ...tpl, ...b, nodes: b.nodes || tpl.nodes }),
  };
  if (!f.name) f.name = tpl.name || 'Untitled flow';
  db.flows.push(f);
  save();
  return { flow: f, issues: validateFlow(f) };
}

export function updateFlow(id, b) {
  const f = findFlow(id);
  if (!f) throw fail('Flow not found', 404);
  Object.assign(f, cleanFlow(b, f), { updatedAt: now() });
  const issues = validateFlow(f);
  if (b.active !== undefined) {
    if (b.active && issues.errors.length) throw fail(`Fix these before switching the flow on: ${issues.errors.join(' ')}`);
    f.active = !!b.active;
  } else if (f.active && issues.errors.length) {
    f.active = false; // a broken flow never stays live
  }
  save();
  return { flow: f, issues };
}

export function deleteFlow(id) {
  if (!findFlow(id)) throw fail('Flow not found', 404);
  db.flows = db.flows.filter((f) => f.id !== id);
  for (const [k, r] of Object.entries(db.flowRuns)) if (r.flowId === id) delete db.flowRuns[k];
  save();
}

export function duplicateFlow(id, user) {
  const f = findFlow(id);
  if (!f) throw fail('Flow not found', 404);
  const copy = JSON.parse(JSON.stringify(f));
  return createFlow({ ...copy, name: `${f.name} (copy)`, active: false }, user);
}

/* ======================= engine ======================= */

const fill = (text, vars) =>
  String(text || '').replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (_, k) => (vars[k] ?? vars[k.toLowerCase()] ?? '').toString());

function validate(kind, raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  switch (kind) {
    case 'number': return /^-?\d+([.,]\d+)?$/.test(t) ? t.replace(',', '.') : null;
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t.toLowerCase() : null;
    case 'phone': { const d = normalizePhone(t); return d.length >= 8 && d.length <= 15 ? d : null; }
    case 'date': return Number.isNaN(Date.parse(t)) && !/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(t) ? null : t;
    case 'yesno': return /^(y|yes|haan|ha|ok|sure|1)$/i.test(t) ? 'yes' : /^(n|no|nahi|nope|2)$/i.test(t) ? 'no' : null;
    default: return t;
  }
}
const INVALID = {
  number: 'Please reply with a number.', email: 'Please reply with a valid email address.',
  phone: 'Please reply with a valid phone number with country code.', date: 'Please reply with a date, e.g. 25/12/2026.',
  yesno: 'Please reply YES or NO.', any: 'Please type your answer.',
};

function evalCondition(n, vars) {
  const v = vars[n.variable];
  const val = String(n.value ?? '').trim().toLowerCase();
  const s = String(v ?? '').trim().toLowerCase();
  switch (n.operator) {
    case 'exists': return s !== '';
    case 'not_exists': return s === '';
    case 'equals': return s === val;
    case 'not_equals': return s !== val;
    case 'contains': return val.split(',').map((x) => x.trim()).filter(Boolean).some((x) => s.includes(x));
    case 'gt': return Number(v) > Number(n.value);
    case 'lt': return Number(v) < Number(n.value);
    default: return false;
  }
}

function matchOption(node, { text, buttonId }) {
  const opts = node.options || [];
  if (buttonId) { const o = opts.find((x) => x.id === buttonId); if (o) return o; }
  const t = String(text || '').trim().toLowerCase().replace(/^\[button\]\s*/, '');
  const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'].indexOf(t);
  const n = emoji >= 0 ? emoji + 1 : /^\d{1,2}$/.test(t) ? Number(t) : 0;
  if (n >= 1 && n <= opts.length) return opts[n - 1];
  return opts.find((o) => o.title.trim().toLowerCase() === t) || null;
}

// Runs steps until the flow needs the customer's input, waits, or ends.
async function step(flow, run, io) {
  for (let i = 0; i < MAX_STEPS; i++) {
    const n = flow.nodes[run.nodeId];
    if (!n) return endRun(flow, run, io, 'completed');
    const vars = run.vars;
    switch (n.type) {
      case 'start':
        run.nodeId = n.next;
        break;
      case 'message':
        await io.send({ text: fill(n.text, vars), imageUrl: n.imageUrl });
        run.nodeId = n.next;
        break;
      case 'menu':
      case 'question':
        await io.send(promptFor(n, vars));
        run.waiting = run.nodeId;
        run.retries = 0;
        return;
      case 'condition':
        run.nodeId = evalCondition(n, vars) ? n.yes : n.no;
        break;
      case 'action':
        await io.action(n, run);
        run.nodeId = n.next;
        break;
      case 'delay':
        run.nodeId = n.next;
        run.waiting = 'delay';
        run.resumeAt = Date.now() + Number(n.seconds) * 1000;
        return;
      case 'handoff':
        await io.handoff(n, run);
        return endRun(flow, run, io, 'handoff');
      case 'end':
        if (n.text) await io.send({ text: fill(n.text, vars) });
        return endRun(flow, run, io, 'completed');
      default:
        run.nodeId = null;
    }
    if (!run.nodeId) return endRun(flow, run, io, 'completed');
  }
  await io.send({ text: 'Sorry, something went wrong. A team member will help you shortly.' });
  return endRun(flow, run, io, 'error');
}

function promptFor(n, vars) {
  const text = fill(n.text, vars);
  if (n.type !== 'menu') return { text };
  const opts = n.options || [];
  if (n.style === 'buttons' && opts.length <= 3) {
    return { text, imageUrl: n.imageUrl, footer: n.footer, buttons: opts.map((o) => ({ id: o.id, type: 'reply', title: o.title })) };
  }
  const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  return { text: `${text}\n\n${opts.map((o, i) => `${emoji[i]} ${o.title}`).join('\n')}\n\nReply with a number.`, imageUrl: n.imageUrl };
}

async function onInput(flow, run, input, io) {
  const n = flow.nodes[run.waiting];
  if (!n) return endRun(flow, run, io, 'completed');
  if (n.type === 'menu') {
    const o = matchOption(n, input);
    if (!o) return retry(flow, run, io, n.invalidText || 'Please choose one of the options.', n);
    run.vars[n.variable || 'choice'] = o.title;
    run.nodeId = o.next;
  } else {
    const v = validate(n.validate || 'any', input.text);
    if (v == null) return retry(flow, run, io, n.invalidText || INVALID[n.validate || 'any'], n);
    run.vars[n.variable] = v;
    await io.saveField(n.variable, v, run);
    run.nodeId = n.next;
  }
  run.waiting = null;
  if (!run.nodeId) return endRun(flow, run, io, 'completed');
  return step(flow, run, io);
}

async function retry(flow, run, io, msg, n) {
  run.retries = (run.retries || 0) + 1;
  if (run.retries >= MAX_RETRIES) {
    await io.send({ text: "Sorry, I didn't get that. A team member will get back to you." });
    await io.handoff({ type: 'handoff', departmentId: null, priority: 'normal', subject: `Bot couldn't understand: ${flow.name}` }, run);
    return endRun(flow, run, io, 'handoff');
  }
  await io.send({ text: msg });
  if (n.type === 'menu') await io.send(promptFor(n, run.vars)); // show the options again
}

function endRun(flow, run, io, outcome) {
  run.ended = outcome;
  run.waiting = null;
  io.ended?.(outcome);
}

/* ======================= live conversations ======================= */

const runKey = (sessionId, phone) => `${sessionId}:${phone}`;

function liveIO(flow, sessionId, phone) {
  return {
    async send({ text, imageUrl, buttons, footer }) {
      let res;
      try {
        if (buttons?.length) res = await sendButtons(sessionId, phone, { text, footer, image: imageUrl ? { url: imageUrl } : null, buttons, includeTextOptions: true });
        else if (imageUrl) res = await sendMedia(sessionId, phone, { url: imageUrl, caption: text });
        else res = await sendText(sessionId, phone, text);
        logMessage({ sessionId, to: phone, text: buttons?.length ? `${text}\n[buttons: ${buttons.map((b) => b.title).join(' | ')}]` : text, status: 'sent', waId: res?.key?.id, flowId: flow.id });
      } catch (e) {
        logMessage({ sessionId, to: phone, text, status: 'failed', error: e.message, flowId: flow.id });
      }
      await sleep(700); // feels less robotic, and keeps messages in order
    },
    async action(n, run) {
      const c = contactFor(phone, run.vars.name);
      if (n.action === 'add_tag') c.tags = [...new Set([...(c.tags || []), String(n.value).trim()])];
      if (n.action === 'remove_tag') c.tags = (c.tags || []).filter((t) => t !== String(n.value).trim());
      if (n.action === 'set_variable') { run.vars[n.variable] = fill(n.value, run.vars); c.fields = { ...c.fields, [n.variable]: run.vars[n.variable] }; }
      if (n.action === 'opt_in') { c.optedOut = false; c.optedInAt = now(); }
      if (n.action === 'webhook') emitWebhook('flow.action', { flowId: flow.id, flow: flow.name, sessionId, phone, value: fill(n.value, run.vars), variables: run.vars });
      save();
    },
    async saveField(key, value, run) {
      const c = contactFor(phone, run.vars.name);
      c.fields = { ...c.fields, [key]: value };
      if (key === 'name' && value) c.name = value;
      save();
    },
    async handoff(n, run) {
      flow.stats.handoffs++;
      const answers = Object.entries(run.vars).filter(([k]) => !['phone'].includes(k));
      const t = createTicket({
        sessionId, phone, name: run.vars.name || '', priority: n.priority || 'normal',
        subject: fill(n.subject, run.vars) || `From chatbot: ${flow.name}`,
        ...(n.departmentId ? { departmentId: n.departmentId } : {}),
        message: answers.map(([k, v]) => `${k}: ${v}`).join('\n'),
      }, { id: null, name: `chatbot "${flow.name}"` });
      addNote(t, { text: `Handed over by chatbot "${flow.name}".${answers.length ? `\n\nCollected:\n${answers.map(([k, v]) => `• ${k}: ${v}`).join('\n')}` : ''}` },
        { id: null, name: 'chatbot' });
      if (n.text) await this.send({ text: fill(n.text, run.vars) });
    },
    ended(outcome) {
      if (outcome === 'completed') flow.stats.completed++;
      delete db.flowRuns[runKey(sessionId, phone)];
      db.flowLast[`${runKey(sessionId, phone)}:${flow.id}`] = Date.now();
      save();
    },
  };
}

function contactFor(phone, name) {
  let c = db.contacts.find((x) => x.phone === phone);
  if (!c) {
    c = { id: uid(), phone, name: name || '', tags: [], optedOut: false, fields: {}, createdAt: now(), source: 'chatbot' };
    db.contacts.push(c);
  }
  return c;
}

function hasActiveTicket(sessionId, phone) {
  return db.tickets.some((t) => t.phone === phone && t.sessionId === sessionId && (t.status === 'open' || t.status === 'pending'));
}

function pickTrigger(sessionId, phone, text) {
  const t = String(text || '').trim().toLowerCase().replace(/^\[button\]\s*/, '');
  const live = db.flows.filter((f) => f.active && (!f.sessionIds?.length || f.sessionIds.includes(sessionId)));
  const cooled = (f) => Date.now() - (db.flowLast[`${runKey(sessionId, phone)}:${f.id}`] || 0) > f.cooldownMinutes * 60000;
  const kw = live.find((f) => f.trigger.type === 'keyword' &&
    f.trigger.keywords.some((k) => (f.trigger.match === 'exact' ? t === k : t.includes(k))));
  if (kw) return kw; // keywords always work, even mid-conversation with a human
  if (hasActiveTicket(sessionId, phone)) return null; // a person is already handling this chat
  const inboundCount = db.messages.filter((m) => m.sessionId === sessionId && m.to === phone && m.direction === 'in').length;
  const first = live.find((f) => f.trigger.type === 'first_message' && inboundCount <= 1 && cooled(f));
  if (first) return first;
  return live.find((f) => f.trigger.type === 'any' && cooled(f)) || null;
}

// Called for every incoming WhatsApp message. Returns true if a flow handled it
// (then no ticket is created — the bot owns the conversation until it hands over).
export async function handleFlowMessage(sessionId, phone, { text, buttonId, pushName }) {
  if (!tenantStatus(currentTenant()).canUse) return false; // subscription inactive: no bot replies
  const key = runKey(sessionId, phone);
  let run = db.flowRuns[key];
  if (OPT_OUT_WORDS.includes(String(text).trim().toLowerCase())) {
    if (run) { delete db.flowRuns[key]; save(); }
    return !!run;
  }
  if (run) {
    const flow = findFlow(run.flowId);
    const expired = !flow || !flow.active || Date.now() - new Date(run.updatedAt).getTime() > flow.timeoutMinutes * 60000;
    if (expired) { delete db.flowRuns[key]; run = null; }
    else {
      // a different flow's keyword restarts with that flow
      const kw = pickTrigger(sessionId, phone, text);
      if (kw && kw.trigger.type === 'keyword' && kw.id !== flow.id) { delete db.flowRuns[key]; run = null; }
      else {
        if (run.waiting === 'delay') return true; // the bot will continue by itself
        run.updatedAt = now();
        await onInput(flow, run, { text, buttonId }, liveIO(flow, sessionId, phone));
        if (!run.ended) { db.flowRuns[key] = run; save(); }
        return true;
      }
    }
  }
  const flow = pickTrigger(sessionId, phone, text);
  if (!flow) return false;
  const contact = db.contacts.find((c) => c.phone === phone);
  run = {
    flowId: flow.id, nodeId: 'start', waiting: null, retries: 0, startedAt: now(), updatedAt: now(),
    vars: { ...(contact?.fields || {}), name: contact?.name || pushName || '', phone, first_message: text },
  };
  db.flowRuns[key] = run;
  flow.stats.started++;
  save();
  await step(flow, run, liveIO(flow, sessionId, phone));
  if (!run.ended) { db.flowRuns[key] = run; save(); }
  return true;
}

// Continue runs that were waiting on a delay step (checked every 10 s; survives restarts).
export function startFlowTimers() {
  setInterval(() => forEachTenant(async () => {
    for (const [key, run] of Object.entries(db.flowRuns)) {
      if (run.waiting !== 'delay' || run.resumeAt > Date.now() || run.busy) continue;
      const flow = findFlow(run.flowId);
      const [sessionId, phone] = key.split(':');
      if (!flow?.active) { delete db.flowRuns[key]; continue; }
      run.busy = true;
      run.waiting = null;
      run.updatedAt = now();
      try { await step(flow, run, liveIO(flow, sessionId, phone)); } catch (e) { console.error('Flow error:', e.message); }
      delete run.busy;
      if (!run.ended) db.flowRuns[key] = run;
      save();
    }
  }), 10000);
}

/* ======================= test chat (no side effects) ======================= */

export async function simulate(flowDraft, state, input) {
  const flow = { ...cleanFlow(flowDraft), stats: { started: 0, completed: 0, handoffs: 0 } };
  const out = [];
  const io = {
    async send(m) { out.push({ type: 'bot', ...m }); },
    async action(n, run) {
      const desc = {
        add_tag: `Add tag "${n.value}"`, remove_tag: `Remove tag "${n.value}"`, opt_in: 'Mark contact as opted in',
        set_variable: `Set ${n.variable} = "${fill(n.value, run.vars)}"`, webhook: 'Send webhook (flow.action)',
      }[n.action] || n.action;
      if (n.action === 'set_variable') run.vars[n.variable] = fill(n.value, run.vars);
      out.push({ type: 'system', text: `⚙️ ${desc}` });
    },
    async saveField(k, v) { out.push({ type: 'system', text: `💾 Saved ${k} = "${v}" on the contact` }); },
    async handoff(n, run) {
      const dep = findDepartment(n.departmentId)?.name;
      out.push({ type: 'system', text: `🎫 Ticket created${dep ? ` in ${dep}` : ''} and handed to a human` });
      if (n.text) out.push({ type: 'bot', text: fill(n.text, run.vars) });
    },
  };
  let run = state;
  if (!run || run.ended) {
    run = { nodeId: 'start', waiting: null, retries: 0, vars: { name: 'Test User', phone: '919999999999', first_message: input || '' } };
    if (input) out.push({ type: 'system', text: '▶️ Flow started' });
    await step(flow, run, io);
  } else if (run.waiting === 'delay') {
    out.push({ type: 'system', text: '⏱️ Delay skipped in test mode' });
    run.waiting = null;
    await step(flow, run, io);
  } else {
    await onInput(flow, run, { text: input }, io);
  }
  if (run.ended) out.push({ type: 'system', text: run.ended === 'handoff' ? '🙋 Conversation handed over — flow finished' : '⏹️ Flow finished' });
  return { output: out, state: run, waitingFor: run.waiting && flow.nodes[run.waiting] ? flow.nodes[run.waiting] : null };
}

/* ======================= templates ======================= */

const TEMPLATES = {
  blank: () => ({ name: 'Untitled flow', trigger: { type: 'keyword', keywords: ['hi'] }, nodes: { start: { type: 'start', x: 40, y: 200, next: null } } }),

  welcome: () => ({
    name: 'Welcome menu',
    description: 'Greets new chats and routes them to Sales, Support or a person.',
    trigger: { type: 'any', keywords: [] },
    cooldownMinutes: 240,
    nodes: {
      start: { type: 'start', x: 40, y: 220, next: 'greet' },
      greet: { type: 'menu', label: 'Main menu', x: 300, y: 180, style: 'buttons', variable: 'topic',
        text: 'Hi {{name}} 👋 Welcome! How can we help you today?',
        options: [{ id: 'o1', title: 'Prices & plans', next: 'prices' }, { id: 'o2', title: 'Support', next: 'order' }, { id: 'o3', title: 'Talk to a person', next: 'human' }] },
      prices: { type: 'message', label: 'Prices', x: 640, y: 40, text: 'Our plans start at ₹499/month. See all plans: https://example.com/pricing', next: 'more' },
      more: { type: 'menu', label: 'Anything else?', x: 960, y: 40, style: 'buttons', text: 'Anything else I can help with?',
        options: [{ id: 'm1', title: 'Main menu', next: 'greet' }, { id: 'm2', title: 'Talk to a person', next: 'human' }, { id: 'm3', title: "No, thanks", next: 'bye' }] },
      order: { type: 'question', label: 'Order number', x: 640, y: 260, text: 'Please share your order number.', variable: 'order_id', validate: 'any', next: 'support' },
      support: { type: 'handoff', label: 'To Support', x: 960, y: 300, text: 'Thanks! Our support team will reply here shortly. 🙏', subject: 'Support for order {{order_id}}', priority: 'normal', departmentId: null },
      human: { type: 'handoff', label: 'To a person', x: 640, y: 440, text: 'Sure — connecting you to our team. Someone will reply soon.', subject: 'Customer asked for a person', priority: 'normal', departmentId: null },
      bye: { type: 'end', label: 'Goodbye', x: 1280, y: 80, text: 'Thank you for contacting us! Have a great day 😊' },
    },
  }),

  lead: () => ({
    name: 'Lead capture',
    description: 'Collects name, email and requirement, tags the contact as a lead and hands over to Sales.',
    trigger: { type: 'keyword', keywords: ['demo', 'quote', 'price'] },
    nodes: {
      start: { type: 'start', x: 40, y: 200, next: 'ask_name' },
      ask_name: { type: 'question', label: 'Name', x: 300, y: 180, text: "Great! Let's get you a quote. What's your name?", variable: 'name', validate: 'any', next: 'ask_email' },
      ask_email: { type: 'question', label: 'Email', x: 620, y: 180, text: 'Thanks {{name}}! What is your email address?', variable: 'email', validate: 'email', next: 'ask_need' },
      ask_need: { type: 'menu', label: 'Requirement', x: 940, y: 160, style: 'list', variable: 'interest', text: 'What are you interested in?',
        options: [{ id: 'n1', title: 'Starter plan', next: 'tag' }, { id: 'n2', title: 'Business plan', next: 'tag' }, { id: 'n3', title: 'Enterprise / custom', next: 'tag' }, { id: 'n4', title: 'Not sure yet', next: 'tag' }] },
      tag: { type: 'action', label: 'Tag as lead', x: 1260, y: 180, action: 'add_tag', value: 'lead', next: 'sales' },
      sales: { type: 'handoff', label: 'To Sales', x: 1560, y: 180, priority: 'high', subject: 'New lead: {{name}} ({{interest}})',
        text: 'Thank you {{name}}! Our sales team will contact you shortly with a quote for {{interest}}.', departmentId: null },
    },
  }),

  feedback: () => ({
    name: 'Feedback survey',
    description: 'Asks for a 1–5 rating; unhappy customers go to a person, happy ones get a review link.',
    trigger: { type: 'keyword', keywords: ['feedback'] },
    nodes: {
      start: { type: 'start', x: 40, y: 200, next: 'rate' },
      rate: { type: 'question', label: 'Rating', x: 300, y: 180, text: 'How would you rate us from 1 (bad) to 5 (excellent)?', variable: 'rating', validate: 'number', invalidText: 'Please reply with a number from 1 to 5.', next: 'check' },
      check: { type: 'condition', label: 'Happy?', x: 620, y: 180, variable: 'rating', operator: 'gt', value: '3', yes: 'happy', no: 'why' },
      happy: { type: 'end', label: 'Thank you', x: 940, y: 60, text: 'Thank you! 🌟 Would you mind leaving us a review? https://g.page/r/example' },
      why: { type: 'question', label: 'What went wrong', x: 940, y: 280, text: "We're sorry to hear that. What could we do better?", variable: 'feedback', validate: 'any', next: 'escalate' },
      escalate: { type: 'handoff', label: 'To a person', x: 1260, y: 280, priority: 'high', subject: 'Unhappy customer (rating {{rating}})', text: 'Thanks for telling us. A manager will contact you personally.', departmentId: null },
    },
  }),
};
export const TEMPLATE_LIST = [
  { id: 'blank', name: 'Blank flow', description: 'Start from scratch.' },
  { id: 'welcome', name: 'Welcome menu', description: 'Greet new chats and route them to Sales, Support or a person.' },
  { id: 'lead', name: 'Lead capture', description: 'Collect name, email and need, tag as lead, hand over to Sales.' },
  { id: 'feedback', name: 'Feedback survey', description: 'Rating 1–5; unhappy customers go to a manager.' },
];
