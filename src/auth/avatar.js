// A profile photo that cannot carry anything but pixels (R13, KTD8).
//
// An avatar is the only file in this application that a person uploads and the application later
// hands back out. That is a short sentence with a long tail, and every rule below is one link in it:
//
//   1. IT ARRIVES AS BASE64 IN A JSON BODY, exactly like POST /api/creative/ai-image. No multipart
//      parser, therefore no new dependency and no second body-reading code path to get wrong. The
//      size cap is applied by the JSON reader WHILE IT READS (AVATAR_BODY_LIMIT below), not after —
//      a cap checked after buffering has already spent the memory it was meant to protect.
//
//   2. IT IS VALIDATED BY DECODING IT, never by its declared type. `image/png` in a header or a
//      data: prefix is a claim by the uploader and nothing more; the only honest question is
//      whether libvips can decode the bytes, so `reencodeAvatar` hands them to sharp and treats a
//      throw as a refusal. `limitInputPixels` is set explicitly because a 40 KB file can describe a
//      gigapixel canvas — a decompression bomb that takes the container down while the operator
//      watches an upload spinner. The bounded output dimension is the second half of that guard.
//
//   3. THE STORED FILE IS NEVER THE UPLOADED BYTES. Always re-encoded, to one format this module
//      chose. That is what strips EXIF — including GPS — and it matters more here than it would
//      anywhere else, because the disk this sits on holds photographs of customers' children and a
//      phone photo used as an avatar would otherwise publish the coordinates of the room it was
//      taken in. `.rotate()` applies the orientation tag before dropping it, so re-encoding cannot
//      turn a portrait sideways.
//
//   4. THE FILE NAME IS GENERATED HERE. Never the client's, never derived from anything the client
//      sent: `<role>-<16 hex>.webp`, and the serving path refuses any name that does not match that
//      shape. A name the caller controls is a path traversal waiting for a careless join().
//
//   5. IT LIVES IN THE ACCOUNTS DATA DIR, OUTSIDE THE SERVED STATIC TREE. The static handler serves
//      anything under static/ with a MIME type read off the extension; an uploaded file there would
//      be one bad extension away from being served as something it should never be served as.
//      Outside that tree, the only way out is the avatar route, which sets the type this module
//      chose plus `X-Content-Type-Options: nosniff`.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { ROLES } from './credentials.js';

/** The folder inside the accounts data dir. Sibling of accounts.json, and like it, off the static tree. */
export const AVATAR_DIR = 'avatars';

/** The one format this module ever writes, and therefore the one Content-Type the route ever sets.
 *  WebP because it is small at avatar sizes and sharp writes it without any extra dependency. */
export const AVATAR_MIME = 'image/webp';
export const AVATAR_EXT = '.webp';

/** The stored square, in pixels. Small on purpose: it is drawn at 32 px in the sidebar, so anything
 *  larger is bytes on a mounted disk nobody will ever see. Also the bound on what a decode can cost
 *  downstream — whatever came in, what leaves here is 256x256. */
export const AVATAR_SIDE = 256;

/** The ceiling on the DECODED size of an upload, in pixels. Without it, a few kilobytes of PNG
 *  header can ask libvips for tens of gigabytes of framebuffer and the container dies. ~40 MP is
 *  more than any phone camera and far less than a bomb. */
export const AVATAR_MAX_PIXELS = 40_000_000;

/** The JSON body cap for the profile route, in bytes of REQUEST — base64 is ~4/3 of the image, so
 *  this admits roughly a 1.5 MB photo. Enforced by readJson while it reads (see the header note). */
export const AVATAR_BODY_LIMIT = 2 * 1024 * 1024;

/** The only file names this module writes, and the only ones the route will serve. Built from ROLES
 *  so a third role cannot silently widen it. */
export const AVATAR_NAME_RE = new RegExp(`^(?:${ROLES.join('|')})-[0-9a-f]{16}\\${AVATAR_EXT}$`);

/** An avatar-seam failure, phrased for the person who uploaded the file. Carries `seam` like the
 *  credential/account/session errors, and a `code` the route maps to a status. */
export class AvatarError extends Error {
  constructor(message, code = 'bad-image') {
    super(message);
    this.name = 'AvatarError';
    this.seam = 'avatar';
    this.code = code;
  }
}

/** The avatars folder for an accounts data dir. */
export const avatarsDir = (dataDir) => join(dataDir, AVATAR_DIR);

/**
 * The absolute path of a stored avatar, or null when the name is not one this module wrote.
 *
 * Two checks, not one: the name must match the generated shape AND the resolved path must still sit
 * inside the avatars folder. The regex alone already excludes a separator, but the containment check
 * is what keeps that true if the shape is ever relaxed — the order of those two failures is not
 * something a later edit should have to reason about.
 */
export function avatarFilePath(dataDir, file) {
  if (!dataDir || typeof file !== 'string' || !AVATAR_NAME_RE.test(file)) return null;
  const root = resolve(avatarsDir(dataDir));
  const path = resolve(root, file);
  return path.startsWith(root + sep) ? path : null;
}

/** A fresh, server-generated file name for a role. Random, so replacing an avatar changes its URL
 *  and no cache can serve the previous person's face under the new one. */
export function avatarFilename(role) {
  if (!ROLES.includes(role)) throw new AvatarError(`unknown role ${JSON.stringify(role)}.`, 'bad-role');
  return `${role}-${randomBytes(8).toString('hex')}${AVATAR_EXT}`;
}

/**
 * The raw bytes behind whatever the page put in the JSON field: a data: URI or bare base64.
 *
 * Deliberately does NOT look at the declared media type in a data: prefix. It is stripped and
 * discarded — the decode in `reencodeAvatar` is the only thing allowed to decide what these bytes
 * are.
 */
export function decodeImagePayload(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AvatarError('Vyberte prosím obrázek.', 'missing');
  }
  const base64 = raw.trim().replace(/^data:[^;,]*;base64,/i, '').replace(/\s+/g, '');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) throw new AvatarError('Obrázek se nepodařilo přečíst.', 'bad-image');
  if (bytes.length > AVATAR_BODY_LIMIT) {
    throw new AvatarError('Obrázek je příliš velký (max 1,5 MB).', 'too-large');
  }
  return bytes;
}

/**
 * Decode, square off, and re-encode. The bytes that come out are never the bytes that went in.
 *
 * A throw from sharp is a refusal, not a 500: "this is not an image" is the answer for a PDF, a ZIP
 * or a text file renamed to .png, and it is the same answer whatever the upload claimed to be.
 */
export async function reencodeAvatar(bytes) {
  try {
    return await sharp(bytes, { limitInputPixels: AVATAR_MAX_PIXELS, animated: false })
      // Apply the orientation tag, then let the re-encode drop it with the rest of the metadata.
      // Without this a phone portrait comes out on its side once EXIF is gone.
      .rotate()
      .resize({ width: AVATAR_SIDE, height: AVATAR_SIDE, fit: 'cover', position: 'centre' })
      // No .withMetadata(): sharp writes no EXIF unless asked, and not asking is the whole point.
      .webp({ quality: 82 })
      .toBuffer();
  } catch (err) {
    throw new AvatarError(`Tenhle soubor není obrázek, který bychom uměli přečíst (${err.message}).`, 'bad-image');
  }
}

/**
 * Re-encode an upload and store it under a fresh, server-generated name. Returns { file, bytes }.
 *
 * `previous` is unlinked afterwards so replaced photos do not accumulate on the mounted disk — and
 * only ever through `avatarFilePath`, so a hand-edited accounts.json cannot make this delete
 * something outside the avatars folder.
 */
export async function storeAvatar({ dataDir, role, payload, previous = null }) {
  if (!dataDir) throw new AvatarError('Profilové fotky nejsou nastavené (accounts.dataDir).', 'not-configured');
  const encoded = await reencodeAvatar(decodeImagePayload(payload));
  const file = avatarFilename(role);
  const dir = avatarsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  // 0o600 for the same reason accounts.json is: this is a shared mount, and a face is not everyone's
  // business either.
  writeFileSync(join(dir, file), encoded, { mode: 0o600 });
  removeAvatar(dataDir, previous);
  return { file, bytes: encoded.length };
}

/** Best-effort delete of a stored avatar. Silent when the name is not ours or the file is gone —
 *  a leftover file is untidy, never a failure worth refusing a profile change over. */
export function removeAvatar(dataDir, file) {
  const path = avatarFilePath(dataDir, file);
  if (!path || !existsSync(path)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** The stored avatar's bytes-on-disk size, or null when it is not there. Used by the route to 404
 *  before opening anything. */
export function avatarSize(dataDir, file) {
  const path = avatarFilePath(dataDir, file);
  if (!path || !existsSync(path)) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
