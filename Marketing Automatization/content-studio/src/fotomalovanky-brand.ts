// ============================================================================
// Fotomalovánky brand model (mirrored from BRAND GUIDE.md)
// ----------------------------------------------------------------------------
// BRAND GUIDE.md is the highest authority. The constants below are a machine-
// usable MIRROR of it for the generator. If anything here ever disagrees with
// BRAND GUIDE.md, the guide wins and this file should be corrected.
// ============================================================================

import type { PersonaId } from './blog-types';

export const BRAND = {
  name: 'Fotomalovánky',
  domain: 'fotomalovanky.cz',
  market: 'CZ',
  author: 'David',
  oneLiner:
    'Proměňujeme fotky z mobilu v osobní omalovánky, které spojují kreativitu s emocemi.',
  universalMessage:
    'Z fotek v mobilu vytváříme osobní omalovánky, které spojují kreativitu s emocemi.',
} as const;

// 4 pilíře tónu (Brand Guide, sekce 3)
export const VOICE_PILLARS = [
  { id: 'srdecny', label: 'Srdečný', meaning: 'Mluvíme s vřelostí, jako k přátelům.' },
  { id: 'nadseny', label: 'Nadšený', meaning: 'Vidíme v produktu kouzlo, ale nepřeháníme.' },
  { id: 'hravy', label: 'Hravý', meaning: 'Humor a lehkost, nikdy nuceně.' },
  { id: 'duveryhodny', label: 'Důvěryhodný', meaning: 'Stojíme za kvalitou a reálnými výsledky.' },
] as const;

export const WE_ARE = [
  'Tvůrci vzpomínek',
  'Most mezi digitálním světem a reálným světem (papír, pastelky, společný čas)',
  'Služba, která z běžné fotky udělá emocionální zážitek',
];

export const WE_ARE_NOT = [
  'Nejsme technologická firma',
  'Nejsme generátor obrázků',
  'Nejsme tiskárna',
  'Nejsme "personalizované dárky" vedle hrnečků a triček',
];

export interface Persona {
  id: PersonaId;
  label: string;
  tier: 'primary' | 'secondary';
  who: string;
  solves: string;
  message: string;
  tone: string;
}

export const PERSONAS: Record<PersonaId, Persona> = {
  maminky: {
    id: 'maminky',
    label: 'Maminky (30-45) - Hrdinka všedního dne',
    tier: 'primary',
    who: '1-3 děti, aktivní na Instagramu, hledá smysluplnou zábavu bez obrazovek.',
    solves: 'Děti u tabletů, generic hračky, dárky pro prarodiče.',
    message: 'Konečně omalovánky, které nebudou ležet v koutě.',
    tone: 'Empatický, "rozumíme ti", lehce humorný.',
  },
  prarodice: {
    id: 'prarodice',
    label: 'Prarodiče (55-70) - Strážci vzpomínek',
    tier: 'primary',
    who: 'Babičky a dědečkové, chtějí dát vnoučatům něco osobního.',
    solves: 'Co koupit vnoučatům, kteří "mají všechno".',
    message: 'Dárek, který zahřeje u srdce.',
    tone: 'Srdečný, respektující, citlivý (ne "cool").',
  },
  darci: {
    id: 'darci',
    label: 'Dárci (25-50) - Hledači originality',
    tier: 'primary',
    who: 'Kdokoli hledající originální dárek k narozeninám, Vánocům, výročí.',
    solves: 'Co dát někomu, kdo má všechno.',
    message: 'Dárek, který nikdo jiný mít nebude.',
    tone: 'Inspirativní, "vyřešíme to za tebe".',
  },
  pary: {
    id: 'pary',
    label: 'Páry (20-35) - Romantici',
    tier: 'secondary',
    who: 'Hledají originální dárek k výročí, Valentýnu, zásnubám.',
    solves: 'Originální společný dárek a aktivita.',
    message: 'Připomeňte si vaše nejkrásnější chvíle trochu jinak.',
    tone: 'Romantický ale ne kýčovitý, lehce humorný.',
  },
  mazlickari: {
    id: 'mazlickari',
    label: 'Mazlíčkáři - Fur parents',
    tier: 'secondary',
    who: 'Chtějí všechno se svým mazlíčkem, fotky na IG.',
    solves: 'Originální obsah a dárek se svým zvířetem.',
    message: 'Tvůj pes si zaslouží vlastní omalovánku.',
    tone: 'Fun, casual, "dog mom/dad" energy.',
  },
  'dospeli-antistres': {
    id: 'dospeli-antistres',
    label: 'Dospělí (antistres) - Hledači klidu',
    tier: 'secondary',
    who: 'Stres, hledají offline aktivitu, mindfulness.',
    solves: 'Potřeba zpomalit a relaxovat mimo obrazovky.',
    message: 'Meditace s pastelkou. Antistres, který funguje.',
    tone: 'Klidný, inspirativní, wellness.',
  },
};

// Ověřená knihovna taglinů (Brand Guide, sekce 4). Použij POUZE tyto fráze.
export const TAGLINES = {
  tier1: [
    'Omalovánky z vašich fotek',
    'Vaše fotky. Vaše příběhy. Vaše omalovánky.',
    'Krásný dárek, co chytne za srdce',
  ],
  tier2: [
    'Z fotky v mobilu → dárek, který nemá nikdo jiný',
    'Nejhezčí dárky jsou ty, které jste prožili',
    'Vzpomínka, která se dá vybarvit',
    'Z fotky vznikne omalovánka, kterou si zamilují všichni',
  ],
  tier3: [
    'Co dát někomu, kdo už všechno má? Vzpomínky.',
    'Dárek, u kterého babičky pláčou dojetím',
    'Zábava bez obrazovky, která děti baví',
    'Lepší než scrollování',
    'Dovolená, která nekončí',
    'Z obyčejné fotky - neobyčejný dárek',
  ],
};

// Obsahové pilíře (Brand Guide, sekce 7)
export const CONTENT_PILLARS = [
  { id: 'promena', label: 'Proměna', share: 0.4, what: 'Before/after fotka vs. omalovánka.' },
  { id: 'emoce', label: 'Emoce & Příběhy', share: 0.25, what: 'Reálné příběhy, reakce, UGC.' },
  { id: 'inspirace', label: 'Inspirace & Nápady', share: 0.2, what: 'Co všechno se dá udělat, sezónní nápady.' },
  { id: 'komunita', label: 'Za scénou & Komunita', share: 0.15, what: 'Lidský rozměr, autenticita.' },
];

// Slova, kterým se vyhýbáme (Brand Guide, sekce 4 + pravidla AI).
export const FORBIDDEN_WORDS: { word: string; reason: string; insteadUse: string }[] = [
  { word: 'AI', reason: 'Prodáváme emoce, ne technologii', insteadUse: 'kouzlo, proměna' },
  { word: 'umělá inteligence', reason: 'Prodáváme emoce, ne technologii', insteadUse: 'kouzlo, proměna' },
  { word: 'algoritmus', reason: 'Prodáváme emoce, ne technologii', insteadUse: 'kouzlo, proměna' },
  { word: 'neuronka', reason: 'Strojový žargon', insteadUse: 'kouzlo, proměna' },
  { word: 'neuronová síť', reason: 'Strojový žargon', insteadUse: 'kouzlo, proměna' },
  { word: 'generování', reason: 'Zní to strojově', insteadUse: 'vytvoření, proměnění' },
  { word: 'vygenerovat', reason: 'Zní to strojově', insteadUse: 'vytvořit, proměnit' },
  { word: 'renderování', reason: 'Zní to strojově', insteadUse: 'vytvoření' },
  { word: 'personalizovaný produkt', reason: 'Zní to jako korporát', insteadUse: 'osobní omalovánka, na míru' },
  { word: 'processing', reason: 'Technický žargon', insteadUse: 'z fotky se stane omalovánka' },
  { word: 'konverze', reason: 'Technický žargon', insteadUse: 'z fotky se stane omalovánka' },
  { word: 'zabavení dítěte', reason: 'Negativní konotace', insteadUse: 'kreativní zábava, rozvoj fantazie' },
  { word: 'levný', reason: 'Snižuje vnímanou hodnotu', insteadUse: 'dárek, radost' },
  { word: 'výprodej', reason: 'Snižuje vnímanou hodnotu', insteadUse: 'dárek, překvapení' },
];

// Slova, která používáme (Brand Guide, sekce 4)
export const PREFERRED_VOCABULARY = {
  produkt: ['omalovánky', 'sešit', 'stránky', 'kvalitní papír', 'tisk'],
  proces: ['kouzlo', 'proměna', 'vytvoření', 'z fotky vznikne'],
  emoce: ['vzpomínky', 'radost', 'dojetí', 'překvapení', 'úsměv', 'srdce'],
  aktivita: ['vybarvování', 'tvoření', 'kreativita', 'pastelky', 'společný čas'],
  hodnota: ['unikátní', 'osobní', 'originální', 'na míru', 'jedinečný'],
  darek: ['dárek', 'překvapení', 'pod stromeček', 'k narozeninám'],
};

export const NO_FABRICATION_NOTE = `
Nikdy nevymýšlej recenze, počty zákazníků, ceny, dodací lhůty, gramáž papíru ani
záruky. Pokud konkrétní údaj není v poskytnutém source material, napiš místo něj
literál [OVĚŘIT] a popiš, co je třeba doplnit. Slovo "sleva"/"akce" používej jen
tehdy, je-li reálná akce výslovně uvedena v source material.
`.trim();
