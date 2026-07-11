# Creative Brief — Zpátky do školy 2026

**Trh:** CZ · **Sezóna:** `BTS` · **Datum:** út 1. 9. 2026 (nasazení konec srpna)

> Nahrazuje rozbité `S5 "Zpátky do školy"` z `MARKETING PLAN v2.md`. To mělo v description
> **"Originální dárek od 249 Kč"** — cena v copy porušuje brand guide § 4 a `lint-copy.mjs` ji
> blokuje. Navíc 249 Kč neodpovídá ceníku (nejlevnější položka je 337 Kč). Ceny patří na
> landing page, ne do reklamy. Tady žádná není.
>
> Kódy: **BTS1, BTS2**.

---

## 1. Proč je tahle sezóna jiná: dá se otestovat

Dneska je 10. 7., zpátky do školy je 1. 9. To je **7 týdnů**, celé před freeze (1. 11.). Na
rozdíl od Vánoc a Mikuláše, kde je okno moc krátké na 25 konverzí, **BTS se stihne skutečně
změřit**. Ber ho jako plnohodnotný angle test, ne jen sezónní aktivaci.

To je taky důvod, proč jsou tu dva různé angles (`EMO`, `SCREEN`) — máme čas zjistit, který
z nich pro tuhle sezónu funguje.

---

## 2. Co "zpátky do školy" pro tenhle produkt vlastně je

Není to školní potřeba (omalovánky se do aktovky nebalí). Silné jsou dvě jiné roviny:

- **Léto právě skončilo.** Mobil je plný prázdninových fotek a začíná rutina. "Než ty vzpomínky
  zapadnou, udělejte z nich něco, co zůstane." → `EMO`.
- **Kratší večery, zpátky k tabletu.** Podzim = děti víc doma, víc u obrazovky. Kreativní
  aktivita na tmavé podvečery. → `SCREEN`.

---

## 3. BTS1 "Kus léta, který zůstane" — EMO

| | |
|---|---|
| **adName** | `FM_CZ_EMO_KIDS_HYBRID_v01` |
| **angle / subject / format** | EMO / KIDS / HYBRID |
| **Fáze / persona** | SEE / rodiče |

### Vizuál
Stůl, na něm mobil s letní fotkou (moře, mola, prázdniny) a vedle hotová omalovánka téže scény.
Kolem pár školních věcí — tužky, sešit — jako náznak, že léto končí. Kontrast "léto v mobilu →
hmatatelná vzpomínka na stole".

### Copy
**Primary text:**
> Prázdniny utekly jako voda. Ale ta fotka, kde skáčete z mola do vody, pořád existuje.
>
> Než zapadne mezi tisíci dalšími v mobilu, uděláme z ní omalovánku. Kus léta, který dítěti zůstane, i když venku prší a začíná škola.
>
> Dovolená, která nekončí.

**Headline:** Kus léta, který zůstane
**Description:** Omalovánka z prázdninových fotek
**CTA:** Vytvořit omalovánku

> "Dovolená, která nekončí" je ověřená tagline (brand guide § 4, Tier 3).

---

## 4. BTS2 "Podvečer bez obrazovky" — SCREEN

| | |
|---|---|
| **adName** | `FM_CZ_SCREEN_FAM_REAL_v01` |
| **angle / subject / format** | SCREEN / FAM / REAL |
| **Fáze / persona** | SEE / rodiče |

### Proč zrovna SCREEN
`SCREEN` je jeden z nejsilnějších rodičovských hooků a jeden ze dvou "negativních" formátů, které
doc označuje za nejvýkonnější pro cold audience — a přesto má **jedinou** kreativu (`E19`). BTS2
tu mezeru zaplňuje a sezóna sedí: podzim, kratší večery, zpátky k tabletu. Přirozený druhý test
proti BTS1.

### Vizuál
Podvečerní domácí scéna, teplé světlo. Dítě (nebo víc dětí) u stolu s pastelkami a omalovánkou,
tablet odložený stranou. Klid, ne guilt-tripping. Reálné, ne stock.

### Copy
**Primary text:**
> Škola začala, večery se krátí a tablet je zase po ruce.
>
> Až příště uslyšíte "nudím se", vytáhněte omalovánku z vlastní fotky. Vlastní pastelky, vlastní vzpomínka, a klid na celý podvečer bez obrazovky.
>
> Kreativita, u které děti vydrží.

**Headline:** Podvečer bez obrazovky
**Description:** Osobní omalovánka z fotky
**CTA:** Vytvořit omalovánku

---

## 5. Poznámka pro DE (až přijde čas)

Německé **Einschulung** (srpen/září) je podle brand guide § 9 obrovská příležitost — děti dostávají
"Schultüte" plnou dárků a osobní omalovánka do ní ideálně sedí. To je mnohem silnější BTS moment
než v CZ. Ale DE trh není spuštěný (`GERMANY_GTM_PLAN.md` chce Impressum, Datenschutz, PayPal).
Až se spustí, Einschulung kreativa má přednost — je to jedno z mála míst, kde DE poptávka
převyšuje CZ.

---

## 6. Produkční seam

- Vyrobit v **srpnu**, nasadit konec srpna, běžet přes 1. 9.
- Žádné `[OVĚŘIT]` datum — BTS není o dodací uzávěrce, je o sezónní náladě. (Doručení do začátku
  školy je nice-to-have, ne hard deadline jako Vánoce.)
- Sestavit v Meta ručně.
- **Cena zůstává na landing page, ne v reklamě.** Tím se řeší celý problém starého S5.

---

## 7. Ověření

```bash
node factory/lint-copy.mjs creatives/backtoschool-concepts.json   # → 0 BLOCK
node factory/check-names.mjs                                       # → žádné kolize
```
