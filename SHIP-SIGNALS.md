# Shipping Signals to signals.roomyrevenue.com

A no-coding-experience checklist for Mark. Follow it top to bottom — every step
has concrete commands or clicks. If something in the UI looks different from
what is described, screenshot it and ask Claude — the platforms change labels
occasionally but the logic doesn't.

The plan below hosts **Signals** at `https://signals.roomyrevenue.com`, gives
staff members their own logins that **only see reporting (no Calendar tab)**,
and keeps the Calendar / dynamic-pricing work hidden behind an admin-only
toggle so you can keep developing it without touching the staff experience.

Estimated time end-to-end: **90 minutes**, of which the longest waits are DNS
propagation (a few minutes) and the first database migration (one command).

---

## 0. What is already done for you

Before you do any of the steps below, here is what has just been shipped into
the codebase:

- **Roles on user accounts.** Every user now has a role: `admin` (you) or
  `viewer` (staff). Existing users were auto-promoted to `admin` so you don't
  lose access.
- **Calendar is hidden for viewers.** The tab is removed from the sidebar,
  direct URLs are bounced, and the `pricing-settings` / admin / sync-trigger /
  Hostaway-connection APIs return `403 Forbidden` for viewers.
- **New team management page at `/dashboard/team`** for admins. You can invite,
  demote, and remove staff from the browser. Safety rails stop you from
  demoting the last admin or deleting yourself.
- **CLI fallback:** `npm run user:create -- email password viewer "Name"`
  and `npm run user:list` if you ever lock yourself out of the UI.
- **Login stamp:** every successful login now records `last_login_at` so you
  can see who is actually using the tool.
- **Scratch-file hygiene:** `.gitignore` updated so the Codex temp folders,
  duplicate `.pid` files, stale `.next_*` dirs and `tsconfig N.tsbuildinfo`
  noise stop leaking into future git history.
- **Cancelled-booking YoY pace logic** (the thing you flagged in the project
  instructions) is already implemented — migration
  `20260325000001_add_cancelled_at_to_reservations` added a `cancelled_at`
  column and the pace query in `src/lib/reports/service.ts` includes nights
  that were live at the cutoff but cancelled later. No action needed.

---

## 1. Host the database and Redis (one-time, 20 minutes)

Signals needs two always-on services: **PostgreSQL** (stores your data) and
**Redis** (queues sync jobs). Pick one of the two bundles below.

### Option A — Recommended: Railway (everything in one place, ~$10/month)

1. Go to https://railway.app and sign up with GitHub.
2. Click **New Project → Provision PostgreSQL**. Wait for it to go green.
3. In the same project, **+ New → Database → Add Redis**. Wait for green.
4. Click each service in turn and copy the **Connect → Private URL** values.
   You will need them in a moment.
   - Postgres looks like `postgresql://postgres:xxxx@...railway.app:5432/railway`
   - Redis looks like `redis://default:xxxx@...railway.app:6379`
5. Keep the Railway tab open — we'll add the web service here too in step 4.

### Option B — Free-tier mix: Neon (DB) + Upstash (Redis)

- https://neon.tech → **Create project**, region **EU (Frankfurt or London)**,
  copy the pooled connection string.
- https://upstash.com → **Create Redis database**, region **eu-west-1**, copy
  the `redis://` URL. Make sure **TLS** is supported (it is on Upstash by
  default — use the `rediss://...` variant if offered).

---

## 2. Prepare your code for production (5 minutes)

> ⚠️  **Important for copy-pasters:** Only paste the command lines (the lines
> *without* a `#` at the start). Lines that begin with `#` are human-readable
> notes — if you paste them into Terminal, zsh will error out with something
> like `bad pattern` or `no such file or directory`. Paste commands **one at a
> time** and hit Enter after each.

### 2a. Rename the folder to `signals`

The project was originally named `hostaway-analytics-mvp`. It is now
**Signals by Roomy Revenue** — let's make the folder name match before we
push anything to GitHub so everything stays consistent.

1. Open **Finder** and go to your `Documents` folder.
2. Right-click on the folder called `hostaway-analytics-mvp` → **Rename**.
3. Change the name to exactly `signals` (lowercase, no spaces).
4. Press Return.

> Heads-up if you have the Cowork desktop app open on this folder right now:
> after renaming, Cowork will lose track of the old path. Close Cowork,
> reopen it, and re-select the `signals` folder when it asks. If this step
> seems risky, you can leave the folder name alone for now and rename it
> later — just replace every `~/Documents/signals` below with
> `~/Documents/hostaway-analytics-mvp`.

### 2b. First time only — turn the folder into a git repo

If you've never run git in this folder before (you'll know because
`git add` says `fatal: not a git repository`), do this first:

```bash
cd ~/Documents/signals
git init
git add -A
git commit -m "Initial Signals commit"
```

Then skip to step **2d**.

### 2c. Already have git set up — just commit the latest changes

```bash
cd ~/Documents/signals
git add -A
git commit -m "Rebrand to Signals by Roomy Revenue + role-based access"
```

### 2d. Connect to GitHub and push

1. In your browser, go to **https://github.com/new**. Create a **private**
   repo called `signals`. Do **not** tick "Initialize this repository with a
   README" — we want it empty.
2. On the confirmation page, copy your GitHub username (you'll need it in a
   second). It's the part right after `github.com/` in the page URL.
3. Back in Terminal, run the three commands below — but **replace
   `YOUR-GITHUB-USERNAME`** with the username you just copied. For example,
   if your username is `markmcc`, the first command becomes:
   `git remote add origin https://github.com/markmcc/signals.git`

```bash
git remote add origin https://github.com/YOUR-GITHUB-USERNAME/signals.git
git branch -M main
git push -u origin main
```

If `git push` asks for a **password**, GitHub actually wants a *personal
access token* (ordinary passwords stopped working in 2021):

1. Visit https://github.com/settings/tokens → "Generate new token (classic)".
2. Give it a name like "Signals shipping", set expiration to 90 days, tick
   the **`repo`** checkbox.
3. Click "Generate token", copy the long string shown (you'll only see it
   once).
4. Paste it when Terminal prompts for the password.

**Before you push:** open `.env` and `.env.local` and confirm they're in
`.gitignore` (they are). Secrets must never be committed.

---

## 3. Generate production secrets (2 minutes)

You need a strong `API_ENCRYPTION_KEY` (used to encrypt Hostaway credentials in
the database). In Terminal:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copy the long base64 string it prints. That's your `API_ENCRYPTION_KEY`.

Also pick a long random string for `NEXTAUTH_SECRET` (any 32+ character
random string will do — Signals doesn't use NextAuth today but the env key is
reserved in case we ever swap to it).

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep both values in a password manager. You will paste them into the hosting
dashboard in the next step.

---

## 4. Deploy the web + worker (25 minutes)

The app has two processes: the **web server** (Next.js) and the **worker**
(syncs data from Hostaway). Both need the same environment variables.

### Using Railway (continuing from step 1, Option A)

In the same Railway project:

1. **+ New → GitHub Repo** → pick `signals`. Railway will
   auto-detect Next.js and start a build. Let it fail the first time — we need
   to set env vars first.

2. Click the new service → **Variables** → paste all of these (use the DB/Redis
   URLs from step 1 and the secrets from step 3):

   ```
   DATABASE_URL=<Postgres internal URL>
   REDIS_URL=<Redis internal URL>
   API_ENCRYPTION_KEY=<base64 from step 3>
   NEXTAUTH_SECRET=<hex from step 3>
   APP_BASE_URL=https://signals.roomyrevenue.com
   NODE_ENV=production
   DATA_MODE=live
   TENANT_DEFAULT_CURRENCY=GBP
   DEFAULT_TIMEZONE=Europe/London
   SEED_TENANT_ID=tenant_roomy
   SEED_ADMIN_EMAIL=mark@roomyrevenue.com
   SEED_ADMIN_PASSWORD=<invent any strong password — you will change it inside the app after you log in the first time>
   HOSTAWAY_BASE_URL=https://api.hostaway.com
   HOSTAWAY_CLIENT_ID=PLACEHOLDER
   HOSTAWAY_CLIENT_SECRET=PLACEHOLDER
   HOSTAWAY_ACCOUNT_ID=PLACEHOLDER
   WEBHOOK_BASIC_USER=signals-webhook
   WEBHOOK_BASIC_PASS=<another long random string>
   ROOMY_ENABLE_LIVE_MARKET_REFRESH=false
   ```

   Leave `SAMPLE_CSV_PATH` unset — production is live-only.

   > **Plain-English key to this list:**
   > - Lines with **angle brackets** like `<something here>` or the word
   >   `PLACEHOLDER` → you must replace the whole thing with a real value
   >   (either something you generated, something Railway gave you, or
   >   something from Hostaway).
   > - Lines with a **plain value** like `https://api.hostaway.com` or
   >   `production` → copy the value in **as-is**. Don't remove it, don't
   >   change it — it's already correct.
   > - The three `HOSTAWAY_*` lines can be left as `PLACEHOLDER` for now;
   >   you'll fill them with real Hostaway credentials in §6. Railway will
   >   happily accept the placeholder text and the app will simply not sync
   >   until you go back and replace them with the real values.

### 4.3. Set the start command so migrations run on deploy

The "start command" is what Railway runs after a successful build. By default
Railway uses `npm run start`, which does **not** run database migrations first.
We need it to migrate the DB before starting the server.

1. Still in the web service, at the top you see a row of tabs:
   **Deployments / Variables / Metrics / Logs / Settings**. Click **Settings**.

2. Scroll down until you find a section called **Deploy** (not "Source" — keep
   scrolling past that). Inside it there's a field labelled
   **Custom Start Command**.

3. Click into that field and paste this exact line:

   ```
   npm run db:deploy && npm run start
   ```

4. Click the **Save** button that appears next to the field, or press Return.

5. Click the **Deployments** tab at the top of the web service. On the most
   recent deployment (top of the list), click the **three-dot menu (⋯)** on
   the right edge and choose **Redeploy**. Wait 2–4 minutes. This is the first
   deploy that will actually set up your database schema.

6. While it's redeploying, click the **Logs** tab. You're watching for two
   things:
   - Early in the log: lines from Prisma about applying migrations, ending in
     something like `All migrations have been successfully applied`.
   - Near the end: a green line that says `▲ Next.js 15.x.x` and
     `- Ready in ...` or `✓ Ready on port 3000`.

   If you see red text, copy-paste it into the chat with me and I'll explain it.

### 4.4. Create the worker service

The worker is a second process that runs alongside the web server. Its job is
to pull data from Hostaway in the background (sync reservations, update
calendars, build nightly snapshots). Same code, different start command.

1. Go back to the **project canvas** — that's the page that shows all your
   services as tiles (Postgres, Redis, and your web service). Click the
   **project name** at the top-left breadcrumb to get there if you're inside
   a service.

2. In the top-right area of the canvas, click the **+ New** button.

3. A menu opens with options including "Database", "GitHub Repo", "Docker
   Image", "Empty Service". Click **Empty Service**.

4. A new grey tile appears on the canvas. Click it. At the top of the panel
   that slides in, find the service name (probably something like
   `empty-service`). Click on it to rename → type `signals-worker` → press
   Return.

5. Click the **Settings** tab at the top of the worker service.

6. Scroll down to the **Source** section. It will say "No source repository
   connected". Click **Connect Repo** → pick `signals` from the list → click
   **Connect**.

7. Still in Settings, scroll to the **Deploy** section. In the
   **Custom Start Command** field, paste:

   ```
   npm run worker
   ```

   Save.

8. The worker needs every environment variable that the web service has. Click
   the **Variables** tab at the top of the worker. The Variables tab will be
   empty.

9. In the top-right of the Variables tab, click the **RAW Editor** or the
   **three-dot menu (⋯)** → **Copy from another service**. Select the web
   service (its name is probably `signals`). Railway copies every variable
   across in one click. Confirm / Save.

10. Click **Deploy** at the top right of the worker service. Wait 2–4 minutes.

11. Click the worker's **Logs** tab. You're watching for a line like
    `sync-worker ready` or `Worker is waiting for jobs`. Red text here means
    a missing env var or a DB connection problem — copy-paste it to me.

### 4.5. Sanity check: both services green

Go back to the project canvas. You should see 4 tiles: Postgres, Redis,
`signals` (web), `signals-worker`. The web and worker tiles should both have
a green dot and say "Active" or "Deployed". If either is red, click it, open
**Logs**, and paste the red lines to me.

At this point the app is technically running, but it's on a random Railway
URL like `https://signals-production-xxxx.up.railway.app` and nothing knows
about `signals.roomyrevenue.com` yet. That's the next section.

### Using Vercel instead

Vercel runs the web app fine but **cannot host the background worker** (it's a
long-lived process). If you go Vercel:

- Deploy the web app on Vercel with the same env vars.
- Run the worker on **Railway, Render, or Fly.io** as a separate service
  pointed at the same GitHub repo with start command `npm run worker`.

That split works but you are managing two providers. Railway-only is simpler
for a first launch.

---

## 5. Point `signals.roomyrevenue.com` at the app (10 minutes + DNS wait)

You'll do this in two places: first Railway (to tell Railway "accept traffic
for this domain"), then your DNS provider (to tell the internet "send
signals.roomyrevenue.com to Railway").

### 5.1. Tell Railway to accept the domain

1. In the Railway project canvas, click the **web service tile** (`signals`,
   not `signals-worker`).

2. At the top of the service, click the **Settings** tab.

3. Scroll down to the **Networking** section. You'll see two sub-sections:
   **Public Networking** and **Private Networking**. In **Public Networking**,
   click the **+ Custom Domain** button.

4. A text field appears. Type exactly `signals.roomyrevenue.com` and click
   **Add Domain**.

5. Railway will show you a row with your domain and a target string. The
   target looks like `abcd-production.up.railway.app` (it's a CNAME). Next
   to it there's a small **Copy** icon. Click Copy. You'll paste this in the
   DNS step.

   > Keep this Railway tab open — you'll come back to it after the DNS step
   > to confirm the SSL certificate issues.

### 5.2. Add the DNS record at your domain provider

Where this happens depends on where `roomyrevenue.com` is managed. It's
whichever provider you log into to edit domain settings — most commonly
Cloudflare, GoDaddy, Namecheap, Squarespace, or similar. If you're not sure,
tell me.

1. Open a new browser tab and log into your DNS provider.

2. Find `roomyrevenue.com` in the list of domains you own and click into it.

3. Find the **DNS** or **DNS Records** page (sometimes called "Zone Editor"
   or "Manage DNS").

4. Click **Add Record** (sometimes labelled **+** or **New Record**).

5. Fill in the form as follows:
   - **Type:** `CNAME`
   - **Name / Host / Subdomain:** just the word `signals` (do NOT type the
     full `signals.roomyrevenue.com` — the provider adds `.roomyrevenue.com`
     automatically)
   - **Target / Value / Points to:** paste the string you copied from
     Railway in step 5.1.5
   - **TTL:** leave as Auto / Default / 5 minutes / 300
   - **Proxy status (Cloudflare ONLY):** click the orange cloud icon so it
     turns grey. The label changes from "Proxied" to "DNS only". Leave it
     grey for at least 24 hours after launch — otherwise Railway can't
     issue the SSL certificate. You can turn the orange cloud back on later
     once HTTPS is working.

6. Save the record.

### 5.3. Wait for DNS + SSL (2–20 minutes)

1. Go back to your Railway browser tab.

2. The domain you added in 5.1 will initially show a status like
   **"Pending"** or **"Awaiting verification"**. Railway checks DNS every
   minute or two.

3. When the DNS change is picked up, the status turns to **"Issuing
   Certificate"**, then **"Active"** with a green checkmark. This usually
   happens within 2-10 minutes of you saving the DNS record, but in rare
   cases can take up to an hour.

4. Once it's green, open a fresh browser tab and visit
   `https://signals.roomyrevenue.com`. You should see the Signals login
   screen.

5. **Don't log in yet** — the database is empty, so there are no user
   accounts to log in with. That's the next section.

If after 30 minutes the Railway status is still "Pending":
- Check your DNS record by visiting https://dnschecker.org and entering
  `signals.roomyrevenue.com`. If no CNAME is showing, the DNS record didn't
  save — go back to 5.2.
- If a CNAME IS showing but Railway is still pending, tell me.

---

## 6. Get your tenants + Hostaway connections into Railway

### 6.0. The situation

Signals is multi-tenant: each of your Hostaway clients is one **tenant**, and
each tenant has its own encrypted Hostaway credentials stored in a database
table called `HostawayConnection`. You've already loaded several clients into
your **local** database on your Mac by using the app's Settings page.
Railway's Postgres, however, starts **completely empty**. So right now if you
hit login on signals.roomyrevenue.com it won't let you in — there are zero
users in the DB.

You have two choices. Pick one and tell me, and I'll walk you through it.

### Path A — Copy your local database up to Railway (recommended)

**What you keep:** every tenant, every user, every Hostaway credential,
every listing, every reservation, every night of sync history.

**One pre-requisite:** the `API_ENCRYPTION_KEY` you set in Railway (§4 step 2)
**must match** the one in your local `.env` file. If they differ, the
encrypted Hostaway client secrets in the database will not decrypt on
Railway and syncs will fail with a decryption error.

#### 6.A.1. Check your local encryption key

1. In Finder, open your `~/Documents/signals` folder.

2. Press `Cmd + Shift + .` — this makes hidden files visible. Look for a file
   called `.env` (it starts with a dot).

3. Double-click to open it in TextEdit (or your editor of choice). Look for
   the line that starts with `API_ENCRYPTION_KEY=`.

4. Copy the value (everything after the `=`).

5. Open a new browser tab on the Railway web service → **Variables** tab →
   find `API_ENCRYPTION_KEY` → click it to reveal the value. Compare.

6. **If they match:** continue to 6.A.2.

7. **If they don't match:** update Railway's `API_ENCRYPTION_KEY` to match
   your local one. Save. Railway will redeploy — wait for green.
   > Why this way round: your local database has secrets encrypted with your
   > local key. If we change the local key, we'd have to re-encrypt every
   > row. Easier to change Railway's key to match.

#### 6.A.2. Dump your local database to a file

1. Make sure Postgres is running locally. In Terminal, run:

   ```
   cd ~/Documents/signals
   docker compose ps
   ```

   You should see a row for `postgres` with status `Up`. If not, run
   `docker compose up -d postgres` and wait 10 seconds.

2. Create a dump of your local database. Paste this into Terminal:

   ```
   docker compose exec postgres pg_dump -U postgres -d hostaway_analytics --no-owner --no-acl > ~/Desktop/signals-local-dump.sql
   ```

   When it finishes (a few seconds to a minute depending on data size), you'll
   have a file called `signals-local-dump.sql` on your Desktop. Check it's
   there.

3. Quick size check — run:

   ```
   ls -lh ~/Desktop/signals-local-dump.sql
   ```

   The size should be somewhere between 100 KB and a few hundred MB. If it's
   0 bytes, the dump failed — paste the output to me.

#### 6.A.3. Get the Railway Postgres external URL

Railway's **internal** URL (what your web service uses) only works from
inside Railway. You need the **external** URL to connect from your Mac.

1. In the Railway project canvas, click the **Postgres** tile.

2. Click the **Connect** tab (not Variables).

3. You'll see several connection methods. Find the one labelled **Postgres
   Connection URL** under **Public Network**. Click the **Copy** icon.

   > If there's only an internal URL listed, click **Settings** at the top of
   > the Postgres service → scroll to **Networking** → toggle **Public
   > Networking** on. Refresh and come back to **Connect** tab.

#### 6.A.4. Restore the dump into Railway

1. Back in Terminal. Paste this command, but **replace `PASTE-URL-HERE`** with
   the URL you just copied:

   ```
   psql "PASTE-URL-HERE" < ~/Desktop/signals-local-dump.sql
   ```

   Example of what it should look like after replacing (yours will differ):
   ```
   psql "postgresql://postgres:abc123@viaduct.proxy.rlwy.net:12345/railway" < ~/Desktop/signals-local-dump.sql
   ```

2. You'll see a lot of log lines scroll past: `CREATE TABLE`, `ALTER TABLE`,
   `COPY`, etc. If they're all black and the command returns you to the
   prompt with no "ERROR" lines, it worked. If you see red "ERROR" lines,
   copy them to me.

3. If `psql` isn't installed on your Mac, Terminal will say
   `zsh: command not found: psql`. Fix: run `brew install postgresql@16` and
   try again.

#### 6.A.5. Restart the Railway services

1. In Railway: open the **web service** → **Deployments** tab → three-dot
   menu on the latest deploy → **Redeploy**.

2. Same for the **worker service**.

3. Wait for both to go green. Check logs to confirm no errors.

#### 6.A.6. First login

1. Visit https://signals.roomyrevenue.com.

2. Log in with the same email and password you use locally. You should see
   the dashboard with all your clients, listings, and reservations intact.

3. Skip to §7 (staff member).

### Path B — Start fresh on Railway and re-add each client

**What you lose:** all historical sync data on Railway (you'd have to run a
full sync again per client). Your local data is untouched.

#### 6.B.1. Log in with the seed admin

1. Visit https://signals.roomyrevenue.com. You'll land on the login screen.

2. Enter:
   - Email: the value of `SEED_ADMIN_EMAIL` from Railway (default:
     `mark@roomyrevenue.com`)
   - Password: the value of `SEED_ADMIN_PASSWORD` you set in §4

3. Click **Sign in**. You're now in the seed tenant
   (`SEED_TENANT_ID=tenant_roomy`), which was created automatically by
   `npm run db:seed` during the first deploy.

#### 6.B.2. Connect this tenant's Hostaway account

1. Click **Account → Settings** in the left sidebar.

2. Scroll to the **Hostaway Connection** section. Paste:
   - **Account ID** — from your Hostaway admin → Marketplace → Public API →
     Apps → the app for THIS client
   - **Client ID** — same page
   - **Client Secret** — same page

3. Click **Test**. If it goes green, click **Run Full Sync**.

4. Watch the **Logs** tab of the worker service in Railway. Within a minute
   you should see sync activity.

#### 6.B.3. Add each additional client as its own tenant

For each extra Hostaway client you had locally, you'll need a new tenant. I
haven't built a UI for this yet, so tell me when you're ready and I'll run
the command against Railway's database to create the tenant record for you.
Then you log in as that tenant's admin and repeat 6.B.2.

### Common to both paths

The three `HOSTAWAY_CLIENT_ID` / `HOSTAWAY_CLIENT_SECRET` /
`HOSTAWAY_ACCOUNT_ID` env vars in §4 are not used at runtime — leave them
as `PLACEHOLDER`. You can delete them from Railway entirely once you're set
up if you'd like a cleaner Variables tab.

### 6.7. Set up each tenant's Hostaway webhook

Once a tenant is connected and Test-green, wire up the webhook so Hostaway
pushes changes to Signals in near-real-time (instead of waiting for the
15-minute background sync).

1. In **Hostaway admin** (for the account that owns the tenant you're
   configuring) → **Marketplace → Public API → Webhooks → New**.

2. Fill in:
   - **URL:** `https://signals.roomyrevenue.com/api/webhooks/hostaway/reservations`
   - **HTTP method:** `POST`
   - **Authentication:** `Basic Auth`
   - **Username:** the exact value of `WEBHOOK_BASIC_USER` from Railway
     (default: `signals-webhook`)
   - **Password:** the exact value of `WEBHOOK_BASIC_PASS` from Railway
   - **Events:** tick `Reservation created`, `Reservation updated`,
     `Reservation cancelled`

3. Click **Save**, then click **Test** inside Hostaway. In Railway, open the
   **web service Logs** tab. Within a few seconds you should see a line with
   `POST /api/webhooks/hostaway/reservations 200`. That's success.

4. If you see a `401` instead, the username/password in Hostaway doesn't
   match Railway — double-check both sides.

5. Repeat per tenant (one webhook per Hostaway account).

---

## 7. Create your staff member (2 minutes)

Do this after you can log into signals.roomyrevenue.com as admin and see your
data.

### 7.1. Change your own admin password (30 seconds)

If you used a temporary password in `SEED_ADMIN_PASSWORD`, change it to your
real one now.

1. Once logged in, click your **name/email in the top-right corner** of the
   app (it's the profile menu).

2. Click **Account settings**.

3. Enter your **current** password (the temporary one) and your **new**
   password (twice). Click **Save**.

### 7.2. Invite your first staff member

1. In the left sidebar, click **Account → Team** (or go directly to
   `https://signals.roomyrevenue.com/dashboard/team` in your browser bar).

2. You'll see a list of current users (just you for now) and an **Invite
   Teammate** form below it.

3. In the invite form, fill in:
   - **Email:** your staff member's work email
   - **Display name:** their first + last name, e.g. `Sam Johnson`
   - **Temporary password:** 8+ characters, e.g. `SignalsTemp2026!` — they'll
     change it after first login
   - **Role:** leave as **Viewer** (the default). Viewers see every report
     but **cannot** see the Calendar tab, cannot trigger syncs, cannot edit
     Hostaway settings, and cannot manage team members. That's exactly what
     you want for onboarding staff while the Calendar side is still being
     built.

4. Click **Invite**. Their account is created immediately.

5. Share their email, temporary password, and the URL
   (`https://signals.roomyrevenue.com`) via your password manager (1Password,
   Bitwarden) or an encrypted message. Do NOT send passwords by plain email
   or SMS.

### 7.3. (Later) Promote a staff member to admin

If you ever need someone to help manage Hostaway connections / trigger
syncs, open the same **Team** page, find their row, and change the role
dropdown from **Viewer** to **Admin**. A safety rail stops you demoting the
very last admin (so you can't accidentally lock yourself out).

### 7.4. Backup path if the Team UI doesn't load

If the Team page 500s or you want to script a bulk add, you can create users
from your Mac's Terminal directly against the production database:

1. Install the Railway CLI once:

   ```
   brew install railway
   ```

2. Log in:

   ```
   railway login
   ```

3. Link the CLI to your Railway project:

   ```
   cd ~/Documents/signals
   railway link
   ```

   Pick your Signals project from the list.

4. Create the user (replace the placeholders):

   ```
   railway run npm run user:create -- staff@firm.com "TempPass2026!" viewer "Sam Johnson"
   ```

5. Verify by running:

   ```
   railway run npm run user:list
   ```

---

## 8. Keep developing Calendar / pricing safely (ongoing)

The reporting side is now frozen-safe for staff — you can still work on the
Calendar workspace without ever exposing half-finished features to them.

- **Branch discipline.** Do pricing work on a `pricing/*` branch. The Calendar
  tab only shows for `role = admin`, so even if you deploy a half-done pricing
  change to production, staff do not see it.
- **Feature flag for in-progress work.** When you want to hide something from
  yourself too until it's ready, wrap it in a check against
  `process.env.NEXT_PUBLIC_ENABLE_NEW_CALENDAR === "1"` and only set that var
  in a staging deploy. We can add a staging environment in Railway whenever
  you want (it's just a second deploy linked to a `staging` branch).
- **When you swap AirROI for Key Data:** that work lives in
  `src/lib/market/` and `.env` variables (`AIRROI_*` will become `KEYDATA_*`).
  The pricing logic uses whatever market anchor comes out of those modules, so
  the swap is an integration change, not a logic change — exactly as you said
  in the project instructions.

---

## 9. After launch: monitoring checklist

A launch is only as safe as the alerts on top of it. Three cheap wins:

1. **Sentry.** Free tier. Add `@sentry/nextjs`, paste a DSN env var in
   Railway, done. You will get notified the moment a report 500s. I can do
   this for you in one commit when you are ready.
2. **Uptime checks.** UptimeRobot (free) or BetterStack — monitor
   `https://signals.roomyrevenue.com/login` every 1 min. You get an email if
   it ever goes red.
3. **Sync freshness.** The Hostaway connection already exposes `last_sync_at`.
   We can add a cron that emails you if `last_sync_at` is more than 2h stale
   — also a one-commit job. Recommended for after the first staff member is
   onboarded.

---

## 10. Troubleshooting

| Symptom | Most likely fix |
|---------|-----------------|
| "Error: cannot find module '@prisma/client'" in Railway build log | Ensure build command is the default `npm run build` — it already runs `prisma generate`. If you changed it, restore it. |
| Login returns 500 immediately | `API_ENCRYPTION_KEY` or `DATABASE_URL` missing in the worker/web env. Double-check both services have the var. |
| Login just says "Invalid credentials" | The seed admin didn't get created. Run `railway run npm run db:seed` once, or use `railway run npm run user:create -- you@email pw admin "Mark"`. |
| DNS page says "No such app" after 30 min | Cloudflare orange-cloud proxy is on before the cert issued. Turn it **off**, wait 5 min, turn it back on once HTTPS works. |
| Webhook test returns 401 | Basic-auth user/pass in Hostaway doesn't match the env vars in Railway. |
| Staff member can still see "Calendar" in the sidebar | They logged in before you promoted their account and it's cached. Ask them to sign out and sign back in. |
| "Prisma migration failed" on deploy | Run `railway run npx prisma migrate status` locally to see which migration is stuck. Usually a re-deploy fixes it; if not, contact me. |

---

## 11. Final sanity check before telling staff "it's live"

From a private/incognito browser window, as the viewer account:

- [ ] You **can** see Overview, Reservations, Property Groups, Pace, Sales,
      Booked, Booking Behaviour, Property Drilldown, Signal Lab.
- [ ] You **cannot** see the Calendar tab in the sidebar.
- [ ] Hitting `https://signals.roomyrevenue.com/dashboard?tab=calendar`
      bounces you to Overview.
- [ ] Hitting `https://signals.roomyrevenue.com/api/pricing-settings?scope=portfolio`
      in the browser returns `{"error":"Forbidden"}` with a 403.
- [ ] Hitting `https://signals.roomyrevenue.com/dashboard/team` redirects you
      to `/dashboard`.
- [ ] Pace chart for a past cutoff (e.g. last October 1) shows nights for
      bookings that existed on that date even if they were cancelled later —
      the cancelled-YoY logic is working.

When all six boxes are green, you're live.
