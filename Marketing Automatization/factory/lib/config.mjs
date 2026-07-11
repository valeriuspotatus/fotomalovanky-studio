import { existsSync } from 'node:fs'

if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env')
}

const num = (raw, fallback) => {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${raw}"`)
  return n
}

const list = (raw, fallback) =>
  (raw ?? fallback).split(',').map(s => s.trim()).filter(Boolean)

const normalizeAccountId = id =>
  !id ? id : id.startsWith('act_') ? id : `act_${id}`

export const meta = {
  token: process.env.META_ACCESS_TOKEN,
  accountId: normalizeAccountId(process.env.META_AD_ACCOUNT_ID),
  version: process.env.META_API_VERSION || 'v21.0',
  actionType: process.env.META_ACTION_TYPE || 'purchase',
  attributionWindows: list(process.env.META_ATTRIBUTION_WINDOWS, '7d_click,1d_view'),
}

export const economics = {
  currency: process.env.FM_CURRENCY || 'CZK',
  // PNO = ad spend / revenue.
  // CZ: ~0.50 today on statics, target < 0.35 (MARKETING PLAN v2 § 8).
  // DE: < 0.45 is the target for the unlaunched German market's learning phase.
  // The 0.65 in the old PDF was the Christmas learning phase, not the steady state.
  pnoTarget: num(process.env.FM_PNO_TARGET, 0.35),
  pnoHistorical: num(process.env.FM_PNO_HISTORICAL, 0.50),
  // Only set this if you know the real AOV. Left null, spend-based KILL verdicts are
  // suppressed rather than computed against a made-up number.
  aovFallback: process.env.FM_AOV_FALLBACK ? num(process.env.FM_AOV_FALLBACK) : null,
}

export const thresholds = {
  // Below this many conversions a cell gets INSUFFICIENT, never a verdict.
  // Sized from ~180 orders/month across 7 angles. See brand/angles.md.
  minConversions: num(process.env.FM_MIN_CONVERSIONS, 25),
  // Zero conversions after this many multiples of target CPA is a kill.
  killSpendMultiple: num(process.env.FM_KILL_SPEND_MULTIPLE, 3),
  // PNO this many times worse than baseline is a kill.
  killPnoMultiple: num(process.env.FM_KILL_PNO_MULTIPLE, 1.3),
  // PNO this fraction of baseline (or better) is a scale, even if above absolute target.
  scalePnoMultiple: num(process.env.FM_SCALE_PNO_MULTIPLE, 0.8),
}

export function requireMetaCredentials() {
  const missing = []
  if (!meta.token) missing.push('META_ACCESS_TOKEN')
  if (!meta.accountId) missing.push('META_AD_ACCOUNT_ID')
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(' and ')}.\n` +
      `Copy .env.example to .env and fill it in. The token needs the ads_read scope.`
    )
  }
}
