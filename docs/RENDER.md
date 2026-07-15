# Deploying the studio to Render (always-on, reachable when your PC is off)

This runs the whole studio on Render instead of your PC, so you can open it from anywhere — including
when your PC is off. Your generator + builder are already `*.onrender.com` services, so the studio just
calls them. **Mail is off in the cloud** (Proton Bridge only runs on your PC); everything else works.

**Before you start:** the code is on GitHub (done), and you have a Render account (render.com — sign up
free, then you'll pick a paid instance below).

**Cost:** ~$25/mo. The free tier sleeps after 15 min of no traffic, which would stop the order automation
— so this needs a paid always-on instance + a small persistent disk.

---

## 1. Create the web service
- Render dashboard → **New +** → **Web Service**
- Connect your GitHub and pick the **`fotomalovanky-studio`** repo
- Render detects the **Dockerfile** automatically (Runtime = Docker). Leave the build/start commands blank
  — the Dockerfile handles them.

## 2. Instance type — pick a PAID one
- Choose an instance with **~2 GB RAM** (Chromium for WhatsApp + the PDF builder needs it).
- **Do NOT pick Free** — it sleeps after 15 min and the automation would stop.

## 3. Add a persistent disk (so data survives restarts)
- In the service settings → **Disks** → **Add Disk**
- **Mount path:** `/data`
- **Size:** 5 GB is plenty
- Without this, the WhatsApp login + finished books would vanish on every redeploy.

## 4. Environment variables
Add these under **Environment**:

| Key | Value |
|-----|-------|
| `STUDIO_USER` | a username you choose (the login for the site) |
| `STUDIO_PASS` | a strong password you choose |
| `FMA_CONFIG` | `/etc/secrets/config.json` |
| `FMA_SHOPIFY_TOKEN` | *(optional)* your Shopify read_orders token, if you'd rather not put it in the config file |

`PORT` and `HOST` are handled automatically — don't set them.

⚠️ **`STUDIO_USER` + `STUDIO_PASS` are the only thing protecting the public URL** (it controls your books,
WhatsApp, and orders). Pick a real password.

## 5. Add the config as a Secret File
- Service settings → **Secret Files** → **Add Secret File**
- **Filename:** `config.json`
- **Contents:** copy `config.render.example.json` from the repo, and replace every `COPY_FROM_LOCAL_config.json`
  placeholder with the real value from your local `config.json` (the generator token URL, builder URL,
  Gemini API key, Shopify token, Jirka's WhatsApp recipient).
- Render mounts it at `/etc/secrets/config.json` — which is what `FMA_CONFIG` above points to.

## 6. Health check path
- Settings → **Health Check Path:** `/healthz`

## 7. Deploy
- Click **Create Web Service** (or **Manual Deploy**). First build takes several minutes (it downloads the
  browser image).
- When it's live, open the Render URL → your browser asks for the **username/password** from step 4.
- Go to the **Objednávky** tab and **scan the WhatsApp QR** once (the cloud server has its own session; your
  PC's link is separate).

---

## After it's up
- **Watch WhatsApp for a few days.** Running from a datacenter IP is the real risk — if the number keeps
  disconnecting or gets flagged, the fallback is to keep WhatsApp delivery on your PC and let Render do
  everything else. (Everything else — orders, generation, ad calendar — is unaffected.)
- **Redeploys** happen automatically when you push to `main`. The `/data` disk (WhatsApp session, books)
  survives them.
- **The Pošta inbox tab** shows "not configured" in the cloud — that's expected (mail stays on your PC).
