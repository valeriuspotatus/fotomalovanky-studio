import { createHash } from 'node:crypto';

export const PHOTO_AUTHORIZATION_VERSION = '2026-08-22-v1';
export const PHOTO_AUTHORIZATION_LOCALE = 'cs-CZ';
export const PHOTO_AUTHORIZATION_TEXT = 'Potvrzuji, že je mi alespoň 18 let a že mám oprávnění použít všechny nahrané fotografie. Pokud je na fotografii dítě nebo jiná osoba, mám souhlas jejího zákonného zástupce nebo této osoby se zpracováním fotografie za účelem vytvoření objednaných Fotomalovánek. Rozumím, že fotografie budou za tímto účelem předány našim technickým poskytovatelům a pracovní kopie budou z místního zpracování automaticky odstraněny po uplynutí zveřejněné doby uchování. Fotografie nepoužijeme pro reklamu, veřejné ukázky ani trénování modelů bez samostatného výslovného souhlasu.';
export const PHOTO_AUTHORIZATION_TEXT_HASH = createHash('sha256').update(PHOTO_AUTHORIZATION_TEXT, 'utf8').digest('hex');

export const PHOTO_AUTHORIZATION_KEYS = Object.freeze({
  accepted: '_Photo authorization accepted',
  version: '_Photo authorization version',
  acceptedAt: '_Photo authorization accepted at',
  locale: '_Photo authorization locale',
  textHash: '_Photo authorization text hash',
});

export const DIGITAL_PERFORMANCE_KEYS = Object.freeze({
  accepted: '_Digital immediate performance accepted',
  acceptedAt: '_Digital immediate performance accepted at',
  version: '_Digital immediate performance version',
  locale: '_Digital immediate performance locale',
  textHash: '_Digital immediate performance text hash',
});
export const DIGITAL_PERFORMANCE_VERSION = '2026-08-22-draft-v1';
export const DIGITAL_PERFORMANCE_TEXT = 'Výslovně žádám o zahájení dodání digitálního PDF před uplynutím lhůty pro odstoupení a beru na vědomí, že po úplném dodání mohu ztratit právo odstoupit. [KONEČNÉ ZNĚNÍ PODLÉHÁ PRÁVNÍ KONTROLE]';
export const DIGITAL_PERFORMANCE_TEXT_HASH = createHash('sha256').update(DIGITAL_PERFORMANCE_TEXT, 'utf8').digest('hex');

const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function exactAttributes(attributes) {
  const values = new Map();
  const duplicates = new Set();
  for (const attribute of attributes ?? []) {
    if (!attribute || typeof attribute.key !== 'string') continue;
    if (!Object.values(PHOTO_AUTHORIZATION_KEYS).includes(attribute.key)) continue;
    if (values.has(attribute.key)) duplicates.add(attribute.key);
    values.set(attribute.key, attribute.value);
  }
  return { values, duplicates };
}

export function validatePhotoAuthorization(attributes, { orderCreatedAt = null } = {}) {
  const { values, duplicates } = exactAttributes(attributes);
  const acceptedAt = values.get(PHOTO_AUTHORIZATION_KEYS.acceptedAt);
  const acceptedMs = typeof acceptedAt === 'string' && UTC_ISO.test(acceptedAt) ? Date.parse(acceptedAt) : NaN;
  const orderMs = typeof orderCreatedAt === 'string' && UTC_ISO.test(orderCreatedAt) ? Date.parse(orderCreatedAt) : NaN;
  const orderTimestamp = Number.isFinite(orderMs) && UTC_ISO.test(orderCreatedAt)
    ? new Date(orderMs).toISOString()
    : null;
  const errors = [];
  if (duplicates.size) errors.push('duplicate-fields');
  if (values.get(PHOTO_AUTHORIZATION_KEYS.accepted) !== 'true') errors.push('accepted');
  if (values.get(PHOTO_AUTHORIZATION_KEYS.version) !== PHOTO_AUTHORIZATION_VERSION) errors.push('version');
  if (!Number.isFinite(acceptedMs) || !UTC_ISO.test(acceptedAt)) errors.push('accepted-at');
  if (values.get(PHOTO_AUTHORIZATION_KEYS.locale) !== PHOTO_AUTHORIZATION_LOCALE) errors.push('locale');
  if (values.get(PHOTO_AUTHORIZATION_KEYS.textHash) !== PHOTO_AUTHORIZATION_TEXT_HASH) errors.push('text-hash');
  if (!orderTimestamp) errors.push('order-timestamp');
  else if (Number.isFinite(acceptedMs) && (acceptedMs < orderMs - 30 * 24 * 60 * 60 * 1000 || acceptedMs > orderMs + 5 * 60 * 1000)) errors.push('accepted-at-order-window');

  return {
    valid: errors.length === 0,
    errors,
    evidence: errors.length ? null : {
      accepted: true,
      version: PHOTO_AUTHORIZATION_VERSION,
      acceptedAt,
      locale: PHOTO_AUTHORIZATION_LOCALE,
      textHash: PHOTO_AUTHORIZATION_TEXT_HASH,
      orderTimestamp,
    },
  };
}

export function validateStoredPhotoAuthorization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['missing'], evidence: null };
  const attributes = Object.entries(PHOTO_AUTHORIZATION_KEYS).map(([field, key]) => ({
    key,
    value: field === 'accepted' ? String(value[field]) : value[field],
  }));
  return validatePhotoAuthorization(attributes, { orderCreatedAt: value.orderTimestamp });
}

export function validateDigitalPerformance(attributes, { required = false, orderCreatedAt = null } = {}) {
  if (!required) return { valid: true, evidence: null, errors: [] };
  const values = new Map();
  const duplicates = new Set();
  for (const attribute of attributes ?? []) {
    if (!attribute || !Object.values(DIGITAL_PERFORMANCE_KEYS).includes(attribute.key)) continue;
    if (values.has(attribute.key)) duplicates.add(attribute.key);
    values.set(attribute.key, attribute.value);
  }
  const acceptedAt = values.get(DIGITAL_PERFORMANCE_KEYS.acceptedAt);
  const acceptedMs = typeof acceptedAt === 'string' && UTC_ISO.test(acceptedAt) ? Date.parse(acceptedAt) : NaN;
  const orderMs = typeof orderCreatedAt === 'string' && UTC_ISO.test(orderCreatedAt) ? Date.parse(orderCreatedAt) : NaN;
  const errors = [];
  if (duplicates.size) errors.push('duplicate-fields');
  if (values.get(DIGITAL_PERFORMANCE_KEYS.accepted) !== 'true') errors.push('accepted');
  if (!Number.isFinite(acceptedMs)) errors.push('accepted-at');
  if (values.get(DIGITAL_PERFORMANCE_KEYS.version) !== DIGITAL_PERFORMANCE_VERSION) errors.push('version');
  if (values.get(DIGITAL_PERFORMANCE_KEYS.locale) !== PHOTO_AUTHORIZATION_LOCALE) errors.push('locale');
  if (values.get(DIGITAL_PERFORMANCE_KEYS.textHash) !== DIGITAL_PERFORMANCE_TEXT_HASH) errors.push('text-hash');
  if (!Number.isFinite(orderMs)) errors.push('order-timestamp');
  else if (Number.isFinite(acceptedMs) && (acceptedMs < orderMs - 30 * 24 * 60 * 60 * 1000 || acceptedMs > orderMs + 5 * 60 * 1000)) errors.push('accepted-at-order-window');
  return { valid: errors.length === 0, errors, evidence: errors.length ? null : { accepted: true, acceptedAt, version: DIGITAL_PERFORMANCE_VERSION, locale: PHOTO_AUTHORIZATION_LOCALE, textHash: DIGITAL_PERFORMANCE_TEXT_HASH, orderTimestamp: new Date(orderMs).toISOString() } };
}

export function validateStoredDigitalPerformance(value, { required = false } = {}) {
  if (!required) return { valid: true, evidence: null, errors: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, evidence: null, errors: ['missing'] };
  const attributes = Object.entries(DIGITAL_PERFORMANCE_KEYS).map(([field, key]) => ({ key, value: field === 'accepted' ? String(value[field]) : value[field] }));
  return validateDigitalPerformance(attributes, { required: true, orderCreatedAt: value.orderTimestamp });
}

export const PHOTO_AUTHORIZATION_ERROR_CS = 'Objednávka nemá platné potvrzení oprávnění k fotografiím. Je pozastavena; podpora musí se zákazníkem domluvit novou objednávku s potvrzením, nebo storno. Fotografie nebudou staženy ani zpracovány.';
