#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { economics, thresholds } from './lib/config.mjs'
import { sumAction, purchaseActionTypes } from './lib/meta.mjs'
import {
  ANGLES, SUBJECTS, FORMATS, LEGACY,
  parseAdName, looksMisnamed, anglesWithoutCreatives,
} from './lib/naming.mjs'

const REPORT_DIR = 'reports'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const div = (a, b) => (b > 0 ? a / b : null)

const emptyAgg = () => ({ spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, ads: new Set() })

function accumulate(agg, row, actionType, windows) {
  agg.spend += Number(row.spend) || 0
  agg.impressions += Number(row.impressions) || 0
  agg.clicks += Number(row.clicks) || 0
  agg.conversions += sumAction(row, actionType, 'actions', windows)
  agg.revenue += sumAction(row, actionType, 'action_values', windows)
  agg.ads.add(row.ad_id)
  return agg
}

const metrics = agg => ({
  spend: agg.spend,
  impressions: agg.impressions,
  clicks: agg.clicks,
  conversions: agg.conversions,
  revenue: agg.revenue,
  ads: agg.ads.size,
  cpa: div(agg.spend, agg.conversions),
  pno: div(agg.spend, agg.revenue),
  aov: div(agg.revenue, agg.conversions),
  ctr: div(agg.clicks, agg.impressions),
  cpm: div(agg.spend * 1000, agg.impressions),
})

const bucketInto = (map, key) => (map.has(key) ? map.get(key) : map.set(key, emptyAgg()).get(key))

/**
 * The verdict lives on the angle only. Subject and format are read marginally —
 * their joint cells are too sparse to mean anything at this order volume.
 */
function verdictFor(m, baseline, targetCpa) {
  const { minConversions, killSpendMultiple, killPnoMultiple, scalePnoMultiple } = thresholds

  if (m.conversions === 0) {
    if (targetCpa && m.spend >= killSpendMultiple * targetCpa) {
      return {
        verdict: 'KILL',
        reason: `${money(m.spend)} spent, zero conversions — past ${killSpendMultiple}× the ${money(targetCpa)} target CPA.`,
      }
    }
    return {
      verdict: 'INSUFFICIENT',
      reason: targetCpa
        ? `No conversions yet, and spend is under the ${money(killSpendMultiple * targetCpa)} kill threshold. Let it run.`
        : `No conversions yet. No AOV baseline, so no spend-based kill is possible — set FM_AOV_FALLBACK to enable one.`,
    }
  }

  if (m.conversions < minConversions) {
    const need = Math.ceil(minConversions - m.conversions)
    return {
      verdict: 'INSUFFICIENT',
      reason: `${round(m.conversions)} conversions. Needs ${need} more before a verdict means anything.`,
    }
  }

  if (m.pno === null) {
    return {
      verdict: 'INSUFFICIENT',
      reason: `${round(m.conversions)} conversions but zero revenue recorded — action_values is likely missing. Cannot compute PNO.`,
    }
  }

  if (m.pno <= economics.pnoTarget) {
    return { verdict: 'SCALE', reason: `PNO ${pct(m.pno)} is at or under the ${pct(economics.pnoTarget)} target.` }
  }

  if (baseline?.pno) {
    if (m.pno <= baseline.pno * scalePnoMultiple) {
      return { verdict: 'SCALE', reason: `PNO ${pct(m.pno)} beats the ${pct(baseline.pno)} baseline by more than ${pct(1 - scalePnoMultiple)}.` }
    }
    if (m.pno >= baseline.pno * killPnoMultiple) {
      return { verdict: 'KILL', reason: `PNO ${pct(m.pno)} is ${killPnoMultiple}× worse than the ${pct(baseline.pno)} baseline.` }
    }
    return {
      verdict: 'WATCH',
      reason: `PNO ${pct(m.pno)} misses the ${pct(economics.pnoTarget)} target but is not ${killPnoMultiple}× the ${pct(baseline.pno)} baseline — too little separation to act on either way.`,
    }
  }

  return { verdict: 'WATCH', reason: `PNO ${pct(m.pno)} is above target, and there is no baseline to compare against.` }
}

const round = n => (n === null ? '—' : Math.round(n * 100) / 100)
const money = n => (n === null || n === undefined ? '—' : `${Math.round(n).toLocaleString('cs-CZ')} ${economics.currency}`)
const pct = n => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(1)}%`)

function marginalTable(title, keys, buckets) {
  const rows = keys
    .filter(k => buckets.has(k))
    .map(k => ({ key: k, ...metrics(buckets.get(k)) }))
    .sort((a, b) => (a.pno ?? Infinity) - (b.pno ?? Infinity))

  if (!rows.length) return `### ${title}\n\nNo tagged ads yet.\n`

  const body = rows
    .map(r => `| ${r.key} | ${r.ads} | ${money(r.spend)} | ${round(r.conversions)} | ${money(r.cpa)} | ${pct(r.pno)} | ${pct(r.ctr)} |`)
    .join('\n')

  return [
    `### ${title}`,
    '',
    '> Directional only. These are marginal totals collapsed across every other dimension — never a verdict.',
    '',
    '| | Ads | Spend | Conv | CPA | PNO | CTR |',
    '|---|---:|---:|---:|---:|---:|---:|',
    body,
    '',
  ].join('\n')
}

async function main() {
  const inputPath = arg('input', join('data', 'latest.json'))
  const raw = await readFile(inputPath, 'utf8').catch(() => {
    throw new Error(`Cannot read ${inputPath}. Run: node factory/pull-meta.mjs`)
  })
  const data = JSON.parse(raw)
  const { actionType, attributionWindows, window: win, rows } = data

  const byAngle = new Map()
  const bySubject = new Map()
  const byFormat = new Map()
  const legacy = emptyAgg()
  const all = emptyAgg()
  const misnamed = []

  for (const row of rows) {
    accumulate(all, row, actionType, attributionWindows)
    const parsed = parseAdName(row.ad_name)
    if (!parsed) {
      accumulate(legacy, row, actionType, attributionWindows)
      if (looksMisnamed(row.ad_name)) misnamed.push(row.ad_name)
      continue
    }
    accumulate(bucketInto(byAngle, parsed.angle), row, actionType, attributionWindows)
    accumulate(bucketInto(bySubject, parsed.subject), row, actionType, attributionWindows)
    accumulate(bucketInto(byFormat, parsed.format), row, actionType, attributionWindows)
  }

  const legacyM = metrics(legacy)
  const allM = metrics(all)

  // Prefer LEGACY as the control: it is the eight months of untagged history every
  // new angle has to beat. Fall back to the whole account only if legacy is too thin.
  const useLegacy = legacyM.conversions >= thresholds.minConversions && legacyM.pno !== null
  const baseline = useLegacy ? legacyM : allM.pno !== null ? allM : null
  const baselineSource = useLegacy ? 'LEGACY' : baseline ? 'whole account' : 'none'

  const baselineAov = baseline?.aov ?? null
  const targetCpa = baselineAov
    ? baselineAov * economics.pnoTarget
    : economics.aovFallback
      ? economics.aovFallback * economics.pnoTarget
      : null

  const angleRows = ANGLES.filter(a => byAngle.has(a))
    .map(angle => {
      const m = metrics(byAngle.get(angle))
      return { angle, ...m, ...verdictFor(m, baseline, targetCpa) }
    })
    .sort((a, b) => {
      const rank = { SCALE: 0, WATCH: 1, INSUFFICIENT: 2, KILL: 3 }
      if (rank[a.verdict] !== rank[b.verdict]) return rank[a.verdict] - rank[b.verdict]
      return (a.pno ?? Infinity) - (b.pno ?? Infinity)
    })

  const warnings = []
  if (!baseline) {
    const available = purchaseActionTypes(rows)
    warnings.push(
      `No revenue anywhere in this window, so there is no baseline and no PNO. ` +
      (available.length
        ? `META_ACTION_TYPE is "${actionType}", but the purchase-like types present are: ${available.join(', ')}. Set it to the right one and re-pull.`
        : `META_ACTION_TYPE is "${actionType}" and no purchase-like action appears at all — check the pixel, or the window may simply have no sales.`)
    )
  }
  if (!useLegacy && baseline) warnings.push(`LEGACY has ${round(legacyM.conversions)} conversions, under the ${thresholds.minConversions} needed for a control group. Baseline falls back to the whole account, which includes the tagged ads — verdicts are self-referential until legacy accrues data.`)
  if (!targetCpa) warnings.push(`No AOV baseline and FM_AOV_FALLBACK unset, so zero-conversion angles cannot be killed on spend. They will sit at INSUFFICIENT indefinitely.`)
  if (misnamed.length) warnings.push(`${misnamed.length} ad name(s) start with FM_ but fail the convention, so their angle is lost: ${[...new Set(misnamed)].slice(0, 5).join(', ')}${misnamed.length > 5 ? ', …' : ''}`)
  if (!byAngle.size) warnings.push(`No ad matches the naming convention yet. Everything is LEGACY. See brand/angles.md § 4.`)

  // Vocabulary size is free; running an angle is not. Conversions are the scarce resource.
  const resolvable = Math.floor(allM.conversions / thresholds.minConversions)
  if (byAngle.size > resolvable) {
    warnings.push(
      `${byAngle.size} angles are live, but this window produced only ${round(allM.conversions)} conversions across the whole account. ` +
      `At ${thresholds.minConversions} per verdict you can resolve ${resolvable}. Run fewer angles at once, or lengthen the window.`
    )
  }

  const noCreative = anglesWithoutCreatives()
  if (noCreative.length) {
    warnings.push(
      `${noCreative.join(', ')} ${noCreative.length === 1 ? 'is an angle' : 'are angles'} with no creative in the E-code or video map. ` +
      `Nothing can test ${noCreative.length === 1 ? 'it' : 'them'} until one is produced.`
    )
  }

  const report = [
    `# Angle Report — ${win.since} → ${win.until}`,
    '',
    `Generated ${new Date().toISOString()} from \`${inputPath}\` (${rows.length} rows, action type \`${actionType}\`, attribution ${attributionWindows.join(' + ')}).`,
    '',
    ...(warnings.length ? ['## ⚠ Warnings', '', ...warnings.map(w => `- ${w}`), ''] : []),
    '## Baseline',
    '',
    `Control group: **${baselineSource}**${useLegacy ? ' — the untagged ads that predate the convention.' : ''}`,
    '',
    '| | Ads | Spend | Conv | CPA | AOV | PNO |',
    '|---|---:|---:|---:|---:|---:|---:|',
    `| LEGACY | ${legacyM.ads} | ${money(legacyM.spend)} | ${round(legacyM.conversions)} | ${money(legacyM.cpa)} | ${money(legacyM.aov)} | ${pct(legacyM.pno)} |`,
    `| Whole account | ${allM.ads} | ${money(allM.spend)} | ${round(allM.conversions)} | ${money(allM.cpa)} | ${money(allM.aov)} | ${pct(allM.pno)} |`,
    '',
    `Target PNO **${pct(economics.pnoTarget)}** · historical **${pct(economics.pnoHistorical)}** · target CPA ${targetCpa ? money(targetCpa) : '— (no AOV baseline)'}`,
    '',
    '## Verdicts by angle',
    '',
    angleRows.length
      ? [
          '| Angle | Verdict | Ads | Spend | Conv | CPA | PNO | Why |',
          '|---|---|---:|---:|---:|---:|---:|---|',
          ...angleRows.map(r =>
            `| **${r.angle}** | ${r.verdict} | ${r.ads} | ${money(r.spend)} | ${round(r.conversions)} | ${money(r.cpa)} | ${pct(r.pno)} | ${r.reason} |`
          ),
        ].join('\n')
      : '_No tagged ads in this window._',
    '',
    marginalTable('By subject', SUBJECTS, bySubject),
    marginalTable('By format', FORMATS, byFormat),
    '## Rules applied',
    '',
    `- A cell under **${thresholds.minConversions} conversions** gets INSUFFICIENT, never a verdict.`,
    `- **SCALE** — PNO at or under ${pct(economics.pnoTarget)}, or beating the baseline by more than ${pct(1 - thresholds.scalePnoMultiple)}.`,
    `- **KILL** — PNO ${thresholds.killPnoMultiple}× the baseline, or zero conversions past ${thresholds.killSpendMultiple}× target CPA.`,
    `- **WATCH** — everything else with enough data.`,
    `- ${LEGACY} is excluded from angle verdicts (it carries no tags) and included in the baseline.`,
    '',
  ].join('\n')

  const winners = {
    generatedAt: new Date().toISOString(),
    window: win,
    baseline: { source: baselineSource, ...(baseline ?? {}) },
    targetCpa,
    angles: angleRows.map(({ angle, verdict, reason, spend, conversions, cpa, pno, ctr }) => ({
      angle, verdict, reason, spend, conversions, cpa, pno, ctr,
    })),
    scale: angleRows.filter(r => r.verdict === 'SCALE').map(r => r.angle),
    watch: angleRows.filter(r => r.verdict === 'WATCH').map(r => r.angle),
    kill: angleRows.filter(r => r.verdict === 'KILL').map(r => r.angle),
    insufficient: angleRows.filter(r => r.verdict === 'INSUFFICIENT').map(r => r.angle),
    untested: ANGLES.filter(a => !byAngle.has(a)),
    subjects: SUBJECTS.filter(s => bySubject.has(s)).map(s => ({ subject: s, ...metrics(bySubject.get(s)) })),
    formats: FORMATS.filter(f => byFormat.has(f)).map(f => ({ format: f, ...metrics(byFormat.get(f)) })),
    warnings,
  }

  await mkdir(REPORT_DIR, { recursive: true })
  const reportPath = join(REPORT_DIR, `angle-report-${win.since}_${win.until}.md`)
  await writeFile(reportPath, report)
  await writeFile(join(REPORT_DIR, 'winners.json'), JSON.stringify(winners, null, 2))

  process.stdout.write(report)
  console.error(`\nWrote ${reportPath}`)
  console.error(`Wrote ${join(REPORT_DIR, 'winners.json')}  (the generation prompts read this)`)
}

main().catch(err => {
  console.error(`\n${err.message}`)
  process.exitCode = 1
})
