# WA Marketing

Multi-tenant (SaaS) WhatsApp marketing platform with its own REST API. Numbers are linked by scanning
a WhatsApp Web QR code (no Meta Business API account needed). Built on Node.js, Express and
[Baileys](https://github.com/WhiskeySockets/Baileys). Deployment: see [DEPLOY.md](DEPLOY.md).

## SaaS

| URL | Who | What |
|---|---|---|
| `/` | visitors | Landing page with live pricing |
| `/signup` | new customers | Creates a workspace with a free trial |
| `/app` | customers | Their dashboard (everything below), incl. **Subscription** page |
| `/admin` | you | Super admin: customers, plan requests, payments, plans, settings, activity log |

- **MySQL storage**: all data and WhatsApp logins are stored in MySQL/MariaDB when `DB_NAME` is set
  (tables are created automatically). Without a database, JSON files under `STORAGE_DIR` are used
  (handy for local development). See `src/storage.js` and `src/mysql.js`.
- **Suite Hub (optional)**: `AUTH_MODE=hub` switches to "Sign in with your account" (OIDC) and takes plans,
  limits and members from the Suite Hub (`src/hub.js`, see DEPLOY.md).
- **Isolated workspaces**: every row carries its workspace id (`tenant_id`); every request runs
  inside its workspace (`src/store.js`), so one customer can never read another's data.
- **Plans & limits**: WhatsApp numbers, users, contacts, messages per month, chatbot flows (`src/platform.js`).
  Expired trials/subscriptions can log in and read, but sending, campaigns and chatbots pause.
- **Manual billing**: customers request a plan and pay by UPI/bank; you record the payment in `/admin`,
  which activates/extends their plan. A grace period applies after the paid period ends.
- **Support**: "Log in as customer" from `/admin` (recorded in the activity log).

## Features

- **Multiple WhatsApp numbers**: link each one by QR, auto-reconnect, sessions survive restarts
- **Own REST API** with API keys (`x-api-key`) for CRMs, websites, ERPs
- **Send** text, images, videos, documents (by URL or upload)
- **Image + button messages** (quick reply, website link, call, copy code) from the dashboard, API and
  campaigns, with optional automatic answers per button. Buttons are unofficial over WhatsApp Web and
  may not show on every phone, so options are also sent as text and a typed number counts as a tap
  (`src/buttons.js`)
- **Contacts** with tags, CSV import, opt-out tracking
- **Campaigns**: bulk sends by tag or phone list, `{{name}}` personalisation, `{Hi|Hello}` spintax,
  random delays, daily per-number cap, pause/resume, skips numbers not on WhatsApp
- **Support tickets**: every incoming WhatsApp message opens or continues a ticket; agents reply from
  the dashboard (text or files), add internal notes, set status/priority/assignee; auto-acknowledge and
  resolved messages; customer replies reopen resolved tickets (`src/tickets.js`)
- **Multi-user with departments**: admin / manager / agent roles; departments (Sales, Support…) get
  tickets by WhatsApp number or keywords, with optional auto-assign to the least busy member and
  transfers between departments. Agents only see their own departments' tickets.
- **Chatbot flow builder**: drag-and-drop canvas to build automated conversations (messages, menus/
  buttons, questions with validation, conditions, actions, waits, hand-over to a department, end),
  triggered by keyword / first message / any message. Answers are saved on the contact, hand-over
  creates a ticket with everything collected, and a built-in test chat runs the flow without sending
  anything. Templates: welcome menu, lead capture, feedback survey (`src/flows.js`)
- **Block Risk screen** (admin): a 0–100 risk score per number from reply rate, opt-outs, invalid
  numbers, volume vs number age, cold messaging, identical text, speed, logouts, night sending and
  links, with a fix for each. Protection settings that campaigns obey: delays, daily limit, warm-up
  for young numbers, quiet hours and auto-pause on failure/opt-out spikes (`src/health.js`, `src/settings.js`)
- **Auto opt-out**: replies of `STOP` / `UNSUBSCRIBE` mark the contact opted out
- **Webhooks** for incoming and sent messages, tickets, chatbot actions, connection events, opt-outs and campaigns.
  Signed (`X-Suite-Signature: v1=<hex HMAC-SHA256(secret, "<X-Suite-Timestamp>.<raw body>")>`, secret on the
  Subscription page), stored in an outbox and retried after 1 m, 5 m, 30 m, 2 h and 12 h. Delivery is at-least-once:
  dedupe by the event `id` / `X-Suite-Event-Id` header.
- **Dashboard**: stats, QR linking, send, contacts, campaigns, logs, API keys, API docs

## Quick start

```bash
npm install
cp .env.example .env      # then set ADMIN_PASSWORD
npm start
```

Open http://localhost:3000, sign in, go to **WhatsApp Numbers**, add a session (e.g. `sales-1`)
and scan the QR from your phone: WhatsApp → Settings → Linked devices → Link a device.

Then create an API key under **API Keys**. Full endpoint list is in the **API Docs** tab.

```bash
curl -X POST http://localhost:3000/api/messages/text \
  -H "x-api-key: wak_..." -H "Content-Type: application/json" \
  -d '{"sessionId":"sales-1","to":"919876543210","text":"Hello from API"}'
```

## Project layout

```
server.js            Express app, startup
src/whatsapp.js      QR login, sessions, send, incoming messages, opt-out
src/campaigns.js     Bulk campaign runner (throttling, templates, daily limit)
src/routes.js        REST API
src/auth.js          Users, logins, roles, API keys
src/departments.js   Ticket routing, auto-assign, ticket visibility
src/tickets.js       Support tickets
src/store.js         Per-workspace data (in memory, saved via storage.js)
src/platform.js      Platform data: workspaces, plans, payments, super admins
src/storage.js       Storage backend: MySQL (src/mysql.js) or JSON files
src/webhook.js       Outgoing webhooks (signed, outbox + retries)
public/              Dashboard (HTML/CSS/JS)
sessions/            WhatsApp logins when running without MySQL (keep private, never commit)
```

## Important: account safety and compliance

This uses the **unofficial** WhatsApp Web protocol. WhatsApp's Terms of Service do not allow
automated or bulk messaging from unofficial clients, and numbers that send unsolicited bulk messages
get **banned**. To reduce risk:

- Message only people who **opted in**, and always include "Reply STOP to unsubscribe".
- Keep the default delays (8–20 s) and daily cap; warm up new numbers slowly (e.g. 20–50/day).
- Use aged numbers with normal chat history, and personalise messages so they're not identical.
- Watch for low reply rates or blocks; that's what triggers bans.

For high volume or guaranteed delivery, use the official **WhatsApp Business Platform (Cloud API)**.
The API layer here is designed so you can swap `src/whatsapp.js` for a Cloud API implementation later
without changing your integrations.

Follow your local marketing and privacy laws (e.g. India's DPDP Act and TRAI rules, GDPR in the EU).

## Production notes

- Put it behind HTTPS (nginx / Caddy) and set a strong `ADMIN_PASSWORD`.
- Run with a process manager: `npm i -g pm2 && pm2 start server.js --name wa-marketing`.
- Use MySQL in production (`DB_*` variables) and back up the database; the `wa_auth` table holds the
  WhatsApp logins, losing it means re-scanning QR codes. (Without MySQL: back up `data/` and `sessions/`.)
- Run a single instance of the app: data is kept in memory and written to MySQL in the background.
