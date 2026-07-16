// The blog topic engine: turn "what should we write about right now?" into a ranked candidate list
// from TWO sources — the marketing calendar (the next occasions, already timed + on-brand) and a
// Gemini SEO step tuned to today's date (the "hot right now" half). Pure orchestration over an
// injected text fn, so it's unit-testable against a fixed `now` with a fake model — no network.
//
// The AI half is best-effort: if the model fails, the calendar half still yields a full, timely list,
// so the topic picker is never empty.

import { MARKETING_CAL, occasionKey } from '../creatives/calendar.js';
import { parseJsonLoose } from '../creatives/adCopy.js';
import { BLOG_VOICE } from '../brandVoice.js';

const NICHE = 'personalizované omalovánky a tištěné omalovánkové knihy z vlastních fotek (Fotomalovánky.cz)';

/** Whole-day distance from `now` to an occasion's month/day, wrapping to next year when it's past. */
export function daysUntil(occasion, now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), occasion.m - 1, occasion.d);
  if (target < start) target = new Date(now.getFullYear() + 1, occasion.m - 1, occasion.d);
  return Math.round((target - start) / 86400000);
}

/** The calendar occasions falling within `windowWeeks` of `now`, soonest first. */
export function upcomingOccasions(now, windowWeeks = 8) {
  const maxDays = windowWeeks * 7;
  return MARKETING_CAL.map((o) => ({ occasion: o, days: daysUntil(o, now) }))
    .filter(({ days }) => days >= 0 && days <= maxDays)
    .sort((a, b) => a.days - b.days);
}

/** One calendar occasion as a topic candidate (its angle IS the intent). */
function calendarTopic({ occasion, days }) {
  return {
    title: occasion.name,
    keyword: occasion.name.toLowerCase(),
    intent: occasion.angle,
    source: 'calendar',
    occasionKey: occasionKey(occasion),
    persona: occasion.persona,
    tone: occasion.tone,
    days,
  };
}

/** The SEO-suggestion prompt: today's date + the upcoming occasions + the niche → timely blog topics. */
export function buildSeoPrompt({ now, upcoming, limit }) {
  const dateStr = `${now.getDate()}. ${now.getMonth() + 1}. ${now.getFullYear()}`;
  const names = upcoming.slice(0, 8).map((u) => `${u.occasion.name} (za ${u.days} dní)`).join(', ') || 'žádné v nejbližším okně';
  return [
    BLOG_VOICE,
    '',
    `Dnešní datum: ${dateStr}. Obor: ${NICHE}.`,
    `Nadcházející marketingové příležitosti: ${names}.`,
    '',
    `Navrhni ${limit} konkrétních SEO témat na blog, která dávají smysl PRÁVĚ TEĎ (sezóna, nadcházející svátky,`,
    'nákupní chování). Každé cílí na reálný český vyhledávací dotaz a je jiné než ostatní.',
    'Vrať POUZE platný JSON objekt (bez markdown fencí, bez komentářů):',
    '{ "topics": [ { "title": "titulek článku", "keyword": "cílové klíčové slovo", "intent": "jednou větou, proč to lidé hledají teď" } ] }',
  ].join('\n');
}

/** Best-effort AI SEO topics; returns [] on any failure so the caller degrades to calendar-only. */
async function seoTopics({ now, upcoming, generateTextFn, config, limit }) {
  try {
    const raw = await generateTextFn({ config, prompt: buildSeoPrompt({ now, upcoming, limit }) });
    const parsed = parseJsonLoose(raw);
    const arr = Array.isArray(parsed?.topics) ? parsed.topics : [];
    return arr
      .filter((t) => t && typeof t.title === 'string' && t.title.trim() && typeof t.keyword === 'string' && t.keyword.trim())
      .slice(0, limit)
      .map((t) => ({ title: t.title.trim(), keyword: t.keyword.trim(), intent: String(t.intent ?? '').trim(), source: 'seo' }));
  } catch {
    return [];
  }
}

/**
 * The ranked topic list: calendar candidates (soonest first) followed by fresh AI SEO suggestions
 * (deduped against the calendar keywords). Never throws — the AI half is optional.
 * @param {object} o
 * @param {Date}   [o.now]            defaults to the real clock
 * @param {function} [o.generateTextFn] ({config, prompt}) => Promise<string>; omit to skip the AI half
 * @param {object} [o.config]         the config.ai block passed to generateTextFn
 * @param {number} [o.windowWeeks]    calendar look-ahead (default 8)
 * @param {number} [o.seoLimit]       how many AI topics to request (default 6)
 */
export async function suggestTopics({ now = new Date(), generateTextFn, config, windowWeeks = 8, seoLimit = 6 } = {}) {
  const upcoming = upcomingOccasions(now, windowWeeks);
  const calendar = upcoming.map(calendarTopic);
  let seo = [];
  if (typeof generateTextFn === 'function') seo = await seoTopics({ now, upcoming, generateTextFn, config, limit: seoLimit });
  const seen = new Set(calendar.map((t) => t.keyword.toLowerCase()));
  const seoFresh = seo.filter((t) => !seen.has(t.keyword.toLowerCase()));
  return { topics: [...calendar, ...seoFresh], aiUsed: seo.length > 0 };
}
