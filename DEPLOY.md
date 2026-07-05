# Wave3 — Deploying to the internet (Render + Turso)

This puts the Wave3 store online at a public link, for free.
The database (orders, stock, money, screenshots, QR codes) lives in **Turso**.
The app runs on **Render**. They talk to each other via two secret values.

You do this once. After that, every time you push code, Render redeploys automatically.

---

## Part A — Get your Turso connection details

1. Go to your Turso dashboard → open the **wave3** database (Tokyo region).
2. Copy the **Database URL** — it looks like:
   `libsql://wave3-jhonb.aws-ap-northeast-1.turso.io`
3. Create a **token** for the database (button is usually "Create Token" / "Generate Token").
   Copy the long token string. **Keep it secret** — treat it like a password.

You now have TWO values:
- `DATABASE_URL`   = the libsql:// address
- `DATABASE_AUTH_TOKEN` = the token

---

## Part B — Put the code on GitHub

From the `wave3` folder, in a terminal:

```bash
git init
git add .
git commit -m "Wave3 store"
git branch -M main
git remote add origin https://github.com/jhon-hub-work/wave3.git
git push -u origin main
```

(Create the empty `wave3` repo on GitHub first, at github.com/new — no README, no .gitignore,
it's already included here.)

> `.gitignore` already excludes `node_modules/`, `data/`, `uploads/`, and `.env`,
> so your local test database and any secrets are NOT uploaded. Good.

---

## Part C — Deploy on Render

1. Go to **render.com** → **New +** → **Web Service**.
2. Connect your GitHub and pick the **wave3** repo. (Authorize Render on GitHub when asked —
   a different email on GitHub is fine.)
3. Render should auto-detect the settings from `render.yaml`. If it asks, set:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
4. Before the first deploy, open **Environment** and add the two variables from Part A:
   - `DATABASE_URL` = your libsql:// url
   - `DATABASE_AUTH_TOKEN` = your token
5. Click **Create Web Service**. Wait ~2–3 minutes for the first build.

When it's live you'll get a link like `https://wave3.onrender.com`.
- Store (share this with customers): `https://wave3.onrender.com`
- Admin dashboard (you only): `https://wave3.onrender.com/admin`

The first time the app boots against the empty Turso database it creates all the tables and
loads your starting products, stock, and payment channels automatically.

---

## Part D — First things to do once it's live

1. Open `/admin`, log in with `wave3admin`, and **change the password** in Settings.
2. Upload your real **GCash / bank QR codes** on each payment channel, then **Save all settings**.
3. Add your **contact channels** (Messenger, Telegram, etc.) in Settings.
4. Place one test order end-to-end, mark it paid, then cancel it to restock.

---

## Good to know

- **Free Render sleeps after ~15 min idle.** The first visitor after a quiet spell waits
  ~30–60 seconds while it wakes up. To reduce this, set up a free uptime pinger
  (e.g. UptimeRobot) to hit your store link every 10 minutes.
- **Admin login resets when the server sleeps/restarts** — just log in again.
- **Backups:** Turso keeps your data safe and has its own backups. Your local `data/` folder
  is only for testing and is not used in production.
- **To change anything later:** edit code locally, `git add . && git commit -m "..." && git push`.
  Render redeploys within a couple of minutes.
