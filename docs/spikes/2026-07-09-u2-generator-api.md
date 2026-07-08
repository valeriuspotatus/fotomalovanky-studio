# U2 spike — generator integration (resolved: scripted HTTP API)

**Date:** 2026-07-09
**Unit:** U2 (`GeneratorDriver`), resolves KTD2 and the Phase-0 generator seam.
**Verdict:** **API-first.** The generator is driven by reproducing its plain HTTP calls
(`ApiGeneratorDriver`). The Playwright `browserDriver` is kept only as the documented
fallback; per the plan's DoD it can be removed once the API driver is validated live.

## How this was determined

- `HAR.txt` — a browser network capture of one real 8-photo session (job `8b0c7d27…`).
  Request side fully captured (URLs, methods, headers, JSON bodies); **response bodies were
  not saved** by the export, so response shapes below came from the two sources next.
- Live read-only fetch of the results page `GET /{token}/compare/{job}` and the client
  bundle `GET /static/js/app.js` — these gave the exact endpoints, request/response fields,
  and the state machine. No generation was triggered.
- The operator's downloaded bundle `coloring-book-8b0c7d27.zip` — gave the authoritative
  output-file naming.

## Auth model

The **only** credential is the token in the URL path (`/{token}/…`). Across all 1,945
captured requests there were **no cookies, no `Authorization` header, and no `Set-Cookie`**.
So the API is reproducible from a plain HTTP client with just the token-scoped base URL.
Backend GPU is **RunPod serverless** (jobs have a `runpod_job_id`; statuses are RunPod's).

## Endpoint contract

`prefix` = `https://fotomalovanky-app.onrender.com/{token}` (token lives in `config.json`, never in source).

| Step | Call | Request | Response |
|---|---|---|---|
| Upload | `POST {prefix}/upload` | `multipart/form-data`: `files[]` = image; plus `job_id` field on the 2nd+ files to append to one job. **One request per file.** | `{ job_id, count, error? }` |
| List | `GET {prefix}/status/{job}` | — | `{ files: [{ filename }, …] }` — server stores each upload under a **hash-prefixed** name (`<hash>_<originalname>`); use this name downstream. |
| Process | `POST {prefix}/process/{job}/{file}` | JSON `{ model, megapixels, steps, positive_prompt?, negative_prompt? }` (omit a prompt → server default). One request per (file × variant). | `{ success, variant_key, runpod_job_id, error? }` |
| Poll | `GET {prefix}/process-status/{job}/{file}/{variantKey}` | — | `{ status, error? }`, status ∈ `IN_QUEUE \| IN_PROGRESS \| COMPLETED \| FAILED`. UI polls every **4 s**. |
| Vectorize | `POST {prefix}/vectorize/{job}/{file}` | JSON `{ variant_key }` | `{ success, jpg_filename, png_filename, svg_filename, error? }` — **this is the step that mints the SVG** (and the final clean-named jpg/_bw.png). |
| Download | `GET {prefix}/download/{job}/{filename}` | filename = one of the vectorize response names | the file bytes (`inline; filename=…`). |
| Download all | `GET {prefix}/download-all/{job}` | — | `coloring-book-{job}.zip` of every vectorized image's triple. |
| Crop (optional) | `POST {prefix}/crop` | JSON `{ job_id, filename, target:"result_{variantKey}", crop:{x,y,width,height} }` | `{ success, image (base64) }` — manual crop of a result; not used by automation. |
| Image (preview) | `GET {prefix}/image/{job}/{name}` | original `{file}`, or raster variant `{base}_{variantKey}.png` | image bytes — used by the compare grid; automation downloads via `/download/` instead. |

### Variant / settings semantics

- A **variant** = `variant_key` = `"<model>_<megapixels>"`, e.g. `2509_1.5`. `model` ∈ `2509` / `2511`
  (Qwen Image Edit 2509 / 2511); `megapixels` ∈ `1.0 / 1.25 / 1.5` (10 res tiers exist; these were used).
- `steps` = diffusion steps; the operator used **4** (Lightning LoRA) for every variant.
- The captured session ran **4 variants × 8 photos** with identical default prompts — that's the
  operator's manual *compare-and-pick* workflow. **Automation only needs one configured variant**
  per photo (process → vectorize → download), which is what `ApiGeneratorDriver.generate()` does.
- The exact default prompts the operator uses are now in `config.example.json`
  (positive 1129 chars, negative 331 chars) — captured verbatim from the `/process` body.
- The web UI **downscales images > 2500 px** (longest edge) to JPEG q0.92 before upload; the driver
  mirrors this with `sharp`.

## Output naming (authoritative — from the download-all zip)

Each photo yields **three** files. `download-all` also **strips the server hash prefix**, so the
base is the uploaded filename minus extension:

```
<base>.jpeg      original photo (echoed back)
<base>_bw.png    raster line-art (Qwen output)
<base>.svg       vector line-art (traced; ~1800 stroke paths, no embedded raster)
```

The builder then consumes a folder of these and emits `<order> Final.pdf`.

### Corrections to the plan's assumptions

The plan/README assumed a **`<base>.jpg` + `<base>_bw.svg` pair**. Reality:

1. **Three files per photo, not two** — `.jpg` + `_bw.png` + `.svg`.
2. **`_bw` is on the PNG, not the SVG** — the SVG is plain `<base>.svg`.
3. **The SVG is a separate `/vectorize` step**, not an automatic `/process` output — which is why it
   never appeared in the HAR (the operator vectorized + downloaded after the capture ended).

`src/organize.js` and `src/skeleton.js` were updated to this triple; U3 (organize/batch) and U5
(builder contract) should assume it.

## Latency / timeout guidance

The captured 32-generation batch spanned ~31 min (Render cold start + RunPod queue + diffusion);
a single generation needed up to ~175 polls. The driver defaults (overridable via
`generator.timeouts`): request timeout 60 s, poll interval 4 s, max poll 20 min, vectorize timeout
3 min, 4 retries with exponential backoff. Retries treat network errors, timeouts, and
408/429/5xx as transient (cold-start-aware).

## Live validation (2026-07-09)

`ApiGeneratorDriver` was run end-to-end against the live app on one real order photo
(variant `2509_1.5`, steps 4). **All inferred response fields confirmed:** upload → `job_id`;
status → hash-prefixed `filename` (`adcb7879_live_input.jpeg`); process → `success` +
`variant_key`; process-status → `IN_QUEUE → IN_PROGRESS → COMPLETED`; vectorize → `success` +
`jpg_filename`/`png_filename`/`svg_filename`; download → the three files. One generation took
**~189 s** on a cold RunPod worker. Outputs came back as the expected triple:
`live_input.jpeg` + `live_input_bw.png` + `live_input.svg` (2382 vector paths). The generator
half of the Phase-0 walking skeleton is proven.

## Open items

- **Which variant is the default?** `config.example.json` ships `2509_1.5` (validated above), but the
  operator's true preferred variant is a quality choice — confirm during the U8 value-gate. (The app's
  own internal fallback is `2509_1.0`.)
- **Builder seam (U5)** is still a stub — the other half of the walking skeleton.
- Crop is a manual touch-up path; left out of the automated driver (available as a redo option later).

## Provenance

HAR job `8b0c7d27-6244-42dd-8dbd-d6dca65f375d`; bundle `coloring-book-8b0c7d27.zip`;
client `app.js` (26,930 bytes) and `compare/{job}` page fetched 2026-07-09.
