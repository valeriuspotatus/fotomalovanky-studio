import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGITAL_PERFORMANCE_KEYS,
  DIGITAL_PERFORMANCE_TEXT_HASH,
  DIGITAL_PERFORMANCE_VERSION,
  PHOTO_AUTHORIZATION_KEYS as KEYS,
  PHOTO_AUTHORIZATION_LOCALE,
  PHOTO_AUTHORIZATION_TEXT_HASH,
  PHOTO_AUTHORIZATION_VERSION,
  validatePhotoAuthorization,
  validateDigitalPerformance,
  validateStoredPhotoAuthorization,
} from '../src/photoAuthorization.js';

const createdAt = '2026-08-22T10:00:00.000Z';
const acceptedAt = '2026-08-22T09:58:00.000Z';
const attributes = () => [
  { key: KEYS.accepted, value: 'true' },
  { key: KEYS.version, value: PHOTO_AUTHORIZATION_VERSION },
  { key: KEYS.acceptedAt, value: acceptedAt },
  { key: KEYS.locale, value: PHOTO_AUTHORIZATION_LOCALE },
  { key: KEYS.textHash, value: PHOTO_AUTHORIZATION_TEXT_HASH },
];

test('exact photo authorization evidence validates and normalizes the order timestamp', () => {
  const result = validatePhotoAuthorization(attributes(), { orderCreatedAt: createdAt });
  assert.equal(result.valid, true);
  assert.deepEqual(result.evidence, {
    accepted: true,
    version: PHOTO_AUTHORIZATION_VERSION,
    acceptedAt,
    locale: PHOTO_AUTHORIZATION_LOCALE,
    textHash: PHOTO_AUTHORIZATION_TEXT_HASH,
    orderTimestamp: createdAt,
  });
});

test('missing, duplicate, invalid, and tampered authorization fields fail closed', () => {
  for (const field of Object.values(KEYS)) {
    assert.equal(validatePhotoAuthorization(attributes().filter((a) => a.key !== field), { orderCreatedAt: createdAt }).valid, false, field);
  }
  assert.equal(validatePhotoAuthorization([...attributes(), attributes()[0]], { orderCreatedAt: createdAt }).valid, false);
  for (const [key, value] of [
    [KEYS.accepted, 'false'], [KEYS.accepted, 'TRUE'], [KEYS.version, 'other'],
    [KEYS.acceptedAt, '2026-08-22'], [KEYS.locale, 'cs'], [KEYS.textHash, '0'.repeat(64)],
  ]) {
    const tampered = attributes().map((a) => a.key === key ? { ...a, value } : a);
    assert.equal(validatePhotoAuthorization(tampered, { orderCreatedAt: createdAt }).valid, false, key);
  }
  assert.equal(validatePhotoAuthorization(attributes(), { orderCreatedAt: 'not-utc' }).valid, false);
  const future = attributes().map((a) => a.key === KEYS.acceptedAt ? { ...a, value: '2026-09-23T10:00:00.000Z' } : a);
  assert.equal(validatePhotoAuthorization(future, { orderCreatedAt: createdAt }).valid, false);
  const nextDay = attributes().map((a) => a.key === KEYS.acceptedAt ? { ...a, value: '2026-08-23T10:00:00.000Z' } : a);
  assert.equal(validatePhotoAuthorization(nextDay, { orderCreatedAt: createdAt }).valid, false);
  assert.equal(validatePhotoAuthorization(attributes(), { orderCreatedAt: '2026-08-22T10:00:00Z' }).evidence.orderTimestamp, createdAt);
  const skewed = attributes().map((a) => a.key === KEYS.acceptedAt ? { ...a, value: '2026-08-22T10:04:00.000Z' } : a);
  assert.equal(validatePhotoAuthorization(skewed, { orderCreatedAt: createdAt }).valid, true, 'an honest client clock skew does not strand a paid order');
});

test('stored evidence is revalidated rather than trusted', () => {
  const evidence = validatePhotoAuthorization(attributes(), { orderCreatedAt: createdAt }).evidence;
  assert.equal(validateStoredPhotoAuthorization(evidence).valid, true);
  assert.equal(validateStoredPhotoAuthorization({ ...evidence, textHash: 'tampered' }).valid, false);
  assert.equal(validateStoredPhotoAuthorization(null).valid, false);
});

test('digital performance evidence is versioned, time-bound, and duplicate-safe', () => {
  const attrs = [
    { key: DIGITAL_PERFORMANCE_KEYS.accepted, value: 'true' },
    { key: DIGITAL_PERFORMANCE_KEYS.acceptedAt, value: acceptedAt },
    { key: DIGITAL_PERFORMANCE_KEYS.version, value: DIGITAL_PERFORMANCE_VERSION },
    { key: DIGITAL_PERFORMANCE_KEYS.locale, value: PHOTO_AUTHORIZATION_LOCALE },
    { key: DIGITAL_PERFORMANCE_KEYS.textHash, value: DIGITAL_PERFORMANCE_TEXT_HASH },
  ];
  assert.equal(validateDigitalPerformance(attrs, { required: true, orderCreatedAt: createdAt }).valid, true);
  assert.equal(validateDigitalPerformance([...attrs, attrs[0]], { required: true, orderCreatedAt: createdAt }).valid, false);
  const future = attrs.map((a) => a.key === DIGITAL_PERFORMANCE_KEYS.acceptedAt ? { ...a, value: '2026-08-23T10:00:00.000Z' } : a);
  assert.equal(validateDigitalPerformance(future, { required: true, orderCreatedAt: createdAt }).valid, false);
});
