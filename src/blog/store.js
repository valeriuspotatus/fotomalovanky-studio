// File-based persistence for blog drafts, under config.blog.dataDir (outside the repo — like the
// creatives/autopilot stores). One JSON file per post in posts/<id>.json plus a blog-index.json of
// summaries the list view reads without opening every file. Same last-write-wins shape as the
// creatives index. No network.

import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';

export const INDEX_FILE = 'blog-index.json';
const POSTS_DIR = 'posts';

/** A post id is a URL slug; reject anything else so a crafted id can't escape the posts folder. */
export function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,120}$/.test(id);
}

function postPath(dataDir, id) {
  return join(dataDir, POSTS_DIR, `${id}.json`);
}

/** The whole index ({ updatedAt, posts: { id: summary } }). Missing/corrupt → empty. */
export function readIndex(dataDir) {
  const path = join(dataDir, INDEX_FILE);
  if (!existsSync(path)) return { updatedAt: null, posts: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && parsed.posts ? parsed : { updatedAt: null, posts: {} };
  } catch {
    return { updatedAt: null, posts: {} };
  }
}

/** Summaries for the list view, newest-updated first. */
export function listPosts(dataDir) {
  return Object.values(readIndex(dataDir).posts).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** One full post, or null if it doesn't exist / is unreadable. */
export function readPost(dataDir, id) {
  if (!isValidId(id)) return null;
  const path = postPath(dataDir, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function summary(post) {
  return {
    id: post.id,
    seoTitle: post.seoTitle,
    keyword: post.topic?.keyword ?? '',
    source: post.topic?.source ?? 'manual',
    status: post.status ?? 'koncept',
    hasHero: Boolean(post.heroImage),
    warnings: post.qc?.warnings?.length ?? 0,
    createdAt: post.createdAt ?? null,
    updatedAt: post.updatedAt ?? null,
  };
}

/** Upsert a post (by its id). Stamps createdAt once and updatedAt every save; merges its summary into
 *  the index. `now` is injectable so tests are deterministic. Returns the stored post. */
export function savePost(dataDir, post, now = new Date()) {
  if (!post || !isValidId(post.id)) throw new Error('savePost needs a post with a valid slug id.');
  mkdirSync(join(dataDir, POSTS_DIR), { recursive: true });
  const existing = readPost(dataDir, post.id);
  const iso = now.toISOString();
  const stored = { ...post, createdAt: existing?.createdAt ?? post.createdAt ?? iso, updatedAt: iso };
  writeFileSync(postPath(dataDir, post.id), JSON.stringify(stored, null, 2));
  const index = readIndex(dataDir);
  index.posts[stored.id] = summary(stored);
  index.updatedAt = iso;
  writeFileSync(join(dataDir, INDEX_FILE), JSON.stringify(index, null, 2));
  return stored;
}

/** Delete a post and drop it from the index. Idempotent — deleting a missing post is a no-op success. */
export function deletePost(dataDir, id) {
  if (!isValidId(id)) return false;
  rmSync(postPath(dataDir, id), { force: true });
  const index = readIndex(dataDir);
  if (index.posts[id]) {
    delete index.posts[id];
    index.updatedAt = new Date().toISOString();
    writeFileSync(join(dataDir, INDEX_FILE), JSON.stringify(index, null, 2));
  }
  return true;
}
