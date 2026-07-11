# Redesign Roadmap — Fotomalovánky Studio

> The incremental plan to take the app from two disconnected pages to one coherent, premium studio.
> **Principle: re-skin and unify, don't rewrite.** No business logic changes (`orchestrator.js`,
> `review.js`, `studio.js`, `ingest.js`, builder/generator stay as-is); the existing `/api/*`
> endpoints are rebound, not replaced. Ship screen-by-screen so the app is usable at every step.

## Guardrails (apply to every phase)

- **Preserve every capability** in `UI_AUDIT.md §4`. A screen isn't done until its checklist passes.
- **Same endpoints, same data.** Bind to `/api/studio` and `/api/state` verbatim; preserve the two
  orderings (board oldest-first, queue newest-first) and the locked-during-run behaviour.
- **No external CDNs.** Self-host fonts + icons under `static/` (CSP/offline posture).
- **No build step.** Stay vanilla HTML/CSS/JS, progressively enhanced, served from `static/`.
- **Backend tests stay green.** `npm test` + `npm run smoke` must pass unchanged after every phase
  (they don't cover the static HTML; UI changes must not touch server behaviour). Each screen also
  gets a **manual smoke** against its functionality checklist.
- **Cut over safely.** Build new screens behind the shell and route to them once at parity; keep the
  old page reachable (e.g. `/legacy`) until the replacement is verified, then remove.

---

## Phase 0 — Foundation (design system + app shell)

*No feature change; everything after this consumes it.*

- **Tokens & components:** `static/css/tokens.css` (all custom properties, light + dark from
  `DESIGN_SYSTEM.md`) and `static/css/components.css` (button, card, chip, KPI, table, tabs, input,
  side panel, dialog, nav, toast, empty state).
- **Fonts & icons:** self-host **Fredoka / Manrope / JetBrains Mono** as `woff2` under
  `static/fonts/`; inline **Lucide** set under `static/icons/` (only icons used).
- **Shared shell:** one `shell` partial (sidebar nav + top bar + theme toggle + user chip + command-
  palette skeleton) and a tiny shared client router + fetch/`esc` helpers, replacing the duplicated
  primitives. Dark-mode plumbing via `data-theme` + `localStorage`.
- **Verify:** shell renders, nav routes, theme toggles, tokens resolve in both themes; served-tree
  containment check still passes; `npm test`/`smoke` green.

## Phase 1 — Přehled / "Dnešní studio" (flagship)

*The screen in the concept mockup; highest daily value and the identity-setter.*

- Rebuild the home (`/`) inside the shell: **KPI row** (5 linked metrics), **Pokračovat v práci**
  (continue-order + generation queue), **Nástroje studia** grid, **Poslední objednávky** table,
  **Calendar rail + Nadcházející**. Bind to `/api/studio` (+ `/api/state` `run` for the queue card).
- Keep the 2.5s conditional polling + keep-last-on-failure behaviour.
- **Verify:** live counts match `/api/studio`; every KPI links to its filtered view; recent-orders
  chips use the unified status tokens; passes on 2560/1920/1600 widths.

## Phase 2 — Objednávky + Order Review (operational core)

*The biggest, most careful phase — the review tool is the tool. Restyle, don't rewrite.*

- **Orders list** (`/orders`): production-pipeline rows (status, progress, priority, last activity,
  ETA), filter tabs + search, oldest-first. Row → Review.
- **Order Review** (`/orders/:id`): move `index.html`'s logic into the shell **unchanged** (keep the
  poll-without-clobber machinery, canvas photo editor, caret preservation), restyle the markup/CSS to
  the design system. Add the **Overview / Focus** mode tab and the **sticky header** (order #,
  progress, product, Uložit, Vytvořit PDF). Focus mode = large original ↓ generated on paper bg +
  Schválit / Generovat znovu / Ruční úprava / Zamítnout.
- Preserve **all** review endpoints/actions (approve/reject/redo/handoff/replaced/edit/revert,
  dedication, intake override, lightbox, order history, attention ordering, locked-during-run).
- **Verify:** every action in the `UI_AUDIT §4` review checklist works against the same endpoints; a
  real order runs through generate → review → PDF unchanged.

## Phase 3 — Generátor

- Give the run pipeline its own module (`/generator`): folder path + **Procházet…** native picker,
  **Fronta** (tick to run), **Spustit/Zastavit** + reprint force, **Živý průběh** log + report,
  **Otevřít generátor**. This is also the manual "open + Go" fallback the overnight-autopilot plan
  depends on — keep it fully working. Reuses `_scan`/`_select`/`_run`/`_stop`/`_pick-folder`/`_open`.
- **Verify:** a folder scans, ticks, runs, stops, and logs exactly as today; autopilot's manual
  fallback path is intact.

## Phase 4 — Kalendář

*The one phase with genuinely new backend.*

- Real **month/week/day** calendar (month default), **Předchozí/Dnes/Další**, in-grid events coloured
  by **type**, with **status**, an **event side panel** (relations included), and the side rails:
  **Dnešní úkoly**, **Nadcházející**, **Aktuální sezóna**, **Chytré tipy**.
- New `/api/calendar` over a small local JSON store (events: type, status, dates, owner, checklist,
  relations). Seed from today's seasonal data.
- **Verify:** create/read/update an event; month transitions animate; side panel opens without
  navigating away; smart-insight cards derive from event data.

## Phase 5 — Kreativy + Sdělení

- Restyle the creatives gallery + lightbox (Feed/Čtverec/Story) and the messaging/angles view into
  the shell + components. Content stays static for now; architected to become data-driven and
  calendar-linked later.
- **Verify:** gallery, format switch, and modal behave as today, in the new system.

## Phase 6 — Potřebuje vás + Nastavení

- **Needs You** (`/needs-you`): unified attention list — held orders (findings + drafted email +
  Copy), deep-linking to Review; ready to absorb overdue calendar tasks + ownerless creatives later.
- **Nastavení** (`/settings`): folders, theme, and integration *status* (Shopify token present,
  autopilot schedule, RunPod spend estimate) — never a secret value.
- **Verify:** held orders match `/api/studio` `needsYou`; Copy e-mail works (with fallback).

## Phase 7 — Polish & cohesion pass

- Command palette (⌘/Ctrl-K) fully wired; keyboard shortcuts for Review (approve/next, etc.);
  micro-interactions and panel/month transitions; empty states everywhere; accessibility sweep
  (focus-visible, aria, contrast); dark-mode QA; responsive check at 2560/1920/1600; remove `/legacy`.
- **Verify:** full walkthrough of every module; `npm test`/`smoke` green; the "does this look like
  software built by a serious company?" bar is met.

---

## Sequencing rationale

Foundation first (everything depends on it), then the **home** (identity + daily value + the mockup),
then the **operational core** (orders/review — where the real work happens), then **generator**
(completes the daily loop and protects the autopilot fallback), then **calendar** (new capability),
then the lighter marketing modules, then **needs-you/settings**, then polish. Each phase leaves the
app shippable and never drops a capability.

## Cross-references

- Visual language & tokens: `DESIGN_SYSTEM.md`
- Current-state inventory & functionality checklist: `UI_AUDIT.md`
- Navigation, routes, status model, relationships: `APPLICATION_INFORMATION_ARCHITECTURE.md`
- Overnight autopilot (feeds the dashboard morning summary): `docs/plans/2026-07-11-003-feat-overnight-autopilot-plan.md`

## Open decisions before Phase 1 (confirm with David)

1. **Language → Czech** across the review tool (currently English). *(Recommended: yes.)*
2. **Generator split** into its own module vs staying in Review. *(Recommended: split.)*
3. **Scope of first delivery:** Foundation + Phase 1 (Dnešní studio) as the first visible milestone,
   then review together before the operational core. *(Recommended.)*
