# Overnight Autopilot — setup & operation

The autopilot watches Shopify for new **paid** photo orders and runs them through the normal pipeline
overnight, so finished books are waiting for you to review in the morning. It **never sends anything**
— it stops at "ready for review", exactly where you'd stop it by hand. The two human steps (approving
the line-art and framing a cover) stay yours.

Worst case on any given morning is "a few orders sitting in review", never bad output sent anywhere.

---

## How it works

A Windows Scheduled Task runs `node src/autopilot.js` every ~15 minutes. Each run:

1. Polls the Shopify Admin API for orders updated in the last few days.
2. Keeps the **paid** ones that have photos and haven't already been finished.
3. Downloads their photos into the inbox and writes the `objednavka.json` sidecar — the same shape the
   Chrome extension produces.
4. Runs the existing pipeline over just those orders (intake QC → generate → review gate → PDF).
5. Writes a **night report** the dashboard reads for its morning banner.

Held orders (a customer uploaded too few/blurry photos) are re-checked every run, so if the customer
re-uploads overnight the hold lifts on its own. Failed orders are retried. Finished ("ready") orders
are remembered and never re-run.

---

## One-time setup

### 1. The Shopify token

The autopilot needs a `read_orders` Admin API token. It's a **full-store credential** — anyone with it
can read every order's customer data — so it lives **outside** the committed code, one of two ways:

- In `config.json` under `shopify.accessToken`, **or**
- In an environment variable `FMA_SHOPIFY_TOKEN` (takes over when the config field is left blank).

`config.json` is gitignored and never committed. Pick whichever is easier; the env var is tidier if you
don't want the token in a file at all.

### 2. Turn the autopilot on in `config.json`

Copy the `shopify` block from `config.example.json` and fill it in:

```json
"shopify": {
  "enabled": true,
  "storeDomain": "aqi8it-7n.myshopify.com",
  "accessToken": "shpat_…",          // or leave "" and set FMA_SHOPIFY_TOKEN
  "apiVersion": "2026-07",
  "photoHostAllowlist": ["cdn.tigren.com"],
  "estSpendPerOrder": 0.3             // rough $/order, for the morning spend line
}
```

With `enabled: false` (the default) the autopilot exits immediately and does nothing — the manual flow
is completely unaffected.

### 3. Teach the format map the two layouts

An order's galerie-vs-full-page layout comes from the Shopify **`Rozvržení`** attribute, not the
product variant. Make sure `delivery.formatMap` in `config.json` maps both values (they're already in
`config.example.json`):

```json
"delivery": {
  "formatMap": {
    "🖼️ Galerie (vaše fotka vedle omalovánky)": "gallery",
    "📄 Celostránková omalovánka (plná stránka pro vybarvování)": "fullpage"
  }
}
```

Without these, autopilot orders build in the default layout instead of the one the customer chose.

### 4. Register the scheduled task

From the repo root, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File tools\installAutopilotTask.ps1
```

It's safe to re-run any time (it just replaces the task). Change the interval with
`-IntervalMinutes 15`, or remove the task with `-Remove`.

### 5. Keep the machine awake **and** up

A sleeping or rebooting machine runs nothing. On this always-on Windows box:

- **Disable sleep** (Settings → System → Power & sleep → "Sleep" = Never on mains), or enable wake
  timers so the task can wake the machine.
- **Windows 10 Home forces updates and can auto-reboot.** Set **active hours** to cover the night
  (Settings → Update & Security → Change active hours), or pause updates, so a 3am reboot doesn't kill
  an in-flight run. The morning banner's "last run HH:MM" is your tell — if it's hours stale, the
  machine slept or rebooted.

### 6. Verify it works

Trigger one run by hand and watch the dashboard:

```powershell
Start-ScheduledTask -TaskName FotomalovankyAutopilot
```

Open the studio home — the **"Přes noc"** banner shows what the run detected (ready / needs-you /
failed, last-run time, estimated spend). The first time, also open one finished PDF to eyeball it.

---

## Living with it

### Spend

Every order runs on the paid RunPod GPU, so **autopilot running = autopilot spending**. There is **no
nightly cap** by design — it runs every paid photo order. The morning banner shows the estimated spend
(`orders that generated × estSpendPerOrder`) so an abnormal night is visible. If a runaway night ever
happens, a cap is a small follow-up; the spend line is the trigger to reconsider.

### Data lifecycle (PII)

The night report and the handled-order state hold order numbers and timestamps. They live in the
outside-repo data dir (`shopify.dataDir`, default `%LOCALAPPDATA%\fotomalovanky\autopilot`), are
gitignored, and **age out on the same `retentionDays` clock as the photos** — `npm run purge` clears
them once the autopilot has been dormant that long. The customer photos it downloads are the normal
inbox/outbox photos and are covered by the existing purge.

### Rotating or revoking the token

The token is a full-store credential — treat rotation as routine hygiene, and revoke **immediately** on
any suspected leak:

1. In the Shopify Dev Dashboard, open the app that issued the token and **revoke / uninstall** it (or
   rotate its credentials). The old token stops working at once.
2. Issue a new `read_orders` token (the same flow used to get the first one — Shopify CLI + classic
   OAuth, `scopes="read_orders"`).
3. Put the new token in `config.json` (`shopify.accessToken`) or the `FMA_SHOPIFY_TOKEN` env var.
4. Run `Start-ScheduledTask -TaskName FotomalovankyAutopilot` to confirm the next poll authenticates.

Nothing else changes — no code edit, no re-register.

### Moving to a dedicated laptop

It's a drop-in: clone the repo, copy `config.json`, install Node, and run the same
`installAutopilotTask.ps1`. Apply the same sleep/wake + Windows Update settings.

---

## Troubleshooting

| Symptom in the morning | What it means | What to do |
| --- | --- | --- |
| Banner "last run" is hours stale | The machine slept, rebooted, or was off | Check sleep + Windows Update active hours (step 5) |
| No banner at all | No night report yet — autopilot never ran, or is disabled | Check `shopify.enabled` and the token; run the task by hand |
| An order shows "needs manual pull" | Its photos couldn't be downloaded from the CDN | Pull that order the manual way (the extension) |
| An order stuck "needs you" for days | Customer hasn't re-uploaded corrected photos | Email them; it can't lift until they do |
| Run log says "inert" | `shopify.enabled: false` or no token resolved | Enable it / set the token, then re-run |

The autopilot only ever **adds** finished books to your review queue. If it's ever misbehaving, set
`shopify.enabled: false` (or `-Remove` the task) and you're back to the fully manual flow with nothing
lost.
