# Overnight, 9→10 July 2026

Everything you asked for is done and committed on `feat/overnight-picker-grid-editor`.
Nothing is pushed. `outbox/1523`, `outbox/1479` and `Objednavky Hotove` were never touched.

**Green:** 205 unit tests. Browser harnesses — grid 21/21, queue 16/16, editor 20/20,
dedication-safety 16/16, folder-picker 5/5.

---

## Three things for you to do

1. **Close the tool and reopen it.** Your instance from last night is still running the old
   code, so none of this shows up until you restart it.
2. **Repair the machine PATH.** Open PowerShell *as Administrator* and run
   `C:\Users\David\path-backup-20260710\fix-machine-path.ps1`. Your user PATH is already
   fixed; the machine half is what is still missing `System32`. Backups of both are in that
   folder.
3. **Decide about the branch.** Say the word and it merges into
   `feat/fotomalovanky-order-automation`.

---

## What changed

### 1. The wiped dedication on 1523

**Not reproduced, and now largely impossible.** I drove nine adversarial sequences at the
title-page box — focus and blur, repaint mid-type, a forced repaint while dirty, pressing Go
with the box focused, reloading, the browser losing focus, tabbing through. None of them wrote
an empty dedication. So rather than guess at a cause I closed the whole class of them:

- The box now saves **only on a real edit** — focus, tab through, blur unchanged, nothing is
  written. The old code saved on any blur.
- A clear is **undoable**. Emptying a dedication records what it was, and the order shows
  *no dedication — was "Hofbauerovi 18.7.2026"* with a **restore** button next to it.
- A missing dedication **no longer blocks printing**. The book prints without a title text.
  (Measured: with your `coverCount: 4`, the book is 20 pages either way.)

1523's text was already back on disk when I went to restore it. It reads
`Hofbauerovi 18.7.2026` now, with all 8 pages intact.

**Honest caveat:** I never found the culprit. If it ever happens again, the *was "…"* hint and
the restore button will be sitting right there, and that itself is the evidence I'd want.

### 2. The folder dialog opens in front

Clicking **Choose a folder** now opens a real Windows folder dialog, on top of the browser.
Windows refuses to let a background process take the foreground, so the picker attaches to the
browser's input thread and raises a genuine top-most owner window first. The probe asserts the
dialog really *is* the foreground window and really belongs to the picker process — not merely
that it exists somewhere behind Brave.

### 3. Finished orders stop piling up

Books that are done collapse behind a **show earlier orders** divider. The grid shows what is
live; the rest is one click away.

### 4. Several orders, run one by one

Point the tool at a folder, tick the orders you want, press **Go**, and it works through them
in turn. Go refuses to start with nothing ticked, rather than quietly running all of them.

### 5. Fix by hand, inside the tool

**Fix by hand** now opens the page with a **white pencil** (with a size slider), a **crop box**,
undo, clear and cancel. Nothing is written until you press Save.

The edit goes into the **SVG**, because the SVG is what the book prints. The preview PNG is
re-rendered from the edited SVG, so the two can never disagree. No downloading, no re-saving,
no matching filenames.

Changed your mind, even days later? **Revert to the generated page** puts back exactly what the
machine drew — the original is copied aside on your first edit, outside the folder the builder
reads. Reverting throws the edit away for good.

Some pages need more than a pencil. **Repair elsewhere…** in the editor toolbar hands the page
over the old way: it names the folder, offers to open it and the generator, and waits for
**I've replaced it**.

---

## Two bugs the browser test caught that the unit tests could not

**The editor opened on nothing.** Real generated pages carry a `viewBox` and no width or height,
so the `<img>` had no size of its own and laid out at zero pixels. My first fix *squashed* it
instead — 1200×760 for a 1.353-shaped page — because `width`/`height` on an `<img>` are
presentational hints, so `max-width` and `max-height` clamp each axis independently and neither
preserves the other. The editor now measures the open dialog and sizes the frame itself.

Checked against a copy of order 1523: **1028×760, aspect 1.3526 against the file's 1.3529**, and
a stroke drawn across the middle lands at **294,544** in the file — where it was drawn.

**A reverted page still called itself hand-fixed.** `revertPhotoEdit` restored the files but left
the backup behind, so the tile went on claiming the page was repaired and went on offering to
undo an edit that was already gone.

Separately: swapping in the editor had orphaned the old repair-in-another-program flow — its
**I've replaced it** button had become unreachable from the grid. That is what
**Repair elsewhere…** restores.

---

## Printing is proven, not assumed

A page painted with a 60-unit white stroke, and a page cropped to 652.8×1030.4, were driven
through the **live** builder from a scratch copy of 1523:

```
built in 8.5s — pairs 8, pages 20
reference: the untouched book is 20 pages with 8 pairs
```

Painting and cropping print, and the book comes out structurally identical.

---

## Still open

I never identified what printed the original
`"…\powershell.exe" terminated with exit code: 1`. It was not anything in this repository.
