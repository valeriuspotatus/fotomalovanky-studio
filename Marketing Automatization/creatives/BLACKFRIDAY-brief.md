# Creative Brief — Black Friday 2026 (bundle, ne sleva)

**Trh:** CZ · **Sezóna:** `BF` · **Datum:** pátek 27. 11. 2026 (víkend 27.–30. 11.)

> Black Friday padá doprostřed vánoční fáze 1 (`calendar/2026-h2.md`). Brand guide § 4 zakazuje
> **sleva, akce, výprodej, levný** a `lint-copy.mjs` je blokuje. Tenhle brief řeší Black Friday
> **bez jediného z těch slov** — přes bundle, ne přes procenta.
>
> Kódy: **BF1, BF2**.

---

## 1. Proč bundle a ne sleva (a kde je háček)

Sleva a bundle nejsou totéž pro PNO:

- **Sleva** sníží cenu → sníží obrat na objednávku → **PNO se zhorší**. A PNO potřebujeme dolů
  (cíl < 35 %), ne nahoru. Sleva táhne přesně opačným směrem, než kam mají mířit celé Vánoce.
- **Bundle** přidá hodnotu → zvedne AOV → **PNO se zlepší**, protože stejný ad spend se rozpustí
  do většího obratu.

**Háček, který nesmíme obejít:** bundle, který dá něco **zadarmo**, je sleva v převleku — sebere
marži úplně stejně. Bundle pomáhá AOV jen když je:

1. **prahový** — dárek navíc až od určité útraty (tlačí lidi na 8-stránkovou, tu "nejoblíbenější"), nebo
2. **placený add-on** — pastelky/druhá kopie za příplatek s dobrou marží.

"Ke každé objednávce pastelky zdarma" AOV **nezvedne**, jen sebere marži. To je rozhodnutí, které
musí padnout dřív, než kreativa poběží. Viz `[OVĚŘIT]` v § 5.

---

## 2. Načasování: urgenci nemusíš kupovat slevou

Black Friday víkend je zároveň **poslední rozumné okno pro doručení na Mikuláše** (5. 12.).
Mikulášská objednávka potřebuje odejít zhruba do 30. 11. — což je neděle Black Friday víkendu.

To je **skutečná** urgence, ne vymyšlený odpočet. Nemusíš říkat "akce končí o půlnoci".
Můžeš říct "tenhle víkend je poslední, kdy to stihne na Mikuláše" — a je to pravda.
(Přesné datum uzávěrky = `[OVĚŘIT]`, viz vánoční brief.)

---

## 3. BF1 "Celý dárek v jedné krabici" — prospecting

| | |
|---|---|
| **adName** | `FM_CZ_GIFT_NONE_REAL_v02` |
| **angle / subject / format** | GIFT / NONE / REAL |
| **Fáze / persona** | DO / dárci · cold + broad |

### Vizuál
Reálná flat-lay fotka: hotová osobní omalovánka, k ní prémiové pastelky, případně krabice/mašle.
"Kompletní dárek" na jednom záběru. Teplé světlo, domácí, ne stock.

### Copy
**Primary text:**
> Tenhle víkend nedáváte jen omalovánku.
>
> K osobní omalovánce z vaší fotky přibalíme i prémiové pastelky, aby se dalo malovat hned, jak dárek rozbalí.
>
> Celý dárek v jedné krabici, připravený pod stromeček.
>
> [OVĚŘIT: do kdy objednat, aby dárek přišel na Mikuláše a do Vánoc]

**Headline:** Celý dárek v jedné krabici
**Description:** Omalovánka a pastelky pohromadě
**CTA:** Vytvořit omalovánku

---

## 4. BF2 "Druhá kopie pro babičku" — remarketing

| | |
|---|---|
| **adName** | `FM_CZ_TOGETHER_GRAND_REAL_v02` |
| **angle / subject / format** | TOGETHER / GRAND / REAL |
| **Fáze / persona** | CARE / prarodiče · remarketing na stávající zákazníky |

### Proč zrovna tohle
Druhá kopie je **levná na výrobu** (stejný soubor, jen dotisk), takže jako bundle sebere míň
marže než pastelky navíc. A tematicky sedí na `TOGETHER` — "malujete každý u sebe a stejně spolu".
Zároveň to dává angle `TOGETHER` sezónní aktivaci a otestuje ho na traffic-heavy víkendu.
Marketingový plán tenhle upsell sám navrhoval ("druhá kopie pro babičku").

### Vizuál
Dvě stejné omalovánky, dvě sady rukou, dva stoly — split nebo koláž. Babička u sebe doma, rodina
u sebe, stejná stránka. Zdůraznit "stejná vzpomínka na dvou místech".

### Copy
**Primary text:**
> Jednu omalovánku vybarvíte a je pryč. Co takhle dvě?
>
> Tenhle víkend k objednávce přibalíme druhou kopii, aby si stejnou vzpomínku vybarvila i babička u sebe doma.
>
> Dvě knihy, jedna vzpomínka. Malujete každý u svého stolu a stejně jste u toho spolu.

**Headline:** Druhá kopie pro babičku
**Description:** Stejná vzpomínka, dvakrát
**CTA:** Vytvořit omalovánku

---

## 5. Co musí David rozhodnout, než to poběží

- **`[OVĚŘIT]` Jaký bundle mechanismus?** Prahový dárek, nebo placený add-on? "Zdarma ke všemu"
  je skrytá sleva a AOV nezvedne (§ 1). Tohle je ekonomické rozhodnutí, ne copywriting.
- **`[OVĚŘIT]` Jsou prémiové pastelky k dispozici a za jakou nákladovou cenu?** BF1 je bez nich prázdný.
- **`[OVĚŘIT]` Datum mikulášské/vánoční uzávěrky.** Bez něj nesmí do copy konkrétní termín.
- **`[OVĚŘIT]` Kolik stojí druhý dotisk?** BF2 dává smysl, jen pokud je marginální náklad druhé kopie nízký.

Copy **záměrně neobsahuje žádnou cenu ani procento** — jednak to § 4 zakazuje, jednak konkrétní
čísla neznáme. Prahy a ceny patří na landing page, ne do reklamního textu.

---

## 6. Ověření

```bash
node factory/lint-copy.mjs creatives/blackfriday-concepts.json
# → 0 BLOCK
```

Obě kreativy prošly linterem bez chyby — a to je pointa: Black Friday bez jediného slova "sleva".
Kdyby copy takové slovo obsahovalo, `lint-copy.mjs` ho zablokuje (ověřeno negativním testem).
