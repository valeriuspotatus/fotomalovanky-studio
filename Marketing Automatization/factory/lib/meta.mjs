import { meta as cfg } from './config.mjs'

const GRAPH_HOST = 'https://graph.facebook.com'

/** Transient Graph API failures. Everything else is a real error and should surface. */
const RETRYABLE_CODES = new Set([
  1,     // unknown, usually transient
  2,     // service temporarily unavailable
  4,     // application request limit reached
  17,    // user request limit reached
  32,    // page request limit reached
  613,   // calls to this api have exceeded the rate limit
  80000, // ads insights throttled
  80004,
])

export const INSIGHT_FIELDS = [
  'ad_id',
  'ad_name',
  'adset_id',
  'adset_name',
  'campaign_id',
  'campaign_name',
  'spend',
  'impressions',
  'clicks',
  'reach',
  'frequency',
  'actions',
  'action_values',
]

export class MetaApiError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'MetaApiError'
    Object.assign(this, details)
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const backoffMs = attempt => Math.min(60_000, 2 ** attempt * 1000 + Math.random() * 500)

export class MetaClient {
  constructor({ token = cfg.token, accountId = cfg.accountId, version = cfg.version } = {}) {
    this.token = token
    this.accountId = accountId
    this.version = version
  }

  #url(path, params = {}) {
    const url = new URL(`${GRAPH_HOST}/${this.version}/${path}`)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
    url.searchParams.set('access_token', this.token)
    return url.toString()
  }

  async #getJson(url, { retries = 5 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res
      try {
        res = await fetch(url)
      } catch (cause) {
        if (attempt >= retries) throw new MetaApiError(`Network failure calling Graph API`, { cause })
        await sleep(backoffMs(attempt))
        continue
      }

      const body = await res.json().catch(() => ({}))
      if (res.ok) return body

      const error = body.error ?? {}
      const retryable = res.status === 429 || res.status >= 500 || RETRYABLE_CODES.has(error.code)

      if (!retryable || attempt >= retries) {
        throw new MetaApiError(error.message ?? `Graph API returned HTTP ${res.status}`, {
          status: res.status,
          code: error.code,
          subcode: error.error_subcode,
          type: error.type,
          fbtraceId: error.fbtrace_id,
          hint: hintFor(error, res.status, this.version),
        })
      }
      await sleep(backoffMs(attempt))
    }
  }

  /** Walks `paging.next` until exhausted, yielding one row at a time. */
  async *paginate(path, params) {
    let url = this.#url(path, params)
    while (url) {
      const page = await this.#getJson(url)
      for (const row of page.data ?? []) yield row
      url = page.paging?.next ?? null
    }
  }

  async adInsights({ since, until, level = 'ad', timeIncrement, attributionWindows = cfg.attributionWindows }) {
    const rows = []
    const params = {
      level,
      fields: INSIGHT_FIELDS.join(','),
      time_range: { since, until },
      action_attribution_windows: attributionWindows,
      time_increment: timeIncrement,
      limit: '500',
    }
    for await (const row of this.paginate(`${this.accountId}/insights`, params)) rows.push(row)
    return rows
  }
}

function hintFor(error, status, version) {
  if (status === 400 && /Unsupported get request|does not exist/i.test(error.message ?? '')) {
    return `Check META_AD_ACCOUNT_ID — it must be the numeric account id, and the token must have access to it.`
  }
  if (error.code === 190) {
    return `Token is invalid or expired. Generate a new system user token with the ads_read scope.`
  }
  if (error.code === 200 || error.code === 10) {
    return `Token lacks permission. The analyzer needs ads_read on this ad account.`
  }
  if (/version/i.test(error.message ?? '')) {
    return `Graph API ${version} may be deprecated. Bump META_API_VERSION in .env to a supported version.`
  }
  if (RETRYABLE_CODES.has(error.code)) {
    return `Rate limited even after retries. Narrow the date window or wait an hour.`
  }
  return undefined
}

/**
 * Meta returns actions as [{action_type, value, '7d_click': '...', '1d_view': '...'}].
 * `value` is the total across requested windows when present; otherwise sum what we asked for.
 */
export function pickActionValue(action, attributionWindows = cfg.attributionWindows) {
  if (action.value !== undefined) return Number(action.value) || 0
  return attributionWindows.reduce((sum, w) => sum + (Number(action[w]) || 0), 0)
}

export function sumAction(row, actionType, field = 'actions', attributionWindows) {
  const entries = row[field] ?? []
  return entries
    .filter(a => a.action_type === actionType)
    .reduce((sum, a) => sum + pickActionValue(a, attributionWindows), 0)
}

/** Available purchase-ish action types on a row, for diagnosing a mis-set META_ACTION_TYPE. */
export function purchaseActionTypes(rows) {
  const seen = new Set()
  for (const row of rows) {
    for (const a of row.actions ?? []) {
      if (/purchase/i.test(a.action_type)) seen.add(a.action_type)
    }
  }
  return [...seen].sort()
}
