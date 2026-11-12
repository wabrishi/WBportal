// Suite Hub settings (see LeadManager/docs/HUB-INTEGRATION.md).
//   AUTH_MODE=local (default)  own logins, signup, plans and billing (standalone product)
//   AUTH_MODE=hub              "Sign in with Hub" (OIDC), subscriptions/limits from the Hub's entitlement
export const hubMode = () => process.env.AUTH_MODE === 'hub';
export const hubUrl = () => String(process.env.HUB_URL || '').replace(/\/+$/, '');
export const hubHome = () => `${hubUrl()}/home`;

// Hub role -> WBportal role
export const HUB_ROLE = { OWNER: 'admin', MANAGER: 'manager', MEMBER: 'agent' };

// Checked at startup so a misconfigured hub deployment fails loudly instead of locking everyone out quietly.
export function checkHubConfig() {
  if (!hubMode()) return;
  const missing = ['HUB_URL', 'HUB_CLIENT_ID', 'HUB_CLIENT_SECRET', 'SUITE_EVENTS_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`AUTH_MODE=hub needs ${missing.join(', ')}`);
}
