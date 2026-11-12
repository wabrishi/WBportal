// Numbers for the dashboard. Everything ticket-related is scoped to what the user may see.
import { db, dailyCount } from './store.js';
import { listSessions } from './whatsapp.js';
import { canSeeTicket, findDepartment } from './departments.js';
import { effectiveDailyLimit } from './health.js';

const DAY = 24 * 60 * 60 * 1000;
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA'); // YYYY-MM-DD in server time
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const avgMinutes = (tickets) => {
  const r = tickets.filter((t) => t.firstResponseAt);
  return r.length ? Math.round(r.reduce((s, t) => s + (new Date(t.firstResponseAt) - new Date(t.createdAt)), 0) / r.length / 60000) : null;
};

function messageTotals(messages) {
  const sent = messages.filter((m) => m.direction !== 'in' && m.status === 'sent').length;
  const failed = messages.filter((m) => m.status === 'failed').length;
  const received = messages.filter((m) => m.direction === 'in').length;
  return { sent, failed, received, successRate: pct(sent, sent + failed) };
}

export function dashboard(user, days = 7) {
  days = [7, 30, 90].includes(Number(days)) ? Number(days) : 7;
  const staff = user.role === 'admin' || user.role === 'manager';
  const nowMs = Date.now();
  const start = new Date(new Date(nowMs - (days - 1) * DAY).toLocaleDateString('en-CA') + 'T00:00:00').getTime();
  const prevStart = start - days * DAY;
  const inRange = (d, a, b) => { const t = new Date(d).getTime(); return t >= a && t < b; };

  const tickets = db.tickets.filter((t) => canSeeTicket(user, t));
  const active = tickets.filter((t) => t.status === 'open' || t.status === 'pending');
  const curTickets = tickets.filter((t) => inRange(t.createdAt, start, nowMs + 1));
  const prevTickets = tickets.filter((t) => inRange(t.createdAt, prevStart, start));
  const resolvedIn = (a, b) => tickets.filter((t) => t.resolvedAt && inRange(t.resolvedAt, a, b)).length;

  const out = {
    days,
    generatedAt: new Date().toISOString(),
    tickets: {
      open: tickets.filter((t) => t.status === 'open').length,
      pending: tickets.filter((t) => t.status === 'pending').length,
      resolved: tickets.filter((t) => t.status === 'resolved').length,
      closed: tickets.filter((t) => t.status === 'closed').length,
      mine: active.filter((t) => t.assignee === user.id).length,
      unassigned: active.filter((t) => !t.assignee).length,
      urgent: active.filter((t) => t.priority === 'urgent').length,
      created: { current: curTickets.length, previous: prevTickets.length },
      resolvedCount: { current: resolvedIn(start, nowMs + 1), previous: resolvedIn(prevStart, start) },
      avgFirstResponseMin: { current: avgMinutes(curTickets), previous: avgMinutes(prevTickets) },
    },
    // active tickets per department
    departments: [...new Set(active.map((t) => t.departmentId || ''))]
      .map((id) => ({ id, name: findDepartment(id)?.name || 'No department', active: active.filter((t) => (t.departmentId || '') === id).length }))
      .sort((a, b) => b.active - a.active),
    // tickets that need attention: urgent/high first, then oldest waiting
    attention: active
      .filter((t) => t.status === 'open')
      .sort((a, b) => ({ urgent: 0, high: 1, normal: 2, low: 3 }[a.priority] - { urgent: 0, high: 1, normal: 2, low: 3 }[b.priority]) ||
        a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, 5)
      .map((t) => ({ id: t.id, number: t.number, name: t.name || `+${t.phone}`, subject: t.subject, priority: t.priority, updatedAt: t.updatedAt, unread: t.unread })),
  };
  if (!staff) return out;

  // ---- admins & managers: messaging, numbers, campaigns, team ----
  const cur = db.messages.filter((m) => inRange(m.createdAt, start, nowMs + 1));
  const prev = db.messages.filter((m) => inRange(m.createdAt, prevStart, start));
  out.messages = { current: messageTotals(cur), previous: messageTotals(prev) };

  const series = [];
  for (let t = start; t <= nowMs; t += DAY) series.push({ date: dayKey(t), sent: 0, received: 0, failed: 0 });
  const byDay = Object.fromEntries(series.map((d) => [d.date, d]));
  for (const m of cur) {
    const d = byDay[dayKey(m.createdAt)];
    if (!d) continue;
    if (m.direction === 'in') d.received++;
    else if (m.status === 'failed') d.failed++;
    else if (m.status === 'sent') d.sent++;
  }
  out.series = series;

  const newContacts = (a, b) => db.contacts.filter((c) => inRange(c.createdAt, a, b)).length;
  out.contacts = {
    total: db.contacts.length,
    optedOut: db.contacts.filter((c) => c.optedOut).length,
    added: { current: newContacts(start, nowMs + 1), previous: newContacts(prevStart, start) },
  };

  out.sessions = listSessions().map((s) => ({ ...s, sentToday: dailyCount(s.id), dailyLimit: effectiveDailyLimit(s.id) }));

  out.campaigns = db.campaigns.slice(-5).reverse().map(({ id, name, status, stats, createdAt, sessionId }) => ({ id, name, status, stats, createdAt, sessionId }));

  out.team = db.users.filter((u) => u.active && (user.role === 'admin' || u.departmentIds?.some((d) => user.departmentIds.includes(d))))
    .map((u) => {
      const theirs = tickets.filter((t) => t.assignee === u.id);
      return {
        id: u.id,
        name: u.name,
        role: u.role,
        active: theirs.filter((t) => t.status === 'open' || t.status === 'pending').length,
        resolved: theirs.filter((t) => t.resolvedAt && inRange(t.resolvedAt, start, nowMs + 1)).length,
        avgFirstResponseMin: avgMinutes(theirs.filter((t) => inRange(t.createdAt, start, nowMs + 1))),
      };
    })
    .sort((a, b) => b.resolved - a.resolved || b.active - a.active);

  out.activity = db.messages.slice(-8).reverse().map(({ id, sessionId, to, text, status, direction, createdAt }) =>
    ({ id, sessionId, to, text: text.length > 90 ? text.slice(0, 90) + '…' : text, status, direction, createdAt }));
  return out;
}
