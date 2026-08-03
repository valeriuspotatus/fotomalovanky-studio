# Vendored: A4 Gallery Builder (offline backup)

Re-fetched **2026-07-31** from `https://fotomalovanky-service.onrender.com/` (David's own Render account).
First vendored 2026-07-16.

**Why this exists:** that Render service has **no connected repo** — it was deployed from an image/manual
upload, so there is no source anywhere to redeploy from. If the service is deleted, the builder is gone.
These files are the whole client app, so **this directory is the builder's only source of truth.**

> **The 2026-07-16 snapshot took the six code files and none of the assets.** A restore from it would
> have produced books with no borders, no logo and no footer — the exact disaster this directory exists
> to prevent, silently. The page-shell check that verified it (`0 failed requests`) could not have caught
> that: the assets are only requested when `app.js` renders a cover, which loading the shell never does.
> **If you re-vendor, fetch the assets too, and check a rendered page and not just the shell.**

| file | bytes | from |
|---|---|---|
| `builder.html` | 5 509 | `GET /` |
| `styles.css` | 36 976 | `GET /styles.css` |
| `app.js` | 69 411 | `GET /app.js` |
| `tuning.js` | 70 910 | `GET /tuning.js` |
| `cover-layout.js` | 8 850 | `GET /cover-layout.js` |
| `collage-layout/collage-layout.js` | 32 193 | `GET /collage-layout/collage-layout.js` |
| `logo.svg` | 74 879 | `GET /logo.svg` |
| `logo-horizontal.svg` | 75 160 | `GET /logo-horizontal.svg` |
| `logo-de.svg` | 91 221 | `GET /logo-de.svg` — the German mark |
| `cover-border.svg` | 45 204 | `GET /cover-border.svg` |
| `bg-border.svg` | 252 | `GET /bg-border.svg` |
| `icon-heart.svg` | 1 790 | `GET /icon-heart.svg` |
| `icon-cz-flag.svg` | 742 | `GET /icon-cz-flag.svg` |

Verified 2026-07-31 over `python3 -m http.server`: all 13 files serve 200, and every `./asset`
referenced by the vendored JS and CSS is present in this directory.

## What changed between the two snapshots

The live builder gained a **CZ/DE output-language toggle** (`#langToggle`, `.lang-btn[data-lang]`)
after the first snapshot. In DE mode it swaps the cover/last/collage logo for `logo-de.svg`, scales
that logo's width on the pencils cover so it matches the CZ logo's *height*
(`LOGO_DE_ASPECT_RATIO = 429/200` in `cover-layout.js` — DE is vertical-only, there is no horizontal
DE asset), and drops the Czech "Vyrobeno s ❤️ v 🇨🇿" title-page footer. The toggle is UI-only state
that resets to CZ on every page load, which is why `src/builder/builderDriver.js` has to select it
per order rather than relying on a remembered setting.

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
