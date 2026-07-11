#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadBrand } from './lib/brand.mjs'
import { parseAdName, isCoherent, formatAdName } from './lib/naming.mjs'

/**
 * Checks generated ad/social/video output against the brand guide before anything ships.
 * The ads-side counterpart to content-studio/src/blog-quality-checker.ts.
 *
 * BLOCK findings mean do not publish. WARN findings mean look at it.
 */

const WINNERS = join('reports', 'winners.json')

/** Fields that hold codes, not prose. Scanning them for banned words is noise. */
const CODE_FIELDS = new Set([
  'adName', 'market', 'angle', 'subject', 'format', 'funnel', 'persona',
  'sourceConcept', 'briefId', 'day', 'pillar', 'channel', 'effort', 'sec', 'durationSec',
])

/**
 * Internal notes, never published. A rationale explaining "bundle, ne sleva" legitimately
 * names the banned word it is avoiding; linting it as if it were ad copy is a false positive.
 * Shot-level onScreenText is NOT here — that gets published and must be checked.
 */
const NOTE_FIELDS = new Set(['rationale', 'title', 'visualBrief', 'needs'])

/**
 * Stems the § 4 table cannot express as single words. Mirrors the extras in
 * content-studio/src/fotomalovanky-brand.ts. Additive only - the guide stays authoritative.
 */
const EXTRA_BANNED = [
  'umělá inteligence', 'umělé inteligence', 'neuronová síť', 'neuronové síti',
  'vygenerov', 'generuj', 'vyrenderov', 'rendrov',
]

const stripPlaceholders = text => text.replace(/\[OVĚŘIT[^\]]*\]/giu, ' ')

const collectStrings = (node, path = '') => {
  if (typeof node === 'string') return [{ path, text: node }]
  if (Array.isArray(node)) return node.flatMap((v, i) => collectStrings(v, `${path}[${i}]`))
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) =>
      CODE_FIELDS.has(k) || NOTE_FIELDS.has(k) ? [] : collectStrings(v, path ? `${path}.${k}` : k)
    )
  }
  return []
}

const CLAIM_PATTERNS = [
  { id: 'percent', re: /\d+\s*%/u, msg: 'Procento bez opory v ověřených faktech.' },
  { id: 'stars', re: /⭐|hvězdič/iu, msg: 'Hvězdičkové hodnocení. Není ověřené.' },
  { id: 'delivery', re: /\b(do|za)\s+\d+\s+(pracovních\s+)?dn\w*|doručíme\s+do\s+\d/iu, msg: 'Slib dodací lhůty.' },
  { id: 'price', re: /\d[\d\s]*\s*(Kč|CZK|EUR|€)|\b(sleva|slevu|slevy|akce|výprodej)\b/iu, msg: 'Cena, sleva nebo akce.' },
  { id: 'paper', re: /gramáž|\bg\/m2\b|\bgsm\b/iu, msg: 'Specifikace papíru. Nikde nedoložená.' },
  { id: 'bignumber', re: /\b\d[\d\s]{2,}\b/u, msg: 'Konkrétní číslo bez opory.' },
]

function numbersIn(text) {
  return [...text.matchAll(/\d[\d\s]*\d|\d/gu)].map(m => m[0].replace(/\s/g, ''))
}

function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: node factory/lint-copy.mjs <generated-output.json>')
    process.exitCode = 1
    return
  }

  const brand = loadBrand()
  const winners = existsSync(WINNERS) ? JSON.parse(readFileSync(WINNERS, 'utf8')) : null
  const killed = new Set(winners?.kill ?? [])

  let items
  try {
    items = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    console.error(`BLOCK  ${file} is not valid JSON: ${err.message}`)
    console.error('The model probably wrapped it in prose or a code fence.')
    process.exitCode = 1
    return
  }
  if (!Array.isArray(items)) {
    console.error('BLOCK  Expected a JSON array of assets.')
    process.exitCode = 1
    return
  }

  const findings = []
  const add = (level, index, check, message) => findings.push({ level, index, check, message })
  const seenNames = new Map()

  items.forEach((item, i) => {
    // 1. Name validity and coherence
    if (item.adName) {
      const parsed = parseAdName(item.adName)
      if (!parsed) {
        add('BLOCK', i, 'ad-name', `"${item.adName}" fails the naming convention.`)
      } else {
        if (!isCoherent(parsed.angle, parsed.subject)) {
          add('BLOCK', i, 'coherence', `${parsed.angle} × ${parsed.subject} is not a permitted pairing.`)
        }
        for (const field of ['angle', 'subject', 'format', 'market']) {
          if (item[field] && item[field] !== parsed[field]) {
            add('BLOCK', i, 'name-mismatch', `${field}="${item[field]}" contradicts the ad name ("${parsed[field]}").`)
          }
        }
        if (seenNames.has(item.adName)) {
          add('BLOCK', i, 'duplicate', `${item.adName} already used at index ${seenNames.get(item.adName)}.`)
        }
        seenNames.set(item.adName, i)
      }
    } else if (item.angle && item.subject) {
      if (!isCoherent(item.angle, item.subject)) {
        add('BLOCK', i, 'coherence', `${item.angle} × ${item.subject} is not a permitted pairing.`)
      }
    }

    // 2. A killed angle must not reappear
    if (item.angle && killed.has(item.angle)) {
      add('BLOCK', i, 'killed-angle', `${item.angle} was KILLed by the last analysis. Do not generate it.`)
    }

    // 3. Prose checks
    for (const { path, text } of collectStrings(item)) {
      const clean = stripPlaceholders(text)
      const lower = clean.toLowerCase()

      for (const { word, insteadUse } of brand.forbiddenWords) {
        const re = new RegExp(`(^|[^\\p{L}])${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u')
        if (re.test(lower)) add('BLOCK', i, 'forbidden-word', `${path}: "${word}" is banned. Use ${insteadUse}.`)
      }
      for (const stem of EXTRA_BANNED) {
        if (lower.includes(stem)) add('BLOCK', i, 'forbidden-word', `${path}: "${stem}" is banned.`)
      }

      if (text.includes('—')) add('BLOCK', i, 'em-dash', `${path}: contains an em dash. RULES.md forbids it.`)

      const bangs = (text.match(/!/g) ?? []).length
      if (bangs > 3) add('WARN', i, 'exclamations', `${path}: ${bangs} exclamation marks. Guide says three at most.`)

      for (const { id, re, msg } of CLAIM_PATTERNS) {
        if (!re.test(clean)) continue
        const unbacked = numbersIn(clean).filter(n => !brand.allowedNumbers.has(n))
        if (id === 'bignumber' && !unbacked.length) continue
        add('BLOCK', i, `claim:${id}`, `${path}: ${msg} Wrap it as [OVĚŘIT: …] or use a verified claim.`)
      }
    }

    // 4. Hashtags must come from the guide
    if (Array.isArray(item.hashtags)) {
      const allowed = new Set(brand.hashtags[item.market ?? 'CZ'] ?? brand.hashtags.CZ)
      for (const tag of item.hashtags) {
        if (!allowed.has(String(tag).toLowerCase())) {
          add('BLOCK', i, 'hashtag', `"${tag}" is not in brand-guide.md § 12.`)
        }
      }
    }

  })

  // 5. Content pillar mix, when the batch declares pillars
  const pillared = items.filter(x => x.pillar)
  if (pillared.length >= 4) {
    for (const { name, weightPct } of brand.contentPillars) {
      const actual = (pillared.filter(x => x.pillar === name).length / pillared.length) * 100
      if (Math.abs(actual - weightPct) > 15) {
        findings.push({
          level: 'WARN', index: -1, check: 'pillar-mix',
          message: `"${name}" is ${actual.toFixed(0)}% of the batch, guide says ${weightPct}%.`,
        })
      }
    }
  }

  const blocks = findings.filter(f => f.level === 'BLOCK')
  const warns = findings.filter(f => f.level === 'WARN')

  for (const f of [...blocks, ...warns]) {
    const where = f.index >= 0 ? `item ${f.index}` : 'batch'
    console.log(`${f.level.padEnd(5)} ${where.padEnd(8)} ${f.check.padEnd(18)} ${f.message}`)
  }

  console.log()
  console.log(`${items.length} assets · ${blocks.length} BLOCK · ${warns.length} WARN`)
  if (!winners) console.log('Note: no reports/winners.json, so killed angles were not checked.')

  process.exitCode = blocks.length ? 1 : 0
}

try { main() } catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
}
