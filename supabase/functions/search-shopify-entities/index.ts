import { createClient } from 'npm:@supabase/supabase-js@2.90.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Types ──────────────────────────────────────────────────────────────

type EntityType = 'product' | 'collection' | 'page';

interface SearchEntity {
  id: string;
  type: EntityType;
  title: string;
  handle: string;
  path: string;
  imageUrl: string | null;
}

interface ProductIndexCacheEntry {
  entities: SearchEntity[];
  expiresAt: number;
}

interface SearchRequest {
  projectId: string;
  query?: string;
  type?: EntityType;
  limit?: number;
  mode?: 'search' | 'index';
  includeCounts?: boolean;
  forceRefresh?: boolean;
}

// ── Cache ──────────────────────────────────────────────────────────────

const PRODUCT_INDEX_CACHE_TTL_MS = 5 * 60 * 1000;

function getProductIndexCache(): Map<string, ProductIndexCacheEntry> {
  const g = globalThis as typeof globalThis & {
    __shopifyProductIndexCache?: Map<string, ProductIndexCacheEntry>;
  };
  if (!g.__shopifyProductIndexCache) {
    g.__shopifyProductIndexCache = new Map();
  }
  return g.__shopifyProductIndexCache;
}

// ── Helpers ────────────────────────────────────────────────────────────

function normalizeSearchValue(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalizeSearchValue(query);
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(' ').filter((t) => t.length >= 2)));
}

function matchesSearch(entity: SearchEntity, query: string): boolean {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return true;
  const title = normalizeSearchValue(entity.title);
  const handle = normalizeSearchValue(entity.handle.replace(/-/g, ' '));
  return tokens.every((t) => title.includes(t) || handle.includes(t));
}

function rankSearchResult(entity: SearchEntity, query: string): number {
  const nq = normalizeSearchValue(query);
  const tokens = tokenizeSearchQuery(query);
  if (!nq || tokens.length === 0) return 0;

  const nt = normalizeSearchValue(entity.title);
  const nh = normalizeSearchValue(entity.handle.replace(/-/g, ' '));
  let score = 0;

  if (nt === nq || nh === nq) score += 200;
  else if (nt.includes(nq) || nh.includes(nq)) score += 120;

  const matched = tokens.reduce((c, t) => (nt.includes(t) || nh.includes(t) ? c + 1 : c), 0);
  score += matched * 30;

  if (entity.handle.startsWith(nq.replace(/\s+/g, '-'))) score += 20;
  return score;
}

// ── Shopify GraphQL ────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(tid);
  }
}

async function fetchGraphql(
  baseUrl: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  retries = 3,
): Promise<any> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      }, 30000);

      if (response.status === 429) {
        // Rate limited — wait and retry
        const retryAfter = Math.min(Number(response.headers.get('Retry-After') || '2'), 10);
        await response.text(); // consume body
        if (attempt < retries) {
          console.warn(`Shopify rate limit, retrying in ${retryAfter}s (attempt ${attempt + 1}/${retries})`);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          continue;
        }
        throw new Error('Shopify rate limit exceeded after retries');
      }

      if (response.status === 503 || response.status === 502 || response.status === 504) {
        const text = await response.text();
        if (attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000;
          console.warn(`Shopify ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(`Shopify API error (${response.status}): ${text}`);
      }

      const text = await response.text();
      if (!response.ok) throw new Error(`Shopify API error (${response.status}): ${text}`);
      const data = JSON.parse(text);
      if (data.errors?.length) {
        // Check if it's a SERVICE_UNAVAILABLE error that we can retry
        const isServiceUnavailable = data.errors.some((e: any) => e.extensions?.code === 'SERVICE_UNAVAILABLE');
        if (isServiceUnavailable && attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000;
          console.warn(`Shopify SERVICE_UNAVAILABLE, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
      }
      return data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isAbort = lastError.name === 'AbortError' || lastError.message.includes('signal has been aborted');
      if ((isAbort || lastError.message.includes('fetch')) && attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`Fetch error (${lastError.message}), retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error('fetchGraphql failed');
}

// ── Product index (paginated) ──────────────────────────────────────────

async function fetchAllProductsIndex(baseUrl: string, token: string): Promise<SearchEntity[]> {
  const query = `query FetchAllProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes { id title handle featuredImage { url } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

  const entities: SearchEntity[] = [];
  let hasNextPage = true;
  let after: string | null = null;

  while (hasNextPage) {
    const result = await fetchGraphql(baseUrl, token, query, { first: 250, after });
    const connection = result?.data?.products;
    for (const node of connection?.nodes || []) {
      const handle = String(node?.handle || '');
      if (!handle) continue;
      entities.push({
        id: String(node?.id || handle || crypto.randomUUID()),
        type: 'product',
        title: String(node?.title || handle || 'Unavngivet produkt'),
        handle,
        path: `/products/${handle}`,
        imageUrl: node?.featuredImage?.url || null,
      });
    }
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = connection?.pageInfo?.endCursor || null;
  }
  return entities;
}

async function getProductIndex(baseUrl: string, token: string, forceRefresh = false): Promise<SearchEntity[]> {
  const cacheKey = `${baseUrl}|${token}`;
  const cache = getProductIndexCache();
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.entities;
  }
  const entities = await fetchAllProductsIndex(baseUrl, token);
  cache.set(cacheKey, { entities, expiresAt: Date.now() + PRODUCT_INDEX_CACHE_TTL_MS });
  return entities;
}

async function fetchProductsCount(baseUrl: string, token: string): Promise<number> {
  const result = await fetchGraphql(baseUrl, token, '{ productsCount { count } }', {});
  return Number(result?.data?.productsCount?.count || 0);
}

// ── Search helpers ─────────────────────────────────────────────────────

function buildShopifySearchQuery(rawQuery: string): string {
  const tokens = normalizeSearchValue(rawQuery)
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => t.replace(/\*/g, ''));
  if (tokens.length === 0) return '';
  return tokens.map((t) => `(title:*${t}* OR handle:*${t}*)`).join(' AND ');
}

function escapeShopifyQueryValue(value: string): string {
  return value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildProductLiveQueries(rawQuery: string): string[] {
  const normalized = normalizeSearchValue(rawQuery);
  const tokens = normalized.split(' ').filter(Boolean).slice(0, 6);
  const plain = escapeShopifyQueryValue(rawQuery);
  const normalizedPlain = escapeShopifyQueryValue(normalized);
  const queryExpr = buildShopifySearchQuery(rawQuery);

  return Array.from(new Set([
    queryExpr,
    plain,
    normalizedPlain,
    tokens.join(' AND '),
    tokens.map((t) => `${t}*`).join(' '),
  ].filter((q) => q && q.length >= 2)));
}

function mapProductNodeToEntity(node: any): SearchEntity | null {
  const handle = String(node?.handle || '');
  if (!handle) return null;

  return {
    id: String(node?.id || handle || crypto.randomUUID()),
    type: 'product',
    title: String(node?.title || handle || 'Unavngivet produkt'),
    handle,
    path: `/products/${handle}`,
    imageUrl: node?.featuredImage?.url || null,
  };
}

async function searchProductsLive(
  baseUrl: string,
  token: string,
  rawQuery: string,
  maxItems: number,
): Promise<SearchEntity[]> {
  const gql = `query SearchProducts($first: Int!, $query: String!) {
    products(first: $first, query: $query, sortKey: RELEVANCE) {
      nodes { id title handle featuredImage { url } }
    }
  }`;

  const queries = buildProductLiveQueries(rawQuery);
  const byPath = new Map<string, SearchEntity>();

  for (const queryExpr of queries) {
    try {
      const result = await fetchGraphql(baseUrl, token, gql, {
        first: Math.min(Math.max(maxItems, 10), 100),
        query: queryExpr,
      });

      for (const node of result?.data?.products?.nodes || []) {
        const entity = mapProductNodeToEntity(node);
        if (entity) byPath.set(entity.path, entity);
      }

      if (byPath.size >= maxItems) break;
    } catch (error) {
      console.warn(`Live product query failed for "${queryExpr}":`, error);
    }
  }

  const candidates = Array.from(byPath.values());
  const strictMatches = candidates.filter((e) => matchesSearch(e, rawQuery));
  const matchesToRank = strictMatches.length > 0 ? strictMatches : candidates;

  return matchesToRank
    .map((e) => ({ entity: e, score: rankSearchResult(e, rawQuery) }))
    .sort((a, b) => b.score - a.score || a.entity.title.localeCompare(b.entity.title))
    .slice(0, maxItems)
    .map((item) => item.entity);
}

function parseDomain(rawDomain: string | null | undefined): string {
  return String(rawDomain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function dedupeEntities(entities: SearchEntity[], limit: number): SearchEntity[] {
  return Array.from(new Map(entities.map((e) => [e.path, e])).values()).slice(0, limit);
}

async function searchCollectionsOrPages(
  baseUrl: string,
  token: string,
  queryExpr: string,
  entityType: Extract<EntityType, 'collection' | 'page'>,
  maxItems: number,
  rawQuery: string,
): Promise<SearchEntity[]> {
  if (entityType === 'collection') {
    const gql = `query SearchCollections($first: Int!, $query: String!) {
      collections(first: $first, query: $query) {
        nodes { id title handle image { url } }
      }
    }`;
    const result = await fetchGraphql(baseUrl, token, gql, { first: maxItems, query: queryExpr });
    return (result?.data?.collections?.nodes || [])
      .map((n: any): SearchEntity => ({
        id: String(n?.id || n?.handle || crypto.randomUUID()),
        type: 'collection',
        title: String(n?.title || n?.handle || 'Unavngivet kollektion'),
        handle: String(n?.handle || ''),
        path: `/collections/${String(n?.handle || '')}`,
        imageUrl: n?.image?.url || null,
      }))
      .filter((e: SearchEntity) => e.handle)
      .filter((e: SearchEntity) => matchesSearch(e, rawQuery));
  }

  const gql = `query SearchPages($first: Int!, $query: String!) {
    pages(first: $first, query: $query) { nodes { id title handle } }
  }`;
  const result = await fetchGraphql(baseUrl, token, gql, { first: maxItems, query: queryExpr });
  return (result?.data?.pages?.nodes || [])
    .map((n: any): SearchEntity => ({
      id: String(n?.id || n?.handle || crypto.randomUUID()),
      type: 'page',
      title: String(n?.title || n?.handle || 'Unavngivet side'),
      handle: String(n?.handle || ''),
      path: `/pages/${String(n?.handle || '')}`,
      imageUrl: null,
    }))
    .filter((e: SearchEntity) => e.handle)
    .filter((e: SearchEntity) => matchesSearch(e, rawQuery));
}

// ── Main handler ───────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const {
      projectId, query = '', type, limit,
      mode = 'search', includeCounts = false, forceRefresh = false,
    }: SearchRequest = await req.json();

    const trimmedQuery = query.trim();

    if (!projectId) {
      return new Response(JSON.stringify({ success: false, error: 'projectId required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (mode !== 'index' && !trimmedQuery) {
      return new Response(JSON.stringify({ success: false, error: 'query required in search mode' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      throw new Error('Missing backend configuration');
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: project, error: projectError } = await serviceClient
      .from('projects')
      .select('id, user_id, shopify_store_domain, shopify_access_token_encrypted')
      .eq('id', projectId)
      .maybeSingle();

    if (projectError || !project) {
      return new Response(JSON.stringify({ success: false, error: 'Project not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (project.user_id !== user.id) {
      return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const domain = parseDomain(project.shopify_store_domain);
    const token = String(project.shopify_access_token_encrypted || '').trim();

    if (!domain || !token) {
      return new Response(JSON.stringify({ success: false, error: 'Shopify not connected' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const baseUrl = `https://${domain}/admin/api/2025-01`;
    const targetTypes: EntityType[] = type ? [type] : ['product', 'collection', 'page'];
    const maxItems = mode === 'index'
      ? Math.min(Math.max(limit ?? 20000, 1), 20000)
      : Math.min(Math.max(limit ?? 25, 1), 100);

    let indexedProductCount: number | null = null;
    let shopifyProductsCount: number | null = null;
    const entities: SearchEntity[] = [];

    if (targetTypes.includes('product')) {
      const productIndex = await getProductIndex(baseUrl, token, forceRefresh);
      indexedProductCount = productIndex.length;

      if (mode === 'index') {
        entities.push(...productIndex.slice(0, maxItems));
      } else {
        const productMatches = productIndex
          .filter((e) => matchesSearch(e, trimmedQuery))
          .map((e) => ({ entity: e, score: rankSearchResult(e, trimmedQuery) }))
          .sort((a, b) => b.score - a.score || a.entity.title.localeCompare(b.entity.title))
          .slice(0, maxItems)
          .map((item) => item.entity);
        entities.push(...productMatches);
      }

      if (includeCounts || mode === 'index') {
        try {
          shopifyProductsCount = await fetchProductsCount(baseUrl, token);
        } catch (countError) {
          console.warn('Failed to fetch Shopify product count:', countError);
        }
      }
    }

    if (mode !== 'index') {
      const searchExpr = buildShopifySearchQuery(trimmedQuery);
      if (searchExpr) {
        for (const entityType of targetTypes) {
          if (entityType === 'collection' || entityType === 'page') {
            const extra = await searchCollectionsOrPages(baseUrl, token, searchExpr, entityType, maxItems, trimmedQuery);
            entities.push(...extra);
          }
        }
      }
    }

    const deduped = dedupeEntities(entities, maxItems);

    return new Response(JSON.stringify({
      success: true,
      entities: deduped,
      meta: {
        indexedProducts: indexedProductCount,
        shopifyProducts: shopifyProductsCount,
        indexComplete:
          indexedProductCount !== null && shopifyProductsCount !== null
            ? indexedProductCount === shopifyProductsCount
            : null,
      },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('search-shopify-entities error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
