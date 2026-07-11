#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { meta as cfg, requireMetaCredentials } from './lib/config.mjs'
import { MetaClient, MetaApiError, purchaseActionTypes } from './lib/meta.mjs'

const DATA_DIR = 'data'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const isoDay = date => date.toISOString().slice(0, 10)

const daysAgo = n => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d
}

async function main() {
  requireMetaCredentials()

  // Default window ends yesterday: today is always partial and would understate every ad.
  const until = arg('until', isoDay(daysAgo(1)))
  const since = arg('since', isoDay(daysAgo(30)))
  const level = arg('level', 'ad')
  const timeIncrement = arg('time-increment')

  const client = new MetaClient()

  console.error(`Pulling ${level}-level insights for ${cfg.accountId}, ${since} → ${until}`)
  const rows = await client.adInsights({ since, until, level, timeIncrement })
  console.error(`Fetched ${rows.length} rows`)

  if (rows.length) {
    const available = purchaseActionTypes(rows)
    const configured = cfg.actionType
    if (available.length && !available.includes(configured)) {
      console.error(
        `\n⚠  META_ACTION_TYPE="${configured}" does not appear in this data.\n` +
        `   Purchase-like action types actually present: ${available.join(', ')}\n` +
        `   Conversions and revenue will read as zero until this matches.\n`
      )
    }
  } else {
    console.error(`\n⚠  Zero rows. Either the window has no delivery, or the account id is wrong.\n`)
  }

  const payload = {
    pulledAt: new Date().toISOString(),
    account: cfg.accountId,
    apiVersion: cfg.version,
    window: { since, until },
    level,
    actionType: cfg.actionType,
    attributionWindows: cfg.attributionWindows,
    rowCount: rows.length,
    rows,
  }

  await mkdir(DATA_DIR, { recursive: true })
  const stamped = join(DATA_DIR, `insights-${since}_${until}.json`)
  const latest = join(DATA_DIR, 'latest.json')

  const json = JSON.stringify(payload, null, 2)
  await writeFile(stamped, json)
  await writeFile(latest, json)

  console.error(`Wrote ${stamped}`)
  console.error(`Wrote ${latest}  (analyze.mjs reads this by default)`)
}

main().catch(err => {
  if (err instanceof MetaApiError) {
    console.error(`\nMeta API error: ${err.message}`)
    if (err.code) console.error(`  code ${err.code}${err.subcode ? `/${err.subcode}` : ''}`)
    if (err.fbtraceId) console.error(`  fbtrace_id ${err.fbtraceId}`)
    if (err.hint) console.error(`\n  → ${err.hint}`)
  } else {
    console.error(`\n${err.message}`)
  }
  process.exitCode = 1
})
