import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { ORDER_INFO } from '../orderInfo.js';
import { PHOTO_AUTHORIZATION_ERROR_CS } from '../photoAuthorization.js';
import { acquireOrderLock, assertSafeOrderId, OrderLockedError } from '../orderLock.js';
import { channelOf, expectedPhotosFrom, sourceFingerprint } from './orders.js';
import { safeFetch as defaultSafeFetch } from './safeFetch.js';

async function ensureJpeg(buffer, ext, sharpImpl) {
  if (ext === 'heic') throw Object.assign(new Error('HEIC unavailable'), { code: 'unsupported-heic' });
  const metadata = await sharpImpl(buffer, { limitInputPixels: 40_000_000, sequentialRead: true }).metadata();
  if (!metadata.width || !metadata.height || metadata.width > 12_000 || metadata.height > 12_000) throw new Error('unsafe image dimensions');
  const converted = await sharpImpl(buffer, { limitInputPixels: 40_000_000, sequentialRead: true })
    .rotate().toColorspace('srgb').flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
  return { buffer: converted, ext: 'jpeg' };
}

function photoName(orderId, index, label, ext) {
  const nnnn = String(index + 1).padStart(4, '0');
  const safeLabel = (label || 'foto').normalize('NFKD').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'foto';
  return `${orderId}_img${nnnn}_-_${safeLabel}.${ext}`;
}

function containedOrderDir(inboxRoot, orderId) {
  const safeId = assertSafeOrderId(orderId);
  const root = resolve(inboxRoot);
  const dir = resolve(root, safeId);
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('A safe order id must stay inside the inbox');
  return { root, dir, safeId };
}

function validStored(dir, orderId, fingerprint, photoIds) {
  try {
    const sidecar = JSON.parse(readFileSync(join(dir, ORDER_INFO), 'utf8'));
    const files = Array.isArray(sidecar.photos) ? sidecar.photos : [];
    if (sidecar.order !== orderId || sidecar.revision?.fingerprint !== fingerprint || JSON.stringify(sidecar.photoIds) !== JSON.stringify(photoIds)) return null;
    if (files.length !== photoIds.length || files.some((name) => typeof name !== 'string' || basename(name) !== name || !existsSync(join(dir, name)))) return null;
    return files;
  } catch { return null; }
}

function heldOrder(root, safeId, orderDir, errors) {
  mkdirSync(root, { recursive: true });
  let release;
  try { release = acquireOrderLock({ inboxRoot: root, orderId: safeId, operation: 'Shopify hold' }); }
  catch (err) {
    if (err instanceof OrderLockedError) return { orderId: safeId, orderDir: null, files: [], incomplete: true, held: true, errors: ['Objednávku právě zpracovává jiný proces; zkuste ji znovu později.'] };
    throw err;
  }
  try {
    if (existsSync(orderDir)) {
      const quarantine = join(root, '.fotomalovanky-staging', safeId);
      mkdirSync(quarantine, { recursive: true });
      rmSync(join(quarantine, 'previous'), { recursive: true, force: true });
      renameSync(orderDir, join(quarantine, 'previous'));
    }
    return { orderId: safeId, orderDir: null, files: [], incomplete: true, held: true, errors };
  } finally { release(); }
}

export async function materializeOrder(order, { inboxRoot, allowlist = [], safeFetch = defaultSafeFetch, fetchImpl = fetch, sharpImpl = sharp, now = () => new Date().toISOString() } = {}) {
  const { root, dir: orderDir, safeId } = containedOrderDir(inboxRoot, order.orderId);
  if (!order.photoAuthorization?.valid || !order.photoAuthorization.evidence) return heldOrder(root, safeId, orderDir, [PHOTO_AUTHORIZATION_ERROR_CS]);
  if (order.digitalPerformance?.valid !== true) return heldOrder(root, safeId, orderDir, ['Digitální PDF nemá platné samostatné potvrzení okamžitého plnění; fotografie nebudou staženy ani zpracovány.']);
  const expectedPhotos = expectedPhotosFrom(order.products);
  if (expectedPhotos && order.photos.length !== expectedPhotos) return heldOrder(root, safeId, orderDir, [`Nesouhlasí počet fotografií: očekáváno ${expectedPhotos}, nalezeno ${order.photos.length}.`]);
  const photoIds = order.photoIds ?? order.photos.map((_, index) => `${safeId}-photo-${String(index + 1).padStart(4, '0')}`);
  if (photoIds.length !== order.photos.length || photoIds.some((id) => typeof id !== 'string') || new Set(photoIds).size !== photoIds.length) return heldOrder(root, safeId, orderDir, ['Nesouhlasí identity fotografií; objednávka byla bezpečně pozastavena.']);
  if (expectedPhotos) {
    const exact = Array.from({ length: expectedPhotos }, (_, index) => `${safeId}-photo-${String(index + 1).padStart(4, '0')}`);
    if (JSON.stringify(photoIds) !== JSON.stringify(exact)) return heldOrder(root, safeId, orderDir, ['Nesouhlasí pořadí nebo identity fotografií; objednávka byla bezpečně pozastavena.']);
  }

  mkdirSync(root, { recursive: true });
  let releaseLock;
  try { releaseLock = acquireOrderLock({ inboxRoot: root, orderId: safeId, operation: 'Shopify materialization' }); }
  catch (err) {
    if (err instanceof OrderLockedError) return { orderId: safeId, orderDir: null, files: [], incomplete: true, held: true, errors: ['Objednávku právě zpracovává jiný proces; zkuste ji znovu později.'] };
    throw err;
  }
  const stagingRoot = join(root, '.fotomalovanky-staging');
  const orderStagingRoot = join(stagingRoot, safeId);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingDir = join(orderStagingRoot, `current-${nonce}`);
  const backupDir = join(orderStagingRoot, 'previous');
  let committed = false;
  try {
    mkdirSync(stagingRoot, { recursive: true });
    mkdirSync(orderStagingRoot, { recursive: true });
    for (const name of readdirSync(orderStagingRoot)) if (name.startsWith('current-')) rmSync(join(orderStagingRoot, name), { recursive: true, force: true });
    mkdirSync(stagingDir);
    const fingerprint = sourceFingerprint({ ...order, photoIds });
    if (existsSync(orderDir)) {
      const previous = validStored(orderDir, safeId, fingerprint, photoIds);
      if (previous) {
        rmSync(orderStagingRoot, { recursive: true, force: true });
        committed = true;
        return { orderId: safeId, orderDir, files: previous, incomplete: false, errors: [], reused: true, fingerprint };
      }
      rmSync(backupDir, { recursive: true, force: true });
      renameSync(orderDir, backupDir);
    }
    const files = [], errors = [], failureCodes = [];
    for (let i = 0; i < order.photos.length; i++) {
      try {
        const fetched = await safeFetch(order.photos[i], { allowlist, fetchImpl });
        const { buffer, ext } = await ensureJpeg(fetched.buffer, fetched.ext, sharpImpl);
        const name = photoName(safeId, i, order.dedication, ext);
        writeFileSync(join(stagingDir, name), buffer);
        files.push(name);
      } catch (err) {
        const code = err?.code === 'unsupported-heic' ? 'unsupported-photo-format' : 'photo-download-or-decode-failed';
        failureCodes.push(code);
        errors.push(code === 'unsupported-photo-format' ? `Fotografie ${i + 1} je ve formátu HEIC/HEIF, který zatím neumíme bezpečně zpracovat. Požádejte zákazníka o JPG, PNG nebo WebP.` : `Fotografii ${i + 1} se nepodařilo bezpečně stáhnout nebo ověřit.`);
      }
    }
    if (errors.length || files.length === 0 || files.length !== order.photos.length) return { orderId: safeId, orderDir: null, files: [], incomplete: true, held: true, failureCode: failureCodes.includes('unsupported-photo-format') ? 'unsupported-photo-format' : 'photo-download-or-decode-failed', errors };

    const products = [];
    if (order.layout) products.push({ title: 'Rozvržení', variant: order.layout, qty: null });
    for (const product of order.products) products.push(product);
    const sidecar = { order: safeId, purchase: order.purchase ?? { orderId: safeId, position: 1, of: 1 }, copies: order.copies ?? 1, dedication: order.dedication, expectedPhotos, customer: { surname: '', email: order.email }, products, photoCount: files.length, photos: files, photoIds, layout: order.layout, attribution: order.attribution ? { ...order.attribution, channel: channelOf(order.attribution) } : null, photoAuthorization: order.photoAuthorization.evidence, digitalPerformance: order.digitalPerformance?.evidence ?? null, source: 'shopify-admin-api', downloadedAt: now(), revision: { fingerprint, sourceUpdatedAt: order.updatedAt ?? null } };
    writeFileSync(join(stagingDir, ORDER_INFO), JSON.stringify(sidecar, null, 2));
    if (!validStored(stagingDir, safeId, fingerprint, photoIds)) throw new Error('staged order failed integrity validation');
    renameSync(stagingDir, orderDir);
    committed = true;
    rmSync(backupDir, { recursive: true, force: true });
    return { orderId: safeId, orderDir, files, incomplete: false, errors, fingerprint };
  } finally {
    if (!committed) rmSync(stagingDir, { recursive: true, force: true });
    if (committed || !existsSync(backupDir)) rmSync(orderStagingRoot, { recursive: true, force: true });
    releaseLock();
  }
}
