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

const BLOGS_QUERY = `query { blogs(first: 50) { edges { node { id title handle } } } }`;
const ARTICLE_CREATE = `
  mutation articleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id handle title isPublished }
      userErrors { field message }
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

  return { listBlogs, createArticleDraft };
}
