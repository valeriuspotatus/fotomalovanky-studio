// Authenticated Shopify Admin GraphQL adapter. Tokens are used only in the request header and are
// never included in errors. Retry classification stays here, where HTTP and GraphQL semantics are known.
// The read_orders token cannot read customer{} or variant{} connections, so the selection deliberately
// avoids them. firstVisit attribution is retained without landingPage/referrerUrl query strings.
export class ShopifyApiError extends Error {
  constructor(message, { attempts = 1, cause } = {}) {
    super(message);
    this.name = 'ShopifyApiError';
    this.seam = 'shopify';
    this.attempts = attempts;
    if (cause) this.cause = cause;
  }
}

const ORDER_FIELDS = `
  name
  email
  createdAt
  updatedAt
  displayFinancialStatus
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 50) { edges { node {
    title
    variantTitle
    quantity
    customAttributes { key value }
  } } }
  customerJourneySummary { firstVisit {
    source
    utmParameters { source medium campaign }
  } }`;

export function createAdminClient({
  storeDomain, accessToken, apiVersion = '2026-07', fetchImpl = fetch,
  maxRetries = 3, backoffBaseMs = 500,
  delay = sleep, random = Math.random,
}) {
  if (!storeDomain) throw new ShopifyApiError('storeDomain is required (e.g. aqi8it-7n.myshopify.com).');
  if (!accessToken) throw new ShopifyApiError('accessToken is required (the read_orders token).');
  const endpoint = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;
  const wait = (attempt) => delay(backoffBaseMs * 2 ** attempt * (1 + random()));

  async function graphql(query, variables = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        if (attempt < maxRetries) { await wait(attempt); continue; }
        throw new ShopifyApiError(`Admin API request failed after ${attempt + 1} attempts: ${err.message}`, { attempts: attempt + 1, cause: err });
      }
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) { await wait(attempt); continue; }
        const suffix = attempt ? ` after ${attempt + 1} attempts` : '';
        throw new ShopifyApiError(`Admin API returned HTTP ${res.status}${suffix}.`, { attempts: attempt + 1 });
      }
      const json = await res.json();
      if (json.errors?.length) {
        const throttled = json.errors.some((error) => error.extensions?.code === 'THROTTLED');
        if (throttled && attempt < maxRetries) { await wait(attempt); continue; }
        const message = json.errors.map((error) => error.message).join('; ');
        const suffix = attempt ? ` after ${attempt + 1} attempts` : '';
        throw new ShopifyApiError(`${throttled ? 'Admin API throttled' : 'Admin API error'}${suffix}: ${message}`, { attempts: attempt + 1 });
      }
      return json.data;
    }
  }

  async function fetchOrderByName(name) {
    const bare = String(name).replace(/^#/, '').trim();
    const data = await graphql(`query($q: String!) { orders(first: 1, query: $q) { edges { node { ${ORDER_FIELDS} } } } }`, { q: `name:${bare}` });
    return data?.orders?.edges?.[0]?.node ?? null;
  }

  async function listOrders({ query = '', pageSize = 50, maxPages = 20 } = {}) {
    const nodes = [];
    let after = null;
    for (let page = 0; page < maxPages; page++) {
      const data = await graphql(
        `query($q: String, $n: Int!, $after: String) {
           orders(first: $n, after: $after, sortKey: UPDATED_AT, reverse: true, query: $q) {
             edges { cursor node { ${ORDER_FIELDS} } }
             pageInfo { hasNextPage }
           }
         }`,
        { q: query, n: pageSize, after },
      );
      const edges = data?.orders?.edges ?? [];
      for (const edge of edges) nodes.push(edge.node);
      if (!data?.orders?.pageInfo?.hasNextPage || !edges.length) break;
      after = edges[edges.length - 1].cursor;
    }
    return nodes;
  }

  return { graphql, fetchOrderByName, listOrders, endpoint };
}
import { setTimeout as sleep } from 'node:timers/promises';
