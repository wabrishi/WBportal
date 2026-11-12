// Departments: routing of new tickets, auto-assignment and who may see which ticket.
import { db, save } from './store.js';

export const findDepartment = (id) => db.departments.find((d) => d.id === id);
export const findUser = (id) => db.users.find((u) => u.id === id);
export const userName = (id) => findUser(id)?.name || '';

// Pick the department for a new ticket: keyword in the first message → WhatsApp number → default.
export function routeDepartment(sessionId, text = '') {
  const t = text.toLowerCase();
  const byKeyword = db.departments.find((d) => d.keywords?.some((k) => k && t.includes(k.toLowerCase())));
  if (byKeyword) return byKeyword.id;
  const byNumber = db.departments.find((d) => d.sessionIds?.includes(sessionId));
  if (byNumber) return byNumber.id;
  return db.departments.find((d) => d.isDefault)?.id || null;
}

export const departmentMembers = (deptId) =>
  db.users.filter((u) => u.active && u.role !== 'admin' && u.departmentIds?.includes(deptId));

// Least-busy member of the department (fewest open/pending tickets), or '' if none / auto-assign off.
export function pickAssignee(deptId) {
  const d = findDepartment(deptId);
  if (!d?.autoAssign) return '';
  const members = departmentMembers(deptId);
  if (!members.length) return '';
  const load = (u) => db.tickets.filter((t) => t.assignee === u.id && (t.status === 'open' || t.status === 'pending')).length;
  return members.map((u) => ({ u, n: load(u) })).sort((a, b) => a.n - b.n)[0].u.id;
}

// Admins see everything. Managers/agents see their departments' tickets and tickets assigned to them;
// managers also see tickets that have no department yet.
export function canSeeTicket(user, t) {
  if (user.role === 'admin') return true;
  if (t.assignee === user.id) return true;
  if (!t.departmentId) return user.role === 'manager';
  return user.departmentIds?.includes(t.departmentId);
}

// One-time upgrade of data created before users/departments existed.
export function migrateTickets() {
  let changed = false;
  for (const t of db.tickets) {
    if (t.departmentId === undefined) { t.departmentId = null; changed = true; }
    if (t.assignee && !findUser(t.assignee)) {
      const match = db.users.find((u) => [u.name, u.username].some((n) => n?.toLowerCase() === t.assignee.toLowerCase()));
      t.assignee = match?.id || '';
      changed = true;
    }
  }
  if (changed) save();
}
