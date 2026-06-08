# Isekai Chronicles — Deployment Guide

## What you have

```
backend/
  server.js          ← the AI backend (runs on Railway)
  package.json       ← Node.js dependencies
  railway.toml       ← Railway config
  .gitignore
  public/
    index.html       ← the PWA (your phone app)
    manifest.json    ← makes it installable as an app
    sw.js            ← offline service worker
```

---

## Step 1 — Put the code on GitHub (free, 3 minutes)

1. Go to **github.com** → sign in or create account (free)
2. Click **New repository**
3. Name it `isekai-chronicles` → click **Create repository**
4. On the next page, click **uploading an existing file**
5. Drag and drop **all files** from the `backend/` folder
   - Make sure `public/` folder with `index.html` is included
6. Click **Commit changes**

---

## Step 2 — Deploy to Railway (free, 3 minutes)

1. Go to **railway.app** → sign in with GitHub (free)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `isekai-chronicles` repository
4. Railway auto-detects Node.js and deploys it
5. Wait ~60 seconds for the build to finish

### Add your API key (critical step)

1. Click your project in Railway
2. Go to **Variables** tab
3. Click **New Variable**
4. Name: `ANTHROPIC_API_KEY`
5. Value: your Anthropic API key (from console.anthropic.com)
6. Click **Add** — Railway restarts the server automatically

### Get your URL

1. Go to **Settings** tab in Railway
2. Click **Generate Domain**
3. You'll get a URL like `https://isekai-chronicles-production.up.railway.app`
4. **Copy this URL** — you need it in the next step

---

## Step 3 — Connect your phone app (1 minute)

1. Open Chrome on your Samsung S24 Ultra
2. Go to your Railway URL (e.g. `https://your-app.railway.app`)
3. The app loads — tap **Begin Your Legend**
4. Paste your Railway URL into the **Backend Server URL** field
5. Tap **Test Connection** — you should see ✓ Connected and ✓ API key set
6. Tap **Save & Continue**

### Install as a home screen app

1. In Chrome, tap the **⋮ menu** (three dots, top right)
2. Tap **Add to Home Screen**
3. Tap **Add**
4. The app icon appears on your home screen — tap it to launch like a native app

---

## How it works now

```
Your Phone (PWA)
      ↕  HTTPS
Your Railway Server  ←→  Anthropic API (Claude)
      ↕
  Your API key (safe, never leaves the server)
```

- Your API key lives only on Railway's server — never in the app
- The phone app talks to your server, which talks to Claude
- Full conversation context is maintained on the server per session
- Works offline for preloaded scenarios when you have no signal

---

## Railway free tier limits

- **500 hours/month** of runtime (enough for personal use)
- **$5 of credit** included when you verify with a card
- After that, costs ~$0.50–2/month for personal use

---

## Troubleshooting

**"Cannot reach server"**
- Check the URL has no trailing slash
- Make sure the Railway deployment finished (check the logs)
- Try the URL directly in your browser — you should see `{"status":"ok"}`

**"API key missing"**
- Double-check the Variable name is exactly `ANTHROPIC_API_KEY`
- Re-deploy after adding (Railway usually does this automatically)

**"No API credit"**
- Go to console.anthropic.com → Billing → Add payment method
- Even $5 is enough for weeks of play

**Narrator responses feel generic**
- The server maintains conversation context per session
- If you cleared the session, tap Settings → New Session to reset cleanly

---

## Updating the app

1. Edit files on GitHub (click the file → pencil icon)
2. Railway auto-detects the change and re-deploys in ~60 seconds
3. Refresh the app on your phone

---

*Built for Samsung S24 Ultra · Powered by Claude Sonnet*
