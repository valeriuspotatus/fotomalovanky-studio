# Fotomalovánky Studio — Design System

> The shared visual language for the whole application. Every screen is built from these tokens and
> components — one product, one system. Light Mode is the primary identity (paper); Dark Mode is an
> optional working mode. Nothing in the app should introduce a colour, radius, shadow, or spacing
> value that is not defined here.

**Aesthetic north star:** a calm, premium *creative production studio*. High-end stationery, not
kindergarten. Reference feel: Linear / Notion / Stripe Dashboard / Arc — warm and paper-inspired,
never enterprise-grey, never a gaming launcher.

---

## 1. Design principles

1. **Paper first.** Surfaces read like sheets of warm paper on a soft desk. Light, spacious, matte.
2. **Hierarchy over decoration.** Type scale, weight, and spacing carry meaning; colour is used
   sparingly and always semantically (status, brand, action).
3. **Calm by default, colour on signal.** The canvas is neutral. Colour appears where the operator
   must look — a status chip, a "needs you" count, the primary action.
4. **One component, everywhere.** A button, chip, or card looks and behaves identically on every
   screen. No page-local restyles.
5. **Fast and quiet motion.** Transitions are 120–200 ms, eased, purposeful. Never bouncy, never
   attention-seeking.

---

## 2. Colour

Colour is expressed as CSS custom properties on `:root` (light) with a `:root[data-theme="dark"]`
override. Never hard-code a hex in a component — reference the token.

### 2.1 Neutrals — the paper canvas (light)

| Token | Value | Role |
|---|---|---|
| `--paper` | `#FBFAF8` | App background — warm off-white "desk paper" |
| `--surface` | `#FFFFFF` | Cards, panels, sheets |
| `--surface-2` | `#F6F4F1` | Sunken areas, table header, hover fills, code blocks |
| `--surface-3` | `#EFECE7` | Deeper sunken / disabled fills |
| `--border` | `#EAE6E0` | Hairline borders (1px), card edges |
| `--border-strong` | `#DCD6CE` | Inputs, dividers that need to read |
| `--ink` | `#22262E` | Primary text — warm near-black |
| `--ink-2` | `#565D69` | Secondary text, labels |
| `--ink-3` | `#8A909B` | Muted text, placeholders, timestamps |
| `--ink-inverse` | `#FFFFFF` | Text on coloured/solid buttons |

### 2.2 Brand

The wordmark stays multi-colour and playful; the *UI* uses a single restrained brand accent.

| Token | Value | Role |
|---|---|---|
| `--brand` | `#F1543F` | Primary brand accent / primary action (coral) |
| `--brand-hover` | `#E0442F` | Hover/active for primary |
| `--brand-soft` | `#FDECE8` | Tinted brand background (chips, icon wells) |
| `--brand-ring` | `#F1543F33` | Focus ring for brand controls |

Wordmark palette (logo only, not UI): `#F1543F` `#F5A623` `#3BB273` `#3B82F6` `#7C5CFC` used across
the letters. Do not use these as arbitrary UI colours.

### 2.3 Semantic status

Each status has a **solid** (text/icon), a **soft** (chip/well background), and is used consistently
everywhere a status appears (chips, KPI icons, order rows, calendar).

| Status | Solid | Soft (light) | Used for |
|---|---|---|---|
| `--info` | `#3B82F6` | `#E8F0FE` | Ready for PDF, scheduled, neutral-active |
| `--success` | `#22A06B` | `#E3F5EC` | Completed, approved, done |
| `--running` | `#12B76A` | `#E4F7EE` | Generating / in progress (animated) |
| `--warning` | `#E5920B` | `#FCF0DA` | Needs attention, photo check, waiting |
| `--danger` | `#E5533D` | `#FCE9E5` | Missing photos, failed, overdue, reject |
| `--neutral` | `#6B7280` | `#EFEDEA` | Queued, draft, idle |
| `--purple` | `#7C5CFC` | `#EEE9FE` | Marketing / creative accent |

### 2.4 Dark mode (optional working mode)

Warm charcoal, not blue-black — still "paper at night."

| Token | Value |
|---|---|
| `--paper` | `#17181B` |
| `--surface` | `#1E2024` |
| `--surface-2` | `#26282D` |
| `--border` | `#2E3136` |
| `--ink` | `#ECEAE6` |
| `--ink-2` | `#A8ADB5` |
| `--ink-3` | `#767B84` |

Brand and status solids stay the same hue; soft backgrounds drop to ~14% opacity of the solid.

---

## 3. Typography

Three families, loaded self-hosted (no external CDN — CSP/offline safe). Fallbacks are system fonts.

| Role | Family | Fallback |
|---|---|---|
| Display / large headings | **Fredoka** (rounded) | `"Fredoka", "Segoe UI", system-ui, sans-serif` |
| UI / body | **Manrope** | `"Manrope", "Inter", system-ui, sans-serif` |
| Technical data / numbers | **JetBrains Mono** | `"JetBrains Mono", ui-monospace, monospace` |

### 3.1 Type scale

| Token | Size / line | Weight | Family | Use |
|---|---|---|---|---|
| `--t-display` | 30 / 36 | 600 | Fredoka | Page title ("Dobrý den, David!") |
| `--t-h1` | 22 / 28 | 600 | Fredoka | Section headers ("Kalendář") |
| `--t-h2` | 18 / 24 | 600 | Manrope | Card titles |
| `--t-h3` | 15 / 20 | 600 | Manrope | Sub-headers, list group labels |
| `--t-body` | 14 / 20 | 450 | Manrope | Default body |
| `--t-label` | 13 / 16 | 500 | Manrope | Labels, nav items, table headers |
| `--t-caption` | 12 / 16 | 500 | Manrope | Timestamps, meta, chip text |
| `--t-mono` | 13 / 18 | 450 | JetBrains Mono | Order IDs, counts, durations, tokens |

- Numerals in metrics use `font-variant-numeric: tabular-nums`.
- Uppercase micro-labels (table headers, calendar weekday row) use `--t-caption`, `letter-spacing:
  0.04em`, `--ink-3`.

---

## 4. Spacing, radius, shadow, motion

### 4.1 Spacing scale (4px base)

`--sp-1: 4px` · `--sp-2: 8px` · `--sp-3: 12px` · `--sp-4: 16px` · `--sp-5: 20px` · `--sp-6: 24px` ·
`--sp-8: 32px` · `--sp-10: 40px` · `--sp-12: 48px` · `--sp-16: 64px`

Page gutter: `--sp-8` (32). Card padding: `--sp-5`–`--sp-6`. Gap between cards: `--sp-4`–`--sp-5`.

### 4.2 Radius

| Token | Value | Use |
|---|---|---|
| `--r-sm` | 8px | Chips, small controls, inputs |
| `--r-md` | 12px | Buttons, tiles, table container |
| `--r-lg` | 16px | Cards, panels |
| `--r-xl` | 20px | Large surfaces, modals |
| `--r-full` | 999px | Pills, avatars, icon buttons |

### 4.3 Shadow (soft, low, warm)

| Token | Value | Use |
|---|---|---|
| `--shadow-xs` | `0 1px 2px rgba(40,33,28,.05)` | Resting hairline lift |
| `--shadow-sm` | `0 1px 2px rgba(40,33,28,.05), 0 2px 8px rgba(40,33,28,.05)` | Cards |
| `--shadow-md` | `0 4px 16px rgba(40,33,28,.08)` | Hover lift, popovers |
| `--shadow-lg` | `0 12px 40px rgba(40,33,28,.14)` | Modals, side panels |

No glows, no glassmorphism, no text shadows, no heavy gradients. Borders stay 1px hairline.

### 4.4 Motion

| Token | Value |
|---|---|
| `--ease` | `cubic-bezier(.2,.7,.2,1)` |
| `--dur-fast` | 120ms |
| `--dur` | 180ms |
| `--dur-slow` | 260ms (panel slide, month transition) |

Respect `prefers-reduced-motion: reduce` — drop transforms, keep opacity.

---

## 5. Iconography

- **Lucide** icons only, inlined as SVG (self-hosted set, tree-shaken to what's used — no CDN).
- Stroke width `1.75`, size 18px in nav/buttons, 16px inline, 20px in KPI wells.
- Icons communicate the action/entity; they never decorate. **No emoji in navigation or controls.**
  (Emoji may still appear inside *customer data* we display verbatim, e.g. a Shopify variant title.)
- Nav mapping: Přehled `home` · Objednávky `shopping-bag` · Generátor `wand-2` · Kreativy `palette` ·
  Sdělení `megaphone` · Kalendář `calendar` · Potřebuje vás `hand` · Nastavení `settings`.

---

## 6. Core components

Each is one implementation, driven by tokens. Specs below are contracts, not suggestions.

### 6.1 Button
- Variants: `primary` (brand solid, `--ink-inverse`), `secondary` (surface + `--border-strong`),
  `ghost` (transparent, hover `--surface-2`), `danger` (soft danger, hover solid).
- Sizes: `sm` 28px, `md` 36px (default), `lg` 44px. Radius `--r-md`. Icon+label gap `--sp-2`.
- States: hover (lift `--shadow-xs` + darken), active (translateY 1px), focus-visible (2px
  `--brand-ring`), disabled (`--surface-3`, `--ink-3`, no shadow). Loading → inline spinner, label
  stays.

### 6.2 Card
- `--surface`, `--r-lg`, `--shadow-sm`, padding `--sp-6`, 1px `--border`. Optional header row
  (title `--t-h2` + trailing action). Hover for *interactive* cards: `--shadow-md`, border →
  `--border-strong`, 120ms.

### 6.3 Status chip (pill)
- `--r-full`, height 22px, `--t-caption` 500, padding `0 --sp-3`, soft bg + solid text of the status
  token, optional 6px leading dot (solid). One chip component; the status → token map in §2.3 is the
  single source of truth. `running` chip: dot pulses.

### 6.4 KPI / metric card
- Big tabular number `--t-display`, label `--t-label` `--ink-2`, a 36px rounded icon well
  (`--r-md`, soft status bg + solid icon), optional trailing arrow link. Whole card is a link to
  the filtered view. Used for the dashboard top row (New Orders, Generating, Needs Attention, Ready
  for PDF, Completed Today).

### 6.5 Table / list row
- Header row: `--surface-2`, `--t-caption` uppercase `--ink-3`. Rows: 52px, hairline `--border`
  between, hover `--surface-2`, `--r` only on the container. Cells align to a 4px baseline. A row is
  clickable (→ detail); a trailing `⋯` (`more-horizontal`) opens a row menu. Thumbnails are 32px
  `--r-sm`.

### 6.6 Tabs
- Underline style: `--t-label`, active `--ink` with a 2px `--brand` underline, inactive `--ink-3`.
  Optional count badge (pill, `--surface-2`). Used for Orders filters and Review Overview/Focus.

### 6.7 Input / select / textarea
- Height 36px, `--surface`, 1px `--border-strong`, `--r-sm`, `--t-body`. Focus: border `--brand`,
  2px `--brand-ring`. Label `--t-label` `--ink-2` above. Error state uses `--danger`.

### 6.8 Side panel (sheet)
- Right-anchored, width 420px, `--surface`, `--shadow-lg`, slides in `--dur-slow`. Sticky header
  (title + close `x`), scrollable body, sticky footer for actions. Used for order detail, calendar
  event detail, photo focus meta. Never navigates away from the underlying screen.

### 6.9 Dialog / modal
- Centered, max-width 520px, `--surface`, `--r-xl`, `--shadow-lg`, scrim `rgba(20,18,16,.45)`.
  Title `--t-h2`, body `--t-body`, footer right-aligned buttons (primary + ghost cancel).

### 6.10 Navigation (sidebar)
- 248px, `--surface` (a hair lighter than `--paper`), wordmark top, nav list of icon+label items
  (`--t-label`, 40px rows, `--r-md`). Active item: `--brand-soft` bg, `--brand` icon, `--ink` label.
  Hover: `--surface-2`. Footer: user chip (avatar + name/role), theme toggle, logout. The subtle
  line-art illustration sits above the footer at low opacity.

### 6.11 Toast / inline feedback
- Bottom-right stack, `--surface`, `--shadow-md`, `--r-md`, status dot, auto-dismiss 4s. Replaces
  the current run-log's ad-hoc text where a transient confirmation is enough.

### 6.12 Empty state
- Centered line-art glyph (paper/pencil motif), `--t-h3` title, `--t-body` `--ink-2` hint, one
  primary action. Every list/grid has one.

---

## 7. Layout

- **App shell:** fixed 248px sidebar + fluid content. Content max-width 1440 on ultra-wide, centered,
  with `--sp-8` gutters. Optimised for 2560×1440, 1920×1080, 1600×900. Mobile is secondary
  (sidebar collapses to a top bar + drawer below 900px).
- **Content grid:** 12-col fluid with `--sp-5` gutter. Dashboard uses a 2/3 + 1/3 split (work rail +
  calendar rail) on ≥1440, stacking below.
- **Density:** comfortable but productive — this is left open all day. Generous whitespace, but no
  wasted vertical space above the fold.

---

## 8. Implementation notes

- Ship a single `tokens.css` (all custom properties, light + dark) imported by every page, plus a
  `components.css` for the components above. No inline `<style>` blocks with hard-coded values.
- Self-host fonts as `woff2` under `static/fonts/` and Lucide as an inline sprite/module under
  `static/icons/` — the server already serves the static tree, and the CSP/offline posture forbids
  external CDNs.
- The current pages are vanilla HTML/JS with no build step; keep that (progressive, dependency-free).
  Extract shared markup (shell, components) so the two current pages and the new screens share one
  system rather than duplicating CSS.
- Accessibility: focus-visible on every control, `aria-*` on tabs/dialogs/panels, contrast ≥ 4.5:1
  for text (the neutral + status tokens above are chosen to pass on `--surface`).
