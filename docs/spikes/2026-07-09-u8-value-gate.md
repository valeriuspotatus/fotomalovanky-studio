# U8 value gate — redo rate on a real sample (resolved: GO)

**Date:** 2026-07-09
**Unit:** U8, Phase 0.5. Resolves the go/no-go before Phase 1 and sets the DoD manual-touch threshold.
**Verdict:** **GO.** Measured redo rate **3 / 20 = 15%** on default settings.

## Sample & method

20 real orders (1502–1523), **one photo per order**, single default variant `2509_1.5` at
**4 diffusion steps**, default prompts, no retries, no variant comparison. Generated via
`ApiGeneratorDriver` into `outbox/u8/` (gitignored — customer photos). Machine QC
(`assessColoringPixels` + `assessColoringSvg`) ran on every result; the operator then eyeballed
all 20 on a contact sheet (`outbox/u8/contact.pdf`) and marked REDO Y/N.

### Input shape (operator-confirmed 2026-07-09)

An **order is a batch of up to 16 photos**, not one photo. Photos are named
`<order>_img<NNNN>_-_<label>.jpg` (e.g. `1523_img0001_-_hofbauerovi_18.7.2026.jpg`). The redo
rate below is therefore **per photo**, which is the right unit — but it has two consequences the
plan's arithmetic did not carry:

- **Per-order redo load.** At 15% per photo, a full 16-photo order expects **~2–3 redos**.
- **Per-order wall time.** ~55 s per photo warm ⇒ **~15 min of sequential GPU per 16-photo order**,
  on top of a 3-minute Render/RunPod cold start. Batch runs are long; U6's resumability is not
  optional.
- **Per-order page count.** U5's formula `pages = 2N + 4` ⇒ a 16-photo order prints **36 A4 pages**.

**Sampling caveat.** All 20 sampled photos are `img0001` — the *first* photo of each order. If
customers upload their strongest photo first, 15% is an optimistic floor and the true rate across
photos 2–16 is higher. Re-measure on a full order before treating 15% as settled.

**Naming-contract drift (open).** The real sample folder `Fotomalovanky.cz - Objednávka 1522/`
contains 8 photos whose filenames are all prefixed **`1523`**, not `1522`. Folder name and
filename prefix disagree by one. U3's ingest must decide which is authoritative for the order id
rather than assuming they agree — this is exactly the drift the plan's Risks section warned about.

| | |
|---|---|
| generated | 20 |
| failed | 0 |
| **QC-flagged** | **0** |
| **operator redo** | **3 (15%)** |
| ink coverage | 4.8% – 10.1% (median 8.0%) |
| latency | 40–213 s (162–213 s cold; ~50 s once RunPod is warm) |

## Why GO

The current manual routine touches **100%** of photos and compares **four** variants per photo to
pick the best. This automation touches one variant and lands 85% of photos usable on the first
pass. The 15% that need a redo flow through U4's review gate, which the plan already requires.
The value case holds comfortably.

**DoD manual-touch threshold: ≤ 15%.** Measured, not guessed. Prompt/steps tuning (below) may
lower it; the threshold does not depend on that work landing.

## The two failure modes (operator-reported)

1. **Missing or random edges → white space.** Outlines are not drawn out to the frame, leaving
   large empty regions; sometimes the model *hallucinates* what the edges should look like.
   Visible in `1515` (two unconnected diagonals off the top corners, empty upper third).
2. **Glasses → invented eyes.** The model draws irises and pupils *through* the lenses of anyone
   wearing glasses.

### What the operator actually does about them (from the screen recording, 2026-05-24)

The plan modelled neither workaround. Both are manual, and both are what the tool must replace:

- **Edges → he crops.** The generator's `/crop` endpoint (U2 spike, "not used by automation") is
  *not* a framing nicety. He crops precisely to **cut away the broken/hallucinated edges**. So the
  blank-border-tile metric below measures a real defect, and a fix that removes it removes the
  crop step.
- **Glasses → he deletes the eyes by hand in Figma.** He opens the `.svg` in his `Fotomalovanky.cz`
  Figma file, zooms to ~800%, and erases the irises/pupils the model drew behind the lenses.
  There is **no opposite "missing eye" defect** — the eyes are always unwanted.
- **Quality bar is best-of-4.** He runs ~4 variants per photo and picks the best. Our automation
  runs **one**. The 15% redo rate is therefore single-variant quality judged against a
  best-of-4 habit — a harsher comparison than it looks.
- **Generator jobs fail.** The recording shows `2 failed` of 24 jobs (~8%). `ApiGeneratorDriver`
  treats `FAILED` as terminal with no retry; at that rate a 16-photo order hits ~1 failure per run.

### Security (actioned separately)

The recording shows the **token-scoped generator URL in the browser address bar** at ~17:12. That
token is the only credential. The file sits beside a `05 Developer brief` folder, i.e. it is meant
to be shared. Rotate the token or blur the address bar before the video leaves the machine.

## QC cannot catch either. The human gate is load-bearing.

This is the central finding, and it **confirms KTD5** rather than undermining it:

- **0 QC flags, 3 real redos.** The heuristic only detects degenerate output (near-blank,
  near-solid, empty SVG). Both real failure modes are *semantic* or *regional*, not global.
- **Ink coverage does not separate good from bad.** `1509` has the **lowest** coverage of all 20
  (4.76%) and is a **good** result — its blank areas are legitimate sky and sand. Tightening
  `minInk` from 0.5% toward the observed 4.8% floor would flag good pages and still miss the bad
  ones.
- **Sunglasses are invisible to any pixel statistic.** A correctly-drawn empty lens and a lens
  with hallucinated eyes have nearly identical ink coverage.

**Do not tune QC thresholds against this sample.** QC stays a cheap degenerate-output tripwire;
the operator review grid (U4) is what actually gates the builder.

## Root cause: the prompt commands the sunglasses bug

`config.example.json` — captured verbatim from the operator's manual usage — contains, in the
**positive** prompt:

> Facial features must remain clear and natural. **Both eyes must include visible irises and
> enclosed pupils.**

and in the **negative** prompt:

> … `missing pupils`, `blank eyes` …

So the model is instructed twice — once as a requirement, once as a penalty — to put eyes in both
eye sockets. When a subject wears opaque sunglasses, it complies. This is a prompt defect, not a
model limitation.

Corroborating evidence that it is **intermittent, not deterministic**: order `1509` contains
sunglasses and rendered them **correctly** (clean empty outlined lenses, no invented eyes). So the
instruction biases the model rather than forcing it, and a prompt fix is plausible.

## A/B result: the edge defect is an under-stepping problem, not a prompt problem

Run `outbox/ab1/` (`tools/promptAB.mjs`, sheet in `outbox/ab1/ab.pdf`). 2×2 factorial on photo
`1515_img0001`, prompt × steps, **2 repeats per cell**, repeats interleaved so cold starts bias
timing rather than any one cell.

| cell | prompt | steps | ink | blank tiles | blank border | blank corner | svg paths |
|---|---|---|---|---|---|---|---|
| A | control | 4 | 5.761% | 5 | 4 | 1 | 986 |
| B | **edge** | 4 | 5.805% | 5 | 4 | 1 | 945 |
| D | control | **8** | 6.121% | **4** | **3** | **0** | **1155** |
| C | **edge** | **8** | 6.361% | **4** | **3** | **0** | 1096 |

**Steps drive the blank-tile metric.** Every 4-step run scores 5/4/1 blank tiles; every 8-step run
scores 4/3/0 — with zero within-cell variance. Doubling steps also traced **+17% more SVG paths**
(986 → 1155), i.e. genuinely more line detail survives to the vector.

> **Correction (operator verdict, 2026-07-09).** An earlier draft of this doc concluded "the prompt
> does nothing — do not ship the edge rewrite," on the strength of the blank-tile counts. **That was
> wrong.** Shown `ab.pdf`, the operator picked **cell C (edge prompt @ 8 steps)** as the best of the
> four: *"all lines are all the way to the edge without there being anything imagined by the
> generator."* C and D score identically on blank tiles (4/3/0) yet differ in **3.70% of ink pixels**
> — the metric simply cannot see "imagined content" versus real edges. Same lesson as the QC
> heuristic: **the counter is a proxy, the operator's eye is the verdict.**
>
> **Ship the edge prompt _and_ 8 steps** (cell C).

Caveats: one photo, n=2 per cell. Timing is **not** a valid steps-cost comparison here — every run
paid RunPod queue/cold-start (188–229 s), swamping the diffusion delta. Measure step cost warm
before committing to 8. Note the app's own UI captions the field *"4 steps recommended for
Lightning LoRA"*, so 8 is off the vendor's recommended path — worth an eyeball on likeness, not
just edges.

## The negative prompt is INERT at 4 steps

This is the single most consequential mechanical finding, and it explains the one above.

Two `ab3` cells differed **only** in their negative prompt (`eyes-neutral` vs `eyes-negative`).
At 4 steps they produced **pixel-identical** output (0.000% differing). At 8 steps the same two
prompts differ in **8.47%** of pixels. Meanwhile two runs of the *same* prompt at 4 steps differ by
1.7% (sampling noise). So:

| | negative prompt effect |
|---|---|
| 4 steps | **none, measured** |
| 8 steps | large |

The mechanism is almost certainly **classifier-free guidance**: the Lightning LoRA runs at CFG ≈ 1.0
at its recommended 4 steps, and at CFG 1.0 the unconditional (negative) branch is not evaluated at
all. Higher step counts use CFG > 1, which switches the negative prompt on.

**Consequences**

- The operator's entire **331-character negative prompt has been doing nothing** at `steps=4`. Every
  term in it — `solid black fill`, `missing pupils`, `invented background elements` — is decoration
  at the current setting.
- The edge rewrite's substance is in its *negative* terms, which is exactly why cell **B**
  (edge @ 4 steps) was indistinguishable from control, while cell **C** (edge @ 8 steps) is the
  operator's pick. The prompt was never ignored; it was never *evaluated*.
- **Moving to 8 steps activates the whole negative prompt for the first time.** That changes output
  character broadly, not just at the edges. Re-eyeball a batch after the switch; do not assume the
  only delta is edge completeness.
- Prompt engineering on the negative prompt is **only possible at ≥ 8 steps**. At 4 steps, only the
  positive prompt can be tuned.

## Determinism: the generator is deterministic at 8 steps, stochastic at 4

Measured by re-running identical inputs and diffing the rasters pixel-for-pixel:

| pair | pixels differing | ink pixels flipped |
|---|---|---|
| A r1 vs A r2 (4 steps) | 8.17% | 1.81% |
| B r1 vs B r2 (4 steps) | 8.47% | 1.86% |
| **D r1 vs D r2 (8 steps)** | **0.00%** | **0.00%** |
| **C r1 vs C r2 (8 steps)** | **0.00%** | **0.00%** |

Both 8-step cells reproduced **pixel-identical** output (the PNG bytes differ — the server
re-encodes — but every pixel matches). Both 4-step cells did not. Most likely the 4-step Lightning
path uses a stochastic sampler while the longer path is deterministic; the backend is not visible,
but the behaviour is unambiguous and reproduced on two independent cells.

### Determinism is WITHIN-RUN ONLY (correction, 2026-07-09)

The same photo, prompt, variant and step count, run in two different sessions, does **not**
reproduce:

| comparison | pixels differing | ink flipped |
|---|---|---|
| `edge@8` rep1 vs rep2, **same run** (`ab1/C`) | 0.000% | 0.000% |
| `edge@8` (`ab1/C-r1`) vs `edge@8` (`ab5/F1hi-r1`), **different runs** | 10.122% | **2.818%** |

Prompts were verified byte-identical between the two runs. The most likely cause is a **different
RunPod worker/GPU** between sessions — fp16 kernel numerics differ, and at 8 steps the sampler is
otherwise deterministic, so each worker has its own stable output.

**Methodological consequence — this bites.** A control generated in a previous run is **not** a
valid control. Every cell of a comparison must be generated **inside the same run**. `outbox/ab5`
is built this way (control-eyes / v1 / v3 all in one run); earlier face comparisons that reused
`ab1/D-r1` as the control are confounded and were re-done.

"One render is proof" therefore holds **only within a run**. Across runs, one render is a sample.

**This rewrites U4's redo contract.** The plan says a redo "re-queues through the `GeneratorDriver`
(optionally with an alternate variant)". At 8 steps, *re-running with identical settings reproduces
the identical bad output* — a plain redo is a no-op. **"Optionally with an alternate variant" must
become "necessarily with something changed"**: a different variant, step count, prompt, or crop.

It also explains why the glasses bug is intermittent at the operator's current `steps=4`: run-to-run
noise flips ~1.8% of ink pixels, enough to sometimes place eyes behind lenses and sometimes not.

## The eye instruction has three symptoms, not one

The control prompt demands eyes unconditionally, in both directions:

> positive: *"Facial features must remain clear and natural. **Both eyes must include visible irises
> and enclosed pupils.**"*
> negative: *… `missing pupils`, `blank eyes` …*

The model obeys even when the eyes are not there to draw. Three observed symptoms, one cause:

1. **Eyes behind opaque sunglasses.** Confirmed on `1523_img0002` — the subject's eyes are entirely
   hidden by dark lenses in the photo; the operator's own output draws both irises and pupils
   through them. *Intermittent* (see base rate below).
2. **Closed eyes prised open.** Confirmed on `1515_img0001` — the man is looking down with his eyes
   closed. **All 8 renders from the edge A/B open his eyes**, and the model also **re-poses his
   head** to face the viewer. Operator reports this fires on *every* render.
3. *(same root)* Both are the model inventing eyes it cannot see.

**Diffusion steps do not fix this.** `1515` at 8 steps (`D-r1`) opens the eyes exactly as 4 steps
does. Steps fix edges; only the prompt can fix eyes.

### Base rates differ — pick the fixture accordingly

| bug | fixture | base rate at 4 steps |
|---|---|---|
| closed eyes opened | `1515_img0001` | ~100% (8/8 renders) |
| eyes behind sunglasses | `1523_img0002` | **< 100%** — control `ab2/A-r1` produced *empty lenses* |

`1523` is a **poor fixture**: its bug is stochastic, so a single sample per cell is worthless.
`1515` is the right one — a 100% base rate means one clean render under a fix is real evidence.

## Failed attempt: negation in the positive prompt makes it worse

First revision put the rule in the **positive** prompt:

> *"…If a subject wears glasses or sunglasses, draw the lenses as empty enclosed outlines — never
> draw eyes, irises, or pupils behind a lens."*

Result on `1523_img0002` at 4 steps (`ab2/B-r1`, n=1): the lenses came back with eyes **and
eyelashes** — while the *control* on the same run produced empty lenses. Suggestive, not
conclusive (n=1, stochastic bug), but the mechanism is well known: diffusion models handle negation
poorly, and naming `eyes` / `irises` / `pupils` in the positive prompt raises their salience no
matter what the surrounding "never" says.

**Lesson: state what you want in the positive prompt; put what you don't want in the negative.**

## Current experiment (`outbox/ab3/`, fixture `1515_img0001`)

Two candidate fixes, run against the deterministic 8-step path (1 sample = proof) and the
stochastic 4-step path (2 samples):

- **v1 `eyes-neutral`** — *delete* the eye demand from the positive prompt and `missing pupils`,
  `blank eyes` from the negative. Adds nothing. After this, the positive prompt contains **no
  mention of eyes, pupils, or irises at all**. This is the clean test of the causal claim.
- **v2 `eyes-negative`** — v1, plus the unwanted concepts pushed into the *negative* prompt:
  `eyes behind sunglasses`, `pupils through lenses`, `opened eyes`, `changed gaze direction`,
  `altered head pose`.

Controls: `A` (control @ 4 steps) in-session; the 8-step control is reused from `ab1/D-r1`, which is
safe precisely because 8 steps is deterministic.

**Open risk:** v1 removes the eye instruction entirely. It may regress ordinary faces (blank or
sloppy eyes on subjects whose eyes *are* visible) — the very thing the instruction was written for.
The `1515` fixture contains three children with open eyes and a man with closed eyes, so a single
render tests both directions at once. Check the children before adopting v1.

## Shipped configuration (2026-07-09) — `edge + eyes-posonly` @ 8 steps

Written into `config.example.json` and `config.json` verbatim from `outbox/ab5/prompts.json`, so the
shipped prompt is byte-for-byte the one that was eyeballed. Live-config guard: the migration
asserted the file it edited still matched the tested control before touching it.

| | before | after |
|---|---|---|
| `diffusionSteps` | 4 | **8** |
| positive prompt | 1129 ch | 1337 ch |
| negative prompt | 331 ch | 387 ch |

- **positive** — removed `Both eyes must include visible irises and enclosed pupils.`; added the
  edge-to-edge clause.
- **negative** — removed `invented background elements`; added `stray lines, unconnected lines,
  incomplete outlines, unfinished edges, empty corners`; **kept `missing pupils, blank eyes`**.

**Why keep the pupil guard (v3) rather than delete it (v1)?** The operator added the eye instruction
because the generator historically omitted pupils. At `steps=4` the negative prompt is inert, so the
*positive* sentence was the sole pupil protection. At `steps=8` the negative wakes up and can take
that job over — so v3 drops the positive demand (the thing that forces eyes onto closed eyelids and
sunglass lenses) while retaining a guard that now actually runs. Both v1 and v3 fixed the closed-eye
defect within-run; v3 is chosen because it is strictly safer against the operator's known failure.

### Verified within one run (`outbox/ab5`, all cells same run)

| face | photo shows | baseline (eye demand kept) | v1 | v3 |
|---|---|---|---|---|
| girl, 1515 | eyes **closed** | drawn **open, filled pupil** | closed ✓ | **closed ✓** |
| man, 1523 | eyes **open** | irises + pupils | preserved ✓ | **preserved ✓** |
| woman, 1523 | **sunglasses** | lenses empty (bug did not fire) | empty | **empty** |

### Not fixed by any prompt

`1515`'s man is **re-posed** — head lifted to face the viewer instead of looking down — under every
prompt and both step counts. That is Qwen Image Edit's own behaviour, not the prompt. The Figma
repair step becomes **rarer, not unnecessary**, and U4's review gate stays load-bearing.

### Cost

8 steps warm: **48–55 s** per photo (observed). Cold: ~230 s. Cold start dominates, so doubling steps
does **not** double wall-clock. A 16-photo order remains roughly 15–20 min of GPU.

## U8 re-run on the shipped config (`outbox/u8v3`, 2026-07-09)

Same 20 orders, one photo each, regenerated through `tools/u8Sample.mjs` on v3 @ 8 steps.
**20/20 succeeded, 0 failed, 0 QC-flagged** (QC flagging nothing is the expected, useless result).

| | old (4 steps, old prompt) | new (8 steps, v3) |
|---|---|---|
| mean ink coverage | 7.83% | **8.40%** |
| median ink coverage | 7.98% | **8.60%** |
| total blank tiles (20 photos) | 53 | **49** (−7.5%) |
| total blank **border** tiles | 47 | **42** (−10.6%) |
| per-photo blank tiles | — | improved 4, unchanged 15, worse 1 |
| median latency | ~53 s | 183 s (RunPod re-cooled between photos) |

**Read this cautiously.** The single-photo A/B showed a clean 5/4/1 → 4/3/0 blank-tile shift. Across
20 photos the aggregate effect is **much smaller**: three-quarters of photos did not move at all.
Two reasons, both real:

1. Most "blank tiles" are **legitimately blank** — sky, sand, studio wall. The metric cannot tell a
   missing edge from an empty sky (`1509` scores 12 blank tiles and is a *good* render).
2. Every photo here is a **single sample on a different worker** than the baseline. Cross-run noise
   is ~2.8% of ink pixels, which is the same order as the effect being measured. Per-photo deltas of
   ±1 tile are not trustworthy; only the aggregate direction is.

### Operator verdict (2026-07-09)

> *"The 8 step version looks much better."*

Directional and unambiguous — **the shipped config is adopted**. Reviewed against the old renders
side by side in `outbox/u8v3/review.html`.

**But the redo rate was NOT re-measured.** The `3/20 = 15%` figure in this document was measured on
the **old** config (4 steps, old prompt) and is now **stale**. It survives only as the *baseline* the
new config must beat, not as a property of what ships. Two consequences:

- The Definition-of-Done manual-touch threshold (≤ 15%) is **carried over, not re-validated**.
- The next real batch should be counted: redo count ÷ photos. `tools/reviewSheet.mjs` builds the
  click-through page for any run directory; the count is the deliverable.

Expect the new rate to be *lower but not zero*: the closed-eye defect is fixed (≈100% base rate
before), the edge defect is improved, and the head re-posing and the stochastic glasses bug both
remain.

## REGRESSION: the shipped edge prompt makes the model hallucinate (order 1510)

**Operator, 2026-07-09:** *"the old one has cut off legs, however the new one adds things instead of
sticking to the original image."*

Order `1510` is a party photo in a blown-out white room. The shipped config invents **curtain
pleats, wall panelling and floorboards** that are not in the photograph. It does **not** fix the
original defect — the seated grandmother's legs are still missing under both prompts.

### Cause

The edge rewrite did two things at once:

1. added a positive instruction to *fill every part of the frame*, and
2. **deleted `invented background elements` from the negative prompt.**

Deletion (2) was justified by the theory that the term suppressed legitimate background linework.
That theory was **never supported**: at `steps=4` the negative prompt is inert, so the term could not
have been suppressing anything. Ship at `steps=8` and the negative prompt wakes up — so the change
removed the only anti-hallucination guard exactly when it would first have taken effect, while (1)
simultaneously told the model to fill empty space.

### The metric actively rewarded the bug

`1510` went from **1 blank tile → 0** and the U8 comparison table scored that as an *improvement*.
It was the hallucination filling the blank. This is the third and worst instance of the same lesson:
the blank-tile counter cannot distinguish drawn-from-the-photo from drawn-from-imagination, and a
metric that cannot tell those apart will reward the wrong one.

### Isolation run (`outbox/ab6`, 8 steps, 2 photos, all cells in one run)

| cell | prompt | fill-frame | `invented background elements` guard | 1510 ink |
|---|---|---|---|---|
| `D` | original | no | **on** | 6.81% |
| `F1hi` | **shipped v3** | **yes** | **off** | **7.01%** |
| `F2hi` | `edge-neg` + eyes fix | no | **on** | 6.48% |
| `F3hi` | eyes fix only | no | **on** | 6.50% |

Visually: `F1hi` draws dense curtain pleats and a heavy dark band; `D` draws a moderate curtain;
`F2hi` and `F3hi` draw almost nothing there. Ink coverage ranks the cells in exactly that order —
**more ink = more invention** on this photo.

`F1hi` also scores **5** blank tiles on `1515` versus `D`'s 4, so the fill instruction did not even
buy edge completeness.

**Caveat:** `F1hi` changed both variables together, so this run identifies a *clean* config, not
which of the two changes did the damage. Isolating that needs a fill-on + guard-on cell.

### Consequence

`config.json` / `config.example.json` currently hold the **regressed** prompt. The candidate
replacement is `F2hi` — `edge-neg + eyes-posonly`: keep `invented background elements`, keep
`missing pupils, blank eyes`, add `stray lines, unconnected lines, incomplete outlines,
unfinished edges` to the negative, and add **no** positive fill instruction. Edge completeness then
comes from `steps=8` alone.

**Unresolved:** the operator praised cell `C` (fill-on) on `1515` for having *"lines all the way to
the edge without anything imagined."* On `1510` the same prompt family invents heavily. The fill
instruction is therefore **photo-dependent** — harmless where real content reaches the frame, harmful
where the background is blank. Requires an operator choice, not a metric.

## Cut-off legs (1510): already fixed, by `steps=8` — not by any prompt

The seated grandmother wears black leggings. In the operator's original renders both shins end in a
flat cut, with no ankles and no feet. The obvious theory — that `Do not fill any regions with solid
black` makes the model erase dark clothing — is **wrong**.

Within-run isolation (`outbox/ab7`, one photo, **byte-identical prompt**, steps the only variable):

| cell | steps | prompt | legs | ink | blank tiles | svg paths |
|---|---|---|---|---|---|---|
| `A` | 4 | original | **both shins truncated** | 7.40% | 2 | 1277 |
| `D` | 8 | original | **complete, down to the ankles** | 6.81% | 1 | 1056 |

The prompt is not implicated: `D` runs the operator's *unmodified* prompt. Raising the step count
alone completes the legs. Confirmed again in `ab6` (`D`, `F1hi`, `F2hi` all draw the legs; only the
4-step renders truncate them).

**This is the same defect as the "missing edges".** Both are the 4-step Lightning sampler failing to
finish a contour: at the frame border it reads as white space, mid-limb it reads as a cut-off leg.
One cause, two symptoms, both resolved by the step increase that already shipped.

**The metric is wrong here too, and in the opposite direction.** The 4-step render has *more* ink
(7.40% vs 6.81%) and more traced paths (1277 vs 1056) than the correct 8-step one. Ink coverage
measures how much was drawn, never whether what was drawn is finished. Do not use it as a
completeness proxy.

**No action required** — `config.json` already runs `steps=8`. Nothing to change.

## Follow-up sequence

1. **Eyeball `outbox/ab1/ab.pdf`** — confirm 8 steps does not degrade likeness. Blank-tile counts
   are a proxy; the operator's eye is the gate (this is the same lesson as "QC cannot catch it").
2. **Measure warm step cost** (4 vs 8) before committing — the A/B timings are cold-start noise.
3. **Glasses prompt A/B** on a photo where the bug reproduces. `1509` has sunglasses but rendered
   them *correctly*, so it is a negative control, not a fixture.
4. **Re-measure the redo rate** at the chosen steps/prompt. 15% was measured at `steps=4` with the
   control prompt; it is not the rate of the fixed configuration.

## Open items

- **Warm cost of `steps=8`** — unmeasured. If diffusion time roughly doubles, a 16-photo order
  goes from ~15 min to ~25 min of GPU. Trade against eliminating the manual crop step.
- **Does 8 steps remove the need to crop?** It cut blank border tiles 4 → 3 and cleared the blank
  corner, but did not zero them. Reducing ≠ eliminating.
- **A photo where the glasses bug reproduces** — needed as the fixture for the prompt fix.
- **Best-of-N variants.** The operator picks from ~4; automation runs 1. Closing the quality gap may
  mean generating 2–3 variants per photo and letting the U4 review grid choose. That multiplies GPU
  cost per photo and should be decided against the measured redo rate, not assumed.
- Whether the operator's preferred variant is really `2509_1.5` (app's internal fallback is
  `2509_1.0`) — still unconfirmed, carried over from the U2 spike.
- **`FAILED` jobs are not retried** (~8% observed). `ApiGeneratorDriver` should treat a GPU `FAILED`
  as retryable at least once, distinct from a permanent refusal.

## Input contract (confirmed against real fixtures, 2026-07-09)

Two operator-supplied fixtures settle U3's ingest contract:

- `Fotomalovanky.cz - Objednávka 1522 Original downloaded imput/` — **8 × `.jpeg`**, nothing else.
  This is exactly what the Chrome extension drops from Shopify. Note the extension is **`.jpeg`**,
  not `.jpg`.
- `Fotomalovanky.cz - Objednávka 1522 Final generator output/` — 8 × (`.jpeg` + `.svg` + `_bw.png`).
  No PDF; the builder produces that separately.

**The folder/filename order-id drift is confirmed, not a typo:** the folder says `1522`, all 8
files inside say `1523_img000N_-_hofbauerovi_18.7.2026`. Ingest must pick one source of truth for
the order id and surface the disagreement rather than silently trusting either.

## Provenance

`outbox/u8/results.json` (20 records), `outbox/u8/contact.pdf`, operator verdict 2026-07-09.
