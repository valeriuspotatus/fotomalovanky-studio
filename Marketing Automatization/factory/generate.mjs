#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBrand, voiceBlock, claimsBlock } from './lib/brand.mjs'
import {
  ANGLES, SUBJECTS, FORMATS, COHERENT_SUBJECTS, AD_NAME_RE,
  CREATIVE_MAP, VIDEO_MAP, anglesWithoutCreatives,
} from './lib/naming.mjs'

const PACKS = ['social-batch', 'ad-copy-variants', 'video-briefs']
const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'prompts')
const WINNERS = join('reports', 'winners.json')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

/**
 * Turns the analyzer's verdicts into a generation policy. This is the whole point of the
 * loop: a KILL angle must not quietly reappear in the next batch.
 */
function performanceBlock(winners) {
  if (!winners) {
    return [
      '## VÝKON PŘEDCHOZÍCH REKLAM',
      '',
      'Zatím žádná data (`reports/winners.json` neexistuje — spusť `node factory/pull-meta.mjs`',
      'a `node factory/analyze.mjs`).',
      '',
      'Generuj vyvážený vzorek napříč angles. Žádný angle nepreferuj — zatím nevíme, co funguje.',
    ].join('\n')
  }

  const { scale = [], watch = [], kill = [], insufficient = [], untested = [], window: win } = winners
  const noCreative = anglesWithoutCreatives()

  const lines = [
    '## VÝKON PŘEDCHOZÍCH REKLAM',
    '',
    `Zdroj: \`reports/winners.json\`, okno ${win?.since} → ${win?.until}.`,
    '',
  ]

  const rule = (label, angles, instruction) => {
    if (!angles.length) return
    lines.push(`- **${label}: ${angles.join(', ')}** — ${instruction}`)
  }

  rule('SCALE', scale, 'funguje. Vygeneruj 3 nové varianty od každého.')
  rule('WATCH', watch, 'nerozhodné. Vygeneruj 1 variantu od každého.')
  rule('KILL', kill, '**NEGENERUJ NIC.** Tenhle angle prohrál. Nevracej ho zadními vrátky pod jiným subjectem.')
  rule('INSUFFICIENT', insufficient, 'málo dat. Negeneruj nové varianty, nech doběhnout stávající.')
  rule('Netestované', untested, 'zatím nikdy neběžely. Vygeneruj 2 varianty od každého.')
  rule('Bez kreativy', noCreative, 'nemají zatím ani jednu kreativu. Nejvyšší priorita: vygeneruj 2 koncepty.')

  if (kill.length) {
    lines.push('', `⚠ Ani jeden výstup nesmí mít angle: ${kill.join(', ')}.`)
  }
  return lines.join('\n')
}

function taxonomyBlock() {
  const pairs = Object.entries(COHERENT_SUBJECTS)
    .map(([angle, subs]) => `- \`${angle}\` → ${subs.join(', ')}`)

  const concepts = Object.entries(CREATIVE_MAP)
    .map(([code, c]) => `  ${code.padEnd(4)} ${c.title.padEnd(30)} ${c.angle}/${c.subject}/${c.format}`)
  const videos = Object.entries(VIDEO_MAP)
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([code, v]) => `  ${code.padEnd(5)} ${v.title.padEnd(28)} ${v.angle}  (priorita ${v.priority})`)

  return [
    '## TAXONOMIE',
    '',
    `Angles: ${ANGLES.join(', ')}`,
    `Subjects: ${SUBJECTS.join(', ')}`,
    `Formats: ${FORMATS.join(', ')}`,
    '',
    'Jeden asset = jedno sdělení. Copy, které argumentuje dvěma angles, jsou dva assety.',
    '',
    '### Povolené kombinace angle × subject',
    ...pairs,
    '',
    '### Název reklamy',
    '```',
    'FM_{market}_{angle}_{subject}_{format}_v{NN}',
    AD_NAME_RE.source,
    '```',
    '',
    '### Existující kreativy (statiky)',
    '```',
    ...concepts,
    '```',
    '',
    '### Existující videa (podle produkční priority)',
    '```',
    ...videos,
    '```',
  ].join('\n')
}

function pillarsBlock(brand) {
  return [
    '## OBSAHOVÉ PILÍŘE (závazný poměr)',
    '',
    ...brand.contentPillars.map(p => `- **${p.name}** — ${p.weightPct} % dávky`),
  ].join('\n')
}

function taglinesBlock(brand) {
  const tier = (n, label) =>
    brand.taglines[`tier${n}`]?.length
      ? [`**Tier ${n} — ${label}:**`, ...brand.taglines[`tier${n}`].map(t => `- "${t}"`), '']
      : []
  return [
    '## OVĚŘENÉ TAGLINY (jiné nevymýšlej jako "ověřené")',
    '',
    ...tier(1, 'hlavní, kdekoli'),
    ...tier(2, 'silné, rotovat v ads'),
    ...tier(3, 'situační'),
  ].join('\n')
}

function main() {
  const pack = arg('pack')
  if (!PACKS.includes(pack)) {
    console.error(`Usage: node factory/generate.mjs --pack <${PACKS.join('|')}> [--market CZ] [--out FILE]`)
    process.exitCode = 1
    return
  }

  const market = arg('market', 'CZ')
  const brand = loadBrand()
  const winners = existsSync(WINNERS) ? JSON.parse(readFileSync(WINNERS, 'utf8')) : null

  const template = readFileSync(join(PROMPT_DIR, `${pack}.md`), 'utf8')

  const substitutions = {
    MARKET: market,
    VOICE: voiceBlock(brand),
    CLAIMS: claimsBlock(brand),
    PERFORMANCE: performanceBlock(winners),
    TAXONOMY: taxonomyBlock(),
    PILLARS: pillarsBlock(brand),
    TAGLINES: taglinesBlock(brand),
  }

  let out = template
  for (const [key, value] of Object.entries(substitutions)) {
    out = out.replaceAll(`{{${key}}}`, value)
  }

  const leftover = out.match(/\{\{[A-Z_]+\}\}/g)
  if (leftover) throw new Error(`Unsubstituted placeholders in ${pack}.md: ${[...new Set(leftover)].join(', ')}`)

  const outPath = arg('out')
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, out)
    console.error(`Wrote ${outPath}`)
  } else {
    process.stdout.write(out)
  }

  if (!winners) {
    console.error(`\nNote: no ${WINNERS} yet, so the prompt has no performance feedback baked in.`)
  }
}

try { main() } catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
}
