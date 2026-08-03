// Adapter: the authenticated Shopify Admin GraphQL call. All network lives here; the pure
// extraction is in orders.js so tests never hit the wire. The token is a full-store read_orders
// credential — it is sent only as the X-Shopify-Access-Token header to the store's own admin
// endpoint, and never logged (errors below carry the GraphQL message, not the request).
//
// Scope note (U0/KTD7): read_orders can read `name`, `email`, `updatedAt`,
// `displayFinancialStatus`, `lineItems.customAttributes` and `lineItems.variantTitle` (scalar).
// It CANNOT read the `customer{}` or `variant{}` connections — requesting them fails the whole
// query with ACCESS_DENIED, so the selection below deliberately avoids them.

export class ShopifyApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShopifyApiError';
    this.seam = 'shopify';
  }
}

const ORDER_FIELDS = `
  name
  email
  createdAt
  updatedAt
  displayFinancialStatus
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 50) {
    edges { node {
      title
      variantTitle
      quantity
      customAttributes { key value }
    } }
  }`;

/** Build a client bound to one store + token. `fetchImpl` is injected so tests never touch the
 *  network. `apiVersion` defaults to the version the U0 spike confirmed. */
export function createAdminClient({ storeDomain, accessToken, apiVersion = '2026-07', fetchImpl = fetch }) {
  if (!storeDomain) throw new ShopifyApiError('storeDomain is required (e.g. aqi8it-7n.myshopify.com).');
  if (!accessToken) throw new ShopifyApiError('accessToken is required (the read_orders token).');
  const endpoint = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;

  async function graphql(query, variables = {}) {
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      // Never surface the request (it carries the token) — only the transport message.
      throw new ShopifyApiError(`Admin API request failed: ${err.message}`);
    }
    if (!res.ok) {
      if (res.status === 429) throw new ShopifyApiError('Admin API throttled (HTTP 429) — back off and retry.');
      throw new ShopifyApiError(`Admin API returned HTTP ${res.status}.`);
    }
    const json = await res.json();
    if (json.errors?.length) {
      const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED');
      const msg = json.errors.map((e) => e.message).join('; ');
      throw new ShopifyApiError(`${throttled ? 'Admin API throttled: ' : 'Admin API error: '}${msg}`);
    }
    return json.data;
  }

  /** One order by its customer-facing name ("#1524" or "1524"). Returns the raw node or null. */
  async function fetchOrderByName(name) {
    const bare = String(name).replace(/^#/, '').trim();
    const data = await graphql(
      `query($q: String!) { orders(first: 1, query: $q) { edges { node { ${ORDER_FIELDS} } } } }`,
      { q: `name:${bare}` },
    );
    return data?.orders?.edges?.[0]?.node ?? null;
  }

  /** Recent orders, newest first, paged by cursor. `query` is a Shopify search string
   *  (e.g. "financial_status:paid"). Returns raw nodes across all pages. */
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
      for (const e of edges) nodes.push(e.node);
      if (!data?.orders?.pageInfo?.hasNextPage || !edges.length) break;
      after = edges[edges.length - 1].cursor;
    }
    return nodes;
  }

  return { graphql, fetchOrderByName, listOrders, endpoint };
}
