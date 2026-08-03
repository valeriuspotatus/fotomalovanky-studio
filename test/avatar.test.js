import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createReviewServer } from '../src/ui/server.js';
import { hashPassword, ROLE_ENV_VARS } from '../src/auth/credentials.js';
import { readAccount } from '../src/auth/accounts.js';
import { AVATAR_BODY_LIMIT, AVATAR_MIME, avatarFilePath, avatarsDir } from '../src/auth/avatar.js';

// The profile photo — the ONE file a person uploads that this application later hands back out.
//
// Everything asserted here is about that sentence. The upload is base64 in a JSON body (KTD8), so
// the cap has to be applied by the reader; the bytes are validated by DECODING them, so a declared
// content type proves nothing; and the file on disk is never the file that arrived, which is what
// strips EXIF. That last one is not tidiness: the disk under this app holds photographs of
// customers' children, and a phone photo used as an avatar would otherwise carry the GPS
// coordinates of the room it was taken in into a file the server serves to anyone with a session.

const PASSWORD = 'correct horse battery staple';
const cheapHash = (password) => hashPassword(password, { logN: 14, r: 8, p: 1 });

const CONFIG_BASE = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  builder: { baseUrl: 'https://example.test/builder' },
};

/** A JPEG carrying a GPS block in its EXIF, the way a phone photo does. */
async function jpegWithGps() {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: '#c33' } })
    .withExif({
      IFD0: { Copyright: 'Fotomalovanky' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 5/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '14/1 25/1 0/1' },
    })
    .jpeg()
    .toBuffer();
}

const dataUri = (buf, mime = 'image/jpeg') => `data:${mime};base64,${buf.toString('base64')}`;

/** The GPS IFD pointer tag (0x8825), little-endian as libvips writes it. Present in the upload,
 *  and the thing whose absence afterwards is the actual proof. */
const GPS_TAG_LE = Buffer.from([0x25, 0x88]);

/** A gated studio over a fresh temp root, or over one handed in (which is how the restart is tested:
 *  a second server, same disk). */
async function studio({ root = mkdtempSync(join(tmpdir(), 'fma-avatar-')), authEnv } = {}) {
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  const dataDir = join(root, 'accounts');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });

  const hash = await cheapHash(PASSWORD);
  const { server } = createReviewServer({
    config: { ...CONFIG_BASE, paths: { inbox, outbox }, accounts: { dataDir } },
    inboxRoot: inbox,
    outboxRoot: outbox,
    memoryRoot: join(root, 'memory'),
    driver: { generate: async () => {} },
    authEnv: authEnv ?? { [ROLE_ENV_VARS.operator]: hash, [ROLE_ENV_VARS.printer]: hash },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const signIn = async (username) => {
    const res = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    assert.equal(res.status, 200, `${username} signs in`);
    return String(res.headers.get('set-cookie')).split(';')[0];
  };

  return {
    root,
    origin,
    dataDir,
    signIn,
    get: (p, cookie) => fetch(origin + p, { headers: cookie ? { cookie } : {} }),
    /** POST /api/profile with a JSON body. `raw` sends a string body untouched, for the size cap. */
    profile: (cookie, body, raw = false) =>
      fetch(`${origin}/api/profile`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: raw ? body : JSON.stringify(body),
      }),
    /** The file on disk this role's record points at, or null. */
    storedFile: (role) => readAccount(dataDir, role).avatar,
    storedBytes: (role) => {
      const file = readAccount(dataDir, role).avatar;
      const path = file && avatarFilePath(dataDir, file);
      return path && existsSync(path) ? readFileSync(path) : null;
    },
    close: () => server.close(),
    cleanup: () => { server.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('AE10 — an uploaded photo carrying GPS is stored without it, and never as the bytes that arrived', async () => {
  const f = await studio();
  try {
    const uploaded = await jpegWithGps();
    assert.ok((await sharp(uploaded).metadata()).exif?.includes(GPS_TAG_LE), 'the fixture really does carry a GPS block');

    const cookie = await f.signIn('Jirka');
    const res = await f.profile(cookie, { image: dataUri(uploaded) });
    assert.equal(res.status, 200, 'the photo is accepted');
    assert.match((await res.json()).identity.avatar, /^\/api\/avatar\/printer-[0-9a-f]{16}\.webp$/, 'and answered as a URL, not a path');

    const stored = f.storedBytes('printer');
    assert.ok(stored, 'a file landed on disk');
    const meta = await sharp(stored).metadata();
    assert.equal(meta.exif, undefined, 'the stored photo carries no EXIF at all — GPS included');
    assert.ok(!stored.includes(GPS_TAG_LE), 'and no GPS block survives anywhere in the bytes');
    assert.equal(meta.format, 'webp', 'it was re-encoded to the format the server chose');
    assert.ok(meta.width <= 256 && meta.height <= 256, 'and to the size the server chose');

    // The whole guarantee in one line: what is on disk is not what was uploaded.
    assert.ok(!stored.equals(uploaded), 'the stored bytes are not the uploaded bytes');
  } finally {
    f.cleanup();
  }
});

test('a payload over the cap is refused while it is being read, not after it is buffered', async () => {
  const f = await studio();
  try {
    const cookie = await f.signIn('Jirka');
    // Deliberately UNTERMINATED JSON, and larger than the cap. If the server buffered the body and
    // checked the size afterwards it would have to parse this and answer "not valid JSON"; because
    // the cap is applied by the reader, it never gets that far and answers "too large" instead.
    const oversized = `{"image":"${'A'.repeat(AVATAR_BODY_LIMIT + 512 * 1024)}`;
    const res = await f.profile(cookie, oversized, true);
    // 413, not the blanket 409 every other refusal in this dispatcher answers: "your photo is too
    // big" is a different thing from "the studio refused that", and the person uploading a 4 MB phone
    // photo is the one who has to be able to tell them apart. The 413 branch beside it in avatar.js
    // could never fire on its own (it compared decoded bytes against the REQUEST cap), so this
    // reader-side refusal is the only path that reaches the operator — it has to carry the status.
    assert.equal(res.status, 413, 'the oversized upload is refused as too large, with the status that says so');
    const refusal = await res.json();
    assert.equal(refusal.code, 'too-large', 'and with the code the page keys its message off');
    assert.match(refusal.error, /příliš velký/i, 'phrased for the person who chose the file, not for a log');

    assert.equal(f.storedFile('printer'), null, 'nothing was stored');
    assert.ok(!existsSync(avatarsDir(f.dataDir)) || readdirSync(avatarsDir(f.dataDir)).length === 0, 'and no file was written');
  } finally {
    f.cleanup();
  }
});

test('a non-image is refused however loudly it claims to be one', async () => {
  const f = await studio();
  try {
    const cookie = await f.signIn('Jirka');
    // A PDF, announced as a PNG in the data: prefix AND in the request's own Content-Type. Neither
    // claim is consulted: the bytes are handed to the decoder and the decoder is what says no.
    const notAnImage = Buffer.from('%PDF-1.4\nthis is not a photograph\n');
    const res = await fetch(`${f.origin}/api/profile`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'image/png' },
      body: JSON.stringify({ image: dataUri(notAnImage, 'image/png') }),
    });
    assert.equal(res.status, 400, 'refused');
    const body = await res.json();
    assert.equal(body.code, 'bad-image', 'as an unreadable image, not as a server error');
    assert.equal(f.storedFile('printer'), null, 'and nothing reached the disk');
  } finally {
    f.cleanup();
  }
});

test('an SVG is refused: no uploaded markup is ever handed to librsvg', async () => {
  const f = await studio();
  try {
    const cookie = await f.signIn('Jirka');
    // sharp will happily rasterise SVG, which means an uploaded document is PARSED server-side by
    // librsvg — attacker-controlled XML, with an external-reference surface, reachable from a profile
    // page. The allowlist is checked against what libvips says it decoded, not against the data:
    // prefix, so announcing it as a PNG changes nothing.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c33"/></svg>');
    assert.equal((await sharp(svg).metadata()).format, 'svg', 'the fixture really is an SVG sharp would otherwise read');

    const res = await f.profile(cookie, { image: dataUri(svg, 'image/png') });
    assert.equal(res.status, 400, 'refused');
    const body = await res.json();
    assert.equal(body.code, 'bad-format', 'as the wrong FORMAT — not as unreadable bytes, which would be untrue');
    assert.match(body.error, /PNG, JPEG nebo WebP/, 'and the person is told what to upload instead');
    assert.equal(f.storedFile('printer'), null, 'nothing reached the disk');

    // The allowlist is an allowlist: the three raster formats still go through.
    for (const [name, buf] of [
      ['png', await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer()],
      ['jpeg', await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer()],
      ['webp', await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).webp().toBuffer()],
    ]) {
      assert.equal((await f.profile(cookie, { image: dataUri(buf, 'image/png') })).status, 200, `a ${name} upload is still accepted`);
    }
  } finally {
    f.cleanup();
  }
});

test('the avatar route serves the type the SERVER chose, with nosniff, and no path from the URL', async () => {
  const f = await studio();
  try {
    const cookie = await f.signIn('David');
    // Uploaded as a JPEG. What comes back is what the re-encode produced, whatever went in.
    await f.profile(cookie, { image: dataUri(await jpegWithGps()) });
    const file = f.storedFile('operator');

    const res = await f.get(`/api/avatar/${file}`, cookie);
    assert.equal(res.status, 200, 'the stored photo is served back');
    assert.equal(res.headers.get('content-type'), AVATAR_MIME, 'with the type the re-encode chose, not the one that was uploaded');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', 'and no browser may second-guess it');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(f.storedBytes('operator')), 'byte for byte, the stored file');

    // The name is matched against the shape the server generates; anything else is simply not there.
    for (const name of ['..%2Faccounts.json', '..%2F..%2Fpackage.json', 'printer-deadbeef.webp', 'accounts.json']) {
      assert.equal((await f.get(`/api/avatar/${name}`, cookie)).status, 404, `/api/avatar/${name} reaches nothing`);
    }
  } finally {
    f.cleanup();
  }
});

test('a filename or path in the body cannot influence where the file lands', async () => {
  const f = await studio();
  try {
    const cookie = await f.signIn('Jirka');
    const res = await f.profile(cookie, {
      image: dataUri(await jpegWithGps()),
      // Every one of these is ignored: the route reads `username` and `image`, and the name comes
      // from the server. There is no code path by which a caller names a file here.
      filename: '../../evil.webp',
      avatar: '../../../etc/passwd',
      path: '/tmp/evil.webp',
      role: 'operator',
    });
    assert.equal(res.status, 200);

    const file = f.storedFile('printer');
    assert.match(file, /^printer-[0-9a-f]{16}\.webp$/, 'the stored name is the server-generated one');
    assert.deepEqual(readdirSync(avatarsDir(f.dataDir)), [file], 'and it is the only file in the avatars folder');
    assert.ok(!existsSync(join(f.root, 'evil.webp')), 'nothing was written beside the data dir');
    assert.ok(!existsSync(join(f.dataDir, 'evil.webp')), 'or inside it under a name from the body');
  } finally {
    f.cleanup();
  }
});

test('one person cannot change the other person\'s profile', async () => {
  const f = await studio();
  try {
    const jirka = await f.signIn('Jirka');
    // `role` in the body is the obvious attempt, and it is not read at all — the route takes the
    // role off the SESSION, so there is no path here that writes to another account.
    const res = await f.profile(jirka, { role: 'operator', username: 'Ukradeno', image: dataUri(await jpegWithGps()) });
    assert.equal(res.status, 200, 'the request succeeds — for the printer\'s OWN record');

    assert.equal(readAccount(f.dataDir, 'operator').username, 'David', 'the operator\'s name is untouched');
    assert.equal(readAccount(f.dataDir, 'operator').avatar, null, 'and so is the operator\'s photo');
    assert.equal(readAccount(f.dataDir, 'printer').username, 'Ukradeno', 'only the signed-in person changed');

    // And the collision rule from accounts.js applies through this route: two people the markers
    // could not tell apart is not a state the studio will write.
    const clash = await f.profile(jirka, { username: 'david' });
    assert.equal(clash.status, 409, 'a name the other person already answers to is refused');
    assert.equal(readAccount(f.dataDir, 'printer').username, 'Ukradeno', 'and the refusal changed nothing');
  } finally {
    f.cleanup();
  }
});

test('a username change persists, is used at the next sign-in, and the photo survives a restart', async () => {
  const f = await studio();
  try {
    const cookie = await f.signIn('Jirka');
    assert.equal((await f.profile(cookie, { username: 'Jirka Tiskař', image: dataUri(await jpegWithGps()) })).status, 200);
    const file = f.storedFile('printer');
    f.close(); // the process this studio ran in is gone; the disk is not

    // A second server over the same disk: the account file and the photo are both still there, and
    // the new name is what signs in. The password hash is keyed by ROLE, so renaming yourself can
    // never lock you out (KTD1).
    const again = await studio({ root: f.root });
    try {
      const fresh = await again.signIn('Jirka Tiskař');
      const res = await again.get(`/api/avatar/${file}`, fresh);
      assert.equal(res.status, 200, 'the photo survived the restart');
      assert.equal(res.headers.get('content-type'), AVATAR_MIME);

      const state = await (await again.get('/api/state', fresh)).json();
      assert.equal(state.identity.username, 'Jirka Tiskař', 'and the page is told the new name');
      assert.equal(state.identity.avatar, `/api/avatar/${file}`);

      const old = await fetch(`${again.origin}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Jirka', password: PASSWORD }),
      });
      assert.equal(old.status, 401, 'the name he no longer answers to signs nobody in');
    } finally {
      again.close();
    }
  } finally {
    f.cleanup();
  }
});

test('replacing a photo replaces the file; clearing it removes it', async () => {
  const f = await studio();
  try {
    const cookie = await f.signIn('Jirka');
    await f.profile(cookie, { image: dataUri(await jpegWithGps()) });
    const first = f.storedFile('printer');

    await f.profile(cookie, { image: dataUri(await sharp({ create: { width: 40, height: 40, channels: 3, background: '#39c' } }).png().toBuffer(), 'image/png') });
    const second = f.storedFile('printer');
    assert.notEqual(second, first, 'a replacement gets its own name, so no cache can serve the old face');
    assert.deepEqual(readdirSync(avatarsDir(f.dataDir)), [second], 'and the replaced file does not accumulate on the mounted disk');

    assert.equal((await f.profile(cookie, { image: null })).status, 200, 'the photo can be cleared');
    assert.equal(f.storedFile('printer'), null, 'the record forgets it');
    assert.deepEqual(readdirSync(avatarsDir(f.dataDir)), [], 'and the file is gone');
  } finally {
    f.cleanup();
  }
});

test('KTD11 — ungated local mode has no profile to change, and the page does not offer one', async () => {
  const f = await studio({ authEnv: {} }); // no role hashes: the desktop workflow, implicit operator
  try {
    const res = await fetch(`${f.origin}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Kdokoli' }),
    });
    assert.equal(res.status, 409, 'there is no identity to change');
    assert.equal((await res.json()).code, 'ungated');
    assert.equal(readAccount(f.dataDir, 'operator').username, 'David', 'and the account file is untouched');

    const state = await (await f.get('/api/state')).json();
    assert.equal(state.identity.role, 'operator', 'the implicit operator still has a defined identity');
    assert.equal(state.identity.implicit, true, 'flagged as implicit, which is what hides the surface');

    const html = await (await f.get('/')).text();
    assert.match(html, /id="profileBtn"[^>]*hidden/, 'the profile control ships hidden');
    assert.match(html, /profileBtn"\)\.hidden=next\.implicit===true/, 'and stays hidden while the identity is the implicit one');
  } finally {
    f.cleanup();
  }
});
