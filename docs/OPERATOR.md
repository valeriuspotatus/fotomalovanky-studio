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
- **Fix by hand** — repair it yourself. The tool shows you which folder to save into.
  Repair the drawing (in the generator, or in Figma), save the new `.svg` and `_bw.png`
  files with **exactly the same names** into that folder, then press **I've replaced it**.

A photo you repaired by hand comes back as *needs approval* — it never sneaks into the
book without you saying yes.

**An order prints only when every one of its photos is approved or clean.** One bad photo
holds back only its own order; the others still print.

When you have approved everything, press **Go** again. The tool skips everything already
done and just prints the books.

---

## Choosing what to work on

Press **Browse…** and pick the folder your orders are in. The dialog opens in front of the
browser, at the folder you used last time.

The tool then lists every order it found, with a tick beside each one. **Ticked orders are the
ones Go will work through**, one after another — tick five and go make coffee. Unticking an order
also takes it out of the grid below, so you only look at what you are actually working on.

If the folder holds more than eight orders you have probably opened your whole archive by mistake,
so nothing is ticked. Tick what you want yourself.

Orders you finished earlier still live in the outbox, and the grid keeps them below a line that
says *"N earlier orders, not in this folder"*. Press **show** if you need one of them back.

---

## The title page

Each book can open with a dedication — *"Pro Barču, s láskou od rodiny"*.

**You usually do not have to type it.** The customer's words are already in the photo names:
`1523_img0001_-_hofbauerovi_18.7.2026` becomes *"Hofbauerovi 18.7.2026"*, and the tool fills the
**Title page** box in for you, marked *from the photo names*. Correct it if it looks wrong — what
you type always wins, and it is saved when you press Tab or click away.

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

Anything else: whatever is written in the black window or on the page is the real reason.
Send that text to whoever set this up.
