# Application Information Architecture — Fotomalovánky Studio

> How the redesigned application is organised: the navigation model, the modules and their screens,
> the routes, the unified status model, and how modules connect (today and in future). This is the
> map the screen-by-screen redesign builds against.

## 1. Product framing

One coherent **internal operating system** for running Fotomalovánky — a *creative production
studio*, not an ERP and not a marketing microsite. Every screen shares one shell, one design system
(see `DESIGN_SYSTEM.md`), one status vocabulary, and **one language: Czech** (the operator is Czech
and the concept is Czech; the current English review tool is unified into Czech — see §7).

The application must always answer, within one second: *What needs attention? What is happening
today? What is next? Where do I click?*

## 2. Global shell

Every route renders inside a persistent shell:

- **Sidebar (248px, fixed):** wordmark → primary nav → footer (user chip, theme toggle, logout).
  Nav items are icon (Lucide) + label; the active item is brand-soft highlighted. A subtle line-art
  motif sits above the footer.
- **Top bar (per content area):** page title + subtitle on the left; global **search (⌘/Ctrl-K)**,
  **notifications**, and **theme toggle** on the right. Search is a command palette (jump to any
  order, screen, or action).
- **Content area:** fluid, max-width 1440 centred, `--sp-8` gutters.

The shell, sidebar, top bar, and command palette are **shared components** rendered once and reused
by every screen — replacing today's two disconnected pages.

## 3. Primary navigation (modules)

| # | Module | Icon | Route | Purpose |
|---|---|---|---|---|
| 1 | **Přehled** (Today's Studio) | `home` | `/` | Operational home — what needs attention now |
| 2 | **Objednávky** (Orders) | `shopping-bag` | `/orders` | The order production pipeline |
| 3 | **Generátor** (Generator) | `wand-2` | `/generator` | The generation run: pick folder, Go/Stop, live queue + log |
| 4 | **Kreativy** (Creatives) | `palette` | `/creatives` | Marketing creative gallery |
| 5 | **Sdělení** (Messaging) | `megaphone` | `/messaging` | Campaign angles / messaging |
| 6 | **Kalendář** (Calendar) | `calendar` | `/calendar` | Operational month/week/day calendar |
| 7 | **Potřebuje vás** (Needs You) | `hand` | `/needs-you` | Everything blocked on the operator |
| — | **Nastavení** (Settings) | `settings` | `/settings` | Folders, theme, integrations, tokens |

Order **Review** is not a top-level nav item; it is the detail view of an order (§4.2).

## 4. Screen inventory & regions

### 4.1 Přehled — "Dnešní studio" (`/`)
Title **"Dobrý den, David!"**, subtitle "Tady je přehled toho, co se dnes děje ve studiu."
Regions (top → bottom, work rail 2/3 + calendar rail 1/3 on ≥1440):
- **KPI row** — 5 metric cards, each a link to its filtered view: *Nové objednávky*, *Generuje se*,
  *Potřebuje pozornost*, *Připraveno pro PDF*, *Dokončeno dnes*. Data: `/api/studio` `counts`.
- **Pokračovat v práci** — a "continue working" rail: the most actionable order (e.g. `#1524 · 4/4
  schváleno · Připraveno pro PDF` → *Dokončit PDF*) + the generation queue (N running jobs → *Zobrazit
  frontu*). Data: `/api/studio` + `/api/state` `run`.
- **Nástroje studia** — a grid of module shortcuts (Generátor, Kreativy, Sdělení, Kalendář,
  Objednávky, Potřebuje vás).
- **Poslední objednávky** — a compact recent-orders table (id, product, pages, status chip, updated).
  Data: `/api/studio` `orders` (newest slice).
- **Calendar rail** — a mini month + **Nadcházející události** (upcoming) list. Data: calendar store.

### 4.2 Objednávky (`/orders`) + Order detail / Review
- **List/pipeline** (`/orders`): every order as a production row — status, progress
  (`eligible/total`), priority, last activity, ETA. Filter tabs (all / needs-you / generating /
  ready / done) + search. Oldest-first by default (preserve `/api/studio` ordering). Row → detail.
- **Order detail / Review** (`/orders/:id`): the current `/review` per-order experience, in **two
  modes** (a tab in the sticky header):
  - **Přehled (Overview)** — the grid of every generated page (today's photo tiles).
  - **Detail (Focus)** — large side-by-side: **original ↓ generated coloring page**, on a light
    paper background, with **Schválit / Generovat znovu / Ruční úprava / Zamítnout** below.
  - **Sticky header:** order number, progress, product, **Uložit**, **Vytvořit PDF**.
  - Hosts every review capability from `UI_AUDIT §4`: dedication editor, intake-hold panel + drafted
    email, per-photo actions, the photo editor (pencil/crop), lightbox, revert. Same endpoints.

### 4.3 Generátor (`/generator`)
The **run pipeline** controls, today embedded in `/review`, given their own home (this is also the
manual "open + Go" fallback the autopilot plan must keep working):
- **Vstupní složka** (folder path + **Procházet…** native picker) — `_pick-folder`, `_scan`.
- **Fronta** (queue): orders found, tick which to run — `_select`; auto-tick ≤ 8.
- **Spustit / Zastavit** (Go/Stop) + "znovu vytisknout hotové PDF" force — `_run` / `_stop`.
- **Živý průběh** (run log + report) — `run` object.
- **Otevřít generátor** (external tool) — `_open/generator` (server-side; token never in the page).

### 4.4 Kreativy (`/creatives`)
The creative gallery + lightbox with Feed 4:5 / Čtverec / Story switch. Data: static
`creatives/graphics/*.svg` today (unchanged); architected so a creative can later link to a campaign
and a calendar event.

### 4.5 Sdělení (`/messaging`)
Campaign angles / messaging (today's static "angles"). Kept as a module; content later becomes
data-driven and linkable to creatives + calendar.

### 4.6 Kalendář (`/calendar`)
A **real calendar**, not a chart (replaces today's SVG demand graph):
- **Views:** Měsíc (default) / Týden / Den; nav **Předchozí / Dnes / Další**.
- **Events in-grid**, coloured by **type**: Creative, Campaign, Meeting, Reminder, Deadline,
  Production, Shipping, Testing, Freeze, Peak, Holiday, Personal (each a distinct colour).
- **Event status:** Draft / Scheduled / In Progress / Waiting / Ready / Completed / Overdue /
  Cancelled.
- **Event detail** opens a **side panel** (no navigation away): title, owner, status, priority, dates,
  checklist, notes, attachments, related creatives, related orders, activity history.
- **Side rails:** **Dnešní úkoly** (Today — Linear "My Issues" feel), **Nadcházející** (Tomorrow /
  This Week / Next Week / Later), **Aktuální sezóna** (Testing/Freeze/Peak + objectives + focus),
  **Chytré tipy** (smart insight cards — "Tři termíny v pátek", "Kampaň začíná zítra", …).
- Data: a new lightweight calendar store (see §6). The seasonal demand data becomes "Aktuální sezóna".

### 4.7 Potřebuje vás (`/needs-you`)
Everything blocked on the operator, unified: **held orders** (intake findings + drafted customer
email + Copy) and, in future, overdue calendar tasks, ownerless creatives. Data: `/api/studio`
`needsYou` today. Each item deep-links to the relevant order/review.

### 4.8 Nastavení (`/settings`)
Input/output folders, theme, and (future) integration config — the Shopify token status, autopilot
schedule, RunPod spend estimate. No secret is ever rendered; status only.

## 5. Unified status model

One status token set (DESIGN_SYSTEM §2.3) expresses two *taxonomies* that keep their distinct
meanings:

- **Order-level (board):** `queued` · `generating` · `held` · `pending-review` · `ready-to-send` ·
  `sent` · `failed` → neutral · running · danger · warning · info · success · danger. (Czech labels:
  ve frontě / generuje se / potřebuje vás / ke kontrole / připraveno pro PDF / odesláno / chyba.)
- **Photo-level (review):** `ok` · `approved` · `flagged` · `pending_review` · `manual_in_progress`
  · `failed` · `pending` → neutral/success · success · danger · info · warning · danger · neutral.

The same chip component renders both; the taxonomy→token maps are the single source of truth (no
per-page colour logic). This resolves today's collision where board-amber and review-amber meant
different things.

## 6. Data & routing architecture

- **Routing:** a single shared client router in the shell (keep vanilla — no framework/build). Paths
  above are logical; implementation may use the History API or hash. Server keeps serving the static
  shell for app routes; the existing `/api/*` endpoints are unchanged.
- **Existing data:** `/api/studio` (board) and `/api/state` (review) are reused verbatim — the
  redesign rebinds, it does not rewrite behaviour.
- **New data (calendar):** a small local JSON-backed store (events with type/status/dates/relations)
  behind a new `/api/calendar` — the only genuinely new backend. Everything else is presentation.
- **Reuse rule:** no business logic (`src/orchestrator.js`, `review.js`, `studio.js`, `ingest.js`,
  builder/generator) is rewritten. The redesign is shell + tokens + components + rebind.

## 7. Cross-module relationships & future integrations

- **KPI → filtered Orders:** each dashboard metric links to `/orders` pre-filtered.
- **Needs You → Review:** each held item deep-links to that order's Review Focus mode.
- **Calendar ↔ everything:** events relate to Orders, Creatives, Messaging, Needs You, Production.
  Eventually **an order automatically creates calendar milestones** (paid → production → shipping),
  and a creative links to the campaign event that ships it. The event side panel is designed for these
  relations from day one (related orders / related creatives fields), even before they're populated.
- **Autopilot (overnight):** the morning summary surfaces on **Dnešní studio** (what generated
  overnight, what's held, what failed, RunPod spend) and feeds the KPI row — see the autopilot plan.

## 8. Open IA decisions (confirm with David)

1. **Language unification to Czech** across the review tool (currently English). Recommended for one
   coherent product; it's a string-level change, no logic. *(Default: yes, Czech.)*
2. **Generator as its own module vs staying inside Review.** Recommended split (§4.3) so Review is
   purely per-order and Generator owns the batch run. *(Default: split.)*
3. **Creatives/Messaging/Calendar content** currently hardcoded — keep as static-but-restyled now,
   make data-driven later. *(Default: restyle now, data-drive in a later phase.)*
