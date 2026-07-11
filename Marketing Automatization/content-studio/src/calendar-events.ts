// ============================================================================
// Event-relevance logic for the blog system (CZ).
// ----------------------------------------------------------------------------
// Schema ported from: ../koolman marketing calendar.ts.txt  (STRUCTURE ONLY).
// Content rewritten for Fotomalovánky from BRAND GUIDE.md + MARKETING PLAN v2.md.
// Movable feasts use approximate MM-DD with approximate:true - VERIFY exact date
// each year before publishing.
// ============================================================================

import type {
  BlogIdea,
  CalendarEvent,
  PersonaId,
  RelevantEvent,
  SourceMaterial,
} from './blog-types';
import { TAGLINES } from './fotomalovanky-brand';

export const CALENDAR_EVENTS: CalendarEvent[] = [
  // === EVERGREEN (relevant celoročně) ===
  {
    id: 'narozeniny',
    name: 'Narozeniny',
    date: '01-01',
    approximate: true,
    evergreen: true,
    recurring: true,
    category: 'gift',
    relevance: 'Největší celoroční dárková příležitost. "Co dát někomu, kdo má všechno?"',
    contentAngles: [
      'Originální dárek k narozeninám z osobní fotky',
      'Dárek pro člověka, který má všechno',
      'Last-minute nápad, který nevypadá jako last-minute',
    ],
    personas: ['darci', 'maminky', 'prarodice'],
    recommendedTaglines: [TAGLINES.tier2[0], TAGLINES.tier3[0]],
    leadTimeDays: 21,
    bestPublishWindow: 'Celoročně',
    emoji: '🎂',
  },
  {
    id: 'vyroci',
    name: 'Výročí',
    date: '01-01',
    approximate: true,
    evergreen: true,
    recurring: true,
    category: 'gift',
    relevance: 'Páry hledají originální dárek ke společnému výročí.',
    contentAngles: [
      'Dárek k výročí ze společné fotky',
      'Rande jinak: víno, pastelky, žádné obrazovky',
    ],
    personas: ['pary', 'darci'],
    recommendedTaglines: [TAGLINES.tier1[1]],
    leadTimeDays: 21,
    bestPublishWindow: 'Celoročně',
    emoji: '❤️',
  },

  // === ZIMA ===
  {
    id: 'valentyn',
    name: 'Valentýn',
    date: '02-14',
    recurring: true,
    category: 'gift',
    relevance: 'Dárek pro partnera, romantická aktivita pro páry.',
    contentAngles: [
      'Valentýnský dárek ze společné fotky',
      'Připomeňte si vaše nejkrásnější chvíle trochu jinak',
    ],
    personas: ['pary', 'darci'],
    recommendedTaglines: [TAGLINES.tier1[1]],
    leadTimeDays: 21,
    bestPublishWindow: 'Od 24.1. do 12.2.',
    emoji: '💘',
  },

  // === JARO ===
  {
    id: 'mdz',
    name: 'MDŽ (Mezinárodní den žen)',
    date: '03-08',
    recurring: true,
    category: 'holiday',
    relevance: 'Příležitost obdarovat ženy osobním, neotřelým dárkem.',
    contentAngles: ['Dárek k MDŽ, který chytne za srdce', 'Místo květin vzpomínka na papíře'],
    personas: ['darci', 'pary'],
    leadTimeDays: 14,
    bestPublishWindow: 'Od 25.2. do 7.3.',
    emoji: '🌷',
  },
  {
    id: 'svatebni-sezona',
    name: 'Svatební sezóna (start)',
    date: '04-15',
    approximate: true,
    recurring: true,
    category: 'seasonal',
    relevance: 'Originální svatební dar i aktivita pro hosty na svatbě.',
    contentAngles: [
      'Originální svatební dar ze zásnubní fotky',
      'Omalovánky jako aktivita pro hosty na svatbě',
    ],
    personas: ['pary', 'darci'],
    leadTimeDays: 30,
    bestPublishWindow: 'Březen-červen',
    emoji: '💍',
  },
  {
    id: 'velikonoce',
    name: 'Velikonoce',
    date: '04-05',
    approximate: true,
    recurring: true,
    category: 'holiday',
    relevance: 'Jarní rodinné setkání, dárek pro děti a aktivita na deštivá odpoledne.',
    contentAngles: ['Jarní kreativní aktivita pro děti', 'Velikonoční dárek z rodinné fotky'],
    personas: ['maminky', 'prarodice'],
    leadTimeDays: 21,
    bestPublishWindow: 'Druhá polovina března',
    emoji: '🐣',
  },
  {
    id: 'den-matek',
    name: 'Den matek',
    date: '05-11',
    approximate: true,
    recurring: true,
    category: 'gift',
    relevance: 'Silná příležitost. "Letos to nebude hrneček." Emocionální dárek pro maminku/babičku.',
    contentAngles: [
      'Dárek pro maminku ze společných fotek',
      'Co dát mámě, která má všechno',
      'Dárek pro babičku, u kterého se dojme',
    ],
    personas: ['darci', 'maminky', 'prarodice'],
    recommendedTaglines: [TAGLINES.tier1[2], TAGLINES.tier3[1]],
    leadTimeDays: 28,
    bestPublishWindow: 'Od poloviny dubna do Dne matek',
    emoji: '💐',
  },

  // === LÉTO ===
  {
    id: 'den-deti',
    name: 'Den dětí',
    date: '06-01',
    recurring: true,
    category: 'holiday',
    relevance: 'Omalovánky, kde je hlavní hrdina samo dítě. Silná identifikace.',
    contentAngles: [
      'Omalovánky, kde je princeznou vaše dcera',
      'Dárek ke Dni dětí, ve kterém se děti poznají',
    ],
    personas: ['maminky', 'prarodice', 'darci'],
    recommendedTaglines: [TAGLINES.tier1[0]],
    leadTimeDays: 14,
    bestPublishWindow: 'Od 20.5. do 1.6.',
    emoji: '🧒',
  },
  {
    id: 'den-otcu',
    name: 'Den otců',
    date: '06-15',
    approximate: true,
    recurring: true,
    category: 'gift',
    relevance: 'Méně exploatovaná příležitost. Dárek pro tátu/dědečka z rodinné fotky.',
    contentAngles: ['Dárek pro tátu, který má všechno', 'Dárek pro dědečka z fotky s vnoučaty'],
    personas: ['darci', 'prarodice'],
    leadTimeDays: 21,
    bestPublishWindow: 'Od konce května do poloviny června',
    emoji: '👨',
  },
  {
    id: 'prazdniny-cestovani',
    name: 'Prázdniny / Cestování',
    date: '07-01',
    approximate: true,
    recurring: true,
    category: 'seasonal',
    relevance: 'Z letních fotek vznikne zábava na doma, "dovolená, která nekončí".',
    contentAngles: [
      'Z fotek z dovolené hodiny zábavy doma',
      'Co s tisíci letních fotek v mobilu',
    ],
    personas: ['maminky', 'darci'],
    recommendedTaglines: [TAGLINES.tier3[4]],
    leadTimeDays: 21,
    bestPublishWindow: 'Červen-srpen',
    emoji: '🏖️',
  },

  // === PODZIM ===
  {
    id: 'zpatky-do-skoly',
    name: 'Zpátky do školy',
    date: '09-01',
    recurring: true,
    category: 'seasonal',
    relevance: 'Vzpomínky ze školy a kamarádství k vybarvení, odměna po vysvědčení.',
    contentAngles: ['Vzpomínky ze školního roku k vybarvení', 'Dárek pro spolužáky a kamarády'],
    personas: ['maminky', 'darci'],
    leadTimeDays: 21,
    bestPublishWindow: 'Konec srpna',
    emoji: '🎒',
  },
  {
    id: 'podzim-halloween',
    name: 'Podzim / Halloween',
    date: '10-31',
    recurring: true,
    category: 'seasonal',
    relevance: 'Kostýmy a podzimní fotky jako omalovánky, aktivita na deštivá odpoledne.',
    contentAngles: [
      'Z halloweenského kostýmu omalovánka',
      'Podzimní fotky jako kreativní zábava na doma',
    ],
    personas: ['maminky', 'prarodice'],
    leadTimeDays: 21,
    bestPublishWindow: 'Říjen',
    emoji: '🎃',
  },
  {
    id: 'predvanocni-buildup',
    name: 'Předvánoční buildup',
    date: '11-10',
    approximate: true,
    recurring: true,
    category: 'seasonal',
    relevance: 'Lidé začínají řešit dárky brzy. Budovat poptávku před hlavním peakem.',
    contentAngles: ['Vánoční dárky v klidu a včas', 'Nápady na dárek, který nikdo jiný mít nebude'],
    personas: ['darci', 'prarodice', 'maminky'],
    leadTimeDays: 30,
    bestPublishWindow: 'Říjen-listopad',
    emoji: '🍂',
  },
  {
    id: 'black-friday',
    name: 'Black Friday',
    date: '11-28',
    approximate: true,
    recurring: true,
    category: 'brand',
    relevance: 'Prodejní příležitost. POZOR: slevy/akce zmiňuj jen pokud reálně probíhají (source material).',
    contentAngles: ['Dárky dopředu a v klidu', 'Nejlepší čas pořídit osobní dárek'],
    personas: ['darci'],
    leadTimeDays: 10,
    bestPublishWindow: 'Druhá polovina listopadu',
    emoji: '🏷️',
  },

  // === ZIMA (peak) ===
  {
    id: 'vanoce',
    name: 'Vánoce',
    date: '12-24',
    recurring: true,
    category: 'holiday',
    relevance: 'Hlavní peak roku. Dárek pod stromeček, který nikdo jiný mít nebude.',
    contentAngles: [
      'Dárek pod stromeček, který nikdo jiný mít nebude',
      'Rodinná aktivita o Vánocích: pastelky místo obrazovek',
      'Vánoční dárek pro prarodiče z rodinných fotek',
    ],
    personas: ['darci', 'prarodice', 'maminky'],
    recommendedTaglines: [TAGLINES.tier1[0], TAGLINES.tier1[2]],
    leadTimeDays: 35,
    bestPublishWindow: 'Od poloviny listopadu do 19.12. (hlídat dodací lhůtu - [OVĚŘIT])',
    emoji: '🎄',
  },
];

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

export function getEventById(id: string): CalendarEvent | undefined {
  return CALENDAR_EVENTS.find((e) => e.id === id);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Convert a Date or 'YYYY-MM-DD'/'MM-DD' string into a {month, day} pair.
function toMonthDay(date: Date | string): { month: number; day: number } {
  if (date instanceof Date) {
    return { month: date.getMonth() + 1, day: date.getDate() };
  }
  const parts = date.split('-').map((p) => parseInt(p, 10));
  if (parts.length === 3) return { month: parts[1], day: parts[2] };
  return { month: parts[0], day: parts[1] };
}

// Day-of-year index (1-365) using a fixed non-leap reference so logic is stable.
const CUMULATIVE_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
function dayOfYear(month: number, day: number): number {
  return CUMULATIVE_DAYS[month - 1] + day;
}

// Forward distance in days from "from" to an event MM-DD, wrapping across year end.
function forwardDistance(fromMonth: number, fromDay: number, eventDate: string): number {
  const ev = toMonthDay(eventDate);
  const fromDoy = dayOfYear(fromMonth, fromDay);
  const evDoy = dayOfYear(ev.month, ev.day);
  let diff = evDoy - fromDoy;
  if (diff < 0) diff += 365;
  return diff;
}

/**
 * Return events whose next occurrence falls within `windowDays` of `date`,
 * sorted by how soon they arrive. Evergreen events are always included
 * (daysUntil 0). `withinLeadTime` is true when we are inside the event's own
 * recommended publishing lead time (i.e. it is time to publish for it).
 */
export function getRelevantEvents(
  date: Date | string,
  windowDays = 45
): RelevantEvent[] {
  const { month, day } = toMonthDay(date);
  const results: RelevantEvent[] = [];

  for (const event of CALENDAR_EVENTS) {
    if (event.evergreen) {
      results.push({ event, daysUntil: 0, withinLeadTime: true });
      continue;
    }
    const daysUntil = forwardDistance(month, day, event.date);
    if (daysUntil <= windowDays) {
      results.push({
        event,
        daysUntil,
        withinLeadTime: daysUntil <= event.leadTimeDays,
      });
    }
  }

  return results.sort((a, b) => a.daysUntil - b.daysUntil);
}

/**
 * Seed deterministic blog ideas for a given event by crossing its content
 * angles with its personas. This is a NON-LLM helper - it only structures
 * starting points. All concrete facts must still come from `sourceMaterial`,
 * and missing ones must become [OVĚŘIT] in the final draft.
 */
export function recommendBlogIdeasForEvent(
  eventId: string,
  sourceMaterial?: SourceMaterial
): BlogIdea[] {
  const event = getEventById(eventId);
  if (!event) return [];

  const hasFacts = !!(
    sourceMaterial &&
    ((sourceMaterial.verifiedFacts?.length ?? 0) > 0 ||
      (sourceMaterial.verifiedReviews?.length ?? 0) > 0 ||
      (sourceMaterial.verifiedNumbers?.length ?? 0) > 0)
  );

  const ideas: BlogIdea[] = event.contentAngles.map((angle, i) => {
    const persona: PersonaId = event.personas[i % event.personas.length];
    return {
      id: `${event.id}-${i + 1}`,
      title: angle,
      angle: `${angle} (příležitost: ${event.name})`,
      targetKeyword: deriveKeyword(angle),
      searchIntent: event.category === 'gift' ? 'commercial' : 'informational',
      persona,
      journeyFit:
        event.category === 'gift'
          ? 'Think/Do - čtenář zvažuje konkrétní dárek.'
          : 'See/Think - inspirace a budování zájmu.',
      outline: [
        'Úvod: hook navázaný na příležitost a emoci',
        'Proč zrovna omalovánky z vlastních fotek (diferenciátor: osobní, na míru)',
        'Konkrétní nápady / use case pro tuto příležitost',
        hasFacts
          ? 'Sociální důkaz z ověřeného source material'
          : 'Sociální důkaz [OVĚŘIT - doplnit recenze/čísla ze source material]',
        'Jak to funguje (3 kroky, bez technického žargonu)',
        'Závěr + CTA',
      ],
    };
  });

  return ideas;
}

// Very small keyword heuristic: lowercase, strip punctuation, take key nouns.
function deriveKeyword(angle: string): string {
  const base = angle
    .toLowerCase()
    .replace(/[(),.:!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // keep it short; this is a seed the editor refines
  return base.split(' ').slice(0, 5).join(' ');
}

// Human-readable event context block for prompt builders.
export function formatEventContext(event: CalendarEvent): string {
  return [
    `### Příležitost: ${event.emoji} ${event.name} (${event.date}${event.approximate ? ', přibližné datum - OVĚŘIT' : ''})`,
    `- Relevance: ${event.relevance}`,
    `- Úhly: ${event.contentAngles.join('; ')}`,
    `- Persony: ${event.personas.join(', ')}`,
    `- Doporučené nasazení: ${event.bestPublishWindow} (lead time ${event.leadTimeDays} dní)`,
    event.recommendedTaglines?.length
      ? `- Ověřené taglines k použití: ${event.recommendedTaglines.join(' | ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
