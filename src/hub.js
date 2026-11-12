// Suite Hub integration (AUTH_MODE=hub), per LeadManager/docs/HUB-INTEGRATION.md:
//   GET  /auth/hub/login      start "Sign in with Hub" (OIDC authorization code + PKCE)
//   GET  /auth/hub/callback   finish it: exchange the code, read /userinfo, sync workspace + user, start a session
//   POST /api/suite/events    signed events from the Hub (subscription, workspace, member changes)
// The Hub owns users, workspaces and subscriptions; this app keeps a local mirror refreshed on every
// sign-in and by events, and keeps its own sessions (the same tokens as local logins).
import crypto from 'node:crypto';
import { db, save, uid, now, runAsTenant } from './store.js';
import {
  platform, savePlatform, findTenant, tenantStatus, ensureHubTenant, tenantForHubWorkspace, audit,
} from './platform.js';
import { issueToken, revokeUserTokens } from './auth.js';
import { stopTenantSessions, restoreTenantSessions } from './whatsapp.js';
import { hubMode, hubUrl, hubHome, HUB_ROLE } from './suite.js';

const COOKIE = 'wa_hub_oidc';
const MODULE = 'wa';
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

/* ---------- OIDC discovery (cached) ---------- */
let discovery = null;
let discoveredAt = 0;
async function oidc() {
  if (discovery && Date.now() - discoveredAt < 3600e3) return discovery;
  const res = await fetch(`${hubUrl()}/api/auth/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Hub discovery failed: HTTP ${res.status}`);
  discovery = await res.json();
  discoveredAt = Date.now();
  return discovery;
}

// Must match the redirect URI registered at the Hub: https://wa.<domain>/auth/hub/callback
const redirectUri = (req) => `${String(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}/auth/hub/callback`;

/* ---------- short-lived signed cookie holding state, nonce and the PKCE verifier ---------- */
const sign = (v) => crypto.createHmac('sha256', process.env.HUB_CLIENT_SECRET).update(v).digest('base64url');
function setFlowCookie(req, res, data) {
  const v = b64url(JSON.stringify(data));
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${v}.${sign(v)}; Path=/auth/hub; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
}
function readFlowCookie(req, res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/auth/hub; HttpOnly; SameSite=Lax; Max-Age=0`); // one use only
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [v, sig] = raw.split('.');
  if (!v || !sig || sig.length !== sign(v).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(v)))) return null;
  try { return JSON.parse(Buffer.from(v, 'base64url').toString()); } catch { return null; }
}

function page(res, status, title, html) {
  res.status(status).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/style.css"></head>
<body><section class="login"><div class="card login-card"><h1>${esc(title)}</h1>${html}</div></section></body></html>`);
}

/* ---------- 1. sign-in ---------- */
export async function hubLogin(req, res) {
  if (!hubMode()) return res.redirect('/app');
  try {
    const d = await oidc();
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    setFlowCookie(req, res, { state, nonce, verifier, at: Date.now() });
    const q = new URLSearchParams({
      response_type: 'code', client_id: process.env.HUB_CLIENT_ID, redirect_uri: redirectUri(req),
      scope: 'openid profile email suite', state, nonce,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    });
    res.redirect(`${d.authorization_endpoint}?${q}`);
  } catch (e) {
    console.error('Hub login:', e.message);
    page(res, 502, 'Sign-in unavailable', `<p class="muted">We couldn't reach your account service. Please try again in a minute.</p>
      <p><a class="btn primary" href="/auth/hub/login">Try again</a></p>`);
  }
}

export async function hubCallback(req, res) {
  if (!hubMode()) return res.redirect('/app');
  const retry = `<p><a class="btn primary" href="/auth/hub/login">Sign in again</a> <a class="btn" href="${esc(hubHome())}">Your account</a></p>`;
  const flow = readFlowCookie(req, res);
  if (req.query.error) {
    return page(res, 400, 'Sign-in cancelled', `<p class="muted">${esc(req.query.error_description || req.query.error)}</p>${retry}`);
  }
  if (!flow || Date.now() - flow.at > 600e3 || !req.query.state || req.query.state !== flow.state || !req.query.code) {
    return page(res, 400, 'Sign-in expired', `<p class="muted">This sign-in link is no longer valid. Please start again.</p>${retry}`);
  }
  try {
    const d = await oidc();
    const tokenRes = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri(req),
        client_id: process.env.HUB_CLIENT_ID, client_secret: process.env.HUB_CLIENT_SECRET, code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokens.access_token) throw new Error(`token exchange failed: HTTP ${tokenRes.status} ${tokens.error || ''}`);
    if (tokens.id_token) checkIdToken(tokens.id_token, d, flow.nonce);

    const infoRes = await fetch(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10000) });
    if (!infoRes.ok) throw new Error(`userinfo failed: HTTP ${infoRes.status}`);
    const claims = await infoRes.json();

    const result = syncFromClaims(claims);
    if (result.problem) return page(res, 403, result.problem.title, `<p class="muted">${esc(result.problem.text)}</p>
      <p><a class="btn primary" href="${esc(hubHome())}">Go to your account</a></p>`);
    const token = runAsTenant(result.tenantId, () => issueToken(result.tenantId, result.userId));
    res.redirect(`/app#token=${encodeURIComponent(token)}`); // the dashboard stores it (same as signup)
  } catch (e) {
    console.error('Hub callback:', e.message);
    page(res, 502, 'Sign-in failed', `<p class="muted">Something went wrong while signing you in. Please try again.</p>${retry}`);
  }
}

// The ID token comes straight from the token endpoint over TLS, so its signature isn't re-verified;
// we still check that it was issued to us, by our Hub, for this sign-in.
function checkIdToken(idToken, d, nonce) {
  let p;
  try { p = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString()); } catch { throw new Error('bad id_token'); }
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!aud.includes(process.env.HUB_CLIENT_ID)) throw new Error('id_token audience mismatch');
  if (d.issuer && p.iss && p.iss !== d.issuer) throw new Error('id_token issuer mismatch');
  if (p.nonce !== undefined && p.nonce !== nonce) throw new Error('id_token nonce mismatch');
  if (p.exp && p.exp * 1000 < Date.now() - 60e3) throw new Error('id_token expired');
}

/* ---------- 2. claims -> local workspace + user ---------- */
// Returns { tenantId, userId } or { problem: { title, text } }.
export function syncFromClaims(c) {
  const email = String(c.email || '').trim().toLowerCase();
  if (!email) return { problem: { title: 'No email', text: 'Your account has no email address.' } };
  if (!c.ws) return { problem: { title: 'No workspace yet', text: 'Create or join a workspace in your account first.' } };
  const ent = c.modules?.[MODULE];
  if (!ent) {
    return { problem: { title: 'WhatsApp Marketing is not enabled',
      text: `Your workspace "${c.ws_name || ''}" doesn't have WhatsApp Marketing. Start a trial or choose a plan in your account.` } };
  }
  const tenantId = c.tenants?.[MODULE] || c.ws;
  const t = ensureHubTenant({ id: tenantId, name: c.ws_name, ownerEmail: email, hubWorkspaceId: c.ws });
  const before = tenantStatus(t).canUse;
  t.hubEntitlement = ent;
  t.hubSuspended = false; // the Hub only puts ACTIVE workspaces in the claims
  platform.userIndex[email] = t.id;
  savePlatform();
  const userId = runAsTenant(t.id, () => upsertMember({ email, name: c.name, role: c.role, hubUserId: c.sub }, true).id);
  afterAccessChange(t, before);
  return { tenantId: t.id, userId };
}

// Creates or updates the local user for a Hub member (matched by email). Inside the tenant context.
function upsertMember({ email, name, role, hubUserId }, signIn = false) {
  const login = String(email).trim().toLowerCase();
  const localRole = HUB_ROLE[role] || 'agent';
  let u = db.users.find((x) => x.username === login || x.email === login);
  if (u) {
    Object.assign(u, { name: String(name || u.name).trim() || u.name, role: localRole, active: true });
  } else {
    u = {
      id: uid(), username: login, email: login, name: String(name || login).trim(), role: localRole, departmentIds: [],
      active: true, passwordHash: '', createdAt: now(), // no local password: sign-in is through the Hub
    };
    db.users.push(u);
  }
  if (hubUserId) u.hubUserId = hubUserId;
  if (signIn) u.lastLoginAt = now();
  save();
  return u;
}

// Connect / disconnect the workspace's WhatsApp numbers when access starts or ends.
function afterAccessChange(t, before) {
  const after = tenantStatus(t).canUse;
  if (before && !after) stopTenantSessions(t.id);
  if (!before && after) restoreTenantSessions(t.id).catch(() => {});
}

/* ---------- 3. events from the Hub ---------- */
const MAX_AGE_S = 300;
function verifyEvent(req) {
  const secret = process.env.SUITE_EVENTS_SECRET;
  if (!secret) throw fail('Not configured', 404);
  const ts = Number(req.get('x-suite-timestamp'));
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_AGE_S) throw fail('Stale or missing timestamp', 401);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const expected = 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
  const given = String(req.get('x-suite-signature') || '');
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw fail('Bad signature', 401);
  return JSON.parse(raw.toString('utf8'));
}

export async function hubEvents(req, res) {
  let ev;
  try { ev = verifyEvent(req); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (!ev?.id || !ev.type) return res.status(400).json({ error: 'id and type are required' });
  if (platform.suiteInbox.some((x) => x.id === ev.id)) return res.json({ ok: true, duplicate: true });
  try {
    const result = applyEvent(ev);
    platform.suiteInbox.push({ id: ev.id, type: ev.type, at: now() });
    const cutoff = Date.now() - 30 * 864e5; // ids are kept 30 days (the Hub gives up after ~15 h)
    platform.suiteInbox = platform.suiteInbox.filter((x) => new Date(x.at).getTime() > cutoff).slice(-20000);
    savePlatform();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(`Hub event ${ev.type} ${ev.id}:`, e.message);
    res.status(500).json({ error: e.message }); // the Hub retries
  }
}

function applyEvent(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'subscription.updated': {
      if (d.module !== MODULE) return { ignored: true };
      const id = d.tenantId || ev.workspaceId;
      let t = findTenant(id) || tenantForHubWorkspace(ev.workspaceId);
      if (!t && !d.entitlement) return { ignored: true };
      t ||= ensureHubTenant({ id, name: d.workspace?.name, hubWorkspaceId: ev.workspaceId });
      const before = tenantStatus(t).canUse;
      t.hubWorkspaceId = ev.workspaceId;
      t.hubEntitlement = d.entitlement || null;
      if (d.workspace?.name) t.name = String(d.workspace.name).slice(0, 80);
      if (d.workspace?.status) t.hubSuspended = d.workspace.status === 'SUSPENDED';
      savePlatform();
      audit('hub', 'tenant.subscription_updated', { tenantId: t.id, plan: d.entitlement?.plan || null, status: d.entitlement?.status || null });
      afterAccessChange(t, before);
      return { tenantId: t.id };
    }
    case 'workspace.created':
    case 'workspace.updated':
    case 'workspace.suspended': {
      const t = tenantForHubWorkspace(ev.workspaceId);
      if (!t) return { ignored: true }; // created here on first sign-in / subscription
      const before = tenantStatus(t).canUse;
      if (d.name) t.name = String(d.name).slice(0, 80);
      t.hubSuspended = ev.type === 'workspace.suspended' || d.status === 'SUSPENDED';
      savePlatform();
      if (t.hubSuspended) {
        stopTenantSessions(t.id);
        runAsTenant(t.id, () => { db.authTokens = []; save(); }); // ends everyone's sessions
      } else afterAccessChange(t, before);
      return { tenantId: t.id };
    }
    case 'member.added':
    case 'member.updated':
    case 'member.removed': {
      const t = tenantForHubWorkspace(ev.workspaceId);
      if (!t || !d.email) return { ignored: true };
      const email = String(d.email).trim().toLowerCase();
      runAsTenant(t.id, () => {
        if (ev.type === 'member.removed') {
          const u = db.users.find((x) => x.username === email || x.email === email);
          if (u) { u.active = false; revokeUserTokens(u.id); save(); }
        } else {
          upsertMember({ email, name: d.name, role: d.role, hubUserId: d.userId });
        }
      });
      if (ev.type !== 'member.removed') { platform.userIndex[email] = t.id; savePlatform(); }
      return { tenantId: t.id };
    }
    default:
      return { ignored: true };
  }
}
