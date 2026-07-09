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

For each one:

- **Approve** — it's good. Only an approved photo can go into the book.
- **Mark bad** — you don't like it. It leaves the book until you fix it.
- **Redo** — make it again. Every attempt comes out slightly different, so a redo often
  fixes a bad drawing on its own. This is the first thing to try.
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

## The title page

Each book can open with a dedication — *"Pro Barču, s láskou od rodiny"*. Type it into the
**Title page** box at the top of the order, then press Tab or click away.

If you leave it empty the book has **no title page**, which makes it two pages shorter than
the books you've been making. The tool warns you when an order has none.

---

## Things worth knowing

- **Nothing is lost if you close the tool.** Every decision is saved the moment you make
  it. Close it, reopen it, and carry on.
- **Pressing Go again is always safe.** Photos already finished are not made again, and a
  book is only reprinted if something about it changed.
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

**"Could not launch the headless browser"** — run `Setup.cmd` again; it installs the
browser that makes the PDFs.

**"Input folder not found"** — the folder you chose isn't there any more. Press Browse…
and pick it again.

**The order number looks wrong.** The tool reads the order number from the photo
*filenames*, not from the folder name, because folder names get renamed by hand. If they
disagree it tells you which folder it read.

Anything else: whatever is written in the black window or on the page is the real reason.
Send that text to whoever set this up.
