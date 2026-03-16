import { createClient } from 'npm:@supabase/supabase-js@2.90.1';
import {
  fetchGraphql,
  fetchProductsCount,
  getProductIndex,
  matchesSearch,
  normalizeSearchValue,
  rankSearchResult,
  type EntityType,
  type SearchEntity,
} from './shopify-product-index.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SearchRequest {
  projectId: string;
  query?: string;
  type?: EntityType;
  limit?: number;
  mode?: 'search' | 'index';
  includeCounts?: boolean;
  forceRefresh?: boolean;
}

function buildShopifySearchQuery(rawQuery: string): string {
  const tokens = normalizeSearchValue(rawQuery)
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
    .map((token) => token.replace(/\*/g, ''));

  if (tokens.length === 0) return '';

  return tokens
    .map((token) => `(title:*${token}* OR handle:*${token}*)`)
    .join(' AND ');
}

function parseDomain(rawDomain: string | null | undefined): string {
  return String(rawDomain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function dedupeEntities(entities: SearchEntity[], limit: number): SearchEntity[] {
  return Array.from(new Map(entities.map((entity) => [entity.path, entity])).values()).slice(0, limit);
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
        nodes {
          id
          title
          handle
          image {
            url
          }
        }
      }
    }`;

    const result = await fetchGraphql(baseUrl, token, gql, { first: maxItems, query: queryExpr });
    const nodes = result?.data?.collections?.nodes || [];

    return nodes
      .map((node: any): SearchEntity => ({
        id: String(node?.id || node?.handle || crypto.randomUUID()),
        type: 'collection',
        title: String(node?.title || node?.handle || 'Unavngivet kollektion'),
        handle: String(node?.handle || ''),
        path: `/collections/${String(node?.handle || '')}`,
        imageUrl: node?.image?.url || null,
      }))
      .filter((entity) => entity.handle)
      .filter((entity) => matchesSearch(entity, rawQuery));
  }

  const gql = `query SearchPages($first: Int!, $query: String!) {
    pages(first: $first, query: $query) {
      nodes {
        id
        title
        handle
      }
    }
  }`;

  const result = await fetchGraphql(baseUrl, token, gql, { first: maxItems, query: queryExpr });
  const nodes = result?.data?.pages?.nodes || [];

  return nodes
    .map((node: any): SearchEntity => ({
      id: String(node?.id || node?.handle || crypto.randomUUID()),
      type: 'page',
      title: String(node?.title || node?.handle || 'Unavngivet side'),
      handle: String(node?.handle || ''),
      path: `/pages/${String(node?.handle || '')}`,
      imageUrl: null,
    }))
    .filter((entity) => entity.handle)
    .filter((entity) => matchesSearch(entity, rawQuery));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const {
      projectId,
      query = '',
      type,
      limit,
      mode = 'search',
      includeCounts = false,
      forceRefresh = false,
    }: SearchRequest = await req.json();

    const trimmedQuery = query.trim();

    if (!projectId) {
      return new Response(JSON.stringify({ success: false, error: 'projectId required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (mode !== 'index' && !trimmedQuery) {
      return new Response(JSON.stringify({ success: false, error: 'query required in search mode' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: project, error: projectError } = await serviceClient
      .from('projects')
      .select('id, user_id, shopify_store_domain, shopify_access_token_encrypted')
      .eq('id', projectId)
      .maybeSingle();

    if (projectError || !project) {
      return new Response(JSON.stringify({ success: false, error: 'Project not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (project.user_id !== user.id) {
      return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const domain = parseDomain(project.shopify_store_domain);
    const token = String(project.shopify_access_token_encrypted || '').trim();

    if (!domain || !token) {
      return new Response(JSON.stringify({ success: false, error: 'Shopify not connected' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const baseUrl = `https://${domain}/admin/api/2025-01`;
    const targetTypes: EntityType[] = type ? [type] : ['product', 'collection', 'page'];
    const maxItems = mode === 'index'
      ? Math.min(Math.max(limit ?? 3000, 1), 5000)
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
          .filter((entity) => matchesSearch(entity, trimmedQuery))
          .map((entity) => ({ entity, score: rankSearchResult(entity, trimmedQuery) }))
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
            const extra = await searchCollectionsOrPages(
              baseUrl,
              token,
              searchExpr,
              entityType,
              maxItems,
              trimmedQuery,
            );
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
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
