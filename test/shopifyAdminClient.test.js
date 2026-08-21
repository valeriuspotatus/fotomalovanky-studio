import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminClient, ShopifyApiError } from '../src/shopify/adminClient.js';

const ok = (data = { shop: { name: 'x' } }) => ({ ok: true, status: 200, json: async () => ({ data }) });

test('Shopify retries HTTP 429 with deterministic exponential backoff and jitter', async () => {
  let calls = 0;
  const waits = [];
  const client = createAdminClient({
    storeDomain: 'shop.myshopify.com', accessToken: 'secret', maxRetries: 2, backoffBaseMs: 100,
    delay: async (ms) => waits.push(ms), random: () => 0.5,
    fetchImpl: async () => (++calls < 3 ? { ok: false, status: 429 } : ok()),
  });
  assert.deepEqual(await client.graphql('{ shop { name } }'), { shop: { name: 'x' } });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [150, 300]);
});

test('Shopify retries GraphQL THROTTLED and network failures, then reports attempt context', async () => {
  let calls = 0;
  const client = createAdminClient({
    storeDomain: 'shop.myshopify.com', accessToken: 'secret', maxRetries: 2, backoffBaseMs: 0,
    delay: async () => {}, random: () => 0,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      return { ok: true, status: 200, json: async () => ({ errors: [{ message: 'slow down', extensions: { code: 'THROTTLED' } }] }) };
    },
  });
  await assert.rejects(() => client.graphql('{ shop { name } }'), (err) => {
    assert.ok(err instanceof ShopifyApiError);
    assert.equal(err.attempts, 3);
    assert.match(err.message, /after 3 attempts/);
    assert.doesNotMatch(err.message, /secret/);
    return true;
  });
});

test('Shopify auth and malformed GraphQL failures fail fast', async () => {
  for (const response of [
    { ok: false, status: 401 },
    { ok: true, status: 200, json: async () => ({ errors: [{ message: 'bad query', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }) },
  ]) {
    let calls = 0;
    const client = createAdminClient({ storeDomain: 'shop.myshopify.com', accessToken: 'secret', maxRetries: 3, delay: async () => {}, fetchImpl: async () => { calls++; return response; } });
    await assert.rejects(() => client.graphql('bad'), ShopifyApiError);
    assert.equal(calls, 1);
  }
});

test('Shopify retries a transient HTTP 503', async () => {
  let calls = 0;
  const client = createAdminClient({
    storeDomain: 'shop.myshopify.com', accessToken: 'secret', maxRetries: 1,
    backoffBaseMs: 0, delay: async () => {}, random: () => 0,
    fetchImpl: async () => (++calls === 1 ? { ok: false, status: 503 } : ok()),
  });
  await client.graphql('{ shop { name } }');
  assert.equal(calls, 2);
});
