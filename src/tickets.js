// Support tickets: incoming WhatsApp messages open/continue a ticket; agents reply from the dashboard or API.
// "actor" arguments are { id, name } of whoever performs the action (a user, the API, or the system).
import { db, save, uid, now, normalizePhone, logMessage } from './store.js';
import { sendText, sendMedia } from './whatsapp.js';
import { emitWebhook } from './webhook.js';
import {
  routeDepartment, pickAssignee, findDepartment, findUser, userName, canSeeTicket,
} from './departments.js';

export const STATUSES = ['open', 'pending', 'resolved', 'closed'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'optout', 'opt out', 'cancel'];
const DAY = 24 * 60 * 60 * 1000;
const SYSTEM = { id: null, name: 'system' };

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const fill = (tpl, t) => tpl.replace(/\{\{\s*ticket\s*\}\}/gi, t.number).replace(/\{\{\s*name\s*\}\}/gi, t.name || 'there');
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

function nextNumber() {
  db.ticketSeq = (db.ticketSeq || 1000) + 1;
  return db.ticketSeq;
}

export function findTicket(idOrNumber) {
  return db.tickets.find((t) => t.id === idOrNumber || String(t.number) === String(idOrNumber).replace('#', ''));
}

// Find a ticket the user is allowed to see (404 otherwise, so ticket ids don't leak).
export function getTicketFor(user, idOrNumber) {
  const t = findTicket(idOrNumber);
  if (!t || !canSeeTicket(user, t)) throw fail('Ticket not found', 404);
  return t;
}

function addEntry(t, entry) {
  const e = { id: uid(), at: now(), ...entry };
  t.thread.push(e);
  t.updatedAt = e.at;
  return e;
}

function validateAssignee(assignee, departmentId) {
  if (!assignee) return '';
  const u = findUser(assignee);
  if (!u || !u.active) throw fail('Assignee must be an active user');
  if (u.role !== 'admin' && departmentId && !u.departmentIds?.includes(departmentId)) {
    throw fail(`${u.name} is not a member of this department`);
  }
  return u.id;
}

export function createTicket({
  sessionId, phone, name = '', subject = '', priority = 'normal', assignee = '', departmentId, tags = [], message,
}, actor = SYSTEM) {
  phone = normalizePhone(phone);
  if (!sessionId || phone.length < 8) throw fail('sessionId and a valid phone are required');
  if (!PRIORITIES.includes(priority)) throw fail(`priority must be one of ${PRIORITIES.join(', ')}`);
  if (departmentId === undefined) departmentId = routeDepartment(sessionId, message || subject);
  if (departmentId && !findDepartment(departmentId)) throw fail('Department not found');
  assignee = assignee ? validateAssignee(assignee, departmentId) : pickAssignee(departmentId);

  const contact = db.contacts.find((c) => c.phone === phone);
  const t = {
    id: uid(),
    number: nextNumber(),
    sessionId,
    phone,
    name: name || contact?.name || '',
    subject: subject || (message ? message.slice(0, 80) : 'New ticket'),
    status: 'open',
    priority,
    departmentId: departmentId || null,
    assignee,
    tags,
    unread: 0,
    thread: [], // { id, at, type: 'in'|'out'|'note'|'event', text, by, byId?, status?, error? }
    createdAt: now(),
    updatedAt: now(),
    firstResponseAt: null,
    resolvedAt: null,
  };
  db.tickets.push(t);
  const dept = findDepartment(t.departmentId);
  addEntry(t, { type: 'event', text: `Ticket created by ${actor.name}${dept ? ` in ${dept.name}` : ''}` });
  if (assignee) addEntry(t, { type: 'event', text: `Assigned to ${userName(assignee)}` });
  save();
  emitWebhook('ticket.created', summary(t));
  return t;
}

// Called for every incoming WhatsApp message.
// autoReply: answer configured on a button the customer tapped; sent instead of the "ticket created" message.
export async function handleIncoming(sessionId, phone, text, pushName, { autoReply } = {}) {
  if (OPT_OUT_WORDS.includes(text.trim().toLowerCase())) return;
  if (env('AUTO_TICKETS', 'true') === 'false') {
    if (autoReply) {
      const res = await sendText(sessionId, phone, autoReply);
      logMessage({ sessionId, to: phone, text: autoReply, status: 'sent', waId: res?.key?.id });
    }
    return;
  }

  const reopenDays = Number(env('TICKET_REOPEN_DAYS', 7));
  const latest = db.tickets
    .filter((t) => t.phone === phone && t.sessionId === sessionId && t.status !== 'closed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const canContinue = latest &&
    (latest.status !== 'resolved' || Date.now() - new Date(latest.resolvedAt).getTime() < reopenDays * DAY);

  let t = canContinue ? latest : null;
  const isNew = !t;
  if (isNew) {
    t = createTicket({ sessionId, phone, name: pushName || '', message: text }, { id: null, name: 'customer' });
  } else if (t.status !== 'open') {
    addEntry(t, { type: 'event', text: `Reopened by customer reply (was ${t.status})` });
    t.status = 'open';
    t.resolvedAt = null;
  }
  if (!t.name && pushName) t.name = pushName;
  addEntry(t, { type: 'in', text, by: t.name || `+${phone}` });
  t.unread = (t.unread || 0) + 1;
  t.lastCustomerAt = now();
  save();
  emitWebhook('ticket.message', { ticket: summary(t), direction: 'in', text });

  if (autoReply) {
    await sendOut(t, autoReply, { id: null, name: 'button auto-reply' }).catch(() => {});
    return;
  }
  const ack = env('TICKET_AUTO_REPLY', 'Thanks for contacting us! Your ticket #{{ticket}} has been created. Our team will reply shortly.');
  if (isNew && ack !== 'off') await sendOut(t, fill(ack, t), { id: null, name: 'auto-reply' }).catch(() => {});
}

async function sendOut(t, text, actor, file) {
  const label = text || `[file] ${file?.originalname}`;
  let res;
  try {
    res = file
      ? await sendMedia(t.sessionId, t.phone, { buffer: file.buffer, mimetype: file.mimetype, fileName: file.originalname, caption: text })
      : await sendText(t.sessionId, t.phone, text);
  } catch (e) {
    addEntry(t, { type: 'out', text: label, by: actor.name, byId: actor.id, status: 'failed', error: e.message });
    save();
    throw e;
  }
  const entry = addEntry(t, { type: 'out', text: label, by: actor.name, byId: actor.id, status: 'sent', waId: res?.key?.id });
  logMessage({ sessionId: t.sessionId, to: t.phone, text: label, status: 'sent', waId: res?.key?.id, ticketId: t.id });
  save();
  return entry;
}

export async function replyToTicket(t, { text, file }, actor) {
  if (!text && !file) throw fail('text or file is required');
  const entry = await sendOut(t, text, actor, file);
  if (!t.firstResponseAt) t.firstResponseAt = entry.at;
  // first person to reply takes an unassigned ticket
  if (!t.assignee && findUser(actor.id)) {
    t.assignee = actor.id;
    addEntry(t, { type: 'event', text: `Assigned to ${actor.name} (first reply)` });
  }
  t.unread = 0;
  if (t.status === 'open') t.status = 'pending'; // waiting on customer
  save();
  emitWebhook('ticket.message', { ticket: summary(t), direction: 'out', text, by: actor.name });
  return t;
}

export function addNote(t, { text }, actor) {
  if (!text) throw fail('text is required');
  addEntry(t, { type: 'note', text, by: actor.name, byId: actor.id });
  save();
  return t;
}

export async function updateTicket(t, changes, actor) {
  const { status, priority, assignee, departmentId, subject, tags, notify = true } = changes;

  if (departmentId !== undefined && (departmentId || null) !== t.departmentId) {
    const to = departmentId ? findDepartment(departmentId) : null;
    if (departmentId && !to) throw fail('Department not found');
    const from = findDepartment(t.departmentId);
    addEntry(t, { type: 'event', text: `${actor.name} transferred ${from?.name || 'No department'} → ${to?.name || 'No department'}` });
    t.departmentId = to?.id || null;
    // keep the assignee only if they belong to the new department
    const current = findUser(t.assignee);
    if (current && current.role !== 'admin' && t.departmentId && !current.departmentIds?.includes(t.departmentId)) {
      t.assignee = '';
    }
    if (assignee === undefined && !t.assignee) {
      t.assignee = pickAssignee(t.departmentId);
      if (t.assignee) addEntry(t, { type: 'event', text: `Assigned to ${userName(t.assignee)}` });
    }
  }
  if (assignee !== undefined && assignee !== t.assignee) {
    const id = validateAssignee(assignee, t.departmentId);
    addEntry(t, { type: 'event', text: id ? `${actor.name} assigned to ${userName(id)}` : `${actor.name} unassigned` });
    t.assignee = id;
  }
  if (status !== undefined && status !== t.status) {
    if (!STATUSES.includes(status)) throw fail(`status must be one of ${STATUSES.join(', ')}`);
    addEntry(t, { type: 'event', text: `${actor.name} changed status ${t.status} → ${status}` });
    t.status = status;
    t.resolvedAt = status === 'resolved' || status === 'closed' ? now() : null;
    const msg = env('TICKET_RESOLVED_MESSAGE', 'Your ticket #{{ticket}} has been resolved. Reply to this chat if you need more help.');
    if (status === 'resolved' && notify && msg !== 'off') await sendOut(t, fill(msg, t), { id: null, name: 'auto-reply' }).catch(() => {});
  }
  if (priority !== undefined && priority !== t.priority) {
    if (!PRIORITIES.includes(priority)) throw fail(`priority must be one of ${PRIORITIES.join(', ')}`);
    addEntry(t, { type: 'event', text: `${actor.name} changed priority ${t.priority} → ${priority}` });
    t.priority = priority;
  }
  if (subject !== undefined) t.subject = subject;
  if (tags !== undefined) t.tags = Array.isArray(tags) ? tags : String(tags).split(',').map((x) => x.trim()).filter(Boolean);
  t.updatedAt = now();
  save();
  emitWebhook('ticket.updated', summary(t));
  return t;
}

export function withNames(t) {
  return {
    ...t,
    departmentName: findDepartment(t.departmentId)?.name || '',
    assigneeName: userName(t.assignee),
  };
}

export function summary({ thread, ...t }) {
  const last = [...thread].reverse().find((e) => e.type === 'in' || e.type === 'out');
  return withNames({ ...t, lastMessage: last ? { type: last.type, text: last.text, at: last.at } : null });
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

export function listTickets(user, { status, priority, assignee, departmentId, sessionId, q, sort = 'updated' } = {}) {
  const search = String(q || '').toLowerCase().replace(/^#/, '');
  const statuses = status ? String(status).split(',') : null;
  const assigneeId = assignee === 'me' ? user.id : assignee;
  return db.tickets
    .filter((t) =>
      canSeeTicket(user, t) &&
      (!statuses || statuses.includes(t.status)) &&
      (!priority || t.priority === priority) &&
      (!sessionId || t.sessionId === sessionId) &&
      (!departmentId || (departmentId === 'none' ? !t.departmentId : t.departmentId === departmentId)) &&
      (!assigneeId || (assigneeId === 'none' ? !t.assignee : t.assignee === assigneeId)) &&
      (!search || String(t.number) === search || t.phone.includes(search) ||
        t.name?.toLowerCase().includes(search) || t.subject?.toLowerCase().includes(search)))
    .sort((a, b) => sort === 'priority'
      ? PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt.localeCompare(a.updatedAt)
      : b.updatedAt.localeCompare(a.updatedAt))
    .map(summary);
}

export function ticketStats(user) {
  const tickets = db.tickets.filter((t) => canSeeTicket(user, t));
  const by = (s) => tickets.filter((t) => t.status === s).length;
  const active = tickets.filter((t) => t.status === 'open' || t.status === 'pending');
  const responded = tickets.filter((t) => t.firstResponseAt);
  const avgFirstResponseMin = responded.length
    ? Math.round(responded.reduce((s, t) => s + (new Date(t.firstResponseAt) - new Date(t.createdAt)), 0) / responded.length / 60000)
    : null;
  return {
    open: by('open'),
    pending: by('pending'),
    resolved: by('resolved'),
    closed: by('closed'),
    mine: active.filter((t) => t.assignee === user.id).length,
    unassigned: active.filter((t) => !t.assignee).length,
    urgent: active.filter((t) => t.priority === 'urgent').length,
    avgFirstResponseMin,
  };
}
