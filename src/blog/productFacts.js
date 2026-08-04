// The product facts every draft is grounded in. Before this existed the draft prompt carried the
// brand voice and nothing else, so the model wrote generic filler about "personal gifts" and, worse,
// invented specifics — prices, delivery times, page counts — because the prompt gave it none.
//
// PROVENANCE. Everything in PRODUCT_FACTS was read off the live shop on 2026-08-04:
//   - variant prices + photo counts: fotomalovanky.cz/products/fotomalovanky (products.json variants)
//   - paper, production and delivery times, "fotky z telefonu jsou dostačující": the product page
//   - shipping options and prices: /pages/moznosti-dopravy-a-platby
//   - the two layout labels: the `Rozvržení` values the shop sends on real orders (config.example.json
//     `delivery.formatMap`, docs/autopilot-setup.md)
//   - the 12-page A4 count for a 4-photo gallery book: measured against the operator's own delivered
//     PDF in docs/spikes/2026-07-09-u5-builder.md
// Anything that could not be checked against those sources is NOT in the string — it's in OPEN_FACTS
// below, phrased as a question for David, and deliberately never reaches the model.
//
// This is a prompt fragment, so it is written in Czech, in the register the model should answer in.
// Pure data, no IO. When the shop changes, this file changes — it is the only place the numbers live.

/** The verified facts injected into every draft prompt. Numbers the model may use, and no others. */
export const PRODUCT_FACTS = [
  'OVĚŘENÁ FAKTA O PRODUKTU (jediný zdroj konkrétních čísel):',
  '- Zákazník nahraje 4, 8, 12 nebo 16 vlastních fotek. Z každé fotky vzniká jedna omalovánka na formát A4.',
  '- Tištěná kniha: 4 fotky 399 Kč, 8 fotek 714 Kč, 12 fotek 983 Kč, 16 fotek 1 243 Kč.',
  '- Varianta pouze PDF (zákazník si ji vytiskne sám doma): 4 fotky 337 Kč, 8 fotek 607 Kč, 12 fotek 835 Kč, 16 fotek 1 057 Kč.',
  '- Dvě rozvržení stránky, zákazník si vybírá: „Galerie" (jeho fotka je vytištěná vedle omalovánky) nebo „Celostránková omalovánka" (kresba přes celou stránku).',
  '- Kniha má titulní stranu, na kterou přijde věnování. Tištěná kniha ze čtyř fotek má dvanáct stran A4.',
  '- Tiskneme na papír ColorLok®, podle počtu stran 160 g/m² nebo 120 g/m².',
  '- Výroba trvá 1–3 dny, doručení celkem 3–5 dní. PDF chodí e-mailem.',
  '- Doprava: Zásilkovna na adresu 99 Kč, Z-BOXy a výdejní místa Zásilkovny 67 Kč, AlzaBoxy 69 Kč, PPL boxy a parcel shopy 69 Kč, osobní odběr v Praze na Hájích zdarma.',
  '- Platba kartou online, dobírkou nebo bankovním převodem.',
  '- Jak objednávka probíhá: 1) zákazník vybere formát a počet fotek a nahraje je, 2) z každé fotky vytvoříme omalovánku a ručně ji doladíme, 3) knihu vytiskneme a pošleme, nebo pošleme PDF e-mailem.',
  '- Fotky z telefonu jsou dostačující. Nejlépe fungují ostré a dobře nasvícené fotky s jedním hlavním motivem; velmi tmavé, rozmazané nebo hodně malé fotky se pro tisk nehodí — v takovém případě se zákazníkovi sami ozveme, než začneme tisknout.',
  '- Když výsledek nebude vypadat podobně jako fotka, zákazník se nám ozve a domluvíme se na nápravě.',
].join('\n');

/**
 * Facts that could NOT be verified against the live shop or the repo. These never enter a prompt —
 * a model handed a "TODO" writes the TODO into the article. They exist to be answered by David and
 * then either moved into PRODUCT_FACTS or dropped.
 */
export const OPEN_FACTS = Object.freeze([
  'TODO(David): Doprava zdarma od 1 000 Kč — produktová stránka ji zmiňuje, /pages/moznosti-dopravy-a-platby ne. Platí, a od jaké částky?',
  'TODO(David): Jsou „🖼️ Galerie (vaše fotka vedle omalovánky)" a „📄 Celostránková omalovánka (plná stránka pro vybarvování)" pořád přesně ty popisky, které zákazník vidí? Beru je z formatMap, ne z živé stránky.',
  'TODO(David): Počet stran je ověřený jen pro 4 fotky v rozvržení Galerie (12 stran A4). Kolik má kniha stran pro 8 / 12 / 16 fotek a pro celostránkové rozvržení?',
  'TODO(David): Rada „ostré, dobře nasvícené fotky s jedním hlavním motivem" vychází z našich vstupních kontrol (src/inputQc.js), ne z textu na webu. Je to i to, co zákazníkům říkáš ty?',
  'TODO(David): Věta o nápravě, když výsledek nesedí, je opsaná z webu volně. Je to formální garance vrácení peněz, nebo záměrně měkký příslib? Článek to nesmí slíbit silněji, než jak to myslíš.',
]);
