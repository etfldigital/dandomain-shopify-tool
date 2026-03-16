export type EntityType = 'product' | 'collection' | 'page';

export interface SearchEntity {
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

const PRODUCT_INDEX_CACHE_TTL_MS = 5 * 60 * 1000;

function getProductIndexCache(): Map<string, ProductIndexCacheEntry> {
  const globalState = globalThis as typeof globalThis & {
    __shopifyProductIndexCache?: Map<string, ProductIndexCacheEntry>;
  };

  if (!globalState.__shopifyProductIndexCache) {
    globalState.__shopifyProductIndexCache = new Map<string, ProductIndexCacheEntry>();
  }

  return globalState.__shopifyProductIndexCache;
}

export function normalizeSearchValue(value: string): string {
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

  return Array.from(new Set(normalized.split(' ').filter((token) => token.length >= 2)));
}

export function matchesSearch(entity: SearchEntity, query: string): boolean {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return true;

  const title = normalizeSearchValue(entity.title);
  const handle = normalizeSearchValue(entity.handle.replace(/-/g, ' '));

  return tokens.every((token) => title.includes(token) || handle.includes(token));
}

export function rankSearchResult(entity: SearchEntity, query: string): number {
  const normalizedQuery = normalizeSearchValue(query);
  const tokens = tokenizeSearchQuery(query);
  if (!normalizedQuery || tokens.length === 0) return 0;

  const normalizedTitle = normalizeSearchValue(entity.title);
  const normalizedHandle = normalizeSearchValue(entity.handle.replace(/-/g, ' '));

  let score = 0;

  if (normalizedTitle === normalizedQuery || normalizedHandle === normalizedQuery) {
    score += 200;
  } else if (normalizedTitle.includes(normalizedQuery) || normalizedHandle.includes(normalizedQuery)) {
    score += 120;
  }

  const matchedTokens = tokens.reduce((count, token) => {
    if (normalizedTitle.includes(token) || normalizedHandle.includes(token)) {
      return count + 1;
    }
    return count;
  }, 0);

  score += matchedTokens * 30;

  if (entity.handle.startsWith(normalizedQuery.replace(/\s+/g, '-'))) {
    score += 20;
  }

  return score;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 10000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchGraphql(
  baseUrl: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<any> {
  const response = await fetchWithTimeout(`${baseUrl}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  }, 12000);

  if (response.status === 429) {
    throw new Error('Shopify rate limit');
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Shopify API error (${response.status}): ${text}`);
  }

  const data = JSON.parse(text);
  if (data.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data;
}

async function fetchAllProductsIndex(baseUrl: string, token: string): Promise<SearchEntity[]> {
  const query = `query FetchAllProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
        handle
        featuredImage {
          url
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

  const entities: SearchEntity[] = [];
  let hasNextPage = true;
  let after: string | null = null;

  while (hasNextPage) {
    const result = await fetchGraphql(baseUrl, token, query, {
      first: 250,
      after,
    });

    const connection = result?.data?.products;
    const nodes = connection?.nodes || [];

    for (const node of nodes) {
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

export async function getProductIndex(
  baseUrl: string,
  token: string,
  forceRefresh = false,
): Promise<SearchEntity[]> {
  const cacheKey = `${baseUrl}|${token}`;
  const cache = getProductIndexCache();
  const now = Date.now();

  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.entities;
    }
  }

  const entities = await fetchAllProductsIndex(baseUrl, token);
  cache.set(cacheKey, {
    entities,
    expiresAt: now + PRODUCT_INDEX_CACHE_TTL_MS,
  });

  return entities;
}

export async function fetchProductsCount(baseUrl: string, token: string): Promise<number> {
  const result = await fetchGraphql(baseUrl, token, '{ productsCount { count } }', {});
  return Number(result?.data?.productsCount?.count || 0);
}
