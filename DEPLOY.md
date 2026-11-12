# Deploying on Hostinger

There are three ways. Pick one:

| | **A. VPS + one-command installer** | **B. VPS + Docker Manager** | **C. Web hosting (Business / Cloud)** |
|---|---|---|---|
| Effort | Upload + 1 command | Point-and-click in hPanel | Point-and-click in hPanel |
| WhatsApp numbers stay connected 24/7 | ✅ | ✅ | ⚠️ Not guaranteed (see below) |
| Capacity (our estimate, ~50 MB per number) | KVM 2: ~100 numbers | KVM 2: ~100 numbers | a handful |
| HTTPS | automatic (Let's Encrypt) | via Traefik template | automatic (hPanel) |
| Storage | files (or MySQL) | files (or MySQL) | **MySQL** (hPanel database) |
| Backups | daily, automatic | Docker volume + VPS snapshots | hPanel database backups |
| Recommended for paying customers | ✅ **Yes** | ✅ Yes | ❌ Demo / testing only |

**Why not web hosting for production?** This app keeps a live connection to WhatsApp open for every
customer's number and runs campaigns and chatbot timers in the background. Hostinger's Node.js web
hosting "doesn't support … always-running background workers", and "queue workers, bots and endless
timers stop when the app is deployed or restarted"
([Hostinger Node.js limits](https://www.hostinger.com/support/hostinger-node-js-limits-for-web-and-cloud-plans/)).
Option C works, but numbers can disconnect whenever Hostinger restarts or idles the app.

---

## A. VPS + one-command installer (recommended)

1. Buy a **Hostinger KVM VPS** (KVM 2 is a good start) with **Ubuntu 24.04**.
2. In your domain's DNS, add an **A record** pointing to the VPS IP (e.g. `app.yourbrand.com`).
3. Upload the project to the VPS. Easiest: on your PC run `npm run package`, then upload
   `deploy/wa-saas-2.0.0.zip` with hPanel → VPS → **Browser terminal**/SFTP, or `scp`:
   ```bash
   scp deploy/wa-saas-2.0.0.zip root@YOUR-VPS-IP:/root/
   ```
4. Connect (hPanel → VPS → **Browser terminal**, or `ssh root@YOUR-VPS-IP`) and run:
   ```bash
   apt-get install -y unzip && mkdir -p /root/wa && cd /root/wa && unzip -o /root/wa-saas-2.0.0.zip
   sudo bash scripts/install-vps.sh app.yourbrand.com you@email.com
   ```
   The installer sets up Node.js 22, the app as an always-on service (pm2), nginx, free HTTPS,
   firewall and daily backups. At the end it prints your links and a **setup key**.
5. Open `https://app.yourbrand.com/admin`, enter the setup key and create your super admin account.
   Then continue with [After deploying](#after-deploying).

**Update to a new version:** upload and unzip the new package into `/root/wa` (as in step 4), then
`sudo bash scripts/install-vps.sh --update`. Your data in `/home/wa/storage` is never touched.

---

## B. VPS + Docker Manager

1. VPS with the **Docker** template (Ubuntu 24.04 with Docker preinstalled).
2. Put the project on GitHub. The included workflow `.github/workflows/docker-publish.yml` builds the
   image on every push to `main` and publishes it as `ghcr.io/<github-user>/<repo>:latest`.
   First time only: GitHub → your profile → **Packages** → the package → **Package settings** →
   **Change visibility → Public** (or log in to ghcr.io on the VPS).
3. hPanel → VPS → **Docker Manager** → **Compose** → **One Click Deploy** → **Traefik**
   (gives free HTTPS for your domain). Point your domain's A record to the VPS IP.
4. **Compose** → **Compose manually** → paste `docker-compose.yml` from this project, change the three
   lines marked `<-- CHANGE` (image name, a random `SETUP_KEY`, your domain) → **Deploy**.
5. Open `https://yourdomain.com/admin`, enter the setup key, create your account.

Data lives in the Docker volume `wa-storage` and survives updates. **Update:** push to GitHub, wait for
the workflow, then redeploy/pull the project in Docker Manager.
Backup (the volume is named `<project name>_wa-storage`; check with `docker volume ls`):
`docker run --rm -v <project>_wa-storage:/s -v /root/backups:/b alpine tar czf /b/wa-$(date +%F).tgz -C /s .`

---

## C. Web hosting (Business / Cloud) with MySQL

1. **Create the database**: hPanel → **Websites** → your site → **Databases** → **MySQL Databases**.
   Create a database and a user (e.g. `u123456789_wa` / `u123456789_wa`) with a strong password.
   Note the **database name**, **user**, **password** and **host** shown in the list (usually `localhost`).
   You don't need to create any tables: the app creates them on first start.
2. On your PC: `npm run package` → creates `deploy/wa-saas-2.0.0.zip` (no node_modules, no data).
3. hPanel → **Websites** → **Create site** → **Web App** → **Upload your website files** → upload the ZIP.
   (Or: put the project on GitHub and choose **Import Git Repository**.)
4. Build settings: framework **Express** (or **Other**), **Node.js 22.x**, entry file **server.js**.
5. **Environment variables** → Edit → add:
   - `DB_HOST` = the MySQL host from step 1 (usually `localhost`)
   - `DB_USER`, `DB_PASSWORD`, `DB_NAME` = from step 1
   - `SETUP_KEY` = a random secret (protects the first-run setup page)
   - `CRON_KEY` = another random secret

   **Don't add `PORT`** (and don't "Import .env" from `.env.example`, which contains `PORT=3000`):
   Hostinger assigns the port itself, and a fixed `PORT` can stop the site from loading.
6. **Deploy**. **Runtime logs** should show `Storage: MySQL database "…"` and
   `Running at http://localhost:<port>`. If you see `Startup failed`, re-check the `DB_*` values.
7. Open `https://yourdomain.com/admin`, enter the setup key and create your account.
8. Keep it awake and reconnect numbers: website dashboard → **Advanced** → **Cron Jobs** → every 5 minutes:
   ```
   curl -s "https://yourdomain.com/api/cron?key=YOUR_CRON_KEY"
   ```

**Your data is in MySQL**: customer data, settings, payments and WhatsApp logins (table `wa_auth`) are
all in the database, so redeploys never touch them. Back up with hPanel → **Databases** → **Backups**
or phpMyAdmin → **Export**. Browse the data in phpMyAdmin (each list — `contacts`, `messages`,
`tickets`, … — is a table with one row per item; the item itself is the JSON in the `data` column).

**Already running on JSON files?** Add the `DB_*` variables and redeploy. On its first start with an
empty database the app imports everything from `…/domains/<domain>/app-storage` (data **and** WhatsApp
logins, so numbers stay linked); the files are left in place as a backup. `Runtime logs` show
`Importing existing data … Import finished.`

Logs: website dashboard → **Runtime logs**. Restart: dashboard → **Running** → **Restart**.

**Run one instance only.** The app keeps data in memory and saves changes to MySQL within ~1 second;
two copies of the app on the same database would overwrite each other's changes.

---

## After deploying

1. `/admin` → **Settings**: brand name, trial length, support email, and your **UPI / bank details**
   (shown to customers on their Subscription page).
2. **Plans & pricing**: adjust prices and limits.
3. Share your domain. Customers sign up at `/signup` and work in `/app`.

**Moving your existing data** (from your PC): copy your local `data` and `sessions` folders into the
server's storage folder (A: `/home/wa/storage/`, B: the Docker volume, C: `…/domains/<domain>/app-storage/`)
before the first start there. Your old single-company data is turned into the first workspace automatically.
With MySQL configured, the app imports these folders into the empty database on its first start.
(Or run the app once on your PC with the `DB_*` variables pointing at the server's database, if your
host allows remote MySQL connections: hPanel → Databases → **Remote MySQL**.)

## Daily operations

- **Payments**: customer pays by UPI/bank and sends a request from their Subscription page → it shows
  under **Plan requests** → check your bank → **Record payment** (activates/extends their plan).
- **Support**: open the customer → **Log in as customer** (recorded in the Activity log).
- **Health check URL** for an uptime monitor (e.g. UptimeRobot): `https://yourdomain.com/api/health`.

## Configuration reference (`.env` or the host's environment variables)

| Variable | Purpose |
|---|---|
| `SETUP_KEY` | Required to use the first-run `/admin` setup page |
| `CRON_KEY` | Enables `/api/cron?key=…` (wake-up + reconnect numbers) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL/MariaDB database. When `DB_NAME` is set, everything is stored there (tables created automatically). `DATABASE_URL=mysql://user:pass@host:3306/db` also works |
| `DB_CONNECTION_LIMIT` | Max MySQL connections (default 5) |
| `STORAGE_DIR` | Without MySQL: where data + WhatsApp logins are stored as files (automatic if empty). With MySQL: only read once, to import existing data |
| `TRUST_PROXY` | Reverse-proxy hops for real visitor IPs (automatic; Docker/Traefik: `1`) |
| `PORT` | Port to listen on (default 3000). A value set by the host wins over `.env`. VPS: the installer points nginx at it (re-run the full install after changing it). Docker: keep 3000. Hostinger web hosting: don't set it |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | Optional: create the super admin on first start instead of the setup page |
| `MIN_DELAY_MS`, `MAX_DELAY_MS`, `DAILY_LIMIT_PER_SESSION`, `AUTO_TICKETS`, `TICKET_*` | Defaults, see `.env.example` |

## Scaling later

The app loads all data into memory at startup and writes changes to MySQL row by row. That is fine for
the first few hundred customers on one server. Beyond that, move hot paths (e.g. the message log) to
direct SQL queries; all data access goes through `src/store.js`, `src/platform.js` and `src/mysql.js`.
