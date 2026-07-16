# Vendored: A4 Gallery Builder (offline backup)

Fetched **2026-07-16** from `https://fotomalovanky-service.onrender.com/` (David's own Render account).

**Why this exists:** that Render service has **no connected repo** — it was deployed from an image/manual
upload, so there is no source anywhere to redeploy from. If the service is deleted, the builder is gone.
These six files are the whole client app, so **this directory is now the builder's only source of truth.**

| file | bytes | from |
|---|---|---|
| `builder.html` | 5 191 | `GET /` |
| `styles.css` | 36 192 | `GET /styles.css` |
| `app.js` | 66 843 | `GET /app.js` |
| `tuning.js` | 70 910 | `GET /tuning.js` |
| `cover-layout.js` | 8 467 | `GET /cover-layout.js` |
| `collage-layout/collage-layout.js` | 32 193 | `GET /collage-layout/collage-layout.js` |

## ⚠ It must be SERVED over HTTP — `file://` gives a dead shell

`builder.html` loads its scripts by **absolute** path (`/app.js`, `/tuning.js`, …). Opened as a file those
resolve to the drive root, so nothing loads: the page still renders its header and buttons (they are plain
HTML), which makes it **look fine while being completely inert**. Don't be fooled — serve it:

```sh
cd vendor/builder && python -m http.server 8791   # → http://localhost:8791/builder.html
```

Verified this way 2026-07-16: 4 scripts loaded, **0 failed requests, 0 page errors**, `#printBtn` correctly
disabled until pairs load, `#folderInput` / `#titleInput` / 2 `.mode-btn` all present.

## What this copy does and does not restore

- ✅ **The folder → A4 PDF flow, completely.** It calls no server: `#folderInput` (`webkitdirectory`) reads a
  local folder, pairs `<base>.jpg` + `<base>.svg`, and exports through the browser's print pipeline
  (`window.print()` / Playwright `page.pdf()`). This is the flow `src/builder/builderDriver.js` drives.
- ❌ **Not the `/api/session/{id}` routes.** Those are server-side and live on the deployed service; the only
  same-origin `fetch` in the whole bundle hits them, and only on the `/session/{id}` URL. Our pipeline never
  uses them, so nothing is lost for automation — but a restore from this directory would be static-only.
- ⚠ **DM Sans is not vendored** — `builder.html` pulls it from Google Fonts. With no network the font falls
  back, which can shift text metrics and therefore **page layout in the PDF**. Vendor the woff2 if that ever
  matters (see `docs/spikes/2026-07-09-u5-builder.md` for the page-count formula this would affect).

Provenance and the full builder contract: `docs/spikes/2026-07-09-u5-builder.md`.
