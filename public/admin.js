// Platform owner (super admin) panel
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString() : '—');
const date = (d) => (d ? new Date(d).toLocaleDateString() : '—');
const lim = (n) => (n < 0 ? '∞' : Number(n).toLocaleString());

let token = '';
try { token = localStorage.getItem('sa_token') || ''; } catch {}
let currentTab = 'overview';
let plans = [];
let settings = {};
let tenants = [];
let openTenant = null;
let cur = '₹';
const money = (n) => `${cur}${Number(n || 0).toLocaleString()}`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/super${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ---------- auth ---------- */
function showLogin() {
  token = '';
  try { localStorage.removeItem('sa_token'); } catch {}
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}
async function showApp() {
  let me;
  try { me = await api('/me'); } catch { return showLogin(); }
  $('#me-name').textContent = me.email;
  [plans, settings] = await Promise.all([api('/plans'), api('/settings')]);
  cur = settings.currency;
  fillPlanSelects();
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  switchTab(currentTab);
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const out = await api('/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    token = out.token;
    try { localStorage.setItem('sa_token', token); } catch {}
    e.target.reset();
    $('#login-error').textContent = '';
    showApp();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout-btn').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); showLogin(); });
$('#password-btn').addEventListener('click', async () => {
  const currentPassword = prompt('Current password');
  if (!currentPassword) return;
  const newPassword = prompt('New password (at least 8 characters)');
  if (!newPassword || prompt('Repeat new password') !== newPassword) return alert('Passwords do not match');
  try { await api('/password', { method: 'POST', body: { currentPassword, newPassword } }); alert('Password changed'); }
  catch (err) { alert(err.message); }
});

/* ---------- tabs ---------- */
$$('.sidebar a[data-tab]').forEach((a) => a.addEventListener('click', () => switchTab(a.dataset.tab)));
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) switchTab(g.dataset.goto); });
function switchTab(tab) {
  currentTab = tab;
  $$('.sidebar a[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  load(tab).catch((e) => console.warn(e));
}
async function load(tab) {
  if (tab === 'overview') await loadOverview();
  if (tab === 'tenants') await loadTenants();
  if (tab === 'requests') await loadRequests();
  if (tab === 'payments') await loadPayments();
  if (tab === 'plans') renderPlans();
  if (tab === 'settings') fillSettings();
  if (tab === 'audit') await loadAudit();
}
setInterval(() => { if (token && !document.hidden && !openTenant && ['overview', 'tenants', 'requests'].includes(currentTab)) load(currentTab).catch(() => {}); }, 20000);

function fillPlanSelects() {
  $$('.plan-select').forEach((s) => {
    const v = s.value;
    s.innerHTML = plans.map((p) => `<option value="${p.id}">${esc(p.name)} (${money(p.price)})</option>`).join('');
    if (v) s.value = v;
  });
}

/* ---------- overview ---------- */
async function loadOverview() {
  const o = await api('/overview');
  $('#ov-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const kpi = (l, v, s = '') => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`;
  $('#ov-kpis').innerHTML = kpi('Monthly recurring revenue', money(o.mrr), 'active + grace plans')
    + kpi('Collected this month', money(o.revenueThisMonth), 'recorded payments')
    + kpi('Customers', o.tenants, `${o.signups30d} new in 30 days`)
    + kpi('Paying', o.states.active + o.states.grace, `${o.states.trial} on trial`)
    + kpi('Connected numbers', o.connectedNumbers, 'across all customers')
    + kpi('Messages this month', o.messagesThisMonth.toLocaleString(), 'all customers')
    + kpi('Open plan requests', o.openRequests, o.openRequests ? '<a href="#" data-goto="requests">Review</a>' : '');
  const states = Object.entries(o.states);
  const max = Math.max(1, ...states.map(([, n]) => n));
  $('#ov-states').innerHTML = `<div class="hbars">${states.map(([s, n]) => `
    <div class="hbar"><span class="name"><span class="state ${s}">${s}</span></span><span class="track"><span class="bar" style="width:${(n / max) * 100}%;background:#2a78d6"></span></span><span class="num">${n}</span></div>`).join('')}</div>`;
  const list = (items, render, empty) => (items.length ? items.map(render).join('') : `<div class="empty-state">${empty}</div>`);
  $('#ov-trials').innerHTML = list(o.trialsEndingSoon, (t) => `<div class="list-row"><a href="#" data-open="${t.id}">${esc(t.name)}</a><span class="muted">${t.daysLeft} day(s)</span></div>`, 'None');
  $('#ov-renewals').innerHTML = list(o.renewalsDue, (t) => `<div class="list-row"><a href="#" data-open="${t.id}">${esc(t.name)}</a><span class="state ${t.state}">${t.state === 'grace' ? 'overdue' : `${t.daysLeft} day(s)`}</span></div>`, 'None');
  $('#ov-payments').innerHTML = o.recentPayments.length ? `<table><tbody>${o.recentPayments.map((p) => `<tr><td>${date(p.at)}</td><td>${esc(p.tenantName)}</td><td>${esc(p.planName)} · ${p.months}m</td><td class="n">${money(p.amount)}</td><td class="muted small">${esc(p.method)} ${esc(p.reference)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">No payments yet</div>';
  const n = o.openRequests;
  $('#req-badge').textContent = n;
  $('#req-badge').classList.toggle('hidden', !n);
}

/* ---------- customers ---------- */
async function loadTenants() {
  tenants = await api('/tenants');
  renderTenants();
}
function renderTenants() {
  const q = $('#t-search').value.trim().toLowerCase();
  const st = $('#t-state').value;
  const rows = tenants.filter((t) => (!st || t.state === st) && (!q || t.name.toLowerCase().includes(q) || t.ownerEmail.includes(q) || t.id.includes(q)));
  $('#tenants').innerHTML = rows.map((t) => `<tr class="clickable" data-open="${t.id}">
    <td><strong>${esc(t.name)}</strong><br><span class="muted small">${esc(t.ownerEmail)} · ${esc(t.id)}</span>${t.openRequest ? '<br><span class="badge pending">plan request</span>' : ''}</td>
    <td>${esc(t.plan?.name || '?')}<br><span class="muted small">${money(t.plan?.price)}/mo</span></td>
    <td><span class="state ${t.state}">${t.state}</span><br><span class="muted small">${t.state === 'trial' ? `ends ${date(t.trialEndsAt)}` : t.paidUntil ? `paid to ${date(t.paidUntil)}` : ''}</span></td>
    <td class="n">${t.connected}/${t.usage.numbers}</td><td class="n">${t.usage.users}</td><td class="n">${t.usage.messagesPerMonth.toLocaleString()}</td>
    <td class="small">${t.lastLoginAt ? date(t.lastLoginAt) : 'never'}</td>
    <td><button class="btn sm" data-open="${t.id}">Manage</button></td></tr>`).join('')
    || '<tr><td colspan="8" class="empty-state">No customers match</td></tr>';
}
$('#t-search').addEventListener('input', renderTenants);
$('#t-state').addEventListener('change', renderTenants);
$('#new-tenant-btn').addEventListener('click', () => $('#new-tenant-form').classList.toggle('hidden'));
$('#new-tenant-cancel').addEventListener('click', () => $('#new-tenant-form').classList.add('hidden'));
$('#new-tenant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const b = Object.fromEntries(new FormData(e.target));
    const t = await api('/tenants', { method: 'POST', body: { ...b, trialDays: Number(b.trialDays) } });
    e.target.reset();
    e.target.classList.add('hidden');
    await loadTenants();
    openDrawer(t.id);
  } catch (err) { alert(err.message); }
});

/* ---------- customer drawer ---------- */
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) { e.preventDefault(); openDrawer(o.dataset.open); }
});
$('#drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openTenant) closeDrawer(); });
function closeDrawer() {
  openTenant = null;
  $('#drawer').classList.add('hidden');
  $('#drawer-backdrop').classList.add('hidden');
  if (currentTab !== 'plans' && currentTab !== 'settings') load(currentTab).catch(() => {});
}
async function openDrawer(id, prefill = {}) {
  const t = await api(`/tenants/${id}`);
  openTenant = t;
  const planOpts = (sel) => plans.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)} (${money(p.price)})</option>`).join('');
  const lims = t.plan?.limits || {};
  $('#drawer').innerHTML = `
    <div class="row space-between" style="margin:0"><h2>${esc(t.name)}</h2><button class="btn sm" data-close>✕</button></div>
    <div class="muted small">${esc(t.ownerName)} · ${esc(t.ownerEmail)} · id ${esc(t.id)} · since ${date(t.createdAt)}</div>
    <div><span class="state ${t.state}">${t.state}</span> <span class="muted small">${t.state === 'trial' ? `trial ends ${date(t.trialEndsAt)} (${t.daysLeft}d)` : t.paidUntil ? `paid until ${date(t.paidUntil)}` : ''}</span></div>
    <div class="facts">
      <div><b>${esc(t.plan?.name || '?')}</b><span>plan</span></div>
      <div><b>${t.connected}/${t.usage.numbers} <small class="muted">of ${lim(lims.numbers)}</small></b><span>numbers online</span></div>
      <div><b>${t.usage.users} <small class="muted">of ${lim(lims.users)}</small></b><span>users</span></div>
      <div><b>${t.usage.messagesPerMonth.toLocaleString()}</b><span>msgs this month (of ${lim(lims.messagesPerMonth)})</span></div>
      <div><b>${t.usage.contacts.toLocaleString()}</b><span>contacts (of ${lim(lims.contacts)})</span></div>
      <div><b>${t.usage.flows}</b><span>flows (of ${lim(lims.flows)})</span></div>
    </div>
    <div class="row">
      <button class="btn" data-act="impersonate">Log in as customer ↗</button>
      ${t.state === 'suspended' ? '<button class="btn" data-act="unsuspend">Reactivate</button>' : '<button class="btn danger" data-act="suspend">Suspend</button>'}
    </div>

    <form class="card inline" id="pay-form">
      <h3 class="full" style="margin:0">Record a payment</h3>
      <label>Plan<select name="planId">${planOpts(prefill.planId || t.plan?.id)}</select></label>
      <label>Months<input name="months" type="number" min="1" max="36" value="${prefill.months || 1}" required /></label>
      <label>Amount (${esc(cur)})<input name="amount" type="number" min="0" step="0.01" placeholder="auto: plan price × months" /></label>
      <label>Method<select name="method"><option>UPI</option><option>Bank transfer</option><option>Cash</option><option>Card</option><option>Cheque</option><option>Other</option></select></label>
      <label class="full">Reference / transaction ID<input name="reference" value="${esc(prefill.reference || '')}" /></label>
      <div class="full row"><button class="btn primary">Record payment &amp; activate</button><span class="muted small" id="pay-hint"></span></div>
    </form>

    <form class="card inline" id="edit-form">
      <h3 class="full" style="margin:0">Plan &amp; status</h3>
      <label>Plan<select name="plan">${planOpts(t.plan?.id)}</select></label>
      <label>Status<select name="status">${['trial', 'active', 'suspended'].map((s) => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label>Trial ends<input name="trialEndsAt" type="date" value="${t.trialEndsAt ? t.trialEndsAt.slice(0, 10) : ''}" /></label>
      <label>Paid until<input name="paidUntil" type="date" value="${t.paidUntil ? t.paidUntil.slice(0, 10) : ''}" /></label>
      <label class="full">Internal notes<textarea name="notes" rows="2">${esc(t.notes)}</textarea></label>
      <div class="full row"><button class="btn primary">Save changes</button>
        <span class="muted small">Extend trial by</span><input id="extend-days" type="number" min="1" max="365" value="7" style="width:70px" /><button type="button" class="btn sm" data-act="extend">Extend</button></div>
    </form>

    <div class="card"><h3 style="margin-top:0">Users</h3>${t.users.map((u) => `<div class="list-row"><span>${esc(u.name)} <span class="muted small">${esc(u.email)}</span></span><span class="small">${u.role}${u.active ? '' : ' · disabled'} · ${u.lastLoginAt ? date(u.lastLoginAt) : 'never'}</span></div>`).join('')}</div>
    <div class="card"><h3 style="margin-top:0">WhatsApp numbers</h3>${t.numbers.length ? t.numbers.map((n) => `<div class="list-row"><span>${esc(n.id)} <span class="muted small">${n.user?.id ? '+' + esc(n.user.id.split(/[:@]/)[0]) : ''}</span></span><span class="small">${esc(n.status)}</span></div>`).join('') : '<div class="empty-state">No numbers running</div>'}</div>
    <div class="card"><h3 style="margin-top:0">Payments</h3>${t.payments.length ? t.payments.map((p) => `<div class="list-row"><span>${date(p.at)} · ${esc(p.planName)} · ${p.months}m</span><span>${money(p.amount)} <span class="muted small">${esc(p.method)} ${esc(p.reference)}</span></span></div>`).join('') : '<div class="empty-state">No payments</div>'}</div>
    <div class="card"><h3 style="margin-top:0">Plan requests</h3>${t.requests.length ? t.requests.map((r) => `<div class="list-row"><span>${date(r.createdAt)} · ${esc(r.planName)} · ${r.months}m · ref ${esc(r.reference || '—')}</span><span class="small">${r.status}</span></div>`).join('') : '<div class="empty-state">None</div>'}</div>
    <div class="card danger-zone"><h3 style="margin-top:0">Danger zone</h3><p class="muted small">Deleting removes the workspace, all its data and WhatsApp logins permanently.</p><button class="btn danger" data-act="delete">Delete workspace</button></div>`;
  $('#drawer').classList.remove('hidden');
  $('#drawer-backdrop').classList.remove('hidden');
  const pf = $('#pay-form');
  const hint = () => {
    const p = plans.find((x) => x.id === pf.planId.value);
    $('#pay-hint').textContent = p ? `Plan price × months = ${money(p.price * Number(pf.months.value || 1))}` : '';
  };
  pf.addEventListener('input', hint);
  hint();
}
$('#drawer').addEventListener('click', async (e) => {
  if (e.target.closest('[data-close]')) return closeDrawer();
  const act = e.target.dataset.act;
  if (!act || !openTenant) return;
  const id = openTenant.id;
  try {
    if (act === 'impersonate') {
      const { token: tk } = await api(`/tenants/${id}/impersonate`, { method: 'POST' });
      window.open(`/app#token=${encodeURIComponent(tk)}`, '_blank', 'noopener');
      return;
    }
    if (act === 'suspend' && !confirm(`Suspend ${openTenant.name}? Their users can't log in and their WhatsApp numbers disconnect.`)) return;
    if (act === 'suspend') await api(`/tenants/${id}`, { method: 'PATCH', body: { status: 'suspended' } });
    if (act === 'unsuspend') await api(`/tenants/${id}`, { method: 'PATCH', body: { status: openTenant.paidUntil ? 'active' : 'trial' } });
    if (act === 'extend') await api(`/tenants/${id}/extend-trial`, { method: 'POST', body: { days: Number($('#extend-days').value) } });
    if (act === 'delete') {
      const name = prompt(`This permanently deletes "${openTenant.name}" and all its data.\nType the workspace name to confirm:`);
      if (name === null) return;
      await api(`/tenants/${id}`, { method: 'DELETE', body: { confirm: name } });
      return closeDrawer();
    }
    openDrawer(id);
  } catch (err) { alert(err.message); }
});
$('#drawer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const id = openTenant.id;
  try {
    if (f.id === 'pay-form') {
      const b = Object.fromEntries(new FormData(f));
      const p = await api(`/tenants/${id}/payments`, { method: 'POST', body: { ...b, months: Number(b.months) } });
      alert(`Payment of ${money(p.amount)} recorded. ${openTenant.name} is active on ${p.planName} until ${date(p.periodTo)}.`);
    }
    if (f.id === 'edit-form') {
      const b = Object.fromEntries(new FormData(f));
      const body = { plan: b.plan, status: b.status, notes: b.notes };
      if (b.trialEndsAt) body.trialEndsAt = b.trialEndsAt;
      if (b.paidUntil) body.paidUntil = b.paidUntil;
      await api(`/tenants/${id}`, { method: 'PATCH', body });
    }
    openDrawer(id);
  } catch (err) { alert(err.message); }
});

/* ---------- requests ---------- */
async function loadRequests() {
  const list = await api('/requests');
  $('#requests').innerHTML = list.map((r) => {
    const p = plans.find((x) => x.id === r.planId);
    return `<tr><td>${date(r.createdAt)}</td><td><a href="#" data-open="${r.tenantId}">${esc(r.tenantName)}</a><br><span class="muted small">${esc(r.requestedBy)}</span></td>
      <td>${esc(r.planName)}</td><td class="n">${r.months}</td><td class="n">${p ? money(p.price * r.months) : '—'}</td>
      <td class="small">${esc(r.reference || '—')}${r.message ? `<br><span class="muted">${esc(r.message)}</span>` : ''}</td>
      <td><span class="badge ${r.status === 'open' ? 'pending' : 'sent'}">${r.status}</span></td>
      <td>${r.status === 'open' ? `<button class="btn sm primary" data-pay-req="${r.id}">Record payment</button> <button class="btn sm" data-close-req="${r.id}">Close</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="empty-state">No requests yet</td></tr>';
  $('#requests').dataset.json = JSON.stringify(list);
  const n = list.filter((r) => r.status === 'open').length;
  $('#req-badge').textContent = n;
  $('#req-badge').classList.toggle('hidden', !n);
}
$('#requests').addEventListener('click', async (e) => {
  const list = JSON.parse($('#requests').dataset.json || '[]');
  const pay = list.find((r) => r.id === e.target.dataset.payReq);
  if (pay) return openDrawer(pay.tenantId, { planId: pay.planId, months: pay.months, reference: pay.reference });
  if (e.target.dataset.closeReq && confirm('Close this request without recording a payment?')) {
    await api(`/requests/${e.target.dataset.closeReq}/close`, { method: 'POST' });
    loadRequests();
  }
});

/* ---------- payments ---------- */
let paymentsCache = [];
async function loadPayments() {
  paymentsCache = await api('/payments');
  const total = paymentsCache.reduce((s, p) => s + p.amount, 0);
  $('#pay-total').textContent = `${paymentsCache.length} payments · ${money(total)} total`;
  $('#payments').innerHTML = paymentsCache.map((p) => `<tr><td>${date(p.at)}</td><td><a href="#" data-open="${p.tenantId}">${esc(p.tenantName)}</a></td><td>${esc(p.planName)}</td>
    <td class="n">${p.months}</td><td class="n">${money(p.amount)}</td><td>${esc(p.method)}</td><td class="small">${esc(p.reference)}</td>
    <td class="small">${date(p.periodFrom)} → ${date(p.periodTo)}</td><td class="small">${esc(p.by)}</td></tr>`).join('')
    || '<tr><td colspan="9" class="empty-state">No payments yet</td></tr>';
}
$('#pay-csv').addEventListener('click', () => {
  const cols = ['at', 'tenantName', 'tenantId', 'planName', 'months', 'amount', 'method', 'reference', 'periodFrom', 'periodTo', 'by'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...paymentsCache.map((p) => cols.map((c) => q(p[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `payments-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
});

/* ---------- plans ---------- */
function renderPlans() {
  const num = (p, k) => `<td><input type="number" min="-1" data-k="limits.${k}" value="${p.limits[k]}" /></td>`;
  $('#plans').innerHTML = plans.map((p, i) => `<tr data-i="${i}">
    <td><input data-k="id" value="${esc(p.id)}" /></td><td><input data-k="name" value="${esc(p.name)}" /></td>
    <td><input type="number" min="0" data-k="price" value="${p.price}" /></td>
    ${num(p, 'numbers')}${num(p, 'users')}${num(p, 'contacts')}${num(p, 'messagesPerMonth')}${num(p, 'flows')}
    <td><input type="checkbox" data-k="popular" ${p.popular ? 'checked' : ''} /></td>
    <td><input type="checkbox" data-k="active" ${p.active !== false ? 'checked' : ''} /></td>
    <td><button class="btn sm danger" data-del-plan="${i}">✕</button></td></tr>`).join('');
}
function readPlans() {
  return $$('#plans tr').map((tr) => {
    const p = { limits: {} };
    for (const el of tr.querySelectorAll('[data-k]')) {
      const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
      if (el.dataset.k.startsWith('limits.')) p.limits[el.dataset.k.slice(7)] = v; else p[el.dataset.k] = v;
    }
    return p;
  });
}
$('#add-plan').addEventListener('click', () => {
  plans = readPlans();
  plans.push({ id: `plan-${plans.length + 1}`, name: 'New plan', price: 0, active: true, limits: { numbers: 1, users: 1, contacts: 1000, messagesPerMonth: 1000, flows: 1 } });
  renderPlans();
});
$('#plans').addEventListener('click', (e) => {
  if (e.target.dataset.delPlan === undefined) return;
  plans = readPlans();
  plans.splice(Number(e.target.dataset.delPlan), 1);
  renderPlans();
});
$('#save-plans').addEventListener('click', async () => {
  try {
    plans = await api('/plans', { method: 'PUT', body: { plans: readPlans() } });
    renderPlans();
    fillPlanSelects();
    $('#plans-result').textContent = 'Saved ✓';
  } catch (err) { $('#plans-result').textContent = err.message; }
});

/* ---------- settings ---------- */
function fillSettings() {
  const f = $('#settings-form');
  for (const k of ['brandName', 'trialDays', 'trialPlan', 'graceDays', 'currency', 'supportEmail', 'paymentInstructions']) f[k].value = settings[k] ?? '';
}
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const b = Object.fromEntries(new FormData(e.target));
    settings = await api('/settings', { method: 'PUT', body: { ...b, trialDays: Number(b.trialDays), graceDays: Number(b.graceDays) } });
    cur = settings.currency;
    $('#settings-result').textContent = 'Saved ✓';
  } catch (err) { $('#settings-result').textContent = err.message; }
});

/* ---------- audit ---------- */
async function loadAudit() {
  const list = await api('/audit');
  $('#audit').innerHTML = list.map((a) => {
    const { at, by, action, ...rest } = a;
    return `<tr><td class="small">${fmt(at)}</td><td class="small">${esc(by)}</td><td>${esc(action)}</td><td class="small muted">${esc(JSON.stringify(rest))}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="empty-state">Nothing yet</td></tr>';
}

/* ---------- first-run setup ---------- */
$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const out = await api('/setup', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    token = out.token;
    try { localStorage.setItem('sa_token', token); } catch {}
    $('#setup-view').classList.add('hidden');
    currentTab = 'settings'; // first thing to do: brand name and payment details
    showApp();
  } catch (err) { $('#setup-error').textContent = err.message; }
});

(async () => {
  const setup = await fetch('/api/super/setup').then((r) => r.json()).catch(() => ({}));
  if (setup.needed) {
    $('#setup-key-field').classList.toggle('hidden', !setup.keyRequired);
    $('#setup-key-field input').required = !!setup.keyRequired;
    $('#setup-view').classList.remove('hidden');
    return;
  }
  if (token) showApp(); else showLogin();
})();
