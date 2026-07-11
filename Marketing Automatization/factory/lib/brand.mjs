import { readFileSync } from 'node:fs'

/**
 * brand-guide.md is the declared source of truth, so we read it rather than keep a
 * second copy of its rules. content-studio/src/fotomalovanky-brand.ts is a hand-maintained
 * mirror of the same sections; if this parser and that mirror disagree, the guide wins.
 *
 * Every extractor throws loudly when its anchor is missing. A silently empty forbidden-word
 * list would let banned vocabulary through, which is worse than crashing.
 */

const GUIDE_PATH = 'brand/brand-guide.md'

const fail = what => {
  throw new Error(
    `Could not parse ${what} from ${GUIDE_PATH}. The guide's structure changed. ` +
    `Fix the parser in factory/lib/brand.mjs rather than working around it.`
  )
}

/** Everything from a heading matching `re` until the next heading at the same or higher level. */
function section(md, re, level = 2) {
  const lines = md.split('\n')
  const start = lines.findIndex(l => re.test(l))
  if (start === -1) return null
  const stop = new RegExp(`^#{1,${level}} `)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => stop.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** Rows of a pipe table, header and separator dropped, cells trimmed and de-bolded. */
function tableRows(block) {
  if (!block) return []
  return block
    .split('\n')
    .filter(l => l.trim().startsWith('|') && !/^\|[\s|:-]+\|$/.test(l.trim()))
    .slice(1)
    .map(l =>
      l.trim().replace(/^\|/, '').replace(/\|$/, '')
        .split('|')
        .map(c => c.trim().replace(/\*\*/g, '').replace(/`/g, ''))
    )
    .filter(cells => cells.some(Boolean))
}

const splitWords = cell => cell.split(',').map(w => w.trim()).filter(Boolean)

function parseForbiddenWords(md) {
  const block = section(md, /^### Slova, kterým se vyhýbáme/, 3)
  const rows = tableRows(block)
  if (!rows.length) fail('the forbidden-words table (§ 4)')
  return rows.flatMap(([words, reason, insteadUse]) =>
    splitWords(words).map(word => ({ word, reason, insteadUse }))
  )
}

function parseTaglines(md) {
  const block = section(md, /^### Tagline knihovna/, 3)
  if (!block) fail('the tagline library (§ 4)')
  const tiers = {}
  let current = null
  for (const line of block.split('\n')) {
    const tier = /^\*\*Tier (\d)/.exec(line)
    if (tier) { current = `tier${tier[1]}`; tiers[current] = []; continue }
    const bullet = /^- "(.+)"$/.exec(line.trim())
    if (bullet && current) tiers[current].push(bullet[1])
  }
  if (!Object.keys(tiers).length) fail('tagline tiers (§ 4)')
  return tiers
}

function parseContentPillars(md) {
  const block = section(md, /^## 7\./, 2)
  if (!block) fail('content pillars (§ 7)')
  const pillars = []
  for (const line of block.split('\n')) {
    const m = /^### \d+\.\s+(.+?)\s+\((\d+)\s*% obsahu\)/.exec(line)
    if (m) pillars.push({ name: m[1], weightPct: Number(m[2]) })
  }
  if (!pillars.length) fail('content pillar weights (§ 7)')
  const total = pillars.reduce((s, p) => s + p.weightPct, 0)
  if (total !== 100) {
    throw new Error(`Content pillar weights sum to ${total}%, not 100%. Fix ${GUIDE_PATH} § 7.`)
  }
  return pillars
}

function parseFormality(md) {
  const block = section(md, /^### Formality podle kanálu/, 3)
  const rows = tableRows(block)
  if (!rows.length) fail('the channel formality table (§ 3)')
  return rows.map(([channel, address, style, example]) => ({ channel, address, style, example }))
}

function parseClaims(md) {
  const block = section(md, /^## 14\./, 2)
  if (!block) fail('the claims register (§ 14)')
  const grab = re => tableRows(section(block, re, 3)).map(([claim, note]) => ({ claim, note }))
  const safe = grab(/^### ✅/)
  const verify = grab(/^### ⚠/)
  const never = grab(/^### ❌/)
  if (!safe.length || !verify.length || !never.length) fail('all three claim tables (§ 14)')
  return { safe, verify, never }
}

function parseHashtags(md) {
  const block = section(md, /^## 12\./, 2)
  if (!block) fail('the hashtag strategy (§ 12)')
  const tags = { CZ: [], DE: [] }
  let market = null
  for (const line of block.split('\n')) {
    if (/^### CZ/.test(line)) { market = 'CZ'; continue }
    if (/^### DE/.test(line)) { market = 'DE'; continue }
    const m = /^-\s*(#[\p{L}\d_]+)\s*$/u.exec(line.trim())
    if (m && market) tags[market].push(m[1].toLowerCase())
  }
  if (!tags.CZ.length || !tags.DE.length) fail('hashtags for both markets (§ 12)')
  return tags
}

/** Numbers we are allowed to state, harvested from the § 14 "smíme tvrdit" table. */
function allowedNumbers(claims) {
  const found = new Set()
  for (const { claim, note } of claims.safe) {
    for (const token of `${claim} ${note}`.matchAll(/\d[\d\s]*\d|\d/g)) {
      found.add(token[0].replace(/\s/g, ''))
    }
  }
  return found
}

export function loadBrand(path = GUIDE_PATH) {
  const md = readFileSync(path, 'utf8')
  const claims = parseClaims(md)
  return {
    forbiddenWords: parseForbiddenWords(md),
    taglines: parseTaglines(md),
    contentPillars: parseContentPillars(md),
    formality: parseFormality(md),
    hashtags: parseHashtags(md),
    claims,
    allowedNumbers: allowedNumbers(claims),
  }
}

/** The banned-vocabulary block every prompt carries. Mirrors content-studio's voiceBlock(). */
export function voiceBlock(brand) {
  const banned = brand.forbiddenWords.map(w => w.word).join(', ')
  return [
    '## TÓN A SLOVNÍK',
    '',
    'Srdečný, nadšený, hravý, důvěryhodný. Nikdy dětinský ani korporátní.',
    '',
    `Zakázaná slova (nikdy nepoužívej): ${banned}.`,
    'Místo "AI/algoritmus" piš "kouzlo/proměna".',
    'Žádný em dash (—). Vykřičníky střídmě, max tři na text.',
    '',
    '### Oslovení podle kanálu (tvrdé pravidlo)',
    ...brand.formality.map(f => `- **${f.channel}**: ${f.address} — ${f.style}`),
  ].join('\n')
}

/** The § 14 claims register, rendered as the only source of assertable fact. */
export function claimsBlock(brand) {
  const { safe, verify, never } = brand.claims
  return [
    '## CO SMÍŠ TVRDIT (jediný zdroj ověřených faktů)',
    '',
    '### ✅ Podložené — smíš použít doslova',
    ...safe.map(c => `- ${c.claim}`),
    '',
    '### ⚠ Neověřené — NIKDY nepoužívej bez ověření',
    ...verify.map(c => `- ${c.claim} (${c.note})`),
    '',
    '### ❌ Zakázané',
    ...never.map(c => `- ${c.claim} (${c.note})`),
    '',
    'Pokud text potřebuje číslo, recenzi, hvězdičky, cenu nebo dodací lhůtu, které nejsou',
    'v sekci ✅, napiš doslovný placeholder `[OVĚŘIT: co je třeba potvrdit]`.',
    'Nikdy nedoplňuj pravděpodobně-pravdivý údaj.',
  ].join('\n')
}
