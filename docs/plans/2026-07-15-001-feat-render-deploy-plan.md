# Render deployment — migrate the studio to an always-on cloud host

**Goal:** reach the tool from anywhere, *including when David's PC is off*. That requirement (chosen 2026-07-15) is the only reason to host in the cloud rather than tunnel to the PC — a tunnel would be 5 min and free but dies when the PC sleeps.

**Platform:** Render (runs always-on services + persistent disks, unlike Vercel which is static/serverless-only). Free tier sleeps after 15 min → useless for an always-on automation tool; needs a **paid instance (~2 GB RAM for Chromium)** + a **persistent disk**. Ballpark **~$25/mo**.

## Decisions already made
- **Separate concern from fotomalovanky.cz** — no DNS/email migration of the business domain.
- **Email dropped in the cloud build.** Mail is cleanly gated by `config.mail.enabled`; with it off the app boots fine and only the Pošta inbox tile goes inert. The core value (Shopify orders → generate → WhatsApp delivery → ad calendar) uses **no email**. Proton Bridge is PC-only and has no cloud IMAP, so the inbox stays a PC-only feature (or a later, separate email-migration project).

## Known risks (accepted, with fallbacks)
- **WhatsApp from a datacenter IP** — the link is already fragile on David's own PC (see whatsapp-hang-fix / resume notes). A cloud IP raises disconnect/ban risk for the number that delivers to Jirka. Fallback: if the cloud IP misbehaves, keep WhatsApp delivery on the PC (hybrid) and run everything else on Render.
- **Customer photos move to a rented server** — the describe-then-generate privacy design kept pixels on David's machine. On Render, `inbox/`/`outbox/` live on the persistent disk. Acceptable per David's choice; note it.
- **No built-in auth on Render** — must add an app-level password before the public URL is live.

## Prerequisites / blockers
1. **No git remote, no `gh` CLI** — code must reach a **private** GitHub repo before Render can build. Long-standing open item.
2. Render account + paid plan + persistent disk + env secrets — David-side.

## Phased plan

### Phase 0 — Code to GitHub (David + me) ← START HERE
- David: `winget install GitHub.cli` then `gh auth login` (run via `!` so output lands in-session), **or** create an empty **private** repo on github.com and paste the URL.
- Me: `.gitignore` already protects secrets + customer data (verified 2026-07-15). Commit current tree, `git remote add origin`, push. MUST stay private (business + customer code).

### Phase 1 — Make it cloud-ready (me, code) — can build in parallel with Phase 0
- **`Dockerfile`** — base `mcr.microsoft.com/playwright:v1.48.0-jammy` (bundles Chromium + system deps for the Playwright PDF builder AND whatsapp-web.js). Node 20+. `npm ci`, copy app, `CMD node src/ui/server.js --no-open`.
- **`render.yaml`** — web service, Docker env, paid plan, `disk:` mounted (e.g. `/data`) for WhatsApp session + `inbox/`/`outbox/`, `healthCheckPath: /`, autoDeploy from main.
- **Bind for cloud** — `server.listen` currently hardcodes `127.0.0.1`; read host+port from env (`PORT`, `HOST=0.0.0.0`) with the localhost default preserved for local runs.
- **Secrets from env** — Gemini key, Shopify token, generator token-URL, etc. read from env vars in the cloud (keep `config.json` for local). Set `mail.enabled=false`, point `sessionDir`/`inbox`/`outbox`/`dataDir` at the mounted disk.
- **App password** — env-gated HTTP Basic Auth middleware in `server.js` (`STUDIO_USER`/`STUDIO_PASS`); off when unset so local is unchanged.

### Phase 2 — Render setup (David)
- Create account, connect the private repo, pick a ~2 GB always-on instance, add a persistent disk, set env secrets, deploy.

### Phase 3 — Bring-up (together)
- Open URL → log in → scan WhatsApp QR from the hosted page → run one test order end-to-end → decide WhatsApp's final home based on how the datacenter IP behaves.

## Status
- 2026-07-15: plan written. cloudflared was installed while exploring the tunnel option (harmless, can uninstall). Email-blocker investigated + dismissed.
- **Phase 0 DONE** — code pushed to the private repo `https://github.com/valeriuspotatus/fotomalovanky-studio` (commit d0905e4 caught up all uncommitted work; secret/PII sweep clean). `gh` 2.96.0 installed but push used Git Credential Manager (browser).
- **Phase 1 DONE + VALIDATED** (commit 659e385): server reads PORT/HOST from env; env-gated HTTP Basic Auth (STUDIO_USER/STUDIO_PASS) + unauthenticated /healthz; `Dockerfile` (Playwright base) + whitelist `.dockerignore`; `config.render.example.json`; `docs/RENDER.md`; `test/auth.test.js` (556 tests green). Docker image built locally (3.98 GB) and smoke-ran: boots in ~4s, reads mounted secret-file config, binds 0.0.0.0, gate returns 401/200 correctly. Validation image removed after.
- Also learned: the generator + builder are already `*.onrender.com` services (external HTTP), so the studio on Render just calls them — no PC dependency for line-art/PDF.
- **NEXT = Phase 2 (David):** follow `docs/RENDER.md` — create the Render web service from the repo (Docker auto-detected), pick a paid ~2 GB instance, add a `/data` persistent disk, set env (STUDIO_USER/PASS, FMA_CONFIG=/etc/secrets/config.json), add the cloud config.json as a Secret File, health check `/healthz`, deploy, then scan the WhatsApp QR from the hosted Objednávky tab. Then Phase 3 bring-up + watch the datacenter-IP WhatsApp risk.
