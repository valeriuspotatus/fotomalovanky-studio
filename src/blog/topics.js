// The blog topic engine: turn "what should we write about right now?" into a ranked candidate list.
// Sources, in the order they rank:
//   1. the curated keyword map (keywordMap.js) — the queries we decided to target, by hand,
//   2. the marketing calendar — the next occasions, already timed + on-brand,
//   3. (opt-in) a Gemini SEO step tuned to today's date.
//
// The AI half used to be first and always on. It invented Czech keywords with no volume behind them,
// so it now sits behind a flag that defaults OFF: invented keywords are a worse input than a short
// hand-maintained list. Pure orchestration over an injected text fn, so it's unit-testable against a
// fixed `now` with a fake model — no network. The list is never empty: the map alone guarantees it,
// and the calendar backs it up if the map is ever emptied.

import { MARKETING_CAL, occasionKey } from '../creatives/calendar.js';
import { parseJsonLoose } from '../creatives/adCopy.js';
import { BLOG_VOICE } from '../brandVoice.js';
import { KEYWORD_MAP } from './keywordMap.js';

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

/** One keyword-map entry as a topic candidate. `days` is null for an evergreen (season-less) entry. */
function mapTopic(entry, days) {
  const kw = entry.keyword;
  return {
    title: kw.charAt(0).toUpperCase() + kw.slice(1),
    keyword: kw,
    intent: entry.notes ?? '',
    source: 'map',
    cluster: entry.cluster ?? null,
    articleType: entry.articleType ?? 'gift',
    priority: entry.priority ?? 2,
    days,
  };
}

/**
 * Rank the keyword map: a seasonal entry whose date is inside the window comes first (soonest
 * first), everything else follows by priority. Outside its window a seasonal entry ranks on
 * priority like any other — "vánoční omalovánky" in May is not urgent, it is just a keyword.
 * Ties keep map order, so the file itself is the tie-breaker David can edit.
 */
export function rankKeywordEntries(map, now, windowDays) {
  return map
    .map((entry, i) => {
      const days = entry.season ? daysUntil(entry.season, now) : null;
      const near = days !== null && days <= windowDays;
      return { entry, days, near, i };
    })
    .sort((a, b) => {
      if (a.near !== b.near) return a.near ? -1 : 1;
      if (a.near && b.near) return a.days - b.days || a.i - b.i;
      return (a.entry.priority ?? 2) - (b.entry.priority ?? 2) || a.i - b.i;
    })
    .map(({ entry, days }) => mapTopic(entry, days));
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
 * The ranked topic list: curated keyword map first, then calendar occasions (soonest first), then —
 * only when explicitly asked for — fresh AI SEO suggestions, deduped against both. Never throws:
 * the AI half is optional and best-effort.
 * @param {object} o
 * @param {Date}   [o.now]            defaults to the real clock
 * @param {function} [o.generateTextFn] ({config, prompt}) => Promise<string>; needed only when useSeo
 * @param {object} [o.config]         the config.ai block passed to generateTextFn
 * @param {number} [o.windowWeeks]    look-ahead for calendar occasions AND seasonal keywords (default 8)
 * @param {number} [o.seoLimit]       how many AI topics to request (default 6)
 * @param {boolean} [o.useSeo]        opt in to the invented-keyword step. Default OFF, on purpose.
 * @param {Array}  [o.map]            the keyword map (injectable for tests)
 */
export async function suggestTopics({
  now = new Date(),
  generateTextFn,
  config,
  windowWeeks = 8,
  seoLimit = 6,
  useSeo = false,
  map = KEYWORD_MAP,
} = {}) {
  const upcoming = upcomingOccasions(now, windowWeeks);
  const curated = rankKeywordEntries(map ?? [], now, windowWeeks * 7);
  const calendar = upcoming.map(calendarTopic);
  let seo = [];
  if (useSeo && typeof generateTextFn === 'function') {
    seo = await seoTopics({ now, upcoming, generateTextFn, config, limit: seoLimit });
  }
  const seen = new Set([...curated, ...calendar].map((t) => t.keyword.toLowerCase()));
  const seoFresh = seo.filter((t) => !seen.has(t.keyword.toLowerCase()));
  return { topics: [...curated, ...calendar, ...seoFresh], aiUsed: seo.length > 0 };
}
