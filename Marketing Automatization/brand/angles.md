# Angle Taxonomy & Naming Convention

> Companion to `brand/brand-guide.md`. The guide says *how* we speak. This says *what claim each creative is testing*, and how it's labelled so eight weeks of spend can answer back.
>
> Machine-readable mirror: `factory/lib/naming.mjs`. If the two disagree, that's a bug.

---

## Why this exists

For eight months every ad ran essentially the same copy — *"Proměňte své vzpomínky…"*. The spend bought reach and taught us nothing, because there was nothing to compare. An experiment with one condition has no result.

A generator that produces more untagged copy inherits that blindness exactly. What turns a generator into a **factory** is a closed, tagged taxonomy: every asset declares which claim it makes, so `analyze.mjs` can group spend by *claim* rather than by *ad ID*, and the next generation round can be pointed at what won.

---

## 1. Three slots, not one

The tempting move is one flat list of codes. It silently mixes three independent things:

- `EMO`, `GIFT`, `PROOF`, `SIMPLE`, `SCREEN`, `TOGETHER`, `RELAX`, `FUN` are **messages** — the claim.
- `KIDS`, `PET`, `COUPLE`, `GRAND` are **subjects** — who is in the photo.
- Season is **timing**.

Collapse them and the data cannot tell you whether `GIFT` beat `PET` because gifting is the right claim or because dogs are the right subject. That is the same attribution failure, moved one level up.

The existing creative codes have exactly this problem, by the way. `E4 "Prarodiče"` names a subject; `E19 "Screen time"` names a message. Both are useful production labels. Neither is an analysis dimension.

The clearest evidence that the split earns its keep: **`E4` and `E12` share a subject and differ in claim.** `E4` sells grandparents on emotion; `E12` sells *you* on a gift for granddad. Same people in the photo, different argument. One flat code cannot express that. Two slots can.

### Which slot gets a verdict

Sample size decides, not taste. At roughly **180 orders/month**:

| Split | Cells | Orders per cell per month | Verdict |
|---|---|---:|---|
| Angle only (7 live) | 7 | ~26 | ✅ Learnable in a month or two |
| Angle × Subject | 56 | ~3 | ❌ Noise that looks like signal |
| Angle × Subject × Format | 504 | <1 | ❌ Meaningless |

**`ANGLE` carries the verdict.** `SUBJECT` and `FORMAT` are read **marginally only** — collapsed across every other dimension — never as joint cells.

### Vocabulary size ≠ how many you can run

These are different limits, and conflating them is a mistake I made once already.

- The **vocabulary** is 8 angles. Defining a code costs nothing.
- The **live set** is capped by conversions: `floor(monthly conversions / FM_MIN_CONVERSIONS)`. At 180 orders and a 25-conversion minimum, that's **7 live angles**.

So all 8 codes exist, and at any moment roughly one sits on the bench. `analyze.mjs` warns when more angles are live than the conversion volume can resolve, and lists angles that have no creative at all.

---

## 2. ANGLE — the message (8 codes, ~7 live)

Each angle is a **falsifiable claim about why someone buys**, mapped to the value table in `brand-guide.md` § 6.

| Code | Claim | Guide § 6 value | Funnel | Example hook |
|---|---|---|---|---|
| `EMO` | The moment of recognition — the child sees *themselves*. | Emoce | SEE, CARE | "Jeho výraz, když pozná sám sebe, je k nezaplacení." |
| `GIFT` | Nobody else will give this gift. | Dárek + Osobní | DO | "Dárek, který nikdo jiný mít nebude." |
| `PROOF` | Others already bought it, and the quality holds up. | Kvalita + social proof | THINK | "Přes 2 000 proměněných fotek." |
| `SIMPLE` | It's effortless — upload a photo, we do the rest. | Jednoduchost | THINK, DO | "Nahrajete fotku. O zbytek se postaráme my." |
| `SCREEN` | Gets the kids off the tablet. Real paper, fine motor skills. | Offline | SEE | "Konečně omalovánky, které nebudou ležet v koutě." |
| `TOGETHER` | An activity the whole family sits down for. | Společný čas | CARE | "Aktivita, u které sedí celá rodina." |
| `RELAX` | You buy it for *yourself*. Antistress, ASMR, a slow evening. | (persona § 5) | SEE, CARE | "Meditace s pastelkou." |
| `FUN` | Humour and provocation stop the scroll. | (SEE register) | SEE | "Levnější než terapie." |

### The two angles worth watching

**`FUN` is the sharpest bet.** It's the register the docs are most excited about — `E18`, `VID4`, `VID6`, `VID8` — and the production priority list ranks `VID4 (iMessage)` as the single first thing to make. It's also the angle with the least evidence that it *sells* rather than merely getting watched. Judge it on CPA, never on views or shares. If it wins engagement and loses CPA, that is a finding.

**`TOGETHER` has no creative at all.** It appears in the canonical value table and in the CARE phase, and nothing in `E1`–`E21` or `VID1`–`VID9` argues it. It cannot be tested until someone makes one. That is not a reason to delete the code — it's a gap in the creative inventory, and naming it is how the gap becomes visible.

---

## 3. SUBJECT — who is depicted (marginal analysis only)

| Code | Who |
|---|---|
| `KIDS` | Children |
| `PET` | Dogs, cats, animals |
| `COUPLE` | Partners, anniversaries, weddings |
| `GRAND` | Grandparents ↔ grandchildren |
| `FAM` | The family as a whole |
| `SELF` | An adult buying for themselves |
| `MIX` | Deliberate breadth — grids and collages showing many subjects at once (`E21`, `VID5`) |
| `NONE` | No depicted subject — text-only "ugly ad" creatives (`E18`, `VID4`) |

`MIX` and `NONE` exist because the real creative inventory needed them. Without `NONE`, the highest-priority video in the production plan could not be named.

### Coherent pairings

`RELAX × KIDS` is incoherent. `SCREEN × SELF` is incoherent. The generator must refuse these rather than produce confused copy.

| Angle | Allowed subjects |
|---|---|
| `EMO` | KIDS, PET, COUPLE, GRAND, FAM, MIX |
| `GIFT` | KIDS, PET, COUPLE, GRAND, FAM, MIX, NONE |
| `PROOF` | KIDS, PET, COUPLE, GRAND, FAM, MIX, NONE |
| `SIMPLE` | KIDS, PET, COUPLE, GRAND, FAM, MIX, NONE |
| `SCREEN` | KIDS, FAM, NONE |
| `TOGETHER` | KIDS, FAM, GRAND, COUPLE |
| `RELAX` | SELF, COUPLE |
| `FUN` | KIDS, PET, COUPLE, SELF, NONE |

---

## 4. FORMAT — the production form (marginal analysis only)

| Code | What | Role |
|---|---|---|
| `SPLIT` | Clean digital split-screen, photo \| omalovánka | Thumbstop. Instant comprehension. First carousel slide. |
| `REAL` | Real-life photo — notebook on a table, in a hand | Trust and emotion. *What it's like.* |
| `HYBRID` | Notebook on a table **beside a phone showing the original photo** | The docs claim this works best. Broken out so the claim is testable. |
| `SCRAP` | "Přilepené" / scrapbook styl — taped-on elements, handmade feel | The brand's established visual signal (§ 8). Also the ugly-ad look. |
| `REVIEW` | Anonymised message screenshot overlaid on a visual | Authenticity. Never set a review in a pretty font. |
| `GRID` | Square collage of many transformations | Breadth. Strength in numbers. |
| `CAROUSEL` | Multi-slide | Consideration. Sequences SPLIT → REAL. |
| `REEL` | Vertical video | Brand and virality. Cheaper CPM. |
| `UGC` | Customer-supplied photo or video | Highest trust, lowest production cost. |

---

## 5. The V-code collision

Their two production docs both use `V`, for different things:

- `CREATIVE PRODUCTION – Evergreen Ads.md` uses **V1–V3** for split-screen *visual variants* inside `E2` (clean digital / scrapbook / mobil+papír).
- `CREATIVE PRODUCTION – Video & Animation.md` uses **V1–V9** for *video concepts* (Transformation, Time-lapse, Unboxing…).

A bare "V1" is therefore ambiguous. In this repo:

| Prefix | Means | Source |
|---|---|---|
| `E1`–`E21` | Evergreen static concept | their evergreen doc, unchanged |
| `VID1`–`VID9` | Video concept | their video doc's "VIDEO V1"–"V9" |
| `SV1`–`SV3` | Split-screen visual variant | their `E2` section's "V1"–"V3" |
| `v01`, `v02` | Copy variant, lowercase, in ad names only | ours |

Their documents are not edited. This is a reading convention.

---

## 6. Mapping the existing creatives

Their codes stay authoritative for production. This is how those creatives become *attributable*.

### Evergreen statics

| Code | Title | Angle | Subject | Format |
|---|---|---|---|---|
| `E1` | Vzpomínky k vybarvení | `EMO` | `FAM` | `HYBRID` |
| `E2` | Nejlepší dárek | `GIFT` | `KIDS` | `SPLIT` |
| `E3` | Mazlíčci | `EMO` | `PET` | `SPLIT` |
| `E4` | Prarodiče | `EMO` | `GRAND` | `REAL` |
| `E7` | Couple Goals | `GIFT` | `COUPLE` | `SPLIT` |
| `E12` | Dědeček & vnoučata | `GIFT` | `GRAND` | `REAL` |
| `E18` | 4 726 fotek | `FUN` | `NONE` | `SCRAP` |
| `E19` | Screen time | `SCREEN` | `KIDS` | `REAL` |
| `E21` | Social proof – čísla | `PROOF` | `MIX` | `GRID` |

The `E` series has gaps — E5, E6, E8–E11, E13–E17, E20 do not exist. It is not a dense range.

### Videos

| Code | Title | Angle | Format | Production priority |
|---|---|---|---|---|
| `VID4` | iMessage konverzace | `FUN` | `REEL` | 1 |
| `VID5` | Slide Show Reels | `PROOF` | `REEL` | 2 |
| `VID1` | The Transformation | `SIMPLE` | `REEL` | 3 |
| `VID6` | POV – Scrolluješ mobilem | `FUN` | `REEL` | 4 |
| `VID8` | Expectation vs. Reality | `FUN` | `REEL` | 5 |
| `VID3` | Unboxing Reaction | `EMO` | `REEL` | 6 |
| `VID2` | Time-lapse vybarvování | `RELAX` | `REEL` | 7 |
| `VID9` | Founder / Talking Head | `PROOF` | `REEL` | 8 |
| `VID7` | Satisfying Process | `RELAX` | `REEL` | 9 |

> **Worth noticing:** three of the top five production priorities are `FUN`, the angle with the least evidence it converts. That may be exactly right — `FUN` is cheap to produce and untested, so testing it first is rational. But if all three ship at once and `FUN` loses on CPA, a large slice of the video budget was spent proving one claim wrong. Stagger them.

---

## 7. Naming convention

Season and audience do not belong in the ad name. They belong in the campaign and ad-set names, which is where Meta's reporting hierarchy already aggregates them.

```
Campaign   FM_{market}_{objective}_{season}
Ad Set     {audience}
Ad         FM_{market}_{angle}_{subject}_{format}_v{NN}
```

| Slot | Values |
|---|---|
| `market` | `CZ`, `DE` — both live. `Fotoausmalbuch.de` is the decided DE brand, with its own tone of voice in `brand-guide.md` § 9. |
| `objective` | `SALES`, `TRAFFIC`, `AWARE`, `REMARKET` |
| `season` | `EVERGREEN`, `BTS`, `BF`, `XMAS`, `MIK`, `CONTEST`, `CHARITY`, `VAL`, `MDM`, `MDD` |
| `audience` | `BROAD`, `INT-FAM`, `INT-PET`, `INT-WEDDING`, `INT-MINDFUL`, `INT-DIY`, `LAL-1`, `LAL-3`, `RMKT-VC`, `RMKT-ATC` |
| `angle` / `subject` / `format` | §§ 2–4 |
| `v{NN}` | `v01`, `v02` … unique within its angle+subject+format |

For the German market, `BTS` covers **Einschulung**, which the guide flags as a far bigger deal than Czech back-to-school.

### Validators

```
Campaign  ^FM_(CZ|DE)_(SALES|TRAFFIC|AWARE|REMARKET)_(EVERGREEN|BTS|BF|XMAS|MIK|CONTEST|CHARITY|VAL|MDM|MDD)$
Ad        ^FM_(CZ|DE)_(EMO|GIFT|PROOF|SIMPLE|SCREEN|TOGETHER|RELAX|FUN)_(KIDS|PET|COUPLE|GRAND|FAM|SELF|MIX|NONE)_(SPLIT|REAL|HYBRID|SCRAP|REVIEW|GRID|CAROUSEL|REEL|UGC)_v\d{2}$
```

### Worked examples

| Name | Reads as | Source concept |
|---|---|---|
| `FM_CZ_GIFT_KIDS_SPLIT_v01` | Gift claim, child, clean split-screen | `E2` |
| `FM_CZ_EMO_GRAND_REAL_v01` | Emotional recognition, grandparents, lifestyle shot | `E4` |
| `FM_CZ_GIFT_GRAND_REAL_v01` | Gift-for-granddad — same subject as above, different claim | `E12` |
| `FM_CZ_FUN_NONE_SCRAP_v01` | Text-only ugly-ad provocation | `E18` |
| `FM_CZ_PROOF_MIX_GRID_v01` | Breadth collage as social proof | `E21` |
| `FM_DE_GIFT_GRAND_REAL_v01` | The E12 argument, German market | — |
| `FM_CZ_SALES_XMAS` / `LAL-1` | Christmas sales campaign, 1% lookalike ad set | — |

---

## 8. The existing ads

Eight months of live ads predate this convention and will not match the validator. They are not renamed — renaming an active ad gains nothing and risks whatever reporting exists.

`analyze.mjs` instead:

1. Parses every ad name against the ad validator.
2. On failure, buckets the ad as `LEGACY`.
3. **Excludes `LEGACY` from every angle, subject, and format verdict** — it carries no tags, so it can only pollute them.
4. **Includes `LEGACY` in the account-level baseline** (blended CPA, PNO, AOV).

`LEGACY` is therefore the control group, and its baseline is the number every new angle must beat. That is the most useful thing those eight months can still do.

An ad name that begins with `FM_` but fails the regex is a typo, not legacy. It is flagged loudly, because a misnamed ad silently loses its attribution and quietly joins the control group.

---

## 9. Rules for the generator

1. Every generated asset carries a full, valid ad name. Nothing ships untagged.
2. One asset makes **one** claim. Copy that argues both `SCREEN` and `GIFT` is two assets.
3. Refuse incoherent angle × subject pairs (§ 3).
4. Variant numbers are unique within their angle+subject+format triple.
5. Never invent an angle code. The vocabulary is closed. A genuinely new claim is a deliberate decision against the sample-size cost in § 1, not something added mid-batch.
6. Obey `brand-guide.md` § 14 — no invented numbers, ratings, or quotes. `[OVĚŘIT: …]` instead.
7. Obey the style rules in `RULES.md` — no em dashes in generated Czech copy, exclamation marks sparingly.

---

## 10. What the analyzer does with this

- Groups ad-level insights by `angle` → one verdict per angle: `SCALE` / `WATCH` / `KILL` / `INSUFFICIENT`.
- Groups marginally by `subject` and by `format` → directional signal only, never a joint cell.
- Emits `INSUFFICIENT` below `FM_MIN_CONVERSIONS` and says how many conversions are still needed.
- Compares every angle against the `LEGACY` baseline, not against zero.
- Warns when more angles are live than the conversion volume can resolve.
- Warns when an angle in the vocabulary has no creative in the E-code or video map.

Economics it serves: **PNO from ~50% on statics down under 45%, and under 35% once video runs.** An angle that raises AOV or repeat rate is worth more than one that merely lowers CPC.
