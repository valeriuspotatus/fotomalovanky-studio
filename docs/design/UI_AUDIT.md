# UI Audit — Fotomalovánky Studio (pre-redesign)

> A factual inventory of the current interface, the functionality that must survive the redesign,
> and the concrete reasons it does not yet read as a premium SaaS product. Line references are to
> the files as they stand today.

## Summary

The app is **two completely separate front-ends with no shared code**:

- **`dashboard.html`** (home, `GET /`) — a **light, playful, Czech** dashboard that mixes a live
  order board with hardcoded marketing content (creatives, "angles", a synthetic demand chart).
- **`index.html`** (`GET /review`) — a **dark, dense, English** operator tool: the real working
  surface (run pipeline, review grid, photo editor).

They share **zero CSS, zero JS**, use **different colour systems, status taxonomies, radii, fonts,
and even different languages**. Clicking "Generátor" jumps from one world to the other with no visual
continuity. Both are single self-contained files (inline `<style>` + inline `<script>`, vanilla JS,
no build step, no external CDN) served from `src/ui/static/` — a good technical baseline to keep.

## 1. Technical structure

| | `dashboard.html` | `index.html` (`/review`) |
|---|---|---|
| Size | 522 lines / ~31 KB | 1,302 lines / ~61 KB (the real tool) |
| CSS | inline, ~185 lines | inline, ~157 lines |
| JS | inline, ~250 lines | inline, ~1,088 lines (incl. a full canvas photo editor) |
| Data | `fetch('/api/studio')`, polled 2.5s **only** on orders/todo tabs | `fetch('/api/state')`, polled 1.5s + forced after each mutation |
| Rendering | manual DOM `el(t,c,h)` helper | template-string `innerHTML` with sophisticated repaint-avoidance (skeleton diff, caret preservation, queue-signature) |
| Shared code | **none** — each re-declares its own `esc()` (with *different* escape rules), its own `.chip`, its own status→colour map |

**Keep:** the dependency-free, no-build, self-contained, `127.0.0.1`-only posture, and `index.html`'s
careful poll-without-clobbering-input machinery. **Replace:** the duplication — there must be one
shared shell + token/component layer both screens (and the new ones) import.

## 2. Screens & views (all must be preserved)

**Dashboard (`/`)** — one `<main>` with a hash router over six views + a modal:
`#home` (hero + 6 nav tiles with live badges), `#creatives` (gallery + lightbox modal with
Feed/Čtverec/Story switch), `#angles` (message bubbles), `#calendar` (seasonal SVG chart + biweekly
lane), `#orders` (KPI strip + live queue), `#todo` ("Potřebuje vás" held list + draft emails). Only
`#orders`/`#todo` and two home badges are **live** (`/api/studio`); creatives/angles/calendar are
**hardcoded arrays**.

**Review (`/review`)** — one dense page: top status bar, the **Go bar** (folder path, Browse,
Go/Stop, "reprint" force), the **queue** (tick which orders to run), the **run log** + report, the
per-order **dedication editor**, the **intake-hold panel** (findings + drafted email), the **photo
tiles** (original+coloring, status pill, actions), a **lightbox**, the **photo editor** (white
pencil + crop, wheel-zoom, pan), and an **order-history** toggle.

## 3. Current design language (two systems)

- **Dashboard:** light-first with a full dark theme; `--bg:#EAEEF6`, `--card:#FFF`; **Nunito**
  rounded font (body 600, headings 800); **8+ distinct radii** (16/18/20/22/24/26/30/32 + 999 + 50%);
  heavy shadows (`0 30px 70px -22px`), blurred glow **blobs**, `translateY(-6px)` hover, `pop`/`fade`
  scale-in; **emoji nav** (🖍️🎨🎯📅📈✋); **rainbow wordmark**. Status = Czech `STATUS` map over
  `--red/blue/amber/green/teal/faint`.
- **Review:** dark-only (deliberate — white UI beside a white coloring page is wrong to stare at);
  `--bg:#14161a`; **system-ui** font; small radii (4–10px); subtle shadows; **inset-ring** status;
  **no icons** (text buttons). Status = English `LABEL` map over `--bad/good/hold/manual`. Many
  **untokenized ad-hoc greys** (`#2a2f38`, `#454c56`, `#343a45`, …).
- **Neither page has a spacing scale** — magic px throughout.

**Two status vocabularies collide:** the order board's amber "pending-review" and the review tool's
amber "manual repair" are the *same colour, unrelated meanings*. The redesign unifies status into one
token set (DESIGN_SYSTEM §2.3) while keeping the two *taxonomies'* distinct meanings (order-level vs
photo-level).

## 4. Functionality to preserve — checklist

Nothing below may be dropped. Each ties to its endpoint.

**Dashboard**
- Light/dark toggle persisted to `localStorage['fm-theme']`.
- Home tiles with live counts — `GET /api/studio` (`counts.total`, `needsYou.length`).
- Creatives gallery + modal + format switch (Feed 4:5 / Čtverec / Story) — static `creatives/graphics/*.svg`.
- Angles bubbles; Calendar seasonal chart + biweekly lane (horizontal scroll) — static.
- Orders KPI strip (ready-to-send, pending-review, held, generating, sent) — `counts`.
- Orders queue **oldest-first**, id + status + `eligible/total` + dedication — `orders[]`.
- Needs-you list: reason + read-only draft email + **Copy e-mail** (clipboard, execCommand fallback) — `needsYou[]`.
- Conditional 2.5s polling; keep last board on fetch failure.

**Review (operational core)**
- Type path + **Enter → scan** — `POST /api/_scan`.
- **Browse…** native OS folder picker — `POST /api/_pick-folder`.
- **Go** (auto-saves dedication first) — `POST /api/_run {inbox,force}`; **Stop** (cooperative) — `POST /api/_stop`.
- **"reprint finished PDFs"** force flag — in `_run`.
- Queue tick/untick, tick shown, tick none — `POST /api/_select`; show/hide, show all/recent; **newest-first**; auto-tick ≤ 8 (`AUTO_TICK_LIMIT`).
- Run log live lines + final report, scroll-pin — `run` object.
- **Dedication** edit (save on blur/Enter), **restore cleared**, source hints (shop/memory/filename), caret preserved across polls — `POST /api/<order>/dedication`.
- **Intake override "Generate it anyway"** — `POST /api/<order>/intake-override`; **Copy draft email**.
- Photo thumbnails (original+coloring, `?v=mtime`) — `GET /img/<order>/<base>/<original|coloring>`.
- **Approve / Reject / Redo / Handoff / "I've replaced it"** — `POST /api/<order>/<base>/<action>`.
- **Open generator** / **Open folder** — `POST /api/_open/...` (server-side; token never in DOM).
- **Photo editor**: white pencil (3–60), crop, wheel-zoom, pan (space/right/middle), Fit, Undo, Clear — `GET /svg/...` → `POST .../edit {strokes,crop}`; **Revert** — `.../revert`.
- **Lightbox**; **order-history** toggle (`inInbox:false`); live/disconnected indicator; toasts.
- Photo ordering **by attention** (failed→flagged→pending_review→manual→pending→ok→approved).
- **Locked-during-run**: all verdict controls disabled while `run.active` (server enforces; UI mirrors).
- Broken/unreadable image → labeled placeholder, not a broken-icon.

## 5. Why it doesn't read as premium SaaS ("gaming launcher" smells)

1. **Emoji as primary navigation** (🖍️🎨🎯📅📈✋) and toggle glyphs — reads as a consumer toy.
2. **Rainbow wordmark** split into four coloured spans — launcher branding.
3. **Heavy decorative effects** — blurred glow blobs, oversized shadows, lift-on-hover on every card, scale-in animations. Premium is restraint.
4. **Two disconnected design languages** — light rounded Nunito vs dark system-ui; radii 30px vs 8px; a jarring context switch between home and the tool.
5. **Two status colour systems / two languages** — Czech board vs English tool; same colours, different meanings.
6. **No spacing scale, 8+ radii, untokenized greys** — no rhythm or system.
7. **Marketing microsite bolted onto an ops tool** — fake progress bars and a synthetic demand chart mixed into an operations surface.
8. **Duplicated primitives that have drifted** — two `esc()` with different escape sets (a latent consistency risk), two `.chip` definitions.

## 6. API response shapes (bind the redesign to the same data)

- **`GET /api/studio`** → `{ orders[], counts{per-status + total}, needsYou[], inbox, run{active,orderId} }`.
  `orders[]` = `{orderId, dirName, inInbox, status(queued|generating|held|pending-review|ready-to-send|sent|failed), dedication, photos{total,eligible,held,pending,failed,ready}, reason, draftEmail}`, **sorted oldest-first**. Status keys must match the client map or render grey.
- **`GET /api/state`** → `{ orders[], inbox, outbox, run{active,stopping,orderId,lines[],error,report}, selected, queue[] }`.
  `orders[].photos[]` = `{base, status(ok|approved|flagged|pending_review|manual_in_progress|failed|pending), reason, builderEligible, holdsForReview, hasOriginal, hasColoring, hasSvg, edited, coloringVersion, busy}`.

Both are projections of the same underlying `reviewState` (`studio.js` derives order-level status from
the same `summary` the review page keeps per-photo). The redesign can bind both screens to **one status
model**, but must preserve the **two deliberate orderings** (board oldest-first; queue newest-first).

## 7. Audit verdict

The bones are good — a clean, dependency-free, security-conscious local server with two well-behaved
pages and a rich, battle-tested review tool. The problem is **cohesion**, not capability: there is no
shared system, and half the "product" is a playful microsite. The redesign is therefore a
**unification + re-skin + IA** job, not a rewrite of behaviour: build one design system and app shell,
rebind the existing endpoints, and restyle screen-by-screen while preserving every capability in §4.
