# Family Register

A private family tree: add people, link them, and see how anyone connects to anyone else.
React + Vite, no backend. Everything is stored in the browser on your device.

## Run it locally

```bash
npm install
npm run dev
```

Opens at http://localhost:5173

## Deploy to Vercel

### Option A — from your terminal (fastest)

```bash
npm i -g vercel
cd family-tree
vercel
```

Answer the prompts (accept the defaults — Vercel detects Vite on its own).
When you're happy with the preview URL:

```bash
vercel --prod
```

### Option B — from GitHub

1. Push this folder to a new GitHub repository.
2. Go to vercel.com/new and import that repository.
3. Leave every build setting as detected:
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Output directory: `dist`
4. Click **Deploy**.

Every push to your default branch redeploys automatically.

## Add it to your phone's home screen

Open the deployed URL in Safari or Chrome, then Share → **Add to Home Screen**.
It launches full-screen without browser chrome.

## Where the data lives

The register is saved to `localStorage` under the key `familyRegister:v2` — on the
device and browser you used. That means:

- Nothing is uploaded anywhere. No account, no server, no one else can read it.
- It does **not** sync between your phone and your laptop.
- Clearing your browser data erases it.

Use **Save a copy** (the download icon) to export a JSON file with everyone and their
photos, and **Load a copy** to restore it or move it to another device. Do this
occasionally — it's your only backup.

## If you want it to sync across devices later

You'd need somewhere to keep the data outside the browser. The change is contained:
the `store` object at the top of `src/App.jsx` is the only place that touches storage.
Swap its `get` and `set` for calls to Vercel Postgres, Supabase, or Firebase and the
rest of the app is unchanged. Add authentication at the same time — otherwise your
family's records would be readable by anyone with the URL.

## Project layout

```
index.html                  page shell, viewport and theme colours
public/favicon.svg          app icon
public/manifest.webmanifest home-screen install settings
src/main.jsx                React entry point
src/App.jsx                 the whole app: data model, relationship
                            engine, layout, and UI
```
