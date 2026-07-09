import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiGeneratorDriver } from '../src/generator/apiDriver.js';
import { GeneratorError } from '../src/generator/driver.js';

// RunPod loses jobs: ~8% of them in the operator's recorded session. A dropped job used to lose
// the photo outright. These tests pin the recovery: resubmit a *new* job, bounded, and when the
// budget is spent fail with a message that names the seam rather than a stack trace.

const PREFIX = 'https://generator.test/tok';
const SERVER_NAME = 'abc123_photo.jpg';

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}
function bytesRes(buf) {
  return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}

/** Fake generator. `gpuFailsFirst` jobs come back FAILED before one finally COMPLETEs. */
function makeServer({ gpuFailsFirst = 0, uploadError = null } = {}) {
  const calls = { upload: 0, process: 0, status: 0, poll: 0, vectorize: 0, download: 0 };
  const fetchStub = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/upload')) {
      calls.upload++;
      return jsonRes(uploadError ? { error: uploadError } : { job_id: 'JOB1', count: 1 });
    }
    if (u.includes('/status/')) {
      calls.status++;
      return jsonRes({ files: [{ filename: SERVER_NAME }] });
    }
    if (u.includes('/process-status/')) {
      calls.poll++;
      // Each submitted job either dies or completes, depending on how many we've submitted.
      const dies = calls.process <= gpuFailsFirst;
      return jsonRes({ status: dies ? 'FAILED' : 'COMPLETED', error: dies ? 'worker exited' : undefined });
    }
    if (u.includes('/process/')) {
      calls.process++;
      return jsonRes({ success: true, variant_key: '2509_1.5', runpod_job_id: `rp${calls.process}` });
    }
    if (u.includes('/vectorize/')) {
      calls.vectorize++;
      return jsonRes({ success: true, jpg_filename: 'photo.jpg', png_filename: 'photo_bw.png', svg_filename: 'photo.svg' });
    }
    if (u.includes('/download/')) {
      calls.download++;
      return bytesRes(Buffer.from('file-bytes'));
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { fetchStub, calls };
}

function makeConfig(overrides = {}) {
  return {
    generator: {
      baseUrl: PREFIX,
      variant: '2509_1.5',
      diffusionSteps: 8,
      positivePrompt: 'p',
      negativePrompt: 'n',
      timeouts: { pollIntervalMs: 1, backoffBaseMs: 1, requestMs: 500, maxPollMs: 2000, retries: 0, ...overrides },
    },
  };
}

let tmp, photoPath, realFetch;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fma-retry-'));
  photoPath = join(tmp, 'photo.jpg');
  writeFileSync(photoPath, 'not-a-real-image'); // sharp fails to parse -> driver uploads raw bytes
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
});

describe('ApiGeneratorDriver GPU-failure retry', () => {
  test('a FAILED GPU job is resubmitted and the photo still lands', async () => {
    const { fetchStub, calls } = makeServer({ gpuFailsFirst: 1 });
    globalThis.fetch = fetchStub;
    const driver = new ApiGeneratorDriver(makeConfig({ gpuRetries: 2 }));

    const out = await driver.generate(photoPath, { workDir: join(tmp, 'out') });

    assert.equal(calls.process, 2, 'the dead job should be resubmitted exactly once');
    assert.ok(existsSync(out.coloringSvgPath), 'outputs are downloaded after the retry succeeds');
    assert.equal(calls.vectorize, 1, 'vectorize runs only for the job that completed');
  });

  test('retries are bounded, and exhausting them names the seam without a stack trace', async () => {
    const { fetchStub, calls } = makeServer({ gpuFailsFirst: 99 });
    globalThis.fetch = fetchStub;
    const driver = new ApiGeneratorDriver(makeConfig({ gpuRetries: 2 }));

    const err = await driver.generate(photoPath, { workDir: join(tmp, 'out') }).then(
      () => null,
      (e) => e,
    );

    assert.ok(err instanceof GeneratorError, 'a typed generator error, not a raw throw');
    assert.equal(err.seam, 'generator');
    assert.equal(err.step, 'poll');
    assert.equal(calls.process, 3, 'initial attempt + 2 retries');
    assert.equal(calls.vectorize, 0, 'never vectorize a job that never completed');
    assert.match(err.message, /gave up after 3 attempts/);
    assert.match(err.message, /worker exited/, 'the GPU’s own reason survives to the operator');
  });

  test('gpuRetries: 0 preserves the old fail-fast behaviour', async () => {
    const { fetchStub, calls } = makeServer({ gpuFailsFirst: 99 });
    globalThis.fetch = fetchStub;
    const driver = new ApiGeneratorDriver(makeConfig({ gpuRetries: 0 }));

    await assert.rejects(() => driver.generate(photoPath, { workDir: join(tmp, 'out') }), GeneratorError);
    assert.equal(calls.process, 1, 'no resubmission when the budget is zero');
  });

  test('a non-retryable failure is not resubmitted', async () => {
    const { fetchStub, calls } = makeServer({ uploadError: 'unsupported file type' });
    globalThis.fetch = fetchStub;
    const driver = new ApiGeneratorDriver(makeConfig({ gpuRetries: 2 }));

    const err = await driver.generate(photoPath, { workDir: join(tmp, 'out') }).then(
      () => null,
      (e) => e,
    );

    assert.ok(err instanceof GeneratorError);
    assert.equal(err.step, 'upload');
    assert.equal(err.retryable, false, 'a rejected upload is the operator’s problem, not the GPU’s');
    assert.equal(calls.process, 0, 'never reached the GPU');
  });

  test('the default retry budget is 2 resubmissions', () => {
    const driver = new ApiGeneratorDriver({ generator: { baseUrl: PREFIX, variant: '2509_1.5' } });
    assert.equal(driver.gpuRetries, 2);
  });
});
