# Creative Production – Evergreen Ads (Weave / Figma)

> Workflow a prompty pro tvorbu FB/IG kreativ v Weave. Prompty v angličtině pro lepší výkon AI modelů. Texty a copy v češtině (DE verze v Brand Guide).

---

## Obecné principy pro top-performing kreativy

### Co funguje na Meta Ads (2025-2026 best practices)
- **Thumb-stop v první 0.3s** – vizuál musí zastavit scroll okamžitě
- **Jedna jasná message** – ne 3 věci najednou, jeden vizuál = jeden koncept
- **Kontrast** – výrazný rozdíl mezi pozadím a produktem
- **Faces perform** – obličeje (zejména dětské) mají nejvyšší engagement
- **Before/After** – split screeny mají na Meta konzistentně vysoké CTR
- **"Ugly ads" trend** – kreativy, které vypadají jako organic post, ne jako reklama, mají nižší CPM
- **Text na vizuálu** – max 20% plochy (Meta penalizuje text-heavy kreativy)
- **Mobilní kontext** – vždy myslet na to, že to vidí na 6" displeji

### Formáty k vytvořit pro každou kreativu
1. **1080×1080** – Feed square (základ)
2. **1080×1350** – Feed portrait 4:5 (víc prostoru ve feedu, nejvyšší priorita)
3. **1080×1920** – Stories/Reels (vertical)

### Barevné schéma (rotovat mezi variantami)
- **Warm A:** #F5A623 (oranžová) + #FFF5E6 (krémová) – hlavní, ověřené
- **Warm B:** #E8845C (broskvová) + #FFF0EB (světle růžová) – měkčí, emocionální
- **Cool A:** #6C5CE7 (fialová) + #EEEAFF (levandulová) – kontrastní, vyčnívající
- **Cool B:** #4A90D9 (modrá) + #E8F0FE (ledová) – svěží, moderní
- **Neutral:** #F8F8F8 (off-white) + stíny – "clean" styl, produkt vynikne

---

## KREATIVA E1: "Vzpomínky k vybarvení"

### Koncept
Lifestyle záběr – omalovánka na stole s pastelkami, vedle mobil s původní fotkou. Teplé, domácí prostředí. Jako by to někdo vyfotil telefonem.

### Vizuální layout (1080×1350)
```
┌─────────────────────┐
│                     │
│   [Hero image:      │
│    coloring book    │
│    on table with    │
│    phone next to    │
│    it showing       │
│    original photo]  │
│                     │
│  ┌───────────────┐  │
│  │ Omalovánky    │  │
│  │ z vašich fotek│  │
│  │ 🖍 FOTOMAL.   │  │
│  └───────────────┘  │
│                     │
│  "Krásný dárek,     │
│   co chytne za      │
│   srdce"            │
│                     │
└─────────────────────┘
```

### Varianta A: Compositor – použít reálné UGC fotky
Vzít reálnou UGC fotku omalovánky na stole a přes Compositor přidat:
- Logo a tagline jako overlay
- Lehký color grade pro konzistenci
- Pastelky v rohu jako brand element

### Varianta B: AI-enhanced background
Pokud potřebujete lifestyle pozadí kolem reálného produktu:

**Prompt (Compositor / image generation):**
```
Overhead flat lay photograph on a warm wooden table. Soft natural
window light from the left. A coloring book is open showing a
hand-drawn line art illustration. Next to it: scattered colored
pencils (Koh-i-noor style, wooden), a cup of coffee, a smartphone
showing a family photo on screen. Cozy home atmosphere, slightly
shallow depth of field. Shot on iPhone, natural, not overly styled.
Warm color temperature.
```

### Varianta C: "UGC / organic post" styl
Kreativa, která vypadá jako normální post, ne jako reklama.

**Prompt:**
```
Casual overhead iPhone photo of a child's hands coloring in a
coloring book page at a kitchen table. Colored pencils scattered
around. Warm afternoon light. The coloring page shows a line art
portrait of a family. Authentic, not perfectly styled – real life
moment. Slight motion blur on the hands.
```

### Text overlay
- **Headline (na vizuálu):** "Omalovánky z vašich fotek"
- **Sub (na vizuálu):** "Krásný dárek, co chytne za srdce"
- **Logo:** Spodní část, malé

### Ad copy (pod vizuálem v Meta)
> Máte v mobilu stovky fotek, na které se nikdy nepodíváte?
>
> My z nich uděláme omalovánky, které celá rodina zamiluje. Stačí nahrát fotku – a kouzlo začne.
>
> ⭐⭐⭐⭐⭐ "Děti u toho vydržely dvě hodiny a pak chtěly další!"
>
> 👉 fotomalovanky.cz

---

## KREATIVA E2: "Nejlepší dárek" – Split Screen

### Koncept
Klasický split screen – fotka vlevo, omalovánka vpravo. Jednoduchý, prokázaně funkční formát. Klíč je výběr emotivní fotky.

### Vizuální layout (1080×1350)
```
┌─────────────────────┐
│  ┌────┐    ┌────┐   │
│  │FOTO│ →  │LINE│   │
│  │    │    │ART │   │
│  │    │    │    │   │
│  └────┘    └────┘   │
│                     │
│  ┌───────────────┐  │
│  │ Z fotky v     │  │
│  │ mobilu → dárek│  │
│  │ co nemá nikdo │  │
│  │ jiný          │  │
│  │ 🖍 FOTOMAL.   │  │
│  └───────────────┘  │
└─────────────────────┘
```

### Compositor workflow
1. Vzít UGC fotku (doporučení: děti u bazénu, Halloween kostýmy, pár – emotivní)
2. Vedle ní umístit odpovídající omalovánku (line art verzi)
3. Mezi ně šipku / "→" / animovaný efekt "proměny"
4. Pozadí: solid barva z palety
5. Text box dole s headline + logo

### Doporučené UGC fotky pro split screen (z vašeho portfolia)
- **Děti u bazénu** – léto, radost, jasné barvy → silný kontrast s line artem
- **Pár (ten mladý s úsměvem)** – romance, dárek k výročí
- **Dědeček s vnoučaty** – emoce, dárek pro prarodiče
- **Holčičky v Halloween kostýmech** – výrazné, eye-catching
- **Miminko na gauči** – něžné, zastaví maminky

### Split screen varianty k testovat

**V1 – Clean digital (jako stávající kreativy):**
Ostrý řez, fotka | omalovánka, pozadí barva.

**V2 – "Přilepené" / scrapbook styl:**
Fotky vypadají jako přilepené lepicí páskou na pozadí. Hravější, autentičtější.

**Prompt pro scrapbook pozadí:**
```
Clean flat background in warm peach/cream color. Subtle paper
texture, like a craft paper or cork board. Soft, even lighting.
No objects, just the textured background. High resolution.
```

**V3 – Mobil + papír (hybrid):**
Vlevo mockup mobilu s fotkou, vpravo reálná omalovánka na stole.

**Prompt pro phone mockup kontext:**
```
A hand holding a modern smartphone displaying a family photo on
screen, next to a printed coloring book page showing the same
scene as line art. Wooden table background. Warm natural light.
Shallow depth of field focusing on both items. Authentic, not
overly produced.
```

### Text overlay
- **Headline:** "Z fotky v mobilu → dárek, který nemá nikdo jiný"
- **Alt headline:** "Co dát někomu, kdo už všechno má?"
- **Logo:** Spodní roh

### Ad copy
> Co dát někomu, kdo už všechno má?
>
> Vzpomínky. Ale takové, které si může vybarvit podle sebe. 🖍️
>
> Z vaší oblíbené fotky vytvoříme originální omalovánku na kvalitním papíře. Každý kus je unikát.
>
> 👉 fotomalovanky.cz

---

## KREATIVA E4: "Prarodiče" – Emocionální

### Koncept
Nejsilnější emocionální kreativa. Fotka dědečka s vnoučaty → omalovánka. Cílí na prarodiče i na jejich děti (kteří hledají dárek pro rodiče).

### Vizuální layout (1080×1350)
```
┌─────────────────────┐
│                     │
│   [Split screen:    │
│    grandpa with     │
│    grandkids photo  │
│    →                │
│    coloring version]│
│                     │
│  ┌───────────────┐  │
│  │ Dárek, který  │  │
│  │ zahřeje u     │  │
│  │ srdce ❤️      │  │
│  │ FOTOMALOVÁNKY │  │
│  └───────────────┘  │
│                     │
│  ⭐⭐⭐⭐⭐ "Babička │
│  poznala každou     │
│  vzpomínku."        │
│                     │
└─────────────────────┘
```

### Compositor workflow
1. UGC fotka dědečka s vnoučaty (máte skvělou v parku!) + její line art verze
2. Teplé pozadí (Warm A nebo B paleta)
3. Text box s headline
4. Recenze jako "přilepený" element (screenshot styl nebo kaligrafický styl)

### Varianta "Dárkový balíček"

**Prompt:**
```
Close-up photograph of elderly hands unwrapping a gift – pulling
a coloring book out of a simple kraft paper wrapping. The coloring
book shows a line art drawing of two children. Warm lighting,
shallow depth of field on the hands. Emotional, intimate moment.
Kitchen or living room background, blurred.
```

### Varianta "Vybarvování spolu"

**Prompt:**
```
Overhead view of a wooden table where a grandmother and a young
child (about 5 years old) are coloring together in a coloring book.
Their hands are visible – grandma's wrinkled hands and child's small
hands, both holding colored pencils. The coloring page shows a
line art family portrait. Scattered pencils on the table. Warm,
cozy afternoon light from a window. Authentic, not staged.
```

### Text overlay
- **Headline:** "Dárek, který zahřeje u srdce"
- **Alt:** "Babičko, dědečku – tohle je pro vás."
- **Sub:** "Omalovánky z vašich rodinných fotek"
- **Review badge:** ⭐⭐⭐⭐⭐ + citát

### Ad copy
> Babičko, tohle je pro tebe.
>
> Omalovánka vašeho vnoučka. Z té fotky, co máte v rámečku na komodě. Ale tentokrát ji může vybarvit celá rodina.
>
> Dárek, u kterého babičky pláčou dojetím (a pak si říkají o další).
>
> ⭐⭐⭐⭐⭐ "Jsou fakt boží! Objednala jsem další." – Ivana, Louny
>
> 👉 fotomalovanky.cz

---

## KREATIVA E7: "Couple Goals"

### Koncept
Pár – romantická, ale ne kýčovitá kreativa. Cílí na muže i ženy 20-35, kteří hledají originální dárek k výročí nebo prostě jen tak.

### Vizuální layout (1080×1350)
```
┌─────────────────────┐
│                     │
│   [Split screen:    │
│    couple photo     │
│    →                │
│    coloring version]│
│                     │
│                     │
│  Vaše fotky.        │
│  Vaše příběhy.      │
│  Vaše omalovánky.   │
│                     │
│  🖍 FOTOMALOVÁNKY   │
│                     │
└─────────────────────┘
```

### Compositor workflow
1. UGC fotka páru (máte tu hezkou s úsměvem) + line art
2. Čistý layout, moderní feel – ne "maminkovský"
3. Barvy: Cool A (fialová) nebo Neutral pro odlišení od rodinných kreativ

### Varianta "Date night"

**Prompt:**
```
A cozy evening scene – two people sitting at a table with wine
glasses, coloring together in a coloring book. Warm candlelight
or string lights in background. The coloring book page shows a
line art of a couple. Colored pencils on the table. Romantic but
not cheesy – modern, casual, authentic. Shot on iPhone aesthetic.
```

### Varianta "Dárek k výročí"

**Prompt:**
```
A flat lay on a white marble surface: an open coloring book showing
a line art couple portrait, next to a smartphone showing the original
photo of the same couple. A few colored pencils, a small bouquet
of dried flowers, and a handwritten card that says "Pro tebe".
Clean, minimal, modern aesthetic. Soft natural light from above.
```

### Text overlay
- **Headline:** "Vaše fotky. Vaše příběhy. Vaše omalovánky."
- **Alt:** "Dárek, u kterého se zastavíte."
- **Logo:** Minimální, dolní roh

### Ad copy
> Vaše společné fotky si zaslouží víc než filtr na Instagramu.
>
> Proměňte je v omalovánky a zpomalte spolu. Víno, pastelky, žádné obrazovky.
>
> 🖍️ Ideální dárek k výročí, k narozeninám nebo prostě jen tak.
>
> 👉 fotomalovanky.cz

---

## KREATIVA E12: "Dědeček & vnoučata"

### Koncept
Specificky cílená na segment "dárek pro dědečka" – méně exploatovaný než babičky. Ta vaše UGC fotka dědečka s dvěma vnoučaty v parku je na tohle ideální.

### Compositor workflow
1. Fotka dědečka s vnoučaty + line art verze
2. Teplé pozadí (Warm B – broskvová)
3. Emotivní headline, recenze

### Varianta "Zarámovaná vzpomínka"

**Prompt:**
```
A coloring book page pinned to a refrigerator with a magnet,
showing a line art portrait of a grandfather with two small children.
The coloring is partially done – some areas colored in with colored
pencils, some still black and white. A child's hand is reaching up
to touch it. Warm kitchen lighting. Real life, authentic moment.
Slightly out of focus background with kitchen elements.
```

### Text overlay
- **Headline:** "Dárek, u kterého se zastaví čas"
- **Sub:** "Omalovánky z vašich rodinných fotek"

### Ad copy
> Dědečku, tohle je pro tebe.
>
> Vaše vnoučata na papíře – s tím úsměvem, co vás vždy dostane. Tentokrát si je můžete vybarvit. Nebo to nechte na nich – a dívejte se, jak se poznávají.
>
> ⭐⭐⭐⭐⭐ "Babička poznala každou vzpomínku. A dojalo ji to."
>
> 👉 fotomalovanky.cz

---

## KREATIVA E18: "4 726 fotek" – Negativní hook

### Koncept
Provokativní, zastaví scroll otázkou. "Ugly ad" styl – vypadá jako organic post, ne jako reklama. Tohle je potenciálně nejvýkonnější formát pro cold audience.

### Vizuální layout (1080×1350)
```
┌─────────────────────┐
│                     │
│  Máte v mobilu      │
│  4 726 fotek.       │
│                     │
│  Na kolik z nich    │
│  jste se podívali   │
│  za poslední měsíc? │
│                     │
│   [Menší split      │
│    screen ukázka    │
│    foto→omalovánka] │
│                     │
│  My z nich uděláme  │
│  něco, na co se     │
│  budete dívat       │
│  každý den. 🖍️     │
│                     │
│  fotomalovanky.cz   │
│                     │
└─────────────────────┘
```

### Compositor workflow – "Text-first" kreativa
1. Pozadí: solid barva nebo jemná textura
2. Velký, výrazný text jako hlavní element (ne fotka!)
3. Menší produktová ukázka (split screen) jako podpůrný element
4. Logo dole

### Varianta A: Čistý text na solid pozadí

**Prompt pro background:**
```
Solid matte background in warm cream/off-white color (#FFF5E6)
with very subtle paper grain texture. Clean, minimal.
High resolution 1080x1350.
```
Pak přes Compositor přidat text a malou produktovou ukázku.

### Varianta B: "Notes app" / screenshot styl
Kreativa vypadající jako screenshot z Notes appky nebo jako tweet. Ultra autentické.

**Layout:**
```
┌─────────────────────┐
│ 📝 Notes            │
│                     │
│ Máte v mobilu       │
│ 4 726 fotek.       │
│                     │
│ Na kolik z nich     │
│ jste se podívali    │
│ za poslední měsíc?  │
│                     │
│ Na tři? Na žádnou?  │
│                     │
│ Takže jsme udělali  │
│ službu, která z     │
│ nich udělá          │
│ omalovánky.         │
│ Fyzické.            │
│ Na papíře.          │
│ Které celá rodina   │
│ zamiluje.           │
│                     │
│ fotomalovanky.cz    │
│                     │
└─────────────────────┘
```

### Varianta C: "iMessage" / chat styl
Kreativa vypadající jako konverzace v iMessage.

**Layout:**
```
┌─────────────────────┐
│                     │
│      ┌──────────┐   │
│      │ Co dáš   │   │
│      │ mámě k   │   │
│      │ narozká?  │   │
│      └──────────┘   │
│  ┌──────────┐       │
│  │ Omalovánky│      │
│  │ z jejích  │      │
│  │ fotek 🖍️ │      │
│  └──────────┘       │
│      ┌──────────┐   │
│      │ ??? To   │   │
│      │ existuje?│   │
│      └──────────┘   │
│  ┌──────────┐       │
│  │ fotomal- │       │
│  │ ovanky.cz│       │
│  └──────────┘       │
│      ┌──────────┐   │
│      │ Jdeš do  │   │
│      │ historie │   │
│      │ jako     │   │
│      │ nejlepší │   │
│      │ dcera 😭 │   │
│      └──────────┘   │
│                     │
│  FOTOMALOVÁNKY 🖍️  │
│                     │
└─────────────────────┘
```

**Prompt pro iMessage background:**
```
iPhone iMessage conversation screenshot background. Light gray
Apple Messages app interface. Clean, realistic iOS design.
Empty conversation, no text bubbles – just the background UI.
High resolution.
```

### Ad copy (pro všechny varianty E18)
> Máte v mobilu 4 726 fotek. Na kolik z nich jste se podívali za poslední měsíc?
>
> My z vašich nejlepších fotek uděláme omalovánky. Fyzické. Na papíře. Které si rodina zamiluje a bude u nich sedět hodiny.
>
> Vzpomínky si zaslouží víc než místo v cloudu.
>
> 👉 fotomalovanky.cz

---

## KREATIVA E19: "Screen time" – Negativní hook

### Koncept
Cílí na rodiče, kteří řeší čas dětí na tabletu. Empatie, ne guilt-tripping.

### Vizuální layout (1080×1350)
```
┌─────────────────────┐
│                     │
│  Další hodina       │
│  na tabletu,        │
│  nebo...? 🤔       │
│                     │
│   [Fotka dítěte    │
│    vybarvujícího   │
│    omalovánku –    │
│    happy, focused] │
│                     │
│  Omalovánky z      │
│  vašich fotek 🖍️   │
│                     │
│  fotomalovanky.cz   │
│                     │
└─────────────────────┘
```

### Compositor workflow
1. Silný textový hook nahoře
2. UGC fotka dítěte s omalovánkou (nebo AI-generovaná)
3. Logo a CTA dole

**Prompt pro hero image:**
```
A young child (around 5-6 years old) sitting at a table, deeply
focused on coloring in a coloring book with colored pencils.
Natural side window light. The child looks happy and concentrated.
No tablet or phone visible anywhere in the frame – just paper,
pencils, and the child's hands. Warm, authentic, shot on iPhone.
Slightly overhead angle.
```

### Ad copy
> Další hodina na tabletu, nebo...?
>
> Omalovánky z vašich fotek. Děti se poznají na papíře, popadnou pastelky a na tablet zapomenou. Rozvíjí kreativitu, jemnou motoriku a fantazii.
>
> A vy máte klid bez výčitek. 🖍️
>
> 👉 fotomalovanky.cz

---

## KREATIVA E21: "Social proof – čísla"

### Koncept
Grid/koláž více transformací. Ukazuje šíři (děti, psi, páry, senioři). Síla v množství.

### Vizuální layout (1080×1080 – square funguje nejlíp pro grid)
```
┌─────────────────────────┐
│ ┌─────┐┌─────┐┌─────┐  │
│ │foto→││foto→││foto→│  │
│ │omal.││omal.││omal.│  │
│ └─────┘└─────┘└─────┘  │
│ ┌─────┐┌─────┐┌─────┐  │
│ │foto→││foto→││foto→│  │
│ │omal.││omal.││omal.│  │
│ └─────┘└─────┘└─────┘  │
│                         │
│ Přes 2 000 proměněných  │
│ fotek. Přidejte tu svou.│
│ 🖍 FOTOMALOVÁNKY        │
└─────────────────────────┘
```

### Compositor workflow
1. 6 mini split-screenů v gridu (3×2)
2. Mix: děti, pár, dědeček, miminko, Halloween, bazén
3. Headline dole s číslem
4. Logo

### Alternativní prompt pro "wall of love" styl
```
A flat lay of many different coloring book pages spread across a
large wooden table, seen from directly above. Each page shows a
different line art – families, dogs, couples, children. Some pages
are partially colored in. Scattered colored pencils between the
pages. Warm overhead lighting. Shows variety and volume.
```

### Ad copy
> Přes 2 000 fotek proměněných v omalovánky. Stovky rodin, které vybarvují vlastní vzpomínky.
>
> ✅ Každá omalovánka je unikát z vaší fotky
> ✅ Kvalitní tisk na silném papíře
> ✅ Dárek, u kterého lidi brečí dojetím
>
> Přidejte se 🖍️
>
> 👉 fotomalovanky.cz

---

## KREATIVA E3: "Mazlíčci"

### Koncept
Psi a kočky – vysoce engagující segment na FB/IG. "Pet parents" sdílejí, komentují, tagují kamarády. Potenciálně virální.

### Vizuální layout (1080×1350)
```
┌─────────────────────┐
│                     │
│  Váš pes je hvězda  │
│  vašeho Instagramu? │
│                     │
│  ┌────┐    ┌────┐   │
│  │DOG │ →  │LINE│   │
│  │FOTO│    │ART │   │
│  │    │    │DOG │   │
│  └────┘    └────┘   │
│                     │
│  Udělejte z něj     │
│  hvězdu omalovánky  │
│  🐕 🖍️              │
│                     │
│  fotomalovanky.cz   │
│                     │
└─────────────────────┘
```

### Varianta "Who did it better?"

**Prompt:**
```
Split composition: on the left side, a cute golden retriever dog
looking at the camera with a slightly tilted head. On the right
side, a coloring book page showing the line art version of the
same dog. Both images are placed on a light wooden table.
A few colored pencils scattered between them. Fun, lighthearted
mood. Natural daylight.
```

### Varianta "Dog mom aesthetic"

**Prompt:**
```
A cozy scene: a woman sitting on a couch with a dog next to her,
coloring in a coloring book that shows a line art portrait of the
same dog. The dog is looking curiously at the page. Warm living
room lighting, blankets, autumn vibes. Shot on iPhone, authentic
lifestyle photo.
```

### Ad copy
> Váš pes je hvězda vašeho Instagramu?
>
> Tak z něj udělejte hvězdu omalovánky! 🐕
>
> Nahrajte fotku svého mazlíčka a my z ní vytvoříme omalovánku, kterou budete chtít zarámovat (až ji vybarvíte).
>
> 👉 fotomalovanky.cz

---

## Bonus: Carousel formát (všechny segmenty)

### Koncept
Jeden carousel ad, který ukazuje šíři use cases. Každý slide = jiný segment. Funguje skvěle pro cold audience v SEE fázi.

### Slide struktura (5 slides)

**Slide 1 (Hook):**
- Headline na vizuálu: "Z jakékoli fotky → omalovánka"
- Vizuál: Nejvýraznější split screen (děti)

**Slide 2:**
- "Rodinné fotky" – split screen rodina
- Sub: "Společný čas nad pastelkami"

**Slide 3:**
- "Váš mazlíček" – split screen pes/kočka
- Sub: "Dárek pro každého pejskaře"

**Slide 4:**
- "Páry & vzpomínky" – split screen couple
- Sub: "Originální dárek k výročí"

**Slide 5 (CTA):**
- "Vyzkoušejte to → fotomalovanky.cz"
- Vizuál: Logo + recenze + CTA button

### Carousel Ad copy
> Z jakékoli fotky v mobilu vytvoříme originální omalovánku. Děti, mazlíčci, páry, prarodiče – funguje to se vším.
>
> Projeďte si, co všechno se dá vytvořit 👉
>
> fotomalovanky.cz

---

## A/B testovací matice

Pro každou kreativu doporučuji testovat:

### Vizuály (min. 2 varianty na kreativu)
| Test | Varianta A | Varianta B |
|---|---|---|
| Styl | Clean digital split screen | Reálná UGC fotka produktu na stole |
| Pozadí | Warm (oranžová/broskvová) | Cool (fialová/modrá) |
| Layout | Fotka dominuje, text malý | Text dominuje, fotka menší ("ugly ad") |
| Obličeje | S obličeji dětí | Bez obličejů (jen ruce + produkt) |

### Copy (min. 2 varianty na kreativu)
| Test | Varianta A | Varianta B |
|---|---|---|
| Hook | Emocionální ("Babičko, tohle je pro tebe") | Provokativní ("4 726 fotek v mobilu") |
| Délka | Krátký (2-3 řádky) | Dlouhý (s příběhem a recenzí) |
| Social proof | S recenzí v textu | Bez recenze |
| CTA | Soft ("Zjistit více") | Direct ("Objednat") |

### Priority testování (první 2 týdny)
1. **Test 1:** E2 split screen (děti) – warm vs. cool pozadí
2. **Test 2:** E18 "4726 fotek" – text-only vs. notes app styl vs. iMessage styl
3. **Test 3:** E4 prarodiče – s recenzí vs. bez recenze
4. **Test 4:** E3 mazlíčci – split screen vs. lifestyle fotka
5. **Test 5:** Carousel (všechny segmenty) vs. single image (nejlepší segment)

---

## Checklist před publikací

- [ ] Vizuál funguje na mobilu (zkontrolovat na telefonu, ne na monitoru)
- [ ] Text na vizuálu je čitelný i při malé velikosti
- [ ] Text zabírá max 20 % plochy vizuálu
- [ ] Logo je přítomné, ale ne dominantní
- [ ] Žádné "AI" nebo "algoritmus" v textu
- [ ] CTA je jasný – víte, co má člověk udělat
- [ ] Primary text má hook v prvních 2 řádcích (zbytek se skryje za "...více")
- [ ] Formáty: 1080×1350 (feed) + 1080×1920 (stories) připraveny
- [ ] Odkaz fotomalovanky.cz je v textu
