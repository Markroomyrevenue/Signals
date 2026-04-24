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

### 2a. First time only — turn the folder into a git repo

If you've never run git in this folder before (you'll know because
`git add` says `fatal: not a git repository`), do this first:

```bash
cd ~/Documents/hostaway-analytics-mvp
git init
git add -A
git commit -m "Initial Signals commit"
```

Then skip to step **2c**.

### 2b. Already have git set up — just commit the latest changes

```bash
cd ~/Documents/hostaway-analytics-mvp
git add -A
git commit -m "Add role-based access, team management, cancelled YoY pace"
```

### 2c. Connect to GitHub and push

1. In your browser, go to **https://github.com/new**. Create a **private**
   repo called `hostaway-analytics-mvp`. Do **not** tick "Initialize this
   repository with a README" — we want it empty.
2. On the confirmation page, copy your GitHub username (you'll need it in a
   second). It's the part right after `github.com/` in the page URL.
3. Back in Terminal, run the three commands below — but **replace
   `YOUR-GITHUB-USERNAME`** with the username you just copied. For example,
   if your username is `markmcc`, the first command becomes:
   `git remote add origin https://github.com/markmcc/hostaway-analytics-mvp.git`

```bash
git remote add origin https://github.com/YOUR-GITHUB-USERNAME/hostaway-analytics-mvp.git
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

1. **+ New → GitHub Repo** → pick `hostaway-analytics-mvp`. Railway will
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
   SEED_ADMIN_PASSWORD=<temporary strong password you'll reset after first login>
   HOSTAWAY_BASE_URL=https://api.hostaway.com
   HOSTAWAY_CLIENT_ID=<from Hostaway — see §6>
   HOSTAWAY_CLIENT_SECRET=<from Hostaway — see §6>
   HOSTAWAY_ACCOUNT_ID=<from Hostaway — see §6>
   WEBHOOK_BASIC_USER=signals-webhook
   WEBHOOK_BASIC_PASS=<another long random string>
   ROOMY_ENABLE_LIVE_MARKET_REFRESH=false
   ```

   Leave `SAMPLE_CSV_PATH` unset — production is live-only.

3. **Settings → Start command.** Set it to:

   ```
   npm run db:deploy && npm run start
   ```

   This applies pending database migrations (including the brand-new
   `20260424120000_add_user_role_and_profile` migration for roles) before
   starting the web server. Safe to run on every deploy — migrations are
   idempotent.

4. **+ New service → Empty service** inside the same project and name it
   `signals-worker`. In **Settings → Source** link it to the same GitHub repo.
   Set its **Start command** to:

   ```
   npm run worker
   ```

   Copy every env var from the web service into the worker's Variables tab
   (Railway has a one-click "copy from service" option). The worker must share
   the same `DATABASE_URL`, `REDIS_URL`, `API_ENCRYPTION_KEY`, and all the
   Hostaway keys.

5. Trigger a redeploy on both services. The web service logs should end with
   `✓ Ready`. The worker logs should show `sync-worker ready`.

### Using Vercel instead

Vercel runs the web app fine but **cannot host the background worker** (it's a
long-lived process). If you go Vercel:

- Deploy the web app on Vercel with the same env vars.
- Run the worker on **Railway, Render, or Fly.io** as a separate service
  pointed at the same GitHub repo with start command `npm run worker`.

That split works but you are managing two providers. Railway-only is simpler
for a first launch.

---

## 5. Point your subdomain at the app (10 minutes + DNS wait)

1. In Railway, open the web service → **Settings → Networking → Custom
   Domain**. Enter `signals.roomyrevenue.com`. Railway shows you either an
   `A` record (IP) or a `CNAME` (points to `<something>.up.railway.app`).
   Copy whichever one it gives you.

2. Log into the DNS provider for `roomyrevenue.com` (Cloudflare, GoDaddy,
   Squarespace Domains, etc.). Create a new record:
   - **Type:** `CNAME` (if Railway gave a CNAME) or `A` (if Railway gave an IP)
   - **Host / Name:** `signals`
   - **Value / Target:** the exact string Railway showed
   - **TTL:** leave as default (auto / 5 minutes is fine)
   - **Proxy (Cloudflare only):** ⚠️ turn **OFF** (grey cloud, "DNS only") for
     the first 24 hours while the SSL certificate issues. Turn it back on
     afterwards if you want Cloudflare's CDN/WAF.

3. Wait 2–10 minutes, then hit `https://signals.roomyrevenue.com`. You should
   see the Signals login screen.

4. Log in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. The first thing you
   should do after the tour: change that password via the team page (§7).

---

## 6. Connect Hostaway the right way (10 minutes)

You already have this mostly wired; the values just need to live in the
hosting provider rather than your local `.env`.

1. In Hostaway admin → **Marketplace → Public API**. Create a Public API key
   if you haven't already. Copy the **Account ID**, **Client ID**, and
   **Client Secret**.
2. Paste those into Railway's env vars (`HOSTAWAY_*`) and redeploy.
3. Back in Signals → open **Settings → Hostaway Connection → "Test"**. If it
   comes back green, click **Run Full Sync**. The worker will start ingesting
   your listings and reservations.
4. Set up the webhook:
   - In Hostaway admin → **Webhooks → New** → URL
     `https://signals.roomyrevenue.com/api/webhooks/hostaway/reservations`,
     **Basic auth** = the `WEBHOOK_BASIC_USER` / `WEBHOOK_BASIC_PASS` values
     you set in step 4, event type `Reservation created/updated/cancelled`.
   - Save, then click **Test** on the Hostaway side. You should see a 2xx in
     Railway's web-service logs within seconds.

---

## 7. Create your staff member (2 minutes)

From Signals, while logged in as admin:

1. Go to the sidebar → **Account → Settings**, then open
   `https://signals.roomyrevenue.com/dashboard/team` in the browser (a link
   to this will also live inside the Settings section once you visit it once).
2. **Invite a teammate.** Enter their email, a temporary password (8+ chars),
   their display name, and leave the role as **Viewer**.
3. Share the credentials with them via your password manager or a secure
   channel. They log in at the same URL; they will **not** see the Calendar
   tab, will not be able to hit `/api/pricing-settings`, and cannot trigger
   syncs or change Hostaway credentials.
4. If you need to promote them to admin later, flip the role selector on the
   same page. The safety rail stops you from accidentally demoting the last
   admin.

Backup path if the UI breaks: in Terminal against the production DB
(`railway run npm run user:create -- staff@firm.com "TempPass!" viewer "Sam"`).

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
