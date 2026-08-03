# Fotomalovánky — how to use it

This tool turns a folder of order photos into a print-ready PDF colouring book, one per
order. Everything happens on your own computer.

---

## First time only

1. Install **Node.js** from <https://nodejs.org> — pick the button that says **LTS**.
   Click through the installer with the default options.
2. Double-click **`Setup.cmd`**. It takes a few minutes.
3. When Notepad opens, paste your private generator link between the quotation marks
   after `"baseUrl"`, so it looks like this:

   ```
   "baseUrl": "https://fotomalovanky-app.onrender.com/your-private-link/"
   ```

   Save the file (Ctrl+S) and close Notepad.

That's it. You never need to do this again.

> **Keep that link private.** It is the only thing protecting your generator — anyone who
> has it can use your account. Don't paste it into chats, screenshots, or screen
> recordings. The tool deliberately never shows it on screen.

---

## Every time

1. Double-click **`Fotomalovanky.cmd`**. A black window opens, and the tool opens in your
   browser. **Leave the black window open** — closing it stops the tool.
2. Click **Browse…** and choose the folder your Chrome extension downloaded the orders
   into. The tool remembers it next time.
3. Press **Go**.

Now wait. Each photo takes a couple of minutes — the drawing is made on a graphics card
somewhere else, and the tool shows you what it is doing. A whole order of 16 photos can
take half an hour. You can leave it running and come back.

**Changed your mind?** While a run is going, the **Go** button is joined by a red **Stop**.
Press it and the tool finishes the drawing it is making right now — you can't pull a picture
back off the graphics card once it has started — then stops, rather than beginning the next one.
Everything already made is kept, and the orders it never reached are left exactly as they were.
Press **Go** when you are ready and it carries on from where it stopped, skipping what is done.

When it finishes you get a summary:

```
2 done, 1 waiting for you, 0 failed.
```

- **done** — the book is finished. You'll find `<order> Final.pdf` in that order's folder.
- **waiting for you** — some photos need your eye. See below.
- **failed** — something broke. The reason is written in plain words next to the order.
  Press **Go** again; most failures are the graphics card dropping a job, and a second
  attempt usually works.

---

## Reviewing the photos that need you

Photos the tool is unsure about — and any you don't like — appear at the top of the page,
with the original photo beside its colouring page.

The tool only notices four things by itself, and it says which one next to the photo:

| it says | what happened |
|---|---|
| `solid-fill` | hair, dark clothes or shadows came out **filled in solid black** instead of drawn as outlines. Nobody can colour those in. This is the one you will see most often. |
| `near-blank` | the page came out almost empty. |
| `near-solid` | the page came out almost entirely black. |
| `empty-svg` / `no-paths` | the drawing file has nothing in it. |

**It cannot see anything else.** It does not know whether a face still looks like the person,
whether someone's eyes were drawn open when they were closed, or whether the machine invented
a tree that was never in the photo. Those are the mistakes that actually reach customers, and
only your eye catches them. **Look at every photo, not only the ones the tool marked.**

For each one:

- **Approve** — it's good. Only an approved photo can go into the book.
- **Mark bad** — you don't like it. It leaves the book until you fix it.
- **Redo** — make it again, drawing it more slowly this time. Ask the drawing machine the
  exact same question and it gives you the exact same answer, so each redo asks a little
  differently. This is the first thing to try. Each redo takes a bit longer than the last,
  and after four of them the tool stops and says so — at that point, approve it, fix it by
  hand, or ask whoever set this up.
- **Fix by hand** — repair it yourself, here, with a white pencil and a crop tool. See
  [Fixing a page by hand](#fixing-a-page-by-hand) below.

A photo you repaired by hand comes back as *needs approval* — it never sneaks into the
book without you saying yes.

**An order prints only when every one of its photos is approved or clean.** One bad photo
holds back only its own order; the others still print.

When you have approved everything, press **Go** again. The tool skips everything already
done and just prints the books.

---

## Fixing a page by hand

**Fix by hand** opens the colouring page full size, with two tools:

- **White pencil** — paint over anything you want gone. The pencil is white, the same white
  as the paper, so a stroke rubs the drawing out. Drag the **size** slider for a fatter or
  finer pencil. This is the fix for hair or clothes that came out as a solid black blob:
  paint the blob away and leave the outline around it.
- **Crop** — drag a box, and everything outside it is trimmed off. Use it to cut away a
  distracting background, or to centre someone in the frame.

**To work on something small, zoom in.** Scroll the wheel to zoom towards wherever the
cursor is. To move the page around, drag it with the **right** mouse button, or hold
**Space** and drag. **Fit** puts the whole page back on screen. The left button always
draws, so the pencil never turns into a drag by accident.

The pencil is a size on the *page*, not on the screen: zooming in does not make it fatter,
it makes it easier to aim. Zoomed right in, a single unit of the drawing is about ten
screen pixels across, which is what you want for filling in a few stray dots.

**Undo** takes back your last stroke or box. **Clear** takes back all of them. **Cancel**
throws the whole lot away and changes nothing. Nothing is written until you press **Save**.

When you save, the page goes back to *needs approval* and is marked **fixed by hand**. Look
it over and approve it like any other page.

Changed your mind, even days later? Open it again and press **Revert to the generated
page**. The page the machine drew is kept safe the first time you edit, so this always
works — right up until you revert, which throws the edit away for good.

You are editing the vector drawing itself, which is the file the book is printed from. What
you see is what gets printed. You never have to open the `.svg` anywhere else, and there is
no second file to keep in step.

> Some pages need more than a pencil. Press **Repair elsewhere…** in the editor and the tool
> hands the page over: it names the folder, and there are buttons to open that folder and the
> generator. Repair the drawing, save the new `.svg` and `_bw.png` into it under **exactly the
> same names**, then press **I've replaced it**. It comes back as *needs approval*, same as
> everything else.

---

## Choosing what to work on

The tool opens on a clean page every time. It remembers the folder you used last and puts it in
the box, but it does not open it until you say so.

Press **Browse…** and pick the folder your orders are in. The dialog opens in front of the
browser, at the folder you used last time.

The tool then lists every order it found, with a tick beside each one. **Ticked orders are the
ones Go will work through**, one after another — tick five and go make coffee. Unticking an order
also takes it out of the grid below, so you only look at what you are actually working on.

If the folder holds more than eight orders you have probably opened your whole archive by mistake,
so nothing is ticked and the list arrives folded away — press **show the list** to open it. Tick
what you want yourself. **tick all** and **tick none** are there for the rest.

A photo that has not been made yet says *"not made yet — press Go to make it"*. Nothing is
happening until you press Go: ticking an order queues it, it does not start it.

Everything you finished before is in **Order history**, the button at the top right. It says how
many there are. It is closed again every time you open the tool.

---

## The title page

Each book can open with a dedication — *"Pro Barču, s láskou od rodiny"*.

**You usually do not have to type it.** The customer's words are already in the photo names:
`1523_img0001_-_hofbauerovi_18.7.2026` becomes *"Hofbauerovi 18.7.2026"*, and the tool fills the
**Title page** box in for you. Correct it if it looks wrong — what you type always wins, and it is
saved when you press Tab or click away.

### The accents

**Usually there is nothing to do.** The Chrome extension writes a small `objednavka.json` next to
the photographs, holding the dedication exactly as the customer typed it into the shop — accents
and all. The tool reads that file, and the box says *from the shop — the customer's own spelling*.

**Older orders have no such file, and their photo names lost the accents.** Order 1366's photos are
named `1366_img0001_-_pro_jiricka`, and nothing in that name can say whether the boy is *Jiříček*,
*Jiřiček* or *Jiricek*. So the tool does not guess. It suggests *"Pro Jiricka"* and says
*from the photo names — check the accents, then it is remembered*.

Type it properly — **Pro Jiříčka** — and the tool remembers that spelling against that name. The
next order for a Jiříček arrives already spelled right, and the box says *the spelling you saved
for this name*. Correct it again and the new spelling replaces the old one.

The spellings live in `dedications.json` beside `config.json`, in the tool's own folder. Emptying
one order's title does not teach the tool that the name has no title — it just forgets that
spelling.

If the shop's file and your saved spelling disagree, the shop wins: the customer's own words are
not a guess. Your saved spelling is left untouched for the orders that still need it.

**A customer who wrote nothing still gets their book.** The box stays empty, the box says *no
dedication*, and the run prints anyway: the title page and its four cover thumbnails are there,
just with no words on them. The run report ends that order's line with `(no dedication)` so you
can tell an empty title page apart from one you meant to fill in.

Emptying the box on purpose is an answer too — the tool takes it and stops suggesting.

---

## Things worth knowing

- **Nothing is lost if you close the tool.** Every decision is saved the moment you make
  it. Close it, reopen it, and carry on.
- **Pressing Go again is always safe.** Photos you approved, and photos that came out clean,
  are never made again. A book is only reprinted if something about it changed. Photos still
  marked bad *are* made again, the same way the **Redo** button makes them again — so if you
  would rather fix one by hand, press **Fix by hand** before you press Go.
- **While a run is going, the buttons are switched off.** The tool is rewriting those
  files; letting you change them at the same time would lose your decision.
- **Your photos never leave your computer**, except to the generator — the same place they
  already went when you did this by hand.
- **Delete a customer's photos when their book is printed**, or after 30 days.

---

## When something goes wrong

**"Node.js is not installed"** — do step 1 of *First time only*.

**"The tool has not been set up yet"** — double-click `Setup.cmd`.

**"Port 4173 is already in use"** — the tool is already running in another window. Look for
the black window, or close it and start again.

**The browser didn't open by itself.** The black window always prints the address. Open Chrome
and go to <http://127.0.0.1:4173/>. Everything you do — Browse, Go, reviewing photos — happens
on that page; there is nothing to click in the black window.

**"Could not launch the headless browser"** — run `Setup.cmd` again; it installs the
browser that makes the PDFs.

**"Input folder not found"** — the folder you chose isn't there any more. Press Browse…
and pick it again.

**The order number looks wrong.** The tool reads the order number from the photo
*filenames*, not from the folder name, because folder names get renamed by hand. If they
disagree it tells you which folder it read.

**An order number ends in `-1` or `-2`.** That is not a fault. The customer bought two
books in one checkout, so each book gets its own row, its own folder and its own PDF —
`1234-1` and `1234-2` are book 1 and book 2 of order 1234. They ship in **one parcel**,
so the board shows "1 z 2" on each row and warns you if you mark one sent or printed
while the other is not finished. You can go ahead anyway; it only asks so you do not
split a parcel by accident.

**A book you pulled by hand came out merged.** Pulling a folder manually gives the tool
no line-item information, so a two-book purchase recovered that way arrives as one job
with all the photos together and only one dedication. Either split the folder yourself
before running it, or let the overnight fetch retry the order so it comes down properly.
**A German order came out with the Czech logo.** The book's language comes from the product the
customer bought, and that product has to be listed in `languageMap` in `config.json`. Anything not
listed is treated as Czech. Nothing about the delivery address or the customer's own language
changes this — only what they bought.

There is **no German product in the shop yet**, so today every order is Czech. That is expected.
When you create the German product, put its exact title into `languageMap` and orders of it start
building in German straight away.

**"Builder has no de language control".** The print builder is running an older version than the
tool expects. The order was stopped on purpose rather than printed with the wrong logo. Czech
orders are unaffected and keep printing normally.

Anything else: whatever is written in the black window or on the page is the real reason.
Send that text to whoever set this up.
