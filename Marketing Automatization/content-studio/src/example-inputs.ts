// ============================================================================
// Example inputs - runnable demo data for the blog system.
// ----------------------------------------------------------------------------
// IMPORTANT: source material below contains only PLACEHOLDER facts marked for
// verification. Real numbers, reviews, prices and delivery times must be filled
// in by David from real data before anything is published. Nothing here is a
// real customer claim.
// ============================================================================

import type {
  BlogBrainstormInput,
  GenerateBlogInput,
  SourceMaterial,
} from './blog-types';

// A minimal, honest source material example. Note how unknown facts are left
// OUT entirely (so the generator must mark them [OVĚŘIT]) rather than invented.
export const EXAMPLE_SOURCE_MATERIAL: SourceMaterial = {
  verifiedFacts: [
    'Zákazník nahraje fotku na fotomalovanky.cz a my z ní vytvoříme osobní omalovánku.',
    'Výsledkem je fyzický sešit na kvalitním papíře.',
  ],
  // No verifiedReviews / verifiedNumbers / verifiedPricing / verifiedDeliveryClaims
  // are provided on purpose - the generator must therefore use [OVĚŘIT] for any
  // such claim instead of inventing it.
  internalLinks: [
    { label: 'Vytvořit omalovánku z fotky', url: '/products/omalovanky-z-fotek', note: 'hlavní produktová stránka' },
    { label: 'Jak to funguje', url: '/pages/jak-to-funguje' },
    { label: 'Dárkový poukaz', url: '/products/darkovy-poukaz' },
  ],
  notes: 'CZ trh. Persona prarodiče + dárci. Doplnit reálné recenze a dodací lhůtu před publikací.',
};

// Brainstorm input tied to Den matek (event-relevance demo).
export const EXAMPLE_BRAINSTORM_INPUT: BlogBrainstormInput = {
  topic: 'Dárek pro maminku ke Dni matek',
  targetKeyword: 'dárek pro maminku',
  searchIntent: 'commercial',
  persona: 'darci',
  journeyStage: 'think',
  eventId: 'den-matek',
  season: 'jaro',
  sourceMaterial: EXAMPLE_SOURCE_MATERIAL,
};

// Generate input - one selected idea expanded into a full BlogPackage.
export const EXAMPLE_GENERATE_INPUT: GenerateBlogInput = {
  ...EXAMPLE_BRAINSTORM_INPUT,
  selectedIdea: {
    id: 'den-matek-1',
    title: 'Dárek pro maminku, který chytne za srdce: omalovánky z vašich společných fotek',
    angle:
      'Místo dalšího hrnečku osobní omalovánka ze společné fotky - dárek, u kterého se mamka dojme.',
    targetKeyword: 'dárek pro maminku',
    searchIntent: 'commercial',
    persona: 'darci',
    journeyFit: 'Think - čtenář zvažuje konkrétní originální dárek.',
    outline: [
      'Úvod: hledání dárku pro mámu, která "nic nepotřebuje"',
      'Proč osobní omalovánka funguje lépe než generický dárek',
      'Jaké fotky se hodí (společné chvíle, vnoučata, dovolená)',
      'Jak to funguje ve 3 krocích',
      'Sociální důkaz [OVĚŘIT]',
      'Závěr + CTA',
    ],
  },
};
