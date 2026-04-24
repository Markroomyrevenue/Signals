# Going Live with Hostaway API

This guide walks you through connecting your app to the real Hostaway API. Follow each step in order.

## What you need before starting

1. **Your Hostaway API credentials** — get these from your Hostaway dashboard:
   - Go to https://dashboard.hostaway.com → Settings → API Keys
   - You need your **Client ID** and **Client Secret**

2. **Docker Desktop** installed and running — download from https://www.docker.com/products/docker-desktop/

3. **Node.js 20 or 22** installed — download from https://nodejs.org (pick the LTS version)

## Step-by-step setup

Open **Terminal** (Mac) or **Command Prompt** (Windows) and run these commands one at a time.

### Step 1: Go to the project folder

```bash
cd /Users/markmccracken/Documents/hostaway-analytics-mvp
```

### Step 2: Install dependencies

```bash
npm install
```

Wait for it to finish (may take a minute).

### Step 3: Set up your environment file

```bash
cp .env.example .env
```

Now open the `.env` file in any text editor and update these values:

```
DATA_MODE=live
SEED_TENANT_ID=tenant_demo
HOSTAWAY_CLIENT_ID=paste_your_client_id_here
HOSTAWAY_CLIENT_SECRET=paste_your_client_secret_here
```

`SEED_TENANT_ID` controls the tenant id used by seed/setup. If you leave it as `tenant_demo`, worker job ids will include `tenant_demo`.

Also make sure these have strong random values (not the defaults):
```
NEXTAUTH_SECRET=any-random-string-at-least-32-characters
API_ENCRYPTION_KEY=another-random-string-at-least-32-characters
```

Tip: you can generate random strings at https://generate-random.org/api-key-generator

Save and close the file.

### Step 4: Start the database and Redis

```bash
docker compose up -d postgres redis
```

You should see two containers start. If Docker isn't running, start Docker Desktop first.

### Step 5: Run the automated setup

```bash
npm run setup:live
```

This will:
- Apply all database tables
- Create a demo login account
- Store your Hostaway credentials securely

### Step 6: Start the app

Open **two** terminal windows.

**Terminal 1** — start the web app:
```bash
npm run dev
```

**Terminal 2** — start the background worker:
```bash
npm run worker:sh
```

### Step 7: Log in and sync

1. Open your browser to **http://127.0.0.1:3000/login**
2. Log in with the `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` values from your `.env`
3. Click **Run Sync** on the dashboard — this pulls all your Hostaway data

The first sync may take a few minutes depending on how many bookings you have.

## Setting up the webhook (optional)

The webhook lets Hostaway notify your app automatically when bookings change, so your data stays up to date without manual syncs.

### Make your app accessible from the internet

Since Hostaway needs to reach your app, you need a public URL. The easiest way is **ngrok**:

1. Sign up free at https://ngrok.com and install ngrok
2. Run:
```bash
ngrok http 3000 --host-header=127.0.0.1:3000
```
3. Copy the HTTPS URL it gives you (looks like `https://abc123.ngrok.io`)

### Configure the webhook in Hostaway

1. Go to https://dashboard.hostaway.com → Settings → Webhooks
2. Add a new webhook with:
   - **URL**: `https://your-ngrok-url.ngrok.io/api/webhooks/hostaway/reservations`
   - **Events**: Reservation created, updated, cancelled
   - **Method**: POST

If you set `WEBHOOK_BASIC_USER` and `WEBHOOK_BASIC_PASS` in your `.env`, also configure those as Basic Auth credentials in Hostaway's webhook settings.

## Checking your credentials in the app

1. Go to http://127.0.0.1:3000/dashboard/settings
2. Click **Test Hostaway Connection** to verify your credentials work
3. You can also update credentials here without editing `.env`

## Troubleshooting

**"Failed to load report" or blank dashboard**
- Make sure you clicked **Run Sync** at least once
- Check that Docker containers are running: `docker compose ps`

**"Missing live Hostaway client credentials"**
- Double-check your `.env` has the correct `HOSTAWAY_CLIENT_ID` and `HOSTAWAY_CLIENT_SECRET`
- Or go to Settings and enter them there

**Sync seems stuck**
- Check `worker.log` for error messages
- Make sure Terminal 2 (worker) is still running

**Port 3000 already in use**
- Another app is using port 3000. Either close it or set `PORT=3001` in `.env`

## Updating the app

When you get a new version:

```bash
npm install
npm run db:deploy
npm run dev
```

The `db:deploy` step applies any new database changes safely without losing your data.
