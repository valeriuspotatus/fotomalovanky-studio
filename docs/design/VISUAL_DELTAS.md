# Visual deltas — refinements to `new visual.txt`

**For:** whoever implements `new visual.txt` into `src/ui/static/dashboard.html`.
**Status:** the spec's direction stands — this is *tuning*, not a redo. Live reference of the tuned version: https://claude.ai/code/artifact/a189fe4b-d32f-4b6a-920d-d95e2b6f1e18

Two driving notes from David: (1) **no brown** — the warm putty/brown ground was rejected; (2) it read **cramped** — needs to use the screen width and breathe. The rest is one principle: **loud frame, quiet data plane** — spend the coloring-book loudness on containers and the act-on-this CTA, keep the data (rows, numbers, small pills) calm so a daily ops tool doesn't fatigue.

---

## Keep exactly as the spec says

The concept and most of the language are right — don't touch:
- Chunky ink outlines + hard **zero-blur** offset shadows + **press physics** (hover lifts −1,−1 / active pushes +1,+1) — on containers and buttons.
- The **`--ink` flip** for dark mode (one variable drives text + borders + shadows).
- **One yellow accent** (`#ffc947`) for CTAs / active tab / act-on-this; the **five marker colors** as 12%-alpha department fills with full-strength text.
- Uppercase tracked labels; emoji icons; Czech **tykání** voice ("Ty jen klikáš ✓ / ✗"); **done-states-recede** (sent/approved → ~62% opacity, flat, no shadow).
- The two-font pairing **Caveat + Nunito Sans** — real webfonts are fine in the app (the CSP limit was only in my artifact sandbox, where I substituted `Ink Free`). Keep Caveat/Nunito Sans.

---

## Deltas

### 1. Palette — de-warm everything (spec §1, §4). The big one.
Replace the warm paper/brown world with a **cool-grey ground**. Keep yellow + marker colors + semantics unchanged.

| Token | Spec (warm) | Use instead (cool) |
|---|---|---|
| ground / rails | `#dfdfd8` putty | `#e6e8ec` cool slate |
| working (center) column | — (one paper tone) | `#f7f8fa` — split it out, brighter than the rails so data reads clean |
| panels / cards | `#fffffe` | `#ffffff` |
| secondary surface | `#f3f2ec` | `#eef0f4` |
| ink | `#11151c` | `#14181f` (still blue-black) |
| **card shadow** | **translucent brown ~30%** | **`rgba(22,28,40,.22)` cool slate** ← kills the brown |
| radial glow | 34% | ~12%, and **not behind the center data grid** |

**Dark mode:** cool it at both ends too — ground `#181b21` (not warm `#1b1915`), ink `#eef1f6` off-white (not warm cream `#f4efe3`), shadow `rgba(0,0,0,.5)`, glow ~12%. Marker colors / warn / good stay as the spec's dark values.

### 2. Handwriting off the DATA (spec §2)
The spec puts Caveat on "the metric numbers" — **move it off.** Caveat/marker font only on the **moments**: header title, section titles, the dedications ("Pro Martinku"), empty-state / reassurance copy.
**Every number — metric tiles, counts, spend, order ids — stays in Nunito Sans, weight 800, `font-variant-numeric: tabular-nums`.** This is the spec's own "playful only on MOMENTS, never on DATA" rule; metric numbers *are* data. Biggest legibility win.

### 3. Zone the outline weight (spec §3)
Uniform 2px on everything makes a "cage" at density. Split it:
- **Loud (2px ink outline + 4px offset shadow + press):** cards, header underline, CTAs, the theme toggle.
- **Quiet:** order rows → **1.5px hairline, no offset shadow**; count/page pills → **12%-alpha fill, no outline**; agent-rail items → outline **only** on active/hover.
- The one loud element inside a calm row is its **primary CTA** (yellow, `2px 2px 0` ink shadow).

### 4. More air (David: "cramped")
- Shell **max-width ~1760px** with ~44px side padding — use the screen instead of a narrow centered column.
- Wider columns: rails **248 / 344** (spec had 216 / 312).
- Bigger spacing: shell `gap: 30px`; queue list `gap: 16px`; **order row padding `18px 22px`** (was tight). Header padding `15px 44px`.

### 5. Restraint on ambient (spec §4–5)
Keep press-physics and the single green pulse on live status dots. Everything else stays still. Make the glow faint and keep it out of the working column — an ambient gradient behind a data grid reads "designed" in a screenshot and "distracting" in daily use.

---

**One-line summary:** same coloring-book neo-brutalism, but cool-grey instead of brown, roomier, with the loudness (thick outlines, Caveat, press-physics, glow) spent on the frame and the moments — never on the numbers or the dense rows.
