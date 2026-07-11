# Creative Brief — Mikuláš 2026

**Trh:** CZ · **Sezóna:** `MIK` · **Datum:** Mikuláš večer pá 5. 12., svátek so 6. 12. 2026

> `calendar/2026-h2.md` značí Mikuláše jako mezeru: "5. 12. Mikuláš (večer) — chybí kreativa".
> Produkt na Mikuláše sedí ideálně — malý osobní dárek pro dítě. Tohle tu mezeru zaplňuje.
>
> Kódy: **M1, M2**. DE ekvivalent Nikolaustag (6. 12.) viz `brand-guide.md` § 9 — až po spuštění DE.

---

## 1. Okno je krátké a navazuje na Black Friday

Mikuláš je 5. 12. Objednávka musí odejít do **30. 11.** (pondělí, Cyber Monday), aby dorazila včas.
Potvrzeno (David, 2026-07-10): výroba a přeprava 3–4 pracovní dny → doručení kolem 4. 12., den před mikulášskou nocí.

To znamená: Mikuláš kreativa běží **cca 24. 11. – 3. 12.**, překrývá se s Black Friday a plynule
navazuje na vánoční fázi 1. Není to samostatná kampaň, je to krátký sezónní hook uvnitř běžícího provozu.

---

## 2. M1 "Malý dárek od Mikuláše" — GIFT

| | |
|---|---|
| **adName** | `FM_CZ_GIFT_KIDS_REAL_v01` |
| **angle / subject / format** | GIFT / KIDS / REAL |
| **Fáze / persona** | DO / rodiče, prarodiče |

### Vizuál
Reálná fotka: hotová osobní omalovánka jako dárek od Mikuláše — u boty za oknem, u punčochy,
nebo prostě v ruce dítěte. Teplé, domácí, prosincové. Ne stock.

### Copy
**Primary text:**
> Co letos přinese Mikuláš? Něco lepšího než uhlí.
>
> Osobní omalovánka, na které se dítě pozná. Malý dárek, u kterého stráví celé prosincové odpoledne tvořením.
>
> Objednejte do 30. 11., ať to na Mikuláše 5. 12. stihne.

**Headline:** Malý dárek od Mikuláše
**Description:** Osobní omalovánka z vaší fotky
**CTA:** Vytvořit omalovánku

---

## 3. M2 "Byl jste hodný?" — FUN

| | |
|---|---|
| **adName** | `FM_CZ_FUN_KIDS_SPLIT_v02` |
| **angle / subject / format** | FUN / KIDS / SPLIT |
| **Fáze / persona** | SEE / broad, rodiče |

### Proč FUN a proč zrovna teď
Mikuláš má hotový vtipný hook — čert, uhlí, "byl jsi celý rok hodný?". To je přesně `FUN`.
A `FUN` je zatím nejméně ověřený angle s nejvíc rozpracovanými videi (E17, E18, VID4/6/8).
Statický Mikuláš dá `FUN` levný sezónní test na traffic-heavy období, než se do něj naleje
video budget. Soudí se podle CPA, ne podle zhlédnutí.

### Vizuál
Hravé: split "uhlí vs omalovánka", nebo čertovsko-andělský motiv. Lehké, ne strašení. Dítě v záběru.

### Copy
**Primary text:**
> Byl jste celý rok hodný? Skvělé.
>
> Byl jste občas trochu čert? No, my vás nesoudíme.
>
> Letos místo uhlí zkuste omalovánku z vaší nejlepší fotky. Mikuláš by souhlasil.

**Headline:** Letos místo uhlí
**Description:** Osobní omalovánka z fotky
**CTA:** Vytvořit omalovánku

---

## 4. Produkční seam a načasování

- Vyrobit v **říjnu/první půli listopadu** společně s vánočními kreativami.
- ✅ **Mikulášská uzávěrka potvrzena:** 30. 11. (výroba + přeprava 3–4 pracovní dny). V M1 je konkrétní datum.
- Sestavit reklamy v Meta ručně (nemáme `ads_management`).

Krátké okno znamená, že Mikuláš nestihne vlastní 25-konverzní odečet. Neber ho jako angle test,
ber ho jako sezónní aktivaci `GIFT` a `FUN`, které se testují celoročně.

---

## 5. Ověření

```bash
node factory/lint-copy.mjs creatives/mikulas-concepts.json   # → 0 BLOCK
node factory/check-names.mjs                                 # → žádné kolize ad names napříč soubory
```
