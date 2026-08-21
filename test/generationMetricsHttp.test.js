import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createReviewServer } from '../src/ui/server.js';

const PAGE = readFileSync(new URL('../src/ui/static/dashboard.html', import.meta.url), 'utf8');
const CONFIG = {
  generator: { baseUrl: 'https://example.test/gen/', mode: 'api' },
  builder: { baseUrl: 'https://example.test/builder' },
  paths: { inbox: './inbox', outbox: './outbox' },
};

test('generation metrics HTTP endpoint reads the configured outbox and preserves zeroes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-generation-http-'));
  const outbox = join(root, 'outbox');
  const order = join(outbox, '1901');
  mkdirSync(order, { recursive: true });
  writeFileSync(join(order, 'state.json'), JSON.stringify({ photos: { p: { generationAttempts: [{
    attemptId: 'one', attemptNumber: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    durationMs: 0, kind: 'initial', result: 'success',
  }] } } }));
  const { server } = createReviewServer({ config: CONFIG, inboxRoot: join(root, 'inbox'), outboxRoot: outbox, memoryRoot: outbox, driver: { generate: async () => {} }, authEnv: {} });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generation-metrics`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.windows.today.generatedPhotos, 1);
    assert.equal(body.windows.today.generationFailureRate, 0);
    assert.equal(body.windows.today.firstPassAcceptanceRate, null);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the concise production block ships hidden and operator-only, with no printer rendering path', () => {
  const section = /<section id="generationMetricsSection"([^>]*)>/.exec(PAGE);
  assert.ok(section);
  assert.match(section[1], /data-operator/);
  assert.match(section[1], /\bhidden\b/);
  assert.match(PAGE, /fetch\("\/api\/generation-metrics"\)/);
  assert.match(PAGE, /PrvnÃ­ pokus|První pokus/);
  assert.match(PAGE, /Pokusy na schvÃ¡lenou|Pokusy na schválenou/);
  assert.doesNotMatch(section[0], /data-printer/);
});
