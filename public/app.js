const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => new Date(d).toLocaleString();

let token = '';
try { token = localStorage.getItem('wa_token') || ''; } catch {}
// Signup and the super admin's "log in as" hand over a token in the URL hash (#token=…)
if (location.hash.startsWith('#token=')) {
  token = decodeURIComponent(location.hash.slice(7));
  try { localStorage.setItem('wa_token', token); } catch {}
  history.replaceState(null, '', location.pathname);
}
let currentTab = null;      // null = the role's home tab
let pollTimer = null;
let me = null;              // signed-in user { id, name, role, departmentIds }
let directory = [];         // all active users, for "assign to" pickers
let departments = [];
const CAMPAIGN_STATUS = {
  draft: 'draft', running: 'running', paused: 'paused', completed: 'completed',
  stopped_limit: 'daily limit reached', waiting_quiet: 'waiting (quiet hours)',
};
const isStaff = () => me && (me.role === 'admin' || me.role === 'manager');

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: form || (body && JSON.stringify(body)) });
  if (res.status === 401 && !path.startsWith('/auth')) { showLogin(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ---------- Auth ---------- */
function showLogin() {
  token = '';
  me = null;
  currentTab = null;
  dashData = null;
  riskData = null;
  riskBadgeAt = 0;
  selectedTicket = null;
  const detail = $('#ticket-detail');
  detail.dataset.id = '';
  detail.innerHTML = '<p class="muted empty">Select a ticket to view the conversation.</p>';
  try { localStorage.removeItem('wa_token'); } catch {}
  clearInterval(pollTimer);
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}
async function showApp() {
  try { me = await api('/auth/me'); } catch { return showLogin(); }
  await loadPeople().catch(() => {});
  // show only the menu items this role may use
  $$('[data-roles]').forEach((el) => el.classList.toggle('hidden', !el.dataset.roles.split(',').includes(me.role)));
  $('#me-name').textContent = me.name;
  $('#me-role').textContent = me.role;
  renderAccountChrome();
  const allowed = currentTab && $(`.sidebar a[data-tab="${currentTab}"]`);
  if (!allowed || allowed.classList.contains('hidden')) currentTab = me.role === 'agent' ? 'tickets' : 'dashboard';
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  switchTab(currentTab);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(currentTab), 3000);
}
async function loadPeople() {
  [directory, departments] = await Promise.all([api('/users/directory'), api('/departments')]);
}

// Workspace name, plan and status banners (trial, expired, support login)
function renderAccountChrome() {
  const t = me.tenant;
  $$('.brand-name').forEach((el) => { el.textContent = me.brandName || 'WA Marketing'; });
  document.title = me.brandName || 'WA Marketing';
  $('#ws-chip').innerHTML = `<strong>${esc(t.name)}</strong><span>${esc(t.plan?.name || '')}${t.state === 'trial' ? ' · trial' : ''}</span>`;
  const banner = $('#account-banner');
  const isAdmin = me.role === 'admin';
  const link = isAdmin ? ' <a href="#" data-goto-billing>View plans</a>' : ' Please contact your workspace admin.';
  let html = '', cls = '';
  if (me.impersonatedBy) { html = `Support view: you are logged in to <strong>${esc(t.name)}</strong> as ${esc(me.name)} (by ${esc(me.impersonatedBy)}).`; cls = 'info'; }
  else if (t.state === 'trial' && t.daysLeft <= 7) { html = `Your free trial ends in <strong>${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'}</strong>.${link}`; cls = 'warn'; }
  else if (t.state === 'grace') { html = `${esc(t.message)}${link}`; cls = 'warn'; }
  else if (t.state === 'expired') { html = `${esc(t.message)} Sending, campaigns and chatbots are paused.${link}`; cls = 'danger'; }
  else if (t.state === 'active' && t.daysLeft <= 5) { html = `Your plan renews in ${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'}.${link}`; cls = 'warn'; }
  banner.className = `account-banner ${cls}`;
  banner.innerHTML = html;
  banner.classList.toggle('hidden', !html);
}
// Pick up plan / status changes (e.g. after we confirm a payment) once a minute
let accountAt = Date.now();
async function refreshAccount() {
  if (Date.now() - accountAt < 60000 || !me) return;
  accountAt = Date.now();
  const fresh = await api('/auth/me').catch(() => null);
  if (fresh && me) { me = fresh; renderAccountChrome(); }
}
$('#account-banner').addEventListener('click', (e) => {
  if (e.target.matches('[data-goto-billing]')) { e.preventDefault(); switchTab('billing'); }
});

/* ---------- Subscription & workspace (admin) ---------- */
let billing = null;
const fmtLimit = (n) => (n < 0 ? 'Unlimited' : n.toLocaleString());
const USAGE_LABELS = { numbers: 'WhatsApp numbers', users: 'Users', contacts: 'Contacts', messagesPerMonth: 'Messages this month', flows: 'Chatbot flows' };

let billingAt = 0;
async function loadBilling(force = false) {
  if (!force && Date.now() - billingAt < 30000) return; // the page refreshes every 30 s
  billingAt = Date.now();
  billing = await api('/workspace');
  const { tenant: t, usage, plans, currency } = billing;
  const stateText = {
    trial: `Free trial · ${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'} left`, active: `Active · renews in ${t.daysLeft} days`,
    grace: 'Payment due — renew now', expired: 'Expired', suspended: 'Suspended',
  }[t.state] || t.state;
  $('#plan-card').innerHTML = `
    <div class="panel-head"><h3>Current plan</h3><span class="badge ${t.state === 'expired' ? 'failed' : t.state === 'active' ? 'sent' : 'pending'}">${esc(stateText)}</span></div>
    <div class="plan-now"><b>${esc(t.plan?.name || '—')}</b><span>${currency}${(t.plan?.price || 0).toLocaleString()} / month</span></div>
    <div class="muted small">${t.state === 'trial' ? `Trial ends ${fmt(t.trialEndsAt)}` : t.paidUntil ? `Paid until ${new Date(t.paidUntil).toLocaleDateString()}` : ''}</div>
    ${t.message ? `<p class="error small">${esc(t.message)}</p>` : ''}`;
  $('#usage-meters').innerHTML = Object.entries(USAGE_LABELS).map(([k, label]) => {
    const limit = t.plan?.limits?.[k] ?? -1;
    const used = usage[k] || 0;
    const pctUsed = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return `<div class="usage-row"><div class="row space-between" style="margin:0"><span>${label}</span><span><b>${used.toLocaleString()}</b> / ${fmtLimit(limit)}</span></div>
      <div class="meter ${pctUsed >= 95 ? 'crit' : pctUsed >= 80 ? 'warn' : ''}"><div style="width:${limit < 0 ? 0 : pctUsed}%"></div></div></div>`;
  }).join('');
  $('#plan-grid').innerHTML = plans.map((p) => `
    <div class="plan ${p.id === t.plan?.id ? 'current' : ''} ${p.popular ? 'popular' : ''}">
      ${p.popular ? '<span class="plan-flag">Most popular</span>' : ''}
      <h4>${esc(p.name)}</h4>
      <div class="price">${currency}${p.price.toLocaleString()}<span>/month</span></div>
      <ul>${Object.entries(USAGE_LABELS).map(([k, l]) => `<li><b>${fmtLimit(p.limits[k])}</b> ${(k === 'numbers' ? l : l.toLowerCase()).replace(' this month', '/month')}</li>`).join('')}</ul>
      <button class="btn ${p.id === t.plan?.id ? '' : 'primary'}" data-choose-plan="${p.id}">${p.id === t.plan?.id ? (t.state === 'trial' ? 'Buy this plan' : 'Renew') : 'Choose'}</button>
    </div>`).join('');
  const f = $('#upgrade-form');
  if (!f.contains(document.activeElement)) {
    const cur = f.planId.value || billing.request?.planId || t.plan?.id;
    f.planId.innerHTML = plans.map((p) => `<option value="${p.id}">${esc(p.name)} — ${currency}${p.price.toLocaleString()}/month</option>`).join('');
    f.planId.value = cur;
    updateUpgradeTotal();
  }
  $('#open-request').innerHTML = billing.request
    ? `<p class="actions-now small" style="margin:0">Request sent: <b>${esc(billing.request.planName)}</b> for ${billing.request.months} month(s) on ${fmt(billing.request.createdAt)}. We'll activate it once the payment is confirmed. You can update it below.</p>` : '';
  $('#pay-instructions').textContent = billing.paymentInstructions;
  $('#support-line').innerHTML = billing.supportEmail ? `Questions? Email <a href="mailto:${esc(billing.supportEmail)}">${esc(billing.supportEmail)}</a>` : '';
  const wf = $('#workspace-form');
  if (!wf.contains(document.activeElement)) { wf.name.value = t.name; wf.webhookUrl.value = billing.webhookUrl; }
  $('#payment-history').innerHTML = billing.payments.length
    ? `<table><thead><tr><th>Date</th><th>Plan</th><th class="n">Amount</th><th>Reference</th></tr></thead><tbody>${billing.payments.map((p) => `
      <tr><td>${new Date(p.at).toLocaleDateString()}</td><td>${esc(p.planName)} · ${p.months}m</td><td class="n">${currency}${p.amount.toLocaleString()}</td><td class="small">${esc(p.method)} ${esc(p.reference)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty-state">No payments yet.</div>';
}
function updateUpgradeTotal() {
  const f = $('#upgrade-form');
  const p = billing?.plans.find((x) => x.id === f.planId.value);
  $('#upgrade-total').textContent = p ? `Amount to pay: ${billing.currency}${(p.price * Number(f.months.value)).toLocaleString()}` : '';
}
$('#upgrade-form').addEventListener('change', updateUpgradeTotal);
$('#plan-grid').addEventListener('click', (e) => {
  const id = e.target.dataset.choosePlan;
  if (!id) return;
  const f = $('#upgrade-form');
  f.planId.value = id;
  updateUpgradeTotal();
  f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  f.reference.focus();
});
$('#upgrade-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/workspace/upgrade-request', { method: 'POST', body: {
      planId: f.planId.value, months: Number(f.months.value), reference: f.reference.value, message: f.message.value,
    } });
    $('#upgrade-result').textContent = "Request sent ✓ We'll activate your plan as soon as we confirm the payment.";
    f.reference.value = ''; f.message.value = '';
    loadBilling(true);
  } catch (err) { $('#upgrade-result').textContent = err.message; }
});
$('#workspace-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/workspace', { method: 'PUT', body: { name: e.target.name.value, webhookUrl: e.target.webhookUrl.value } });
    $('#workspace-result').textContent = 'Saved ✓';
    me = await api('/auth/me');
    renderAccountChrome();
  } catch (err) { $('#workspace-result').textContent = err.message; }
});
const deptName = (id) => departments.find((d) => d.id === id)?.name || '';
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { token: t } = await api('/auth/login', { method: 'POST', body: Object.fromEntries(f) });
    token = t;
    try { localStorage.setItem('wa_token', t); } catch {}
    $('#login-error').textContent = '';
    e.target.reset();
    showApp();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#password-btn').addEventListener('click', async () => {
  const currentPassword = prompt('Current password');
  if (!currentPassword) return;
  const newPassword = prompt('New password (at least 8 characters)');
  if (!newPassword) return;
  if (prompt('Repeat new password') !== newPassword) return alert('Passwords do not match');
  try {
    await api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
    alert('Password changed');
  } catch (err) { alert(err.message); }
});
$('#logout-btn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* ---------- Tabs ---------- */
$$('.sidebar a[data-tab]').forEach((a) => a.addEventListener('click', () => switchTab(a.dataset.tab)));
function switchTab(tab) {
  currentTab = tab;
  $$('.sidebar a[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  refresh(tab);
}
async function refresh(tab) {
  try {
    if (tab === 'dashboard') await loadDashboard();
    if (tab === 'sessions') await loadSessions();
    loadTicketBadge();
    loadRiskBadge();
    if (tab === 'risk') await loadRisk();
    if (tab === 'flows') await loadFlows();
    if (tab === 'billing') await loadBilling();
    refreshAccount();
    if (tab === 'send' || tab === 'campaigns' || tab === 'tickets' || tab === 'departments') await loadSessionSelects();
    if (tab === 'tickets') await loadTickets();
    if (tab === 'users') await loadUsers();
    if (tab === 'departments') await loadDepartments();
    if (tab === 'contacts' && !$('#contact-search').matches(':focus')) await loadContacts();
    if (tab === 'campaigns') await loadCampaigns();
    if (tab === 'logs') await loadLogs();
    if (tab === 'keys') await loadKeys();
    if (tab === 'docs') renderDocs();
  } catch (e) { console.warn(e.message); }
}

/* ---------- Dashboard ---------- */
let dashDays = 7;
let dashData = null;
let dashLoadedAt = 0;
let activityTable = false;

const compact = (n) => (n == null ? '—' : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${+(n / 1e3).toFixed(1)}K` : n.toLocaleString());
const minutes = (m) => (m == null ? '—' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`);
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// "▲ 12% vs previous 7 days", coloured by whether the change is good
function delta(cur, prev, { upIsGood = true, unit = '%' } = {}) {
  const period = `vs previous ${dashDays} days`;
  if (cur == null || prev == null) return `<div class="delta">${period}: —</div>`;
  if (prev === 0) return `<div class="delta">${cur ? 'New activity' : 'No change'} ${period}</div>`;
  const change = unit === '%' ? Math.round(((cur - prev) / prev) * 100) : Math.round((cur - prev) * 10) / 10;
  if (change === 0) return `<div class="delta"><b>No change</b> ${period}</div>`;
  const good = (change > 0) === upIsGood;
  return `<div class="delta ${good ? 'good' : 'bad'}"><b>${change > 0 ? '▲' : '▼'} ${Math.abs(change)}${unit === '%' ? '%' : ' pts'}</b> ${period}</div>`;
}
const kpi = (label, value, deltaHtml = '', cls = '', inner = '') =>
  `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${deltaHtml}${inner}</div>`;

$('#dash-range').addEventListener('click', (e) => {
  const d = Number(e.target.dataset.days);
  if (!d) return;
  dashDays = d;
  $$('#dash-range button').forEach((b) => b.classList.toggle('active', b === e.target));
  loadDashboard(true);
});
$('.dashboard').addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) switchTab(go.dataset.goto);
  const t = e.target.closest('[data-ticket]');
  if (t) { selectedTicket = t.dataset.ticket; renderedTicketAt = null; switchTab('tickets'); }
});
$('#activity-table-btn').addEventListener('click', (e) => {
  activityTable = !activityTable;
  e.target.setAttribute('aria-pressed', activityTable);
  e.target.textContent = activityTable ? 'Chart' : 'Table';
  $('#chart-activity').classList.toggle('hidden', activityTable);
  $('#activity-table').classList.toggle('hidden', !activityTable);
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => currentTab === 'dashboard' && dashData && renderActivityChart(dashData.series), 150);
});

// The dashboard refreshes every 15 s (the rest of the app polls every 3 s).
async function loadDashboard(force = false) {
  if (!force && Date.now() - dashLoadedAt < 15000 && dashData) {
    if (dashData.series) renderActivityChart(dashData.series); // size may have changed while hidden
    return;
  }
  const d = await api(`/dashboard?days=${dashDays}`);
  dashData = d;
  dashLoadedAt = Date.now();
  const hour = new Date().getHours();
  $('#dash-greeting').textContent = `Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${me.name.split(' ')[0]}`;
  $('#dash-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  renderKpis(d);
  renderBars($('#chart-status'), [
    ['Open', d.tickets.open], ['Pending', d.tickets.pending], ['Resolved', d.tickets.resolved], ['Closed', d.tickets.closed],
  ], 'tickets', 'No tickets yet');
  $('#ticket-mini').innerHTML = [
    [d.tickets.created.current, `Created · ${d.days} days`], [d.tickets.resolvedCount.current, `Resolved · ${d.days} days`],
    [d.tickets.unassigned, 'Unassigned'], [d.tickets.urgent, 'Urgent'],
  ].map(([v, l]) => `<div><b>${compact(v)}</b><span>${l}</span></div>`).join('');
  renderBars($('#chart-depts'), d.departments.map((x) => [x.name, x.active]), 'active tickets', 'No active tickets — all caught up');
  renderAttention(d.attention);
  if (d.series) {
    renderActivityChart(d.series);
    renderActivityTable(d.series);
    renderSessions(d.sessions);
    renderCampaignsPanel(d.campaigns);
    renderTeam(d.team);
    renderActivityFeed(d.activity);
  }
}

function renderKpis(d) {
  const t = d.tickets;
  let html;
  if (d.messages) {
    const m = d.messages;
    html = kpi(`Messages sent · last ${d.days} days`, compact(m.current.sent), delta(m.current.sent, m.previous.sent),
      'hero', sparkline(d.series.map((x) => x.sent))) +
      kpi('Messages received', compact(m.current.received), delta(m.current.received, m.previous.received)) +
      kpi('Send success rate', m.current.successRate == null ? '—' : `${m.current.successRate}%`,
        delta(m.current.successRate, m.previous.successRate, { unit: 'pts' })) +
      kpi('Open tickets', compact(t.open), `<div class="delta">${t.unassigned} unassigned · ${t.urgent} urgent</div>`) +
      kpi('Avg first response', minutes(t.avgFirstResponseMin.current),
        delta(t.avgFirstResponseMin.current, t.avgFirstResponseMin.previous, { upIsGood: false }));
    $('#contacts-sub').textContent =
      `${compact(d.contacts.total)} contacts · +${d.contacts.added.current} new · ${d.contacts.optedOut} opted out`;
  } else {
    html = kpi('My active tickets', compact(t.mine), `<div class="delta">${t.open} open in your departments</div>`, 'hero') +
      kpi('Open tickets', compact(t.open), '<div class="delta">Waiting for a reply</div>') +
      kpi('Unassigned', compact(t.unassigned), '<div class="delta">Waiting for someone to pick up</div>') +
      kpi(`Resolved · ${d.days} days`, compact(t.resolvedCount.current), delta(t.resolvedCount.current, t.resolvedCount.previous)) +
      kpi('Avg first response', minutes(t.avgFirstResponseMin.current),
        delta(t.avgFirstResponseMin.current, t.avgFirstResponseMin.previous, { upIsGood: false }));
  }
  $('#dash-kpis').innerHTML = html;
}

function sparkline(values) {
  if (values.length < 2) return '';
  const max = Math.max(...values, 1), w = 200, h = 56;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 4 - (v / max) * (h - 8)}`);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="0,${h} ${pts.join(' ')} ${w},${h}" fill="rgba(255,255,255,.12)"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

// Horizontal bars, one hue (magnitude). Value at the tip, hover tooltip.
function renderBars(el, rows, unit, emptyText) {
  const max = Math.max(...rows.map((r) => r[1]), 0);
  if (!max) { el.innerHTML = `<div class="empty-state">${emptyText}</div>`; return; }
  el.innerHTML = `<div class="hbars">${rows.map(([name, v]) => `
    <div class="hbar" data-tip="${esc(name)}|${v} ${esc(unit)}">
      <span class="name">${esc(name)}</span>
      <span class="track"><span class="bar" style="width:${Math.max((v / max) * 100, v ? 2 : 0)}%"></span></span>
      <span class="num">${compact(v)}</span>
    </div>`).join('')}</div>`;
}

const SERIES = [
  { key: 'sent', label: 'Sent', color: 'var(--series-1)' },
  { key: 'received', label: 'Received', color: 'var(--series-2)' },
];

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v);
}

// Two-series line chart (one axis) with crosshair + tooltip on hover.
function renderActivityChart(series) {
  const el = $('#chart-activity');
  $('#activity-legend').innerHTML = SERIES.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
  const W = el.clientWidth || 600, H = el.clientHeight || 260;
  const m = { top: 12, right: 78, bottom: 26, left: 36 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const max = niceMax(Math.max(...series.flatMap((d) => [d.sent, d.received]), 0));
  const x = (i) => m.left + (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw);
  const y = (v) => m.top + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const every = Math.ceil(series.length / Math.max(2, Math.floor(iw / 70)));
  const path = (key) => series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join('');
  const last = series.length - 1;

  // end labels, unless they would collide
  const ends = SERIES.map((s) => ({ ...s, v: series[last][s.key], y: y(series[last][s.key]) }));
  const collide = Math.abs(ends[0].y - ends[1].y) < 16;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Messages sent and received per day over the last ${series.length} days">
    ${ticks.map((t) => `<line x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}" stroke="${t ? 'var(--grid)' : 'var(--axis)'}" stroke-width="1"/>
      <text class="tick" x="${m.left - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join('')}
    ${series.map((d, i) => (i % every === 0 || i === last) && (i === last || last - i >= every / 2)
      ? `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="middle">${shortDate(d.date)}</text>` : '').join('')}
    <path d="${path('sent')}L${x(last)},${y(0)}L${x(0)},${y(0)}Z" fill="var(--series-1)" opacity=".1"/>
    ${SERIES.map((s) => `<path d="${path(s.key)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('')}
    ${ends.map((e) => `<circle cx="${x(last)}" cy="${e.y}" r="4.5" fill="${e.color}" stroke="#fff" stroke-width="2"/>`).join('')}
    ${collide ? '' : ends.map((e) => `<text class="end-label" x="${x(last) + 10}" y="${e.y + 4}">${compact(e.v)} <tspan fill="var(--ink-muted)" font-weight="400">${e.label}</tspan></text>`).join('')}
    <g id="xhair" visibility="hidden">
      <line y1="${m.top}" y2="${m.top + ih}" stroke="var(--axis)" stroke-width="1"/>
      ${SERIES.map((s) => `<circle data-k="${s.key}" r="4.5" fill="${s.color}" stroke="#fff" stroke-width="2"/>`).join('')}
    </g>
    <rect x="${m.left}" y="${m.top}" width="${iw}" height="${ih}" fill="transparent" id="hit"/>
  </svg>`;

  const svg = el.querySelector('svg'), xh = svg.querySelector('#xhair');
  svg.querySelector('#hit').addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(last, Math.round(((px - m.left) / iw) * last)));
    const d = series[i];
    xh.setAttribute('visibility', 'visible');
    xh.querySelector('line').setAttribute('x1', x(i));
    xh.querySelector('line').setAttribute('x2', x(i));
    xh.querySelectorAll('circle').forEach((c) => { c.setAttribute('cx', x(i)); c.setAttribute('cy', y(d[c.dataset.k])); });
    showTip(ev, `<div class="t-title">${new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
      ${SERIES.map((s) => `<div class="t-row"><span><i style="background:${s.color}"></i>${s.label}</span><b>${d[s.key].toLocaleString()}</b></div>`).join('')}
      <div class="t-row"><span><i style="background:#d03b3b"></i>Failed</span><b>${d.failed.toLocaleString()}</b></div>`);
  });
  svg.querySelector('#hit').addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); hideTip(); });
}

function renderActivityTable(series) {
  $('#activity-table').innerHTML = `<table><thead><tr><th>Date</th><th class="n">Sent</th><th class="n">Received</th><th class="n">Failed</th></tr></thead>
    <tbody>${[...series].reverse().map((d) => `<tr><td>${shortDate(d.date)}</td><td class="n">${d.sent}</td><td class="n">${d.received}</td><td class="n">${d.failed}</td></tr>`).join('')}</tbody></table>`;
}

/* tooltip shared by all dashboard charts */
const tip = $('#viz-tooltip');
function showTip(ev, html) {
  tip.innerHTML = html;
  tip.classList.remove('hidden');
  const pad = 14, r = tip.getBoundingClientRect();
  let left = ev.clientX + pad, top = ev.clientY + pad;
  if (left + r.width > window.innerWidth - 8) left = ev.clientX - r.width - pad;
  if (top + r.height > window.innerHeight - 8) top = ev.clientY - r.height - pad;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTip() { tip.classList.add('hidden'); }
$('.dashboard').addEventListener('mousemove', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  const [title, body] = el.dataset.tip.split('|');
  showTip(e, `<div class="t-title">${esc(title)}</div><div>${esc(body)}</div>`);
});
$('.dashboard').addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]')) hideTip(); });

function renderAttention(list) {
  $('#dash-attention').innerHTML = list.length ? `<div class="plist">${list.map((t) => `
    <div class="item link" data-ticket="${t.id}">
      <div class="grow">
        <div class="title">#${t.number} · ${esc(t.name)}</div>
        <div class="sub">${esc(t.subject)}</div>
      </div>
      ${t.priority !== 'normal' ? `<span class="badge ${t.priority}">${t.priority}</span>` : ''}
      ${t.unread ? `<span class="unread">${t.unread}</span>` : ''}
      <span class="muted small">${ago(t.updatedAt)}</span>
    </div>`).join('')}</div>` : '<div class="empty-state">No open tickets waiting. Nice work!</div>';
}

const SESSION_STATUS = {
  connected: ['good', 'Connected'], qr: ['warning', 'Waiting for QR scan'], starting: ['warning', 'Starting'],
  disconnected: ['critical', 'Disconnected'], logged_out: ['critical', 'Logged out'],
};
function renderSessions(list) {
  $('#dash-sessions').innerHTML = list.length ? `<div class="plist">${list.map((s) => {
    const [cls, label] = SESSION_STATUS[s.status] || ['warning', s.status];
    const used = Math.min(100, Math.round((s.sentToday / s.dailyLimit) * 100));
    return `<div class="item"><div class="grow">
        <div class="row space-between" style="margin:0"><span class="title">${esc(s.id)}</span><span class="status-dot ${cls}">${label}</span></div>
        <div class="sub">${s.user?.id ? '+' + esc(s.user.id.split(/[:@]/)[0]) : 'Not linked'} · ${s.sentToday}/${s.dailyLimit} campaign sends today</div>
        <div class="meter ${used >= 95 ? 'crit' : used >= 80 ? 'warn' : ''}" data-tip="${esc(s.id)}|${used}% of today's limit used"><div style="width:${used}%"></div></div>
      </div></div>`;
  }).join('')}</div>` : '<div class="empty-state">No WhatsApp numbers linked yet.</div>';
}

function renderCampaignsPanel(list) {
  $('#dash-campaigns').innerHTML = list.length ? `<div class="plist">${list.map((c) => {
    const done = c.stats.sent + c.stats.failed + c.stats.skipped;
    const p = c.stats.total ? Math.round((done / c.stats.total) * 100) : 0;
    return `<div class="item"><div class="grow">
      <div class="row space-between" style="margin:0"><span class="title">${esc(c.name)}</span><span class="badge ${esc(c.status)}">${esc(CAMPAIGN_STATUS[c.status] || c.status)}</span></div>
      <div class="sub">${c.stats.sent} sent · ${c.stats.failed} failed · ${c.stats.total} recipients</div>
      <div class="meter" data-tip="${esc(c.name)}|${p}% processed"><div style="width:${p}%"></div></div>
    </div></div>`;
  }).join('')}</div>` : '<div class="empty-state">No campaigns yet.</div>';
}

function renderTeam(list) {
  $('#team-sub').textContent = `Last ${dashDays} days`;
  $('#dash-team').innerHTML = list.length ? `<table class="team"><thead><tr><th>Member</th><th class="n">Active tickets</th><th class="n">Resolved</th><th class="n">Avg first response</th></tr></thead>
    <tbody>${list.map((u) => `<tr>
      <td><div class="row" style="flex-wrap:nowrap"><span class="avatar">${esc(initials(u.name))}</span><span>${esc(u.name)}<br><span class="muted small">${u.role}</span></span></div></td>
      <td class="n">${u.active}</td><td class="n"><strong>${u.resolved}</strong></td><td class="n">${minutes(u.avgFirstResponseMin)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty-state">No team members yet.</div>';
}

function renderActivityFeed(list) {
  $('#dash-activity').innerHTML = list.length ? `<div class="plist">${list.map((m) => `
    <div class="item">
      <span class="dir ${m.direction === 'in' ? 'in' : 'out'}" title="${m.direction === 'in' ? 'Received' : 'Sent'}"><svg class="ic"><use href="#i-${m.direction === 'in' ? 'in' : 'out'}"/></svg></span>
      <div class="grow"><div class="title">+${esc(m.to)} <span class="muted small" style="font-weight:400">via ${esc(m.sessionId)}</span></div><div class="sub">${esc(m.text)}</div></div>
      ${m.status === 'failed' ? '<span class="badge failed">failed</span>' : ''}
      <span class="muted small">${ago(m.createdAt)}</span>
    </div>`).join('')}</div>` : '<div class="empty-state">No messages yet.</div>';
}

/* ---------- Sessions ---------- */
$('#session-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/sessions', { method: 'POST', body: { id: e.target.id.value.trim() } });
    e.target.reset();
    loadSessions();
  } catch (err) { alert(err.message); }
});
async function loadSessions() {
  const list = await api('/sessions');
  const detailed = await Promise.all(list.map((s) => api(`/sessions/${encodeURIComponent(s.id)}`)));
  $('#sessions').innerHTML = detailed.length ? detailed.map((s) => `
    <div class="card session">
      <h3>${esc(s.id)}</h3>
      <span class="badge ${esc(s.status)}">${esc(s.status)}</span>
      ${s.user ? `<p>${esc(s.user.name || '')}<br><span class="muted">+${esc((s.user.id || '').split(/[:@]/)[0])}</span></p>` : ''}
      ${s.qr ? `<p><img src="${s.qr}" alt="QR code"></p><p class="muted">Scan with WhatsApp → Linked devices</p>` : ''}
      ${s.status === 'starting' ? '<p class="muted">Generating QR…</p>' : ''}
      <div class="row" style="justify-content:center">
        ${['disconnected', 'logged_out'].includes(s.status) ? `<button class="btn sm" data-reconnect="${esc(s.id)}">Reconnect</button>` : ''}
        <button class="btn sm danger" data-logout="${esc(s.id)}">Unlink</button>
      </div>
    </div>`).join('') : '<p class="muted">No numbers yet. Add one above.</p>';
}
$('#sessions').addEventListener('click', async (e) => {
  const re = e.target.dataset.reconnect, lo = e.target.dataset.logout;
  try {
    if (re) await api('/sessions', { method: 'POST', body: { id: re } });
    if (lo && confirm(`Unlink "${lo}" from WhatsApp?`)) await api(`/sessions/${encodeURIComponent(lo)}?logout=true`, { method: 'DELETE' });
    loadSessions();
  } catch (err) { alert(err.message); }
});
async function loadSessionSelects() {
  const list = (await api('/sessions')).filter((s) => s.status === 'connected');
  $$('.session-select').forEach((sel) => {
    const cur = sel.value;
    const html = list.length
      ? list.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} ${s.user ? '(+' + esc(s.user.id.split(/[:@]/)[0]) + ')' : ''}</option>`).join('')
      : '<option value="">No connected numbers</option>';
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; if (cur) sel.value = cur; }
  });
}

/* ---------- Tickets ---------- */
let ticketStatus = 'open,pending';
let selectedTicket = null;     // id
let renderedTicketAt = null;   // updatedAt of the thread currently on screen
let composeMode = 'reply';     // reply | note

// Users who may own a ticket in this department: its members plus admins.
const eligibleAssignees = (deptId) =>
  directory.filter((u) => !deptId || u.role === 'admin' || u.departmentIds?.includes(deptId));
// Departments this user may file tickets into.
const myDepartments = () => (me.role === 'admin' ? departments : departments.filter((d) => me.departmentIds.includes(d.id)));
const options = (items, selected) =>
  items.map(([v, l]) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');

function fillTicketPickers() {
  fillSelect($('#ticket-filters').departmentId, 'All departments',
    [...departments.map((d) => [d.id, d.name]), ['none', 'No department']]);
  const nf = $('#new-ticket-form').departmentId;
  const html = (me.role === 'admin' ? '<option value="">Auto (routing rules)</option>' : '') +
    options(myDepartments().map((d) => [d.id, d.name]));
  if (nf.dataset.html !== html) { nf.innerHTML = html; nf.dataset.html = html; }
}
const ago = (d) => {
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

async function loadTicketBadge() {
  const s = await api('/tickets/stats').catch(() => null);
  if (!s) return;
  const b = $('#ticket-badge');
  b.textContent = s.open;
  b.classList.toggle('hidden', !s.open);
}

$('#ticket-status-tabs').addEventListener('click', (e) => {
  const st = e.target.dataset.status;
  if (st === undefined) return;
  ticketStatus = st;
  $$('#ticket-status-tabs button').forEach((b) => b.classList.toggle('active', b === e.target));
  loadTickets();
});
let ticketFilterTimer;
$('#ticket-filters').addEventListener('input', () => { clearTimeout(ticketFilterTimer); ticketFilterTimer = setTimeout(loadTickets, 250); });
$('#ticket-filters').addEventListener('submit', (e) => e.preventDefault());

async function loadTickets() {
  await loadPeople();
  fillTicketPickers();
  const f = $('#ticket-filters');
  const p = new URLSearchParams({ sort: f.sort.value });
  if (ticketStatus) p.set('status', ticketStatus);
  for (const k of ['q', 'priority', 'assignee', 'departmentId']) if (f[k].value.trim()) p.set(k, f[k].value.trim());
  const list = await api(`/tickets?${p}`);
  $('#ticket-list').innerHTML = list.map((t) => `
    <div class="t-item ${t.id === selectedTicket ? 'active' : ''}" data-id="${t.id}">
      <div class="top"><span class="who">#${t.number} · ${esc(t.name || '+' + t.phone)}</span>
        <span class="muted">${ago(t.updatedAt)} ${t.unread ? `<span class="unread">${t.unread}</span>` : ''}</span></div>
      <div class="subj">${esc(t.subject)}</div>
      ${t.lastMessage ? `<div class="last">${t.lastMessage.type === 'out' ? '↩ ' : ''}${esc(t.lastMessage.text)}</div>` : ''}
      <div class="meta"><span class="badge ${t.status}">${t.status}</span>
        ${t.priority !== 'normal' ? `<span class="badge ${t.priority}">${t.priority}</span>` : ''}
        ${t.departmentName ? `<span class="badge dept">${esc(t.departmentName)}</span>` : ''}
        ${t.assignee ? `<span class="badge">👤 ${esc(t.assignee === me.id ? 'Me' : t.assigneeName)}</span>` : '<span class="badge">unassigned</span>'}</div>
    </div>`).join('') || '<p class="muted" style="padding:12px">No tickets here.</p>';
  if (selectedTicket) await loadTicketDetail();
}

$('#ticket-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.t-item');
  if (!item) return;
  selectedTicket = item.dataset.id;
  renderedTicketAt = null;
  $$('.t-item').forEach((x) => x.classList.toggle('active', x === item));
  await api(`/tickets/${selectedTicket}/read`, { method: 'POST' }).catch(() => {});
  await loadTicketDetail();
});

async function loadTicketDetail() {
  let t;
  try { t = await api(`/tickets/${selectedTicket}`); } catch {
    selectedTicket = null;
    $('#ticket-detail').innerHTML = '<p class="muted empty">Select a ticket to view the conversation.</p>';
    return;
  }
  if (t.unread) api(`/tickets/${t.id}/read`, { method: 'POST' }).catch(() => {}); // agent is looking at it
  const box = $('#ticket-detail');
  if (box.dataset.id !== t.id) {
    box.dataset.id = t.id;
    box.innerHTML = `
      <div class="td-head">
        <h3 id="td-title"></h3>
        <div class="muted" id="td-sub"></div>
        <div class="td-controls">
          <select id="td-status">${['open', 'pending', 'resolved', 'closed'].map((s) => `<option>${s}</option>`).join('')}</select>
          <select id="td-priority">${['low', 'normal', 'high', 'urgent'].map((s) => `<option>${s}</option>`).join('')}</select>
          <select id="td-department" title="Transfer to department"></select>
          <select id="td-assignee" title="Assignee"></select>
          <button class="btn sm" id="td-assign-me">Assign to me</button>
          ${isStaff() ? '<button class="btn sm danger" id="td-delete">Delete</button>' : ''}
        </div>
      </div>
      <div class="thread" id="td-thread"></div>
      <form class="composer" id="td-composer">
        <div class="row space-between" style="margin:0">
          <div class="mode-tabs"><button type="button" data-mode="reply">Reply on WhatsApp</button><button type="button" data-mode="note">Internal note</button></div>
          <span class="muted" id="td-hint"></span>
        </div>
        <textarea name="text" rows="3" placeholder="Type your reply… (Ctrl+Enter to send)"></textarea>
        <div class="row">
          <input type="file" name="file" />
          <button class="btn primary" id="td-send">Send</button>
          <button type="button" class="btn" id="td-send-resolve">Send &amp; resolve</button>
        </div>
      </form>`;
    bindTicketDetail();
    setComposeMode(composeMode);
  }
  $('#td-title').textContent = `#${t.number} · ${t.subject}`;
  $('#td-sub').textContent = `${t.name ? t.name + ' · ' : ''}+${t.phone} · via ${t.sessionId} · opened ${fmt(t.createdAt)}`;
  const deptSel = $('#td-department'), asgSel = $('#td-assignee');
  if (!deptSel.matches(':focus')) {
    deptSel.innerHTML = options([['', 'No department'], ...departments.map((d) => [d.id, d.name])], t.departmentId || '');
  }
  if (!asgSel.matches(':focus')) {
    asgSel.innerHTML = options([['', 'Unassigned'],
      ...eligibleAssignees(t.departmentId).map((u) => [u.id, u.id === me.id ? `${u.name} (me)` : u.name])], t.assignee || '');
  }
  $('#td-assign-me').classList.toggle('hidden', t.assignee === me.id || me.apiKey);
  for (const [id, v] of [['#td-status', t.status], ['#td-priority', t.priority]]) {
    if (!$(id).matches(':focus')) $(id).value = v;
  }
  if (renderedTicketAt !== t.updatedAt) {
    renderedTicketAt = t.updatedAt;
    const th = $('#td-thread');
    th.innerHTML = t.thread.map((e) => e.type === 'event'
      ? `<div class="event">${esc(e.text)} · ${fmt(e.at)}</div>`
      : `<div class="bubble ${e.type} ${e.status === 'failed' ? 'failed' : ''}">${e.type === 'note' ? '<strong>Note:</strong> ' : ''}${esc(e.text)}
          <div class="by">${esc(e.by || '')} · ${fmt(e.at)}${e.status === 'failed' ? ` · <span class="error">failed: ${esc(e.error)}</span>` : ''}</div></div>`).join('');
    th.scrollTop = th.scrollHeight;
  }
}

function setComposeMode(mode) {
  composeMode = mode;
  $$('#td-composer .mode-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#td-composer').classList.toggle('note-mode', mode === 'note');
  $('#td-composer [name=file]').classList.toggle('hidden', mode === 'note');
  $('#td-send-resolve').classList.toggle('hidden', mode === 'note');
  $('#td-send').textContent = mode === 'note' ? 'Add note' : 'Send';
  $('#td-hint').textContent = mode === 'note' ? 'Only your team sees notes' : 'Customer receives this on WhatsApp';
}

async function patchTicket(body) {
  try {
    await api(`/tickets/${selectedTicket}`, { method: 'PATCH', body });
  } catch (err) { alert(err.message); }
  renderedTicketAt = null;
  await loadTickets();
}

function bindTicketDetail() {
  $('#td-status').addEventListener('change', (e) => patchTicket({ status: e.target.value }));
  $('#td-priority').addEventListener('change', (e) => patchTicket({ priority: e.target.value }));
  $('#td-assignee').addEventListener('change', (e) => patchTicket({ assignee: e.target.value }));
  $('#td-department').addEventListener('change', (e) => {
    const name = e.target.value ? deptName(e.target.value) : 'No department';
    if (!confirm(`Transfer this ticket to ${name}?`)) { renderedTicketAt = null; return loadTicketDetail(); }
    patchTicket({ departmentId: e.target.value || null });
  });
  $('#td-assign-me').addEventListener('click', () => patchTicket({ assignee: me.id }));
  $('#td-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this ticket permanently?')) return;
    await api(`/tickets/${selectedTicket}`, { method: 'DELETE' });
    selectedTicket = null;
    $('#ticket-detail').dataset.id = '';
    loadTickets();
  });
  $('#td-composer .mode-tabs').addEventListener('click', (e) => e.target.dataset.mode && setComposeMode(e.target.dataset.mode));
  const form = $('#td-composer');
  form.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) form.requestSubmit(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); sendTicketMessage(false); });
  $('#td-send-resolve').addEventListener('click', () => sendTicketMessage(true));
}

async function sendTicketMessage(resolve) {
  const form = $('#td-composer');
  const text = form.text.value.trim();
  const file = form.file.files[0];
  if (!text && !file) return;
  const btns = $$('#td-composer button.btn');
  btns.forEach((b) => (b.disabled = true));
  try {
    if (composeMode === 'note') {
      await api(`/tickets/${selectedTicket}/notes`, { method: 'POST', body: { text } });
    } else {
      const fd = new FormData();
      fd.append('text', text);
      if (file) fd.append('file', file);
      await api(`/tickets/${selectedTicket}/reply`, { method: 'POST', form: fd });
      if (resolve) await api(`/tickets/${selectedTicket}`, { method: 'PATCH', body: { status: 'resolved', notify: false } });
    }
    form.reset();
    renderedTicketAt = null;
    await loadTickets();
  } catch (err) { alert(err.message); renderedTicketAt = null; loadTicketDetail(); }
  finally { btns.forEach((b) => (b.disabled = false)); }
}

$('#new-ticket-btn').addEventListener('click', () => $('#new-ticket-form').classList.toggle('hidden'));
$('#new-ticket-cancel').addEventListener('click', () => $('#new-ticket-form').classList.add('hidden'));
$('#new-ticket-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const t = await api('/tickets', { method: 'POST', body: {
      sessionId: f.sessionId.value, phone: f.phone.value, name: f.name.value, subject: f.subject.value,
      priority: f.priority.value, message: f.message.value, sendMessage: f.sendMessage.checked,
      ...(f.departmentId.value ? { departmentId: f.departmentId.value } : {}),
      ...(f.assignToMe.checked ? { assignee: me.id } : {}),
    } });
    f.reset();
    f.classList.add('hidden');
    selectedTicket = t.id;
    renderedTicketAt = null;
    loadTickets();
  } catch (err) { alert(err.message); }
});

/* ---------- Chatbot flows ---------- */
const NODE_META = {
  start: { label: 'Start', icon: 'i-play', color: '#128c7e' },
  message: { label: 'Send message', icon: 'i-chat', color: '#2a78d6' },
  menu: { label: 'Menu / buttons', icon: 'i-list', color: '#6250d6' },
  question: { label: 'Ask a question', icon: 'i-help', color: '#eb6834' },
  condition: { label: 'Condition', icon: 'i-split', color: '#c98500' },
  action: { label: 'Action', icon: 'i-zap', color: '#1baf7a' },
  delay: { label: 'Wait', icon: 'i-clock', color: '#7a7f7c' },
  handoff: { label: 'Hand to a person', icon: 'i-user', color: '#d55181' },
  end: { label: 'End', icon: 'i-stop', color: '#52514e' },
};
const PALETTE = ['message', 'menu', 'question', 'condition', 'action', 'delay', 'handoff', 'end'];
const VALIDATE = { any: 'Any text', number: 'Number', email: 'Email', phone: 'Phone number', date: 'Date', yesno: 'Yes / No' };
const OPERATORS = { equals: 'is', not_equals: 'is not', contains: 'contains (comma = any)', gt: 'is greater than', lt: 'is less than', exists: 'has a value', not_exists: 'is empty' };
const ACTIONS = { add_tag: 'Add tag to contact', remove_tag: 'Remove tag', set_variable: 'Set a variable', opt_in: 'Mark contact as opted in', webhook: 'Send webhook to your system' };
const TRIGGER_LABEL = { keyword: 'Message contains a keyword', first_message: "Customer's first message ever", any: 'Any message (when no ticket is open)' };
const DEFAULTS = {
  message: () => ({ text: '' }),
  menu: () => ({ text: 'Please choose an option:', style: 'buttons', variable: 'choice',
    options: [{ id: rid('o'), title: 'Option 1', next: null }, { id: rid('o'), title: 'Option 2', next: null }] }),
  question: () => ({ text: '', variable: 'answer', validate: 'any' }),
  condition: () => ({ variable: '', operator: 'equals', value: '' }),
  action: () => ({ action: 'add_tag', value: '' }),
  delay: () => ({ seconds: 60 }),
  handoff: () => ({ text: 'Connecting you to our team. Someone will reply shortly.', priority: 'normal', departmentId: null, subject: '' }),
  end: () => ({ text: '' }),
};
function rid(p) { return p + Math.random().toString(36).slice(2, 8); }

let flowsList = [];
let flowSessionIds = []; // WhatsApp numbers, for the flow settings
let fe = null; // open editor: { flow, issues, selected, scale, tx, ty, dirty, mode, sim, drag }

/* ----- list ----- */
const triggerText = (f) => f.trigger.type === 'keyword'
  ? `Keyword: ${(f.trigger.keywords || []).map((k) => `"${k}"`).join(', ') || '—'}` : TRIGGER_LABEL[f.trigger.type];

async function loadFlows() {
  if (fe) return; // editor is open
  flowsList = await api('/flows');
  $('#flows').innerHTML = flowsList.map((f) => `<tr>
    <td><strong>${esc(f.name)}</strong><br><span class="muted small">${esc(f.description || `${f.steps} steps`)}</span></td>
    <td class="small">${esc(triggerText(f))}</td>
    <td class="small">${f.sessionIds?.length ? f.sessionIds.map(esc).join(', ') : 'All numbers'}</td>
    <td class="n">${f.stats.started}</td><td class="n">${f.stats.completed}</td><td class="n">${f.stats.handoffs}</td>
    <td><label class="switch"><input type="checkbox" data-live="${f.id}" ${f.active ? 'checked' : ''} aria-label="Live"><span></span></label></td>
    <td style="white-space:nowrap"><button class="btn sm" data-edit="${f.id}">Edit</button>
      <button class="btn sm" data-dup="${f.id}">Duplicate</button>
      <button class="btn sm danger" data-del="${f.id}">Delete</button></td></tr>`).join('')
    || '<tr><td colspan="8" class="empty-state">No flows yet. Click "+ New flow" and start from a template.</td></tr>';
}

$('#flow-new-btn').addEventListener('click', async () => {
  const box = $('#flow-templates');
  if (box.classList.toggle('hidden')) return;
  const tpls = await api('/flows/templates');
  box.innerHTML = tpls.map((t) => `<button class="tpl" data-tpl="${t.id}"><strong>${esc(t.name)}</strong><span>${esc(t.description)}</span></button>`).join('');
});
$('#flow-templates').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tpl]');
  if (!b) return;
  const { flow } = await api('/flows', { method: 'POST', body: { template: b.dataset.tpl } });
  $('#flow-templates').classList.add('hidden');
  openFlowEditor(flow.id);
});
$('#flows').addEventListener('click', async (e) => {
  const { edit, dup, del } = e.target.dataset;
  try {
    if (edit) openFlowEditor(edit);
    if (dup) { await api(`/flows/${dup}/duplicate`, { method: 'POST' }); loadFlows(); }
    if (del && confirm('Delete this flow? Conversations running in it will stop.')) { await api(`/flows/${del}`, { method: 'DELETE' }); loadFlows(); }
  } catch (err) { alert(err.message); }
});
$('#flows').addEventListener('change', async (e) => {
  const id = e.target.dataset.live;
  if (!id) return;
  try { await api(`/flows/${id}`, { method: 'PUT', body: { active: e.target.checked } }); }
  catch (err) { alert(err.message); }
  loadFlows();
});

/* ----- editor: open / close / save ----- */
async function openFlowEditor(id) {
  const [{ flow, issues }, sessions] = await Promise.all([api(`/flows/${id}`), api('/sessions')]);
  flowSessionIds = sessions.map((s) => s.id);
  fe = { flow, issues, selected: null, scale: 1, tx: 0, ty: 0, dirty: false, mode: 'props', sim: null, drag: null };
  $('#flows-list-view').classList.add('hidden');
  $('#flow-editor').classList.remove('hidden');
  $('#fe-name').value = flow.name;
  $('#fe-active').checked = flow.active;
  setFeStatus();
  renderPalette();
  renderCanvas();
  renderSide();
  renderIssues();
  requestAnimationFrame(() => { fitFlow(); drawEdges(); });
}
function closeFlowEditor() {
  if (fe?.dirty && !confirm('You have unsaved changes. Leave without saving?')) return;
  fe = null;
  $('#flow-editor').classList.add('hidden');
  $('#flows-list-view').classList.remove('hidden');
  loadFlows();
}
function markDirty() { fe.dirty = true; setFeStatus(); }
function setFeStatus(text) {
  $('#fe-status').textContent = text || (fe.dirty ? 'Unsaved changes' : fe.flow.active ? 'Live' : 'Draft (not live)');
}
$('#fe-back').addEventListener('click', closeFlowEditor);
$('#fe-name').addEventListener('input', (e) => { fe.flow.name = e.target.value; markDirty(); });
window.addEventListener('beforeunload', (e) => { if (fe?.dirty) e.preventDefault(); });

async function saveFlow(extra = {}) {
  const f = fe.flow;
  const res = await api(`/flows/${f.id}`, { method: 'PUT', body: {
    name: f.name, description: f.description, trigger: f.trigger, sessionIds: f.sessionIds,
    timeoutMinutes: f.timeoutMinutes, cooldownMinutes: f.cooldownMinutes, nodes: f.nodes, ...extra,
  } });
  fe.flow = res.flow;
  fe.issues = res.issues;
  fe.dirty = false;
  $('#fe-active').checked = res.flow.active;
  renderCanvas();
  renderIssues();
  setFeStatus(res.issues.errors.length ? 'Saved — fix the errors below to go live' : 'Saved ✓');
}
$('#fe-save').addEventListener('click', () => saveFlow().catch((err) => alert(err.message)));
$('#fe-active').addEventListener('change', async (e) => {
  try { await saveFlow({ active: e.target.checked }); }
  catch (err) { e.target.checked = !e.target.checked; alert(err.message); }
});
$('#fe-test').addEventListener('click', () => {
  fe.mode = 'test';
  fe.sim = { state: null, log: [], waitingFor: null };
  renderSide();
});

function renderIssues() {
  const { errors = [], warnings = [] } = fe.issues || {};
  $('#fe-issues').innerHTML = !errors.length && !warnings.length ? '<span class="ok">✓ No problems found</span>'
    : [...errors.map((x) => `<div class="err">✕ ${esc(x)}</div>`), ...warnings.map((x) => `<div class="warn">⚠ ${esc(x)}</div>`)].join('');
}

/* ----- graph helpers ----- */
function outputs(n) {
  switch (n.type) {
    case 'start': return [{ key: 'next', label: 'Then' }];
    case 'menu': return (n.options || []).map((o) => ({ key: `opt:${o.id}`, label: o.title || '(no title)' }));
    case 'condition': return [{ key: 'yes', label: 'Yes', cls: 'yes' }, { key: 'no', label: 'No', cls: 'no' }];
    case 'handoff': case 'end': return [];
    default: return [{ key: 'next', label: 'Next' }];
  }
}
const getTarget = (n, key) => (key.startsWith('opt:') ? n.options?.find((o) => o.id === key.slice(4))?.next : n[key]);
function setTarget(n, key, id) {
  if (key.startsWith('opt:')) { const o = n.options.find((x) => x.id === key.slice(4)); if (o) o.next = id || null; }
  else n[key] = id || null;
}
const nodeName = (id) => { const n = fe.flow.nodes[id]; return n ? n.label || NODE_META[n.type].label : '?'; };
const duration = (s) => (s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? '' : 's'}` : s % 60 === 0 ? `${s / 60} min` : `${s} sec`);
function flowVars() {
  const v = new Set(['name', 'phone', 'first_message']);
  for (const n of Object.values(fe.flow.nodes)) {
    if (n.type === 'question' && n.variable) v.add(n.variable);
    if (n.type === 'menu') v.add(n.variable || 'choice');
    if (n.type === 'action' && n.action === 'set_variable' && n.variable) v.add(n.variable);
  }
  return [...v];
}
function nodeSummary(n) {
  switch (n.type) {
    case 'start': return `When: ${triggerText(fe.flow)}`;
    case 'message': return `${n.imageUrl ? '🖼 ' : ''}${n.text || ''}`;
    case 'menu': return `${n.text || ''}${n.style === 'buttons' ? '' : '\n(numbered list)'}`;
    case 'question': return `${n.text || ''}\n→ saves {{${n.variable || '?'}}} · ${VALIDATE[n.validate || 'any']}`;
    case 'condition': return `If {{${n.variable || '?'}}} ${OPERATORS[n.operator]}${['exists', 'not_exists'].includes(n.operator) ? '' : ` "${n.value ?? ''}"`}`;
    case 'action': return `${ACTIONS[n.action]}${n.value ? `: ${n.action === 'set_variable' ? `${n.variable} = ` : ''}${n.value}` : ''}`;
    case 'delay': return `Wait ${duration(Number(n.seconds) || 0)}`;
    case 'handoff': return `Ticket → ${n.departmentId ? deptName(n.departmentId) || '?' : 'routing rules'} · ${n.priority || 'normal'}${n.text ? `\n${n.text}` : ''}`;
    case 'end': return n.text || 'End of conversation';
    default: return '';
  }
}

/* ----- canvas rendering ----- */
function renderPalette() {
  $('#fe-palette').innerHTML = '<div class="pal-title">Add a step</div>' + PALETTE.map((t) => `
    <button class="pal-btn" data-add="${t}" style="--nc:${NODE_META[t].color}" title="${NODE_META[t].label}">
      <span class="dot"><svg class="ic"><use href="#${NODE_META[t].icon}"/></svg></span><span>${NODE_META[t].label}</span></button>`).join('');
}
function renderCanvas() {
  const nodes = fe.flow.nodes;
  $('#fe-nodes').innerHTML = Object.entries(nodes).map(([id, n]) => {
    const m = NODE_META[n.type] || NODE_META.message;
    return `<div class="fnode ${fe.selected === id ? 'selected' : ''}" data-id="${id}" style="left:${n.x || 0}px;top:${n.y || 0}px;--nc:${m.color}">
      ${n.type !== 'start' ? '<span class="port in"></span>' : ''}
      <div class="fn-head"><span class="dot"><svg class="ic"><use href="#${m.icon}"/></svg></span><span class="t">${esc(n.label || m.label)}</span></div>
      <div class="fn-body">${esc(nodeSummary(n))}</div>
      ${outputs(n).length ? `<div class="fn-outs">${outputs(n).map((o) => `
        <div class="fn-out"><span class="lbl">${esc(o.label)}</span><span class="port out ${getTarget(n, o.key) ? 'linked' : ''}" data-key="${esc(o.key)}" title="Drag to connect"></span></div>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
  applyTransform();
  drawEdges();
}
function applyTransform() {
  $('#fe-world').style.transform = `translate(${fe.tx}px, ${fe.ty}px) scale(${fe.scale})`;
}
function curve(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}
function portPos(el) {
  const w = $('#fe-world').getBoundingClientRect(), r = el.getBoundingClientRect();
  return { x: (r.left + r.width / 2 - w.left) / fe.scale, y: (r.top + r.height / 2 - w.top) / fe.scale };
}
function drawEdges(temp = '') {
  if (!fe) return;
  const out = [];
  for (const el of $$('#fe-nodes .fnode')) {
    const n = fe.flow.nodes[el.dataset.id];
    for (const p of el.querySelectorAll('.port.out')) {
      const to = getTarget(n, p.dataset.key);
      const inEl = to && $(`#fe-nodes .fnode[data-id="${to}"] .port.in`);
      if (!inEl) continue;
      const d = curve(portPos(p), portPos(inEl));
      const cls = p.dataset.key === 'yes' ? 'yes' : p.dataset.key === 'no' ? 'no' : '';
      out.push(`<g data-from="${el.dataset.id}" data-key="${esc(p.dataset.key)}"><path class="edge-hit" d="${d}"/><path class="edge ${cls}" d="${d}" marker-end="url(#fe-arrow)"/></g>`);
    }
  }
  $('#fe-edges').innerHTML = `<defs><marker id="fe-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#9aa7a2"/></marker></defs>
    <g transform="translate(5000 5000)">${out.join('')}${temp}</g>`;
}
function fitFlow() {
  const els = $$('#fe-nodes .fnode');
  if (!els.length) return;
  const c = $('#fe-canvas');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of els) {
    const n = fe.flow.nodes[el.dataset.id];
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + el.offsetWidth); maxY = Math.max(maxY, n.y + el.offsetHeight);
  }
  const s = Math.min(1, (c.clientWidth - 80) / (maxX - minX), (c.clientHeight - 80) / (maxY - minY));
  fe.scale = Math.max(0.3, s);
  fe.tx = (c.clientWidth - (maxX - minX) * fe.scale) / 2 - minX * fe.scale;
  fe.ty = (c.clientHeight - (maxY - minY) * fe.scale) / 2 - minY * fe.scale;
  applyTransform();
}
function zoomAt(cx, cy, factor) {
  const s = Math.min(1.8, Math.max(0.3, fe.scale * factor));
  const k = s / fe.scale;
  fe.tx = cx - (cx - fe.tx) * k;
  fe.ty = cy - (cy - fe.ty) * k;
  fe.scale = s;
  applyTransform();
}
const canvasCenter = () => {
  const c = $('#fe-canvas');
  return { x: (c.clientWidth / 2 - fe.tx) / fe.scale - 120, y: (c.clientHeight / 2 - fe.ty) / fe.scale - 40 };
};
$('#fe-zoom-in').addEventListener('click', () => { const c = $('#fe-canvas'); zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1.2); });
$('#fe-zoom-out').addEventListener('click', () => { const c = $('#fe-canvas'); zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1 / 1.2); });
$('#fe-zoom-fit').addEventListener('click', fitFlow);
$('#fe-canvas').addEventListener('wheel', (e) => {
  if (!fe) return;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

/* ----- adding / removing steps ----- */
function addNode(type, pos, connectFrom) {
  const id = rid('n');
  const p = pos || canvasCenter();
  const stagger = Object.keys(fe.flow.nodes).length % 5 * 18;
  fe.flow.nodes[id] = { type, x: Math.round(p.x + (pos ? 0 : stagger)), y: Math.round(p.y + (pos ? 0 : stagger)), next: null, ...DEFAULTS[type]() };
  if (connectFrom) setTarget(fe.flow.nodes[connectFrom.id], connectFrom.key, id);
  fe.selected = id;
  fe.mode = 'props';
  markDirty();
  renderCanvas();
  renderSide();
  return id;
}
function deleteNode(id) {
  if (id === 'start') return;
  delete fe.flow.nodes[id];
  for (const n of Object.values(fe.flow.nodes)) {
    for (const k of ['next', 'yes', 'no']) if (n[k] === id) n[k] = null;
    for (const o of n.options || []) if (o.next === id) o.next = null;
  }
  fe.selected = null;
  markDirty();
  renderCanvas();
  renderSide();
}
function duplicateNode(id) {
  const src = fe.flow.nodes[id];
  const copy = JSON.parse(JSON.stringify(src));
  copy.next = null; copy.yes = null; copy.no = null;
  for (const o of copy.options || []) { o.id = rid('o'); o.next = null; }
  if (copy.label) copy.label += ' (copy)';
  const nid = rid('n');
  fe.flow.nodes[nid] = { ...copy, x: src.x + 30, y: src.y + 30 };
  fe.selected = nid;
  markDirty();
  renderCanvas();
  renderSide();
}
$('#fe-palette').addEventListener('click', (e) => { const b = e.target.closest('[data-add]'); if (b) addNode(b.dataset.add); });
function showAddMenu(clientX, clientY, connectFrom) {
  const c = $('#fe-canvas').getBoundingClientRect();
  const menu = $('#fe-add-menu');
  const world = { x: (clientX - c.left - fe.tx) / fe.scale, y: (clientY - c.top - fe.ty) / fe.scale - 20 };
  menu.innerHTML = '<div class="pal-title muted small" style="padding:4px 8px">Add and connect</div>' + PALETTE.map((t) => `
    <button class="pal-btn" data-type="${t}" style="--nc:${NODE_META[t].color}"><span class="dot"><svg class="ic"><use href="#${NODE_META[t].icon}"/></svg></span><span>${NODE_META[t].label}</span></button>`).join('');
  menu.style.left = `${Math.min(clientX - c.left, c.width - 200)}px`;
  menu.style.top = `${Math.min(clientY - c.top, c.height - 330)}px`;
  menu.classList.remove('hidden');
  menu.onclick = (ev) => {
    const b = ev.target.closest('[data-type]');
    if (!b) return;
    menu.classList.add('hidden');
    addNode(b.dataset.type, world, connectFrom);
  };
}

/* ----- pointer interactions: select, move, pan, connect ----- */
function selectNode(id) {
  fe.selected = id;
  fe.mode = 'props';
  $$('#fe-nodes .fnode').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
  renderSide();
}
$('#fe-canvas').addEventListener('pointerdown', (e) => {
  if (!fe || e.button !== 0) return;
  if (!e.target.closest('#fe-add-menu')) $('#fe-add-menu').classList.add('hidden');
  if (e.target.closest('.fe-zoom, #fe-add-menu, .edge-hit')) return;
  const port = e.target.closest('.port.out');
  const nodeEl = e.target.closest('.fnode');
  if (port) {
    fe.drag = { type: 'connect', from: nodeEl.dataset.id, key: port.dataset.key, start: portPos(port) };
  } else if (nodeEl) {
    const id = nodeEl.dataset.id;
    if (fe.selected !== id || fe.mode !== 'props') selectNode(id);
    const n = fe.flow.nodes[id];
    if (e.target.closest('.fn-head, .fn-body')) fe.drag = { type: 'move', id, el: nodeEl, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false };
  } else {
    fe.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, tx: fe.tx, ty: fe.ty, moved: false };
    e.currentTarget.classList.add('panning');
  }
  if (fe.drag) e.currentTarget.setPointerCapture(e.pointerId);
});
$('#fe-canvas').addEventListener('pointermove', (e) => {
  const d = fe?.drag;
  if (!d) return;
  if (d.type === 'move') {
    const n = fe.flow.nodes[d.id];
    n.x = Math.round(d.ox + (e.clientX - d.sx) / fe.scale);
    n.y = Math.round(d.oy + (e.clientY - d.sy) / fe.scale);
    d.el.style.left = `${n.x}px`;
    d.el.style.top = `${n.y}px`;
    if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
    drawEdges();
  } else if (d.type === 'pan') {
    fe.tx = d.tx + (e.clientX - d.sx);
    fe.ty = d.ty + (e.clientY - d.sy);
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
    applyTransform();
  } else if (d.type === 'connect') {
    const w = $('#fe-world').getBoundingClientRect();
    const p = { x: (e.clientX - w.left) / fe.scale, y: (e.clientY - w.top) / fe.scale };
    drawEdges(`<path class="temp" d="${curve(d.start, p)}"/>`);
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.fnode');
    $$('#fe-nodes .fnode').forEach((el) => el.classList.toggle('drop-target', el === over && el.dataset.id !== d.from && el.dataset.id !== 'start'));
  }
});
$('#fe-canvas').addEventListener('pointerup', (e) => {
  const d = fe?.drag;
  if (!d) return;
  fe.drag = null;
  e.currentTarget.classList.remove('panning');
  if (d.type === 'move' && d.moved) markDirty();
  if (d.type === 'pan' && !d.moved && fe.selected) { fe.selected = null; renderCanvas(); renderSide(); }
  if (d.type === 'connect') {
    $$('#fe-nodes .fnode').forEach((el) => el.classList.remove('drop-target'));
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.fnode');
    if (over && over.dataset.id !== d.from && over.dataset.id !== 'start') {
      setTarget(fe.flow.nodes[d.from], d.key, over.dataset.id);
      markDirty();
      renderCanvas();
      if (fe.selected === d.from) renderSide();
    } else if (!over) {
      drawEdges();
      showAddMenu(e.clientX, e.clientY, { id: d.from, key: d.key }); // dropped on empty space
    } else drawEdges();
  }
});
$('#fe-edges').addEventListener('click', (e) => {
  const g = e.target.closest('g[data-from]');
  if (!g || !confirm('Remove this connection?')) return;
  setTarget(fe.flow.nodes[g.dataset.from], g.dataset.key, null);
  markDirty();
  renderCanvas();
  if (fe.selected === g.dataset.from) renderSide();
});
document.addEventListener('keydown', (e) => {
  if (!fe || currentTab !== 'flows' || $('#flow-editor').classList.contains('hidden')) return;
  if (e.target.matches('input, textarea, select')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && fe.selected && fe.selected !== 'start') { e.preventDefault(); deleteNode(fe.selected); }
  if (e.key === 'Escape') { $('#fe-add-menu').classList.add('hidden'); if (fe.selected) { fe.selected = null; renderCanvas(); renderSide(); } }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFlow().catch((err) => alert(err.message)); }
});

/* ----- side panel: flow settings, step properties, test chat ----- */
const sel = (attrs, opts, value) => `<select ${attrs}>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const nextOptions = (selfId) => [['', '— End the flow —'],
  ...Object.entries(fe.flow.nodes).filter(([id, n]) => id !== selfId && n.type !== 'start')
    .map(([id, n]) => [id, `${n.label || NODE_META[n.type].label}: ${nodeSummary(n).split('\n')[0].slice(0, 40)}`])];
const nextField = (label, n, id, key) => `<label>${label} ${sel(`data-next="${key}"`, nextOptions(id), getTarget(n, key) || '')}</label>`;
const chips = (target) => `<div class="var-chips">${flowVars().map((v) => `<button type="button" data-chip="${v}" data-target="${target}">{{${v}}}</button>`).join('')}</div>`;
const textArea = (n, field = 'text', label = 'Message', ph = '') => `<label>${label}<textarea data-f="${field}" rows="4" placeholder="${esc(ph)}">${esc(n[field] || '')}</textarea></label>${chips(field)}`;

function renderSide() {
  const side = $('#fe-side');
  if (!fe) return;
  if (fe.mode === 'test') return renderSim();
  const id = fe.selected;
  const n = id && fe.flow.nodes[id];
  if (!n) return renderFlowSettings();
  const m = NODE_META[n.type];
  let body = '';
  switch (n.type) {
    case 'start':
      body = `<p class="help">This is where every conversation begins. Set when it starts under <a href="#" data-act="settings">Flow settings</a>.</p>
        ${nextField('First step', n, id, 'next')}`;
      break;
    case 'message':
      body = `${textArea(n, 'text', 'Message', 'Hi {{name}}! …')}
        <label>Image URL (optional)<input data-f="imageUrl" value="${esc(n.imageUrl || '')}" placeholder="https://…/photo.jpg" /></label>
        ${nextField('Then go to', n, id, 'next')}`;
      break;
    case 'menu':
      body = `${textArea(n, 'text', 'Question / message')}
        <label>Show options as ${sel('data-f="style" data-rerender="1"', [['buttons', 'Buttons (max 3, numbers shown too)'], ['list', 'Numbered list (up to 10)']], n.style)}</label>
        <div><strong class="small">Options</strong> <span class="help">Customer taps a button, types the number or the option text.</span></div>
        ${(n.options || []).map((o, i) => `<div class="opt-row">
          <input data-opt-title="${o.id}" value="${esc(o.title)}" maxlength="${n.style === 'buttons' ? 20 : 60}" placeholder="Option ${i + 1}" />
          ${sel(`data-next="opt:${o.id}"`, nextOptions(id), o.next || '')}
          <button type="button" class="btn sm danger" data-act="del-opt" data-opt="${o.id}" title="Remove option">✕</button></div>`).join('')}
        ${(n.options || []).length < (n.style === 'buttons' ? 3 : 10) ? '<button type="button" class="btn sm" data-act="add-opt">+ Add option</button>' : ''}
        <label>Save the choice as variable<input data-f="variable" value="${esc(n.variable || 'choice')}" /></label>
        <label>Reply when the answer isn't an option<input data-f="invalidText" value="${esc(n.invalidText || '')}" placeholder="Please choose one of the options." /></label>
        <label>Image URL (optional)<input data-f="imageUrl" value="${esc(n.imageUrl || '')}" placeholder="https://…" /></label>
        ${n.style === 'buttons' ? `<label>Footer (optional)<input data-f="footer" value="${esc(n.footer || '')}" /></label>` : ''}`;
      break;
    case 'question':
      body = `${textArea(n, 'text', 'Question', "What's your email address?")}
        <label>Save the answer as variable<input data-f="variable" value="${esc(n.variable || '')}" placeholder="email" /></label>
        <p class="help">Saved on the contact too, so you can use {{${esc(n.variable || 'variable')}}} later and in campaigns.</p>
        <label>Expected answer ${sel('data-f="validate"', Object.entries(VALIDATE), n.validate || 'any')}</label>
        <label>Reply when the answer is invalid<input data-f="invalidText" value="${esc(n.invalidText || '')}" placeholder="Please reply with a valid answer." /></label>
        ${nextField('Then go to', n, id, 'next')}`;
      break;
    case 'condition':
      body = `<label>Check variable <input data-f="variable" list="fe-vars" value="${esc(n.variable || '')}" placeholder="choice" /></label>
        <datalist id="fe-vars">${flowVars().map((v) => `<option value="${v}">`).join('')}</datalist>
        <label>Condition ${sel('data-f="operator" data-rerender="1"', Object.entries(OPERATORS), n.operator)}</label>
        ${['exists', 'not_exists'].includes(n.operator) ? '' : `<label>Value<input data-f="value" value="${esc(n.value ?? '')}" /></label>`}
        ${nextField('If yes, go to', n, id, 'yes')}${nextField('If no, go to', n, id, 'no')}`;
      break;
    case 'action':
      body = `<label>Action ${sel('data-f="action" data-rerender="1"', Object.entries(ACTIONS), n.action)}</label>
        ${n.action === 'set_variable' ? `<label>Variable<input data-f="variable" value="${esc(n.variable || '')}" placeholder="vip" /></label>` : ''}
        ${n.action === 'opt_in' ? '<p class="help">Use after the customer agrees to receive offers, so they can be included in campaigns.</p>' : ''}
        ${n.action === 'webhook' ? '<p class="help">POSTs a "flow.action" event with all collected variables to the WEBHOOK_URL in .env.</p>' : ''}
        ${['add_tag', 'remove_tag', 'set_variable', 'webhook'].includes(n.action)
          ? `<label>${n.action === 'webhook' ? 'Label (optional)' : n.action === 'set_variable' ? 'Value' : 'Tag'}<input data-f="value" value="${esc(n.value || '')}" placeholder="${n.action === 'set_variable' ? 'yes or {{choice}}' : 'lead'}" /></label>` : ''}
        ${nextField('Then go to', n, id, 'next')}`;
      break;
    case 'delay': {
      const s = Number(n.seconds) || 60;
      const unit = s % 3600 === 0 ? 3600 : s % 60 === 0 ? 60 : 1;
      body = `<label>Wait<div class="inline-fields" style="justify-content:flex-start"><input type="number" min="1" data-delay="amount" value="${s / unit}" />
          ${sel('data-delay="unit"', [[1, 'seconds'], [60, 'minutes'], [3600, 'hours']], unit)}</div></label>
        <p class="help">The bot pauses, then continues by itself. Maximum 24 hours.</p>
        ${nextField('Then go to', n, id, 'next')}`;
      break;
    }
    case 'handoff':
      body = `<p class="help">Creates a ticket with everything the bot collected and ends the flow. Your team continues the chat from Tickets.</p>
        <label>Department ${sel('data-f="departmentId"', [['', 'Use routing rules'], ...departments.map((d) => [d.id, d.name])], n.departmentId || '')}</label>
        <label>Priority ${sel('data-f="priority"', [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']], n.priority || 'normal')}</label>
        <label>Ticket subject<input data-f="subject" value="${esc(n.subject || '')}" placeholder="New lead: {{name}}" /></label>
        ${textArea(n, 'text', 'Message to the customer', 'Connecting you to our team…')}`;
      break;
    case 'end':
      body = textArea(n, 'text', 'Closing message (optional)', 'Thanks for chatting with us!');
      break;
  }
  side.innerHTML = `<h3><span class="dot" style="--nc:${m.color};width:24px;height:24px;border-radius:6px;display:grid;place-items:center;background:${m.color};color:#fff"><svg class="ic" style="width:13px;height:13px"><use href="#${m.icon}"/></svg></span>${m.label}</h3>
    ${n.type !== 'start' ? `<label>Step name (optional)<input data-f="label" value="${esc(n.label || '')}" placeholder="${m.label}" /></label>` : ''}
    ${body}
    ${n.type !== 'start' ? `<div class="side-actions"><button type="button" class="btn sm" data-act="dup-node">Duplicate step</button>
      <button type="button" class="btn sm danger" data-act="del-node">Delete step</button></div>` : ''}`;
}

function renderFlowSettings() {
  const f = fe.flow;
  const sessions = [...new Set([...flowSessionIds, ...(f.sessionIds || [])])];
  $('#fe-side').innerHTML = `<h3>Flow settings</h3>
    <p class="help">Select a step on the canvas to edit it, or add steps from the left.</p>
    <label>Start this flow when ${sel('data-flow="trigger.type" data-rerender="1"', Object.entries(TRIGGER_LABEL), f.trigger.type)}</label>
    ${f.trigger.type === 'keyword' ? `
      <label>Keywords (comma separated)<input data-flow="trigger.keywords" value="${esc((f.trigger.keywords || []).join(', '))}" placeholder="hi, menu, price" /></label>
      <label>Match ${sel('data-flow="trigger.match"', [['contains', 'Message contains the keyword'], ['exact', 'Message is exactly the keyword']], f.trigger.match)}</label>` : ''}
    <div><strong class="small">WhatsApp numbers</strong> <span class="help">None ticked = all numbers.</span>
      <div class="check-list">${sessions.length ? sessions.map((s) => `<label class="check"><input type="checkbox" data-flow-session="${esc(s)}" ${f.sessionIds?.includes(s) ? 'checked' : ''}> ${esc(s)}</label>`).join('') : '<span class="muted small">No numbers linked yet</span>'}</div></div>
    <label>End an unanswered conversation after (minutes)<input type="number" min="5" max="1440" data-flow="timeoutMinutes" value="${f.timeoutMinutes}" /></label>
    ${f.trigger.type !== 'keyword' ? `<label>Don't restart for the same customer within (minutes)<input type="number" min="0" max="10080" data-flow="cooldownMinutes" value="${f.cooldownMinutes}" /></label>` : ''}
    <label>Description (optional)<textarea data-flow="description" rows="2">${esc(f.description || '')}</textarea></label>`;
}

function onSideInput(e) {
  if (!fe) return;
  const el = e.target;
  const n = fe.selected && fe.flow.nodes[fe.selected];
  const f = fe.flow;
  if (el.dataset.f && n) {
    n[el.dataset.f] = el.value === '' && el.dataset.f === 'departmentId' ? null : el.value;
    if (el.dataset.f === 'style' && el.value === 'buttons') n.options = (n.options || []).slice(0, 3);
  } else if (el.dataset.next && n) setTarget(n, el.dataset.next, el.value);
  else if (el.dataset.optTitle && n) n.options.find((o) => o.id === el.dataset.optTitle).title = el.value;
  else if (el.dataset.delay && n) {
    const box = el.closest('label');
    n.seconds = Math.min(86400, Math.max(1, Math.round(Number(box.querySelector('[data-delay=amount]').value || 1) * Number(box.querySelector('[data-delay=unit]').value))));
  } else if (el.dataset.flow) {
    const k = el.dataset.flow;
    if (k === 'trigger.type') f.trigger.type = el.value;
    else if (k === 'trigger.keywords') f.trigger.keywords = el.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    else if (k === 'trigger.match') f.trigger.match = el.value;
    else f[k] = el.type === 'number' ? Number(el.value) : el.value;
  } else if (el.dataset.flowSession) {
    f.sessionIds = $$('#fe-side [data-flow-session]:checked').map((x) => x.dataset.flowSession);
  } else return;
  markDirty();
  renderCanvas();
  if (e.type === 'change' && el.dataset.rerender) renderSide();
}
$('#fe-side').addEventListener('input', onSideInput);
$('#fe-side').addEventListener('change', onSideInput);
$('#fe-side').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const chip = e.target.dataset.chip;
  const n = fe?.selected && fe.flow.nodes[fe.selected];
  if (chip) {
    const ta = $(`#fe-side [data-f="${e.target.dataset.target}"]`);
    const pos = ta.selectionStart ?? ta.value.length;
    ta.value = `${ta.value.slice(0, pos)}{{${chip}}}${ta.value.slice(ta.selectionEnd ?? pos)}`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    return;
  }
  if (!act) return;
  e.preventDefault();
  if (act === 'settings') { fe.selected = null; renderCanvas(); renderSide(); }
  if (act === 'add-opt') { n.options.push({ id: rid('o'), title: `Option ${n.options.length + 1}`, next: null }); markDirty(); renderCanvas(); renderSide(); }
  if (act === 'del-opt') { n.options = n.options.filter((o) => o.id !== e.target.closest('[data-opt]').dataset.opt); markDirty(); renderCanvas(); renderSide(); }
  if (act === 'del-node' && confirm('Delete this step?')) deleteNode(fe.selected);
  if (act === 'dup-node') duplicateNode(fe.selected);
});

/* ----- test chat ----- */
function renderSim() {
  const s = fe.sim;
  const wait = s.waitingFor;
  $('#fe-side').innerHTML = `<div class="sim">
    <div class="row space-between" style="margin:0"><h3>Test chat</h3>
      <div class="row"><button class="btn sm" data-sim="restart">Restart</button><button class="btn sm" data-sim="close">Close</button></div></div>
    <p class="help">Tests your current changes (even unsaved). Nothing is sent and no tickets or tags are created.
      ${fe.flow.trigger.type === 'keyword' ? `Start by typing a keyword, e.g. "${esc(fe.flow.trigger.keywords?.[0] || '')}".` : 'Type any message to start.'}</p>
    <div class="sim-log" id="sim-log">${s.log.map((m) => {
      if (m.type === 'you') return `<div class="sim-msg you">${esc(m.text)}</div>`;
      if (m.type === 'system') return `<div class="sim-msg system">${esc(m.text)}</div>`;
      return `<div class="sim-msg bot">${m.imageUrl ? `<img src="${esc(m.imageUrl)}" alt="">` : ''}${esc(m.text)}${m.footer ? `<div class="muted small">${esc(m.footer)}</div>` : ''}</div>`
        + (m.buttons ? `<div class="sim-btns">${m.buttons.map((b) => `<button data-reply="${esc(b.title)}">↩ ${esc(b.title)}</button>`).join('')}</div>` : '');
    }).join('')}</div>
    ${wait?.type === 'menu' && wait.style !== 'buttons' ? `<div class="var-chips">${wait.options.map((o, i) => `<button data-reply="${i + 1}">${i + 1}. ${esc(o.title)}</button>`).join('')}</div>` : ''}
    <form class="sim-input" id="sim-form"><input name="msg" placeholder="Type a message…" autocomplete="off" /><button class="btn primary">Send</button></form>
  </div>`;
  const log = $('#sim-log');
  log.scrollTop = log.scrollHeight;
  $('#sim-form').msg.focus();
}
async function simSend(text) {
  const s = fe.sim;
  s.log.push({ type: 'you', text });
  renderSim();
  try {
    const r = await api('/flows/simulate', { method: 'POST', body: { flow: fe.flow, state: s.state, input: text } });
    s.log.push(...r.output);
    s.state = r.state;
    s.waitingFor = r.waitingFor;
  } catch (err) { s.log.push({ type: 'system', text: `Error: ${err.message}` }); }
  renderSim();
}
$('#fe-side').addEventListener('submit', (e) => {
  if (e.target.id !== 'sim-form') return;
  e.preventDefault();
  const v = e.target.msg.value.trim();
  if (v) simSend(v);
});
$('#fe-side').addEventListener('click', (e) => {
  if (!fe || fe.mode !== 'test') return;
  const reply = e.target.closest('[data-reply]')?.dataset.reply;
  const act = e.target.dataset.sim;
  if (reply) simSend(reply);
  if (act === 'restart') { fe.sim = { state: null, log: [], waitingFor: null }; renderSim(); }
  if (act === 'close') { fe.mode = 'props'; renderSide(); }
});

/* ---------- Block risk (admin) ---------- */
const LEVELS = {
  low: ['Low risk', 'i-check', 'var(--good)'],
  medium: ['Medium risk', 'i-alert', 'var(--warning)'],
  high: ['High risk', 'i-alert', 'var(--serious)'],
  critical: ['Critical risk', 'i-x', 'var(--critical)'],
};
const SIG_STATUS = {
  good: ['Safe', 'i-check'], warning: ['Watch', 'i-alert'], serious: ['Risky', 'i-alert'],
  critical: ['Danger', 'i-x'], info: ['Not enough data', 'i-info'],
};
let riskData = null;
let riskLoadedAt = 0;
let riskBadgeAt = 0;

// Half-circle gauge, 0–100
function gauge(score, color) {
  const r = 80, cx = 100, cy = 100, a = Math.PI * (1 - Math.min(100, score) / 100);
  const x = cx + r * Math.cos(a), y = cy - r * Math.sin(a);
  return `<div class="gauge"><svg viewBox="0 0 200 112" aria-hidden="true">
    <path d="M20,100 A80,80 0 0 1 180,100" fill="none" stroke="#e7ebe9" stroke-width="14" stroke-linecap="round"/>
    ${score > 0 ? `<path d="M20,100 A80,80 0 0 1 ${x.toFixed(1)},${y.toFixed(1)}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/>` : ''}
  </svg><div class="score"><b>${score}</b><span>risk score / 100</span></div></div>`;
}

async function loadRiskBadge() {
  if (me?.role !== 'admin' || Date.now() - riskBadgeAt < 60000) return;
  riskBadgeAt = Date.now();
  const d = await api('/health').catch(() => null);
  if (!d) return;
  const n = d.sessions.filter((s) => s.level === 'high' || s.level === 'critical').length;
  $('#risk-badge').textContent = n;
  $('#risk-badge').classList.toggle('hidden', !n);
}

async function loadRisk(force = false) {
  if (!force && riskData && Date.now() - riskLoadedAt < 30000) return;
  const d = await api('/health');
  riskData = d;
  riskLoadedAt = Date.now();
  riskBadgeAt = 0;
  $('#risk-numbers').innerHTML = d.sessions.length ? d.sessions.map(renderRiskCard).join('')
    : '<div class="card empty-state">No WhatsApp numbers yet. Link one on the WhatsApp Numbers page to see its block risk.</div>';
  const f = $('#protect-form');
  if (!f.contains(document.activeElement) && !f.dataset.dirty) fillProtectForm(d.settings);
}

function renderRiskCard(h) {
  const [label, icon, color] = LEVELS[h.level];
  const todo = h.signals.filter((s) => s.status !== 'good' && s.status !== 'info').slice(0, 3);
  const used = h.limits.effective ? Math.min(100, Math.round((h.stats.todaySent / h.limits.effective) * 100)) : 0;
  const phone = h.user?.id ? '+' + h.user.id.split(/[:@]/)[0] : 'Not connected';
  return `<div class="card risk-card">
    <div class="risk-summary">
      <div><h3>${esc(h.sessionId)}</h3><div class="muted small">${esc(phone)} · ${esc(h.status.replace('_', ' '))}</div></div>
      ${gauge(h.score, color)}
      <span class="level ${h.level}"><svg class="ic"><use href="#${icon}"/></svg>${label}</span>
      <div class="facts">
        <div><b>${h.stats.sent}</b><span>sent · 7 days</span></div>
        <div><b>${h.stats.replied}</b><span>people replied</span></div>
        <div><b>${h.ageDays}d</b><span>number age</span></div>
        <div><b>${h.limits.effective}</b><span>safe limit today</span></div>
      </div>
      <div>
        <div class="row space-between small" style="margin:0 0 4px"><span class="muted">Sent today</span><span><b>${h.stats.todaySent}</b> / ${h.limits.effective}</span></div>
        <div class="meter ${used >= 95 ? 'crit' : used >= 80 ? 'warn' : ''}"><div style="width:${used}%"></div></div>
      </div>
      <label class="age-edit">Number in use since (for warm-up)
        <input type="date" data-age="${esc(h.sessionId)}" max="${new Date().toISOString().slice(0, 10)}" value="${h.numberSince ? h.numberSince.slice(0, 10) : ''}" />
      </label>
    </div>
    <div class="risk-detail">
      <div class="actions-now ${todo.length ? '' : 'ok'}">
        <h4>${todo.length ? 'What to do now' : 'Looking good'}</h4>
        ${todo.length ? `<ol>${todo.map((s) => `<li><strong>${esc(s.label)}:</strong> ${esc(s.fix)}</li>`).join('')}</ol>`
          : `<div class="small">No risky patterns found for this number in the last 7 days. Keep following the tips below.${h.stats.sent < 20 ? ' (Few messages sent yet, so some checks need more data.)' : ''}</div>`}
      </div>
      <table class="signals">
        <thead><tr><th>Signal</th><th>This number</th><th>Safe range</th><th>Status</th></tr></thead>
        <tbody>${h.signals.map((s) => {
          const [sl, si] = SIG_STATUS[s.status];
          return `<tr>
            <td><div class="sig-name">${esc(s.label)}</div><div class="sig-why">${esc(s.why)}</div>
              ${s.status !== 'good' && s.status !== 'info' ? `<div class="sig-fix"><strong>Fix:</strong> ${esc(s.fix)}</div>` : ''}</td>
            <td class="val">${s.enough ? esc(`${s.value}${s.unit && !s.unit.startsWith('/') ? s.unit : s.unit ? ' ' + s.unit : ''}`) : '—'}</td>
            <td class="safe">${esc(s.safe)}</td>
            <td><span class="sig-status ${s.status}"><svg class="ic"><use href="#${si}"/></svg>${sl}</span></td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
  </div>`;
}

$('#risk-refresh').addEventListener('click', () => loadRisk(true));
$('#risk-numbers').addEventListener('change', async (e) => {
  const id = e.target.dataset.age;
  if (!id) return;
  try {
    await api(`/sessions/${encodeURIComponent(id)}/meta`, { method: 'PATCH', body: { numberSince: e.target.value || null } });
    loadRisk(true);
  } catch (err) { alert(err.message); }
});

/* protection settings form */
const hourOpts = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('');
$('#protect-form').quietStart.innerHTML = hourOpts;
$('#protect-form').quietEnd.innerHTML = hourOpts;
function fillProtectForm(s) {
  const f = $('#protect-form');
  f.minDelay.value = Math.round(s.minDelayMs / 1000);
  f.maxDelay.value = Math.round(s.maxDelayMs / 1000);
  f.dailyLimit.value = s.dailyLimit;
  f.warmup.checked = s.warmup;
  f.quietEnabled.checked = s.quietHours.enabled;
  f.quietStart.value = s.quietHours.start;
  f.quietEnd.value = s.quietHours.end;
  f.autoPause.checked = s.autoPause.enabled;
  f.failRate.value = s.autoPause.failRate;
  f.optOutRate.value = s.autoPause.optOutRate;
}
$('#protect-form').addEventListener('input', (e) => { e.currentTarget.dataset.dirty = '1'; $('#protect-result').textContent = 'Unsaved changes'; });
$('#protect-recommended').addEventListener('click', () => {
  fillProtectForm(riskData.recommended);
  $('#protect-form').dataset.dirty = '1';
  $('#protect-result').textContent = 'Recommended values filled in. Save to apply.';
});
$('#protect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const s = await api('/settings', { method: 'PUT', body: {
      minDelayMs: f.minDelay.value * 1000, maxDelayMs: f.maxDelay.value * 1000, dailyLimit: Number(f.dailyLimit.value),
      warmup: f.warmup.checked,
      quietHours: { enabled: f.quietEnabled.checked, start: Number(f.quietStart.value), end: Number(f.quietEnd.value) },
      autoPause: { enabled: f.autoPause.checked, failRate: Number(f.failRate.value), optOutRate: Number(f.optOutRate.value) },
    } });
    delete f.dataset.dirty;
    fillProtectForm(s);
    $('#protect-result').textContent = 'Saved ✓';
    loadRisk(true);
  } catch (err) { $('#protect-result').textContent = err.message; }
});

/* ---------- Users (admin) ---------- */
const ROLE_HELP = {
  admin: 'Everything, incl. users, departments, numbers and API keys',
  manager: 'Tickets of their departments + contacts, campaigns, sending, logs',
  agent: 'Only tickets of their departments',
};
const checkboxes = (name, items, checked = []) => items.length
  ? items.map(([v, l]) => `<label class="check"><input type="checkbox" name="${name}" value="${esc(v)}" ${checked.includes(v) ? 'checked' : ''}> ${esc(l)}</label>`).join('')
  : '<span class="muted">None yet</span>';

function resetUserForm() {
  const f = $('#user-form');
  f.reset();
  f.id.value = '';
  f.username.disabled = false;
  f.password.required = true;
  f.password.placeholder = 'Password (min 8 characters)';
  $('#user-form-title').textContent = 'Add user';
  $('#user-cancel').classList.add('hidden');
  $('#user-depts').innerHTML = checkboxes('departmentIds', departments.map((d) => [d.id, d.name]));
  $('#role-help').textContent = ROLE_HELP[f.role.value];
}
$('#user-form').role.addEventListener('change', (e) => { $('#role-help').textContent = ROLE_HELP[e.target.value]; });
$('#user-cancel').addEventListener('click', resetUserForm);

async function loadUsers() {
  await loadPeople();
  const f = $('#user-form');
  if (!f.id.value && !f.contains(document.activeElement)) {
    const html = checkboxes('departmentIds', departments.map((d) => [d.id, d.name]));
    if ($('#user-depts').dataset.html !== html) { resetUserForm(); $('#user-depts').dataset.html = html; }
  }
  const users = await api('/users');
  $('#users').innerHTML = users.map((u) => `<tr>
    <td>${esc(u.name)}${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</td><td>${esc(u.username)}</td>
    <td><span class="badge role-${u.role}">${u.role}</span></td>
    <td>${u.role === 'admin' ? '<span class="muted">All</span>' : (u.departmentIds || []).map((id) => `<span class="badge dept">${esc(deptName(id))}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
    <td>${u.active ? '<span class="badge sent">active</span>' : '<span class="badge failed">disabled</span>'}</td>
    <td class="muted">${u.lastLoginAt ? fmt(u.lastLoginAt) : 'never'}</td>
    <td><button class="btn sm" data-edit="${u.id}">Edit</button>
      ${u.id !== me.id ? `<button class="btn sm" data-toggle="${u.id}" data-active="${u.active ? 1 : 0}">${u.active ? 'Disable' : 'Enable'}</button>
      <button class="btn sm danger" data-del="${u.id}">Delete</button>` : ''}</td></tr>`).join('');
  $('#users').dataset.json = JSON.stringify(users);
}

$('#users').addEventListener('click', async (e) => {
  const { edit, toggle, active, del } = e.target.dataset;
  try {
    if (edit) {
      const u = JSON.parse($('#users').dataset.json).find((x) => x.id === edit);
      const f = $('#user-form');
      f.id.value = u.id;
      f.name.value = u.name;
      f.username.value = u.username;
      f.username.disabled = true;
      f.password.value = '';
      f.password.required = false;
      f.password.placeholder = 'New password (leave blank to keep)';
      f.role.value = u.role;
      $('#role-help').textContent = ROLE_HELP[u.role];
      $('#user-depts').innerHTML = checkboxes('departmentIds', departments.map((d) => [d.id, d.name]), u.departmentIds || []);
      $('#user-form-title').textContent = `Edit ${u.name}`;
      $('#user-cancel').classList.remove('hidden');
      f.scrollIntoView({ behavior: 'smooth' });
    }
    if (toggle) await api(`/users/${toggle}`, { method: 'PATCH', body: { active: active !== '1' } });
    if (del && confirm('Delete this user? Their tickets become unassigned.')) await api(`/users/${del}`, { method: 'DELETE' });
    if (toggle || del) loadUsers();
  } catch (err) { alert(err.message); }
});

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim(), role: f.role.value,
    departmentIds: $$('#user-depts input:checked').map((x) => x.value),
  };
  if (f.password.value) body.password = f.password.value;
  try {
    if (f.id.value) await api(`/users/${f.id.value}`, { method: 'PATCH', body });
    else await api('/users', { method: 'POST', body: { ...body, username: f.username.value.trim() } });
    resetUserForm();
    loadUsers();
  } catch (err) { alert(err.message); }
});

/* ---------- Departments (admin) ---------- */
let sessionIds = [];
function resetDeptForm() {
  const f = $('#dept-form');
  f.reset();
  f.id.value = '';
  $('#dept-form-title').textContent = 'Add department';
  $('#dept-cancel').classList.add('hidden');
  $('#dept-sessions').innerHTML = checkboxes('sessionIds', sessionIds.map((s) => [s, s]));
}
$('#dept-cancel').addEventListener('click', resetDeptForm);

async function loadDepartments() {
  await loadPeople();
  if (me.role === 'admin') {
    sessionIds = (await api('/sessions')).map((s) => s.id);
    const f = $('#dept-form');
    if (!f.id.value && !f.contains(document.activeElement)) {
      const key = sessionIds.join(',');
      if ($('#dept-sessions').dataset.key !== key) { resetDeptForm(); $('#dept-sessions').dataset.key = key; }
    }
  }
  $('#departments').innerHTML = departments.map((d) => `<tr>
    <td><strong>${esc(d.name)}</strong>${d.isDefault ? ' <span class="badge">default</span>' : ''}<br><span class="muted">${esc(d.description || '')}</span></td>
    <td>${(d.sessionIds || []).map((s) => `<span class="badge">${esc(s)}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
    <td>${(d.keywords || []).map((k) => `<code>${esc(k)}</code>`).join(' ') || '<span class="muted">—</span>'}</td>
    <td>${d.members.map((m) => esc(m.name)).join(', ') || '<span class="muted">No members</span>'}</td>
    <td>${d.activeTickets}</td>
    <td>${d.autoAssign ? 'On' : 'Off'}</td>
    <td>${me.role === 'admin' ? `<button class="btn sm" data-edit="${d.id}">Edit</button> <button class="btn sm danger" data-del="${d.id}">Delete</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="7" class="muted">No departments yet</td></tr>';
}

$('#departments').addEventListener('click', async (e) => {
  const { edit, del } = e.target.dataset;
  try {
    if (edit) {
      const d = departments.find((x) => x.id === edit);
      const f = $('#dept-form');
      f.id.value = d.id;
      f.name.value = d.name;
      f.description.value = d.description || '';
      f.keywords.value = (d.keywords || []).join(', ');
      f.autoAssign.checked = !!d.autoAssign;
      f.isDefault.checked = !!d.isDefault;
      $('#dept-sessions').innerHTML = checkboxes('sessionIds', [...new Set([...sessionIds, ...(d.sessionIds || [])])].map((s) => [s, s]), d.sessionIds || []);
      $('#dept-form-title').textContent = `Edit ${d.name}`;
      $('#dept-cancel').classList.remove('hidden');
      f.scrollIntoView({ behavior: 'smooth' });
    }
    if (del && confirm('Delete this department? Its tickets will have no department.')) {
      await api(`/departments/${del}`, { method: 'DELETE' });
      loadDepartments();
    }
  } catch (err) { alert(err.message); }
});

$('#dept-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value, description: f.description.value, keywords: f.keywords.value,
    sessionIds: $$('#dept-sessions input:checked').map((x) => x.value),
    autoAssign: f.autoAssign.checked, isDefault: f.isDefault.checked,
  };
  try {
    if (f.id.value) await api(`/departments/${f.id.value}`, { method: 'PATCH', body });
    else await api('/departments', { method: 'POST', body });
    resetDeptForm();
    loadDepartments();
  } catch (err) { alert(err.message); }
});

/* ---------- Button builder (Send page + campaigns) ---------- */
const BUTTON_KINDS = {
  reply: { label: 'Quick reply', value: 'reply', hint: 'Automatic answer when tapped (optional)' },
  url: { label: 'Website link', value: 'url', hint: 'https://…' },
  call: { label: 'Call number', value: 'phone', hint: 'Phone with country code' },
  copy: { label: 'Copy code', value: 'code', hint: 'Coupon code, e.g. DIWALI30' },
};
const NUMS = ['1️⃣', '2️⃣', '3️⃣'];

function buttonBuilder(container, onChange = () => {}) {
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn sm';
  addBtn.textContent = '+ Add button';
  const rows = document.createElement('div');
  container.append(rows, addBtn);

  function addRow() {
    if (rows.children.length >= 3) return;
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.innerHTML = `
      <select class="b-type">${Object.entries(BUTTON_KINDS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
      <input class="b-title" maxlength="20" placeholder="Button text (max 20)" />
      <input class="b-value" placeholder="${BUTTON_KINDS.reply.hint}" />
      <button type="button" class="btn sm danger b-remove" title="Remove">✕</button>`;
    row.querySelector('.b-type').addEventListener('change', (e) => {
      row.querySelector('.b-value').placeholder = BUTTON_KINDS[e.target.value].hint;
      onChange();
    });
    row.querySelector('.b-remove').addEventListener('click', () => { row.remove(); sync(); });
    row.addEventListener('input', onChange);
    rows.append(row);
    sync();
  }
  function sync() {
    addBtn.classList.toggle('hidden', rows.children.length >= 3);
    onChange();
  }
  addBtn.addEventListener('click', addRow);

  return {
    get() {
      return [...rows.children].map((row) => {
        const type = row.querySelector('.b-type').value;
        const title = row.querySelector('.b-title').value.trim();
        const value = row.querySelector('.b-value').value.trim();
        return title ? { type, title, [BUTTON_KINDS[type].value]: value } : null;
      }).filter(Boolean);
    },
    clear() { rows.innerHTML = ''; sync(); },
  };
}

// Text version of the options, matching what the server appends to the message.
function textOptions(buttons) {
  const lines = [];
  const replies = buttons.filter((b) => b.type === 'reply');
  if (replies.length) { lines.push('Reply with a number:'); replies.forEach((b, i) => lines.push(`${NUMS[i]} ${b.title}`)); }
  for (const b of buttons) {
    if (b.type === 'url') lines.push(`🔗 ${b.title}: ${b.url}`);
    if (b.type === 'call') lines.push(`📞 ${b.title}: +${String(b.phone || '').replace(/\D/g, '')}`);
    if (b.type === 'copy') lines.push(`🏷️ ${b.title}: ${b.code}`);
  }
  return lines.join('\n');
}

const sendButtons = buttonBuilder($('#send-buttons'), renderSendPreview);
const campaignButtons = buttonBuilder($('#campaign-buttons'));
let previewImageUrl = null;

function renderSendPreview() {
  const f = $('#send-form');
  const buttons = sendButtons.get();
  const file = f.file.files[0];
  f.footer.classList.toggle('hidden', !buttons.length);
  const text = f.text.value + (buttons.length ? `\n\n${textOptions(buttons)}` : '');
  const icon = { reply: '↩', url: '🔗', call: '📞', copy: '📋' };
  $('#send-preview').innerHTML = !text.trim() && !file ? '<p class="muted small">Type a message to see a preview.</p>' : `
    <div class="wa-bubble">
      ${file && previewImageUrl ? `<img src="${previewImageUrl}" alt="">` : file ? `<div class="wa-file">📎 ${esc(file.name)}</div>` : ''}
      ${text.trim() ? `<div class="wa-text">${esc(text)}</div>` : ''}
      ${buttons.length && f.footer.value ? `<div class="wa-footer">${esc(f.footer.value)}</div>` : ''}
    </div>
    ${buttons.map((b) => `<div class="wa-button">${icon[b.type]} ${esc(b.title)}</div>`).join('')}`;
}
$('#send-form').addEventListener('input', renderSendPreview);
$('#send-form').file.addEventListener('change', (e) => {
  if (previewImageUrl) URL.revokeObjectURL(previewImageUrl);
  const file = e.target.files[0];
  previewImageUrl = file?.type.startsWith('image/') ? URL.createObjectURL(file) : null;
  renderSendPreview();
});
renderSendPreview();

/* ---------- Contact picker for the "To" field ---------- */
const toInput = $('#send-form').to;
const toList = $('#to-suggestions');
let toMatches = [];
let toActive = -1;
let toTimer;

function showSelectedContact(c) {
  $('#to-selected').innerHTML = c
    ? `✓ ${esc(c.name || 'Saved contact')}${c.tags?.length ? ` · ${c.tags.map(esc).join(', ')}` : ''}${c.optedOut ? ' · <span class="error">opted out</span>' : ''}`
    : '';
}
function closeSuggestions() {
  toList.classList.add('hidden');
  toInput.setAttribute('aria-expanded', 'false');
  toActive = -1;
}
function renderSuggestions() {
  toList.innerHTML = toMatches.length
    ? toMatches.map((c, i) => `
      <li role="option" data-i="${i}" class="${i === toActive ? 'active' : ''} ${c.optedOut ? 'disabled' : ''}" aria-selected="${i === toActive}">
        <span><strong>${esc(c.name || '+' + c.phone)}</strong>${c.name ? ` <span class="muted">+${esc(c.phone)}</span>` : ''}</span>
        <span class="tags">${c.optedOut ? '<span class="badge opted">opted out</span>' : ''}${(c.tags || []).slice(0, 3).map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</span>
      </li>`).join('')
    : '<li class="empty">No saved contacts match. You can still send to a typed number.</li>';
  toList.classList.remove('hidden');
  toInput.setAttribute('aria-expanded', 'true');
  toList.querySelector('li.active')?.scrollIntoView({ block: 'nearest' });
}
async function searchContacts() {
  const q = toInput.value.trim();
  const list = await api(`/contacts?limit=30${q ? `&q=${encodeURIComponent(q)}` : ''}`).catch(() => []);
  if (toInput.value.trim() !== q) return; // a newer search is on its way
  // active contacts first, then by name, unnamed last
  toMatches = list.sort((a, b) => (!!a.optedOut - !!b.optedOut) || (!a.name - !b.name) ||
    (a.name || a.phone).localeCompare(b.name || b.phone));
  toActive = -1;
  const digits = q.replace(/\D/g, '');
  showSelectedContact(digits && list.find((c) => c.phone === digits));
  if (document.activeElement === toInput) renderSuggestions();
}
function pickContact(i) {
  const c = toMatches[i];
  if (!c || c.optedOut) return;
  toInput.value = c.phone;
  showSelectedContact(c);
  closeSuggestions();
}

toInput.addEventListener('focus', searchContacts);
toInput.addEventListener('input', () => {
  showSelectedContact(null);
  clearTimeout(toTimer);
  toTimer = setTimeout(searchContacts, 200);
});
toInput.addEventListener('blur', () => setTimeout(closeSuggestions, 150));
toInput.addEventListener('keydown', (e) => {
  const open = !toList.classList.contains('hidden');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) return searchContacts();
    if (!toMatches.length) return;
    toActive = (toActive + (e.key === 'ArrowDown' ? 1 : -1) + toMatches.length) % toMatches.length;
    renderSuggestions();
  } else if (e.key === 'Enter' && open && toActive >= 0) {
    e.preventDefault(); // pick the contact instead of submitting the form
    pickContact(toActive);
  } else if (e.key === 'Escape' && open) {
    e.preventDefault();
    closeSuggestions();
  }
});
// mousedown (not click) so the input doesn't lose focus first
toList.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  e.preventDefault();
  if (li) pickContact(Number(li.dataset.i));
});

/* ---------- Send ---------- */
$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, out = $('#send-result');
  out.textContent = 'Sending…';
  try {
    const file = f.file.files[0];
    const buttons = sendButtons.get();
    if (buttons.length) {
      if (!f.text.value.trim()) throw new Error('A message is required when sending buttons');
      if (file && !file.type.startsWith('image/')) throw new Error('With buttons, the attachment must be an image');
      const fd = new FormData();
      fd.append('sessionId', f.sessionId.value); fd.append('to', f.to.value); fd.append('text', f.text.value);
      fd.append('footer', f.footer.value); fd.append('buttons', JSON.stringify(buttons));
      if (file) fd.append('image', file);
      await api('/messages/buttons', { method: 'POST', form: fd });
    } else if (file) {
      const fd = new FormData();
      fd.append('sessionId', f.sessionId.value); fd.append('to', f.to.value); fd.append('caption', f.text.value); fd.append('file', file);
      await api('/messages/media', { method: 'POST', form: fd });
    } else {
      if (!f.text.value.trim()) throw new Error('Enter a message or attach a file');
      await api('/messages/text', { method: 'POST', body: { sessionId: f.sessionId.value, to: f.to.value, text: f.text.value } });
    }
    out.innerHTML = '<span class="badge sent">Sent</span>';
    f.text.value = ''; f.file.value = ''; f.footer.value = '';
    sendButtons.clear();
    previewImageUrl = null;
    renderSendPreview();
  } catch (err) { out.innerHTML = `<span class="error">${esc(err.message)}</span>`; }
});

/* ---------- Contacts ---------- */
$('#contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/contacts', { method: 'POST', body: { phone: f.phone.value, name: f.name.value, tags: f.tags.value.split(',') } });
    f.reset(); loadContacts();
  } catch (err) { alert(err.message); }
});
$('#import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/contacts/import', { method: 'POST', form: new FormData(e.target) });
    $('#import-result').textContent = `Imported ${r.imported}, skipped ${r.skipped}`;
    e.target.reset(); loadContacts();
  } catch (err) { $('#import-result').textContent = err.message; }
});
let searchTimer;
$('#contact-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadContacts, 250); });
async function loadContacts() {
  const q = $('#contact-search').value.trim();
  const list = await api(`/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('#contacts').innerHTML = list.slice(0, 500).map((c) => `
    <tr><td>+${esc(c.phone)}</td><td>${esc(c.name)}</td><td>${(c.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join(' ')}</td>
    <td>${c.optedOut ? '<span class="badge opted">opted out</span>' : '<span class="badge sent">active</span>'}</td>
    <td><button class="btn sm" data-toggle="${c.id}" data-opt="${c.optedOut ? 1 : 0}">${c.optedOut ? 'Re-subscribe' : 'Opt out'}</button>
        <button class="btn sm danger" data-del="${c.id}">Delete</button></td></tr>`).join('') ||
    '<tr><td colspan="5" class="muted">No contacts</td></tr>';
}
$('#contacts').addEventListener('click', async (e) => {
  const { toggle, opt, del } = e.target.dataset;
  if (toggle) await api(`/contacts/${toggle}`, { method: 'PATCH', body: { optedOut: opt !== '1' } });
  if (del && confirm('Delete contact?')) await api(`/contacts/${del}`, { method: 'DELETE' });
  loadContacts();
});

/* ---------- Campaigns ---------- */
$('#campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const c = await api('/campaigns', { method: 'POST', body: {
      name: f.name.value, sessionId: f.sessionId.value, tags: f.tags.value, message: f.message.value,
      mediaUrl: f.mediaUrl.value || null, startNow: f.startNow.checked,
      buttons: campaignButtons.get(), footer: f.footer.value,
    } });
    alert(`Campaign created for ${c.stats.total} recipients`);
    f.reset(); campaignButtons.clear(); loadCampaigns();
  } catch (err) { alert(err.message); }
});
async function loadCampaigns() {
  const list = await api('/campaigns');
  $('#campaigns').innerHTML = list.map((c) => {
    const done = c.stats.sent + c.stats.failed + c.stats.skipped;
    const pct = c.stats.total ? Math.round((done / c.stats.total) * 100) : 0;
    return `<tr><td>${esc(c.name)}<br><span class="muted">${fmt(c.createdAt)}</span></td><td>${esc(c.sessionId)}</td>
      <td><span class="badge ${esc(c.status)}">${esc(CAMPAIGN_STATUS[c.status] || c.status)}</span>
        ${c.pauseReason ? `<div class="pause-reason">${esc(c.pauseReason)}</div>` : ''}</td>
      <td>${c.stats.sent} sent · ${c.stats.failed} failed · ${c.stats.skipped} skipped / ${c.stats.total}
        <div class="progress"><div style="width:${pct}%"></div></div></td>
      <td>${c.status === 'running' || c.status === 'waiting_quiet'
        ? `<button class="btn sm" data-pause="${c.id}">Pause</button>`
        : c.status !== 'completed' ? `<button class="btn sm" data-start="${c.id}">${c.status === 'draft' ? 'Start' : 'Resume'}</button>` : ''}
        <button class="btn sm danger" data-del="${c.id}">Delete</button></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="muted">No campaigns</td></tr>';
}
$('#campaigns').addEventListener('click', async (e) => {
  const { start, pause, del } = e.target.dataset;
  try {
    if (start) await api(`/campaigns/${start}/start`, { method: 'POST' });
    if (pause) await api(`/campaigns/${pause}/pause`, { method: 'POST' });
    if (del && confirm('Delete campaign?')) await api(`/campaigns/${del}`, { method: 'DELETE' });
    loadCampaigns();
  } catch (err) { alert(err.message); }
});

/* ---------- Logs ---------- */
// Keep a <select>'s options in sync without losing the current choice.
function fillSelect(sel, firstLabel, items) {
  const html = `<option value="">${firstLabel}</option>` +
    items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  if (sel.dataset.html === html) return;
  const cur = sel.value;
  sel.innerHTML = html;
  sel.dataset.html = html;
  sel.value = cur;
}

function logQuery() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData($('#log-filters'))) {
    if (!v) continue;
    // date inputs are local days; send exact start/end instants
    if (k === 'from') p.set(k, new Date(`${v}T00:00:00`).toISOString());
    else if (k === 'to') p.set(k, new Date(`${v}T23:59:59.999`).toISOString());
    else p.set(k, v);
  }
  return p.toString();
}

async function loadLogs() {
  const f = $('#log-filters');
  const [sessions, campaigns] = await Promise.all([api('/sessions'), api('/campaigns')]);
  fillSelect(f.sessionId, 'All numbers', sessions.map((s) => [s.id, s.id]));
  fillSelect(f.campaignId, 'All messages', campaigns.map((c) => [c.id, `Campaign: ${c.name}`]));

  const { total, messages: list } = await api(`/messages?${logQuery()}`);
  $('#log-count').textContent = `${list.length} of ${total} shown`;
  $('#logs').innerHTML = list.map((m) => `<tr><td>${fmt(m.createdAt)}</td><td>${esc(m.sessionId)}</td>
    <td>${m.direction === 'in' ? '⬅ in' : 'out ➡'}</td><td>+${esc(m.to)}</td><td class="msg">${esc(m.text)}</td>
    <td><span class="badge ${esc(m.status)}">${esc(m.status)}</span>${m.error ? `<br><span class="muted">${esc(m.error)}</span>` : ''}</td></tr>`).join('') ||
    '<tr><td colspan="6" class="muted">No messages match these filters</td></tr>';
}
let logTimer;
$('#log-filters').addEventListener('input', () => { clearTimeout(logTimer); logTimer = setTimeout(loadLogs, 250); });
$('#log-filters').addEventListener('submit', (e) => e.preventDefault());
$('#log-reset').addEventListener('click', () => { $('#log-filters').reset(); loadLogs(); });

/* ---------- API keys ---------- */
$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const k = await api('/keys', { method: 'POST', body: { name: e.target.name.value } });
  e.target.reset();
  const box = $('#new-key');
  box.classList.remove('hidden');
  box.innerHTML = `<strong>New key — copy it now, it won't be shown again:</strong><pre>${esc(k.key)}</pre>`;
  loadKeys();
});
async function loadKeys() {
  const list = await api('/keys');
  $('#keys').innerHTML = list.map((k) => `<tr><td>${esc(k.name)}</td><td><code>${esc(k.key)}</code></td><td>${fmt(k.createdAt)}</td>
    <td><button class="btn sm danger" data-del="${k.id}">Revoke</button></td></tr>`).join('') ||
    '<tr><td colspan="4" class="muted">No API keys</td></tr>';
}
$('#keys').addEventListener('click', async (e) => {
  if (e.target.dataset.del && confirm('Revoke this key?')) { await api(`/keys/${e.target.dataset.del}`, { method: 'DELETE' }); loadKeys(); }
});

/* ---------- Docs ---------- */
function renderDocs() {
  $('#base-url').textContent = `${location.origin}/api`;
  $('#curl-example').textContent =
`curl -X POST ${location.origin}/api/messages/text \\
  -H "x-api-key: wak_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"sessionId":"sales-1","to":"919876543210","text":"Hello from API"}'`;
}

/* ---------- Boot ---------- */
if (token) showApp(); else showLogin();
