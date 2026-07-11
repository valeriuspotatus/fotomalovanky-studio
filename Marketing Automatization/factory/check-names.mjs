#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseAdName, isCoherent } from './lib/naming.mjs'

/**
 * Cross-file guard the linter can't provide: lint-copy.mjs only sees one file, but v-numbers
 * must be unique per taxonomy cell across every creative-concepts file. Two files each minting
 * FM_CZ_GIFT_KIDS_REAL_v01 would both pass lint-copy and still collide in the ad account.
 */

const DIR = 'creatives'

function loadAll() {
  const files = readdirSync(DIR).filter(f => f.endsWith('-concepts.json'))
  const assets = []
  for (const file of files) {
    let arr
    try {
      arr = JSON.parse(readFileSync(join(DIR, file), 'utf8'))
    } catch (err) {
      console.error(`BLOCK  ${file}: not valid JSON (${err.message})`)
      process.exitCode = 1
      continue
    }
    if (!Array.isArray(arr)) {
      console.error(`BLOCK  ${file}: not a JSON array`)
      process.exitCode = 1
      continue
    }
    arr.forEach((a, i) => assets.push({ ...a, _file: file, _i: i }))
  }
  return { files, assets }
}

function main() {
  const { files, assets } = loadAll()
  const withNames = assets.filter(a => a.adName)

  const byName = new Map()
  for (const a of withNames) {
    if (!byName.has(a.adName)) byName.set(a.adName, [])
    byName.get(a.adName).push(a)
  }

  const collisions = [...byName].filter(([, uses]) => uses.length > 1)
  const invalid = withNames.filter(a => !parseAdName(a.adName))
  const incoherent = withNames
    .map(a => ({ a, p: parseAdName(a.adName) }))
    .filter(({ p }) => p && !isCoherent(p.angle, p.subject))

  for (const [name, uses] of collisions) {
    console.log(`COLLISION  ${name}`)
    for (const u of uses) console.log(`             ${u._file}[${u._i}] (${u.sourceConcept ?? '?'})`)
  }
  for (const a of invalid) console.log(`INVALID    ${a.adName}  (${a._file}[${a._i}])`)
  for (const { a, p } of incoherent) console.log(`INCOHERENT ${a.adName}  ${p.angle}×${p.subject}  (${a._file})`)

  // Per-cell v-number map, so gaps and next-free numbers are visible at a glance.
  const cells = new Map()
  for (const a of withNames) {
    const p = parseAdName(a.adName)
    if (!p) continue
    const cell = `${p.market}_${p.angle}_${p.subject}_${p.format}`
    if (!cells.has(cell)) cells.set(cell, [])
    cells.get(cell).push(p.variant)
  }

  console.log()
  console.log(`${files.length} files · ${withNames.length} named assets · ${cells.size} taxonomy cells used`)
  for (const [cell, vs] of [...cells].sort()) {
    const sorted = vs.slice().sort((x, y) => x - y)
    const dup = sorted.length !== new Set(sorted).size ? '  ⚠ DUP' : ''
    console.log(`  ${cell.padEnd(28)} v${sorted.map(v => String(v).padStart(2, '0')).join(', v')}${dup}`)
  }

  const problems = collisions.length + invalid.length + incoherent.length
  console.log()
  console.log(problems ? `${problems} problem(s) — fix before shipping.` : 'No cross-file collisions. Clean.')
  if (problems) process.exitCode = 1
}

try { main() } catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
}
