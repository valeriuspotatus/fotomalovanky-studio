// The 2026 marketing calendar (occasion → persona → message angle) — the source of truth for the
// calendar-of-ads generator and the Kreativy gallery. This mirrors the inline MARKETING_CAL the
// dashboard's Kalendář tile renders (src/ui/static/dashboard.html, ~line 1238); keep the two in sync.
// tone: brand = love/family, warm = seasonal/gift, info = general.

export const MARKETING_CAL = [
  { m: 1, d: 2, name: 'Novoroční detox & Slow Living', persona: 'Dospělí (mindfulness)', angle: 'Po shonu Vánoc vypněte. Nalijte si čaj a vybarvěte vzpomínku na klidnou zimní krajinu.', tone: 'info' },
  { m: 1, d: 19, name: 'Blue Monday', persona: 'Přátelé / kolegové', angle: 'Nejdepresivnější den v roce? Pošlete kamarádovi vtipnou fotku z poslední akce jako omalovánku.', tone: 'info' },
  { m: 2, d: 13, name: 'Galentine’s Day', persona: 'Kamarádky', angle: 'Kdo potřebuje chlapa, když má nejlepší kámošku? Omalovánka z vaší dámské jízdy.', tone: 'brand' },
  { m: 2, d: 14, name: 'Sv. Valentýn', persona: 'Páry', angle: 'Rande s vínem a pastelkami nad vaší společnou fotkou — originální obraz do ložnice.', tone: 'brand' },
  { m: 2, d: 16, name: 'Jarní prázdniny', persona: 'Rodiče, prarodiče', angle: 'Když na horách prší nebo děti nelyžují — zábava na chatě bez Wi-Fi.', tone: 'warm' },
  { m: 3, d: 8, name: 'MDŽ', persona: 'Muži pro ženy / ženy sobě', angle: 'Pro ženu vašeho života. Nejen kytku, ale chvilku pro sebe, kdy může tvořit a relaxovat.', tone: 'brand' },
  { m: 3, d: 13, name: 'Světový den spánku', persona: 'Dospělí (stresovaní)', angle: 'Nemůžete spát? Místo koukání do mobilu zkuste vybarvovat — prokazatelně uklidňuje.', tone: 'info' },
  { m: 3, d: 20, name: 'První jarní den', persona: 'Všichni (hobby)', angle: 'Svět se barví, vy taky. Vyfoťte první sněženky a zachyťte to kouzlo.', tone: 'warm' },
  { m: 4, d: 1, name: 'Apríl', persona: 'Přátelé (vtipálci)', angle: 'Máte fotku, kde se kamarád tváří „inteligentně“? Udělejte z toho omalovánku.', tone: 'info' },
  { m: 4, d: 5, name: 'Velikonoce', persona: 'Rodina / kreativci', angle: 'Letos žádné čokoládové figurky. Kreativní výslužka, která se nezkazí.', tone: 'warm' },
  { m: 4, d: 15, name: 'Svatební sezóna (start)', persona: 'Svatebčané', angle: 'Omalovánka místa seznámení — nebo zábava pro děti na svatební hostině.', tone: 'brand' },
  { m: 5, d: 1, name: '1. máj (lásky čas)', persona: 'Páry', angle: 'Nestihli jste polibek pod rozkvetlou třešní? Nevadí, vybarvěte si ho doma.', tone: 'brand' },
  { m: 5, d: 10, name: 'Den matek', persona: 'Děti pro mámy', angle: 'Mámo, díky za vše. Naše společná chvíle, kterou si můžeš vybarvit a zarámovat.', tone: 'brand' },
  { m: 5, d: 15, name: 'Mezinárodní den rodiny', persona: 'Rodina', angle: 'Vypněte TV, sedněte si všichni ke stolu. Velká sada omalovánek pro celou rodinu.', tone: 'warm' },
  { m: 6, d: 1, name: 'Den dětí', persona: 'Rodiče / prarodiče', angle: 'Dítě jako hlavní hrdina — omalovánka, kde je on sám Batmanem nebo princeznou.', tone: 'warm' },
  { m: 6, d: 21, name: 'Den otců', persona: 'Děti pro táty', angle: 'Pro tátu a jeho „hračky“ — omalovánka jeho auta, motorky, psa nebo fotbalu.', tone: 'info' },
  { m: 6, d: 30, name: 'Konec školního roku', persona: 'Žáci pro učitele', angle: 'Místo bonboniéry koláž třídy jako omalovánka. Památka na vaše „zlobidla“.', tone: 'warm' },
  { m: 7, d: 1, name: 'Cestování & prázdniny', persona: 'Cestovatelé', angle: 'Vyfoť, pošli, vybarvi. Až se vrátíte z dovolené, prodlužte si ten pocit.', tone: 'info' },
  { m: 7, d: 15, name: 'Letní festivaly & párty', persona: 'Mladí dospělí', angle: 'Legendární fotka z festivalu? Zvěčněte ji. Skvělý dárek k narozeninám pro parťáka.', tone: 'warm' },
  { m: 8, d: 8, name: 'Mezinárodní den koček', persona: 'Majitelé koček', angle: 'Váš kočičí vládce si zaslouží portrét. Relaxace u vybarvování chlupáče.', tone: 'info' },
  { m: 8, d: 15, name: 'Svatby (vrchol sezóny)', persona: 'Rozlučka se svobodou', angle: 'Vtipný dárek pro nevěstu? Omalovánka ženicha (nebo svalnatého plavčíka).', tone: 'brand' },
  { m: 8, d: 26, name: 'Mezinárodní den psů', persona: 'Majitelé psů', angle: 'Z fotky z parku uděláme umělecké dílo. Nejlepší dekorace do bytu pejskaře.', tone: 'info' },
  { m: 9, d: 1, name: 'Back to School / Work', persona: 'Dospělí (office)', angle: 'Šéf vás štve? Uklidněte se u omalovánky z letní dovolené. Zenová pauza v kanceláři.', tone: 'info' },
  { m: 9, d: 15, name: 'Výročí & rande', persona: 'Páry', angle: 'První výročí je „papírové“. Co je lepšího než papírová vzpomínka na váš den D?', tone: 'brand' },
  { m: 10, d: 1, name: 'Den prarodičů', persona: 'Vnoučata pro prarodiče', angle: 'Trénink bystrosti pro babičku a dědu — a největší motivací je fotka vnoučat.', tone: 'warm' },
  { m: 10, d: 10, name: 'Světový den duševního zdraví', persona: 'Dospělí (self-care)', angle: 'Terapie uměním. Vypněte hlavu, vnímejte jen tahy tužkou. Vaše fotka jako mandala.', tone: 'info' },
  { m: 10, d: 31, name: 'Halloween', persona: 'Rodiny / přátelé', angle: 'Ta maska se fakt povedla! Uchovejte ji navždy — nebo strašidelný dárek pro kamarády.', tone: 'warm' },
  { m: 11, d: 1, name: 'Movember', persona: 'Muži / přátelé', angle: 'Máte fotku s knírem? Udělejte z ní vtipnou omalovánku pro kámoše.', tone: 'info' },
  { m: 11, d: 27, name: 'Black Friday', persona: 'Všichni', angle: 'Nekupujte lapače prachu. Kupte zážitek a emoci — dárek, který má smysl.', tone: 'brand' },
  { m: 11, d: 29, name: 'Adventní přípravy', persona: 'Rodiny', angle: '24 malých fotek jako omalovánkový adventní kalendář? Proč ne!', tone: 'warm' },
  { m: 12, d: 5, name: 'Mikuláš', persona: 'Děti', angle: 'Zdravější než sladkosti. Omalovánka čerta, kterého dítě „přemaluje“ na hodného.', tone: 'warm' },
  { m: 12, d: 24, name: 'Vánoce', persona: 'Všichni (hlavní sezóna)', angle: 'Ten NEJ dárek — pro babičku vnoučata, pro partnera rande, pro kamaráda momentka.', tone: 'brand' },
  { m: 12, d: 31, name: 'Silvestr', persona: 'Přátelé', angle: 'Originální PF? Vybarvená fotka vaší rodiny nebo týmu. Pošlete to dál.', tone: 'info' },
];

const pad = (n) => String(n).padStart(2, '0');
const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'x';

/** Stable per-occasion key: "MM-DD-slug", e.g. "02-14-sv-valentyn". Drives the store folder + ad ids. */
export function occasionKey(o) {
  return `${pad(o.m)}-${pad(o.d)}-${slug(o.name)}`;
}

/** The occasion matching a key, or null. */
export function occasionForKey(key) {
  return MARKETING_CAL.find((o) => occasionKey(o) === key) ?? null;
}
