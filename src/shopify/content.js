// The Shopify WRITE seam for the blog: create an article as an UNPUBLISHED draft, and list the store's
// blogs so David can pick a target. Kept in its own file so the read-only orders path (adminClient.js)
// is never touched by a write scope. Uses the content token (write_content) — a wider credential than
// the orders token — sent only as the X-Shopify-Access-Token header to the store's own admin endpoint,
// never logged.
//
// Load-bearing invariant: createArticleDraft ALWAYS sends isPublished:false. There is no publish-live
// path here on purpose — nothing the blog writes goes public without David hitting Publish in Shopify.

export class ShopifyContentError extends Error {
  constructor(message, code = 'unknown') {
    super(message);
    this.name = 'ShopifyContentError';
    this.code = code;
    this.seam = 'shopify-content';
  }
}

/** SEO title/description live in the theme-standard metafields Shopify reads for the <title>/<meta>. */
function seoMetafields(post) {
  const mf = [];
  if (post.seoTitle) mf.push({ namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: post.seoTitle });
  if (post.metaDescription) mf.push({ namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: post.metaDescription });
  return mf;
}

/** Build the ArticleCreateInput for a draft. Pure, so a test can assert the shape (esp. isPublished). */
export function buildArticleInput({ blogId, post, author }) {
  const input = {
    blogId,
    title: post.seoTitle || post.topic?.title || 'Bez názvu',
    body: post.bodyHtml || '',
    isPublished: false, // INVARIANT: always a draft
    author: { name: author || 'Fotomalovánky' },
  };
  if (post.metaDescription) input.summary = post.metaDescription;
  if (post.handle) input.handle = post.handle;
  if (Array.isArray(post.tags) && post.tags.length) input.tags = post.tags;
  if (post.heroImage && /^https?:\/\//.test(post.heroImage)) input.image = { url: post.heroImage, altText: post.heroAlt || '' };
  const metafields = seoMetafields(post);
  if (metafields.length) input.metafields = metafields;
  return input;
}

/**
 * The update input: everything buildArticleInput carries EXCEPT isPublished.
 *
 * Leaving the publish state out is the whole point. Sending isPublished:false on an update would
 * silently UNPUBLISH an article David had already published — the create-time invariant ("never go
 * live from here") would become "quietly take live things down". An update only ever rewrites words.
 */
export function buildArticleUpdateInput({ blogId, post, author }) {
  const { isPublished, ...rest } = buildArticleInput({ blogId, post, author });
  return rest;
}

const BLOGS_QUERY = `query { blogs(first: 50) { edges { node { id title handle } } } }`;
const ARTICLE_CREATE = `
  mutation articleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id handle title isPublished }
      userErrors { field message }
    }
  }`;
const ARTICLE_UPDATE = `
  mutation articleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id handle title isPublished }
      userErrors { field message }
    }
  }`;
// The lookup goes through the TOP-LEVEL articles connection: Blog.articles takes only pagination
// arguments, no `query`, so filtering has to happen here and the blog is matched on the node.
const ARTICLE_BY_HANDLE = `
  query articleByHandle($q: String!) {
    articles(first: 20, query: $q) {
      edges { node { id handle title isPublished blog { id } } }
    }
  }`;

/** A content client bound to one store + content token. `fetchImpl` injected so tests never hit the wire. */
export function createContentClient({ storeDomain, contentToken, apiVersion = '2026-07', fetchImpl = fetch }) {
  if (!storeDomain) throw new ShopifyContentError('storeDomain is required (e.g. aqi8it-7n.myshopify.com).', 'not-configured');
  if (!contentToken) throw new ShopifyContentError('A content token with write_content is required.', 'not-configured');
  const endpoint = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;

  async function graphql(query, variables = {}) {
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': contentToken },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new ShopifyContentError(`Admin API request failed: ${err.message}`, 'network');
    }
    if (!res.ok) {
      if (res.status === 429) throw new ShopifyContentError('Admin API throttled (HTTP 429) — back off and retry.', 'throttled');
      if (res.status === 401 || res.status === 403) throw new ShopifyContentError('Content token rejected — check the write_content scope.', 'auth');
      throw new ShopifyContentError(`Admin API returned HTTP ${res.status}.`, 'http');
    }
    const body = await res.json();
    if (body.errors?.length) {
      const denied = body.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED');
      const msg = body.errors.map((e) => e.message).join('; ');
      throw new ShopifyContentError(denied ? `Chybí oprávnění write_content: ${msg}` : `Admin API error: ${msg}`, denied ? 'scope' : 'api');
    }
    return body.data;
  }

  /** The store's blogs ([{ id, title, handle }]) so the UI can pick where the article lands. */
  async function listBlogs() {
    const data = await graphql(BLOGS_QUERY);
    return (data?.blogs?.edges ?? []).map((e) => e.node);
  }

  /** Create the post as an UNPUBLISHED article in `blogId`. Returns the created article node. Surfaces
   *  a taken handle (or any userError) as a clear error so David can tweak the slug — never mangles it. */
  async function createArticleDraft({ blogId, post, author }) {
    if (!blogId) throw new ShopifyContentError('blogId is required — pick a target blog first.', 'bad-input');
    const article = buildArticleInput({ blogId, post, author });
    const data = await graphql(ARTICLE_CREATE, { article });
    const result = data?.articleCreate;
    const errs = result?.userErrors ?? [];
    if (errs.length) {
      const handleTaken = errs.some((e) => (e.field ?? []).includes('handle'));
      throw new ShopifyContentError(errs.map((e) => e.message).join('; '), handleTaken ? 'handle-taken' : 'user-error');
    }
    if (!result?.article?.id) throw new ShopifyContentError('Shopify nevrátil vytvořený článek.', 'api');
    return result.article;
  }

  /** The article in `blogId` whose handle matches exactly, or null. The connection query is a search,
   *  not a lookup, so the exact match is re-checked here rather than trusting the first hit. */
  async function findArticleByHandle({ blogId, handle }) {
    if (!blogId || !handle) return null;
    const data = await graphql(ARTICLE_BY_HANDLE, { q: `handle:${handle}` });
    const nodes = (data?.articles?.edges ?? []).map((e) => e.node);
    // `query:` is a search, so the exact handle is re-checked, and the blog is matched too: the same
    // handle can legitimately exist in another blog and that article is not ours to overwrite.
    return nodes.find((n) => n.handle === handle && n.blog?.id === blogId) ?? null;
  }

  /** Rewrite an existing article's words in place. Never touches its publish state — see
   *  buildArticleUpdateInput. Returns the updated article node. */
  async function updateArticleDraft({ articleId, blogId, post, author }) {
    if (!articleId) throw new ShopifyContentError('articleId is required to update an article.', 'bad-input');
    const article = buildArticleUpdateInput({ blogId, post, author });
    const data = await graphql(ARTICLE_UPDATE, { id: articleId, article });
    const result = data?.articleUpdate;
    const errs = result?.userErrors ?? [];
    if (errs.length) throw new ShopifyContentError(errs.map((e) => e.message).join('; '), 'user-error');
    if (!result?.article?.id) throw new ShopifyContentError('Shopify nevrátil upravený článek.', 'api');
    return result.article;
  }

  /**
   * Save the post to Shopify without ever making a second copy of it: update the article that already
   * carries this handle, or create it as a draft if there is none.
   *
   * Worth the lookup because the local store's `shopifyArticleId` is not trustworthy on its own —
   * regenerating a draft resets it to null, and then a blind create either 409s on the taken handle or,
   * with a tweaked slug, leaves two articles saying nearly the same thing. The store is the source of
   * truth for what exists; our record is only a cache of it.
   *
   * @returns {{article: object, action: 'created'|'updated'}}
   */
  async function saveArticleDraft({ blogId, post, author }) {
    if (!blogId) throw new ShopifyContentError('blogId is required — pick a target blog first.', 'bad-input');
    const existing = await findArticleByHandle({ blogId, handle: post?.handle });
    if (existing) {
      return { article: await updateArticleDraft({ articleId: existing.id, blogId, post, author }), action: 'updated' };
    }
    return { article: await createArticleDraft({ blogId, post, author }), action: 'created' };
  }

  return { listBlogs, createArticleDraft, findArticleByHandle, updateArticleDraft, saveArticleDraft };
}
