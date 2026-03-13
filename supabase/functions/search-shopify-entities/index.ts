import { createClient } from 'npm:@supabase/supabase-js@2.90.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type EntityType = 'product' | 'collection' | 'page';

interface SearchRequest {
  projectId: string;
  query: string;
  type?: EntityType;
  limit?: number;
}

interface SearchEntity {
  id: string;
  type: EntityType;
  title: string;
  handle: string;
  path: string;
  imageUrl: string | null;
}

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

function matchesSearch(entity: SearchEntity, query: string): boolean {
  const q = normalizeSearchValue(query);
  if (!q) return true;
  const tokens = q.split(' ').filter(Boolean);
  if (tokens.length === 0) return true;

  const text = `${normalizeSearchValue(entity.title)} ${normalizeSearchValue(entity.handle.replace(/-/g, ' '))}`;
  return tokens.every((token) => text.includes(token));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchGraphql(
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
  }, 10000);

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

    const { projectId, query, type, limit }: SearchRequest = await req.json();
    if (!projectId || !query?.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'projectId and query required' }), {
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

    const { data: { user }, error: userError } = await userClient.auth.getUser();
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

    const domain = String(project.shopify_store_domain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const token = String(project.shopify_access_token_encrypted || '').trim();

    if (!domain || !token) {
      return new Response(JSON.stringify({ success: false, error: 'Shopify not connected' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const targetTypes: EntityType[] = type ? [type] : ['product', 'collection', 'page'];
    const maxItems = Math.min(Math.max(limit ?? 25, 1), 40);
    const searchExpr = buildShopifySearchQuery(query);
    if (!searchExpr) {
      return new Response(JSON.stringify({ success: true, entities: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const baseUrl = `https://${domain}/admin/api/2025-01`;
    const entities: SearchEntity[] = [];

    for (const entityType of targetTypes) {
      if (entityType === 'product') {
        const gql = `query SearchProducts($first: Int!, $query: String!) {
          products(first: $first, query: $query) {
            nodes {
              id
              title
              handle
              featuredImage {
                url
              }
            }
          }
        }`;
        const result = await fetchGraphql(baseUrl, token, gql, { first: maxItems, query: searchExpr });
        const nodes = result?.data?.products?.nodes || [];
        for (const node of nodes) {
          const entity: SearchEntity = {
            id: String(node.id || node.handle || crypto.randomUUID()),
            type: 'product',
            title: String(node.title || node.handle || 'Unavngivet produkt'),
            handle: String(node.handle || ''),
            path: `/products/${String(node.handle || '')}`,
            imageUrl: node?.featuredImage?.url || null,
          };
          if (entity.handle && matchesSearch(entity, query)) entities.push(entity);
        }
      }

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
        const result = await fetchGraphql(baseUrl, token, gql, { first: maxItems, query: searchExpr });
        const nodes = result?.data?.collections?.nodes || [];
        for (const node of nodes) {
          const entity: SearchEntity = {
            id: String(node.id || node.handle || crypto.randomUUID()),
            type: 'collection',
            title: String(node.title || node.handle || 'Unavngivet kollektion'),
            handle: String(node.handle || ''),
            path: `/collections/${String(node.handle || '')}`,
            imageUrl: node?.image?.url || null,
          };
          if (entity.handle && matchesSearch(entity, query)) entities.push(entity);
        }
      }

      if (entityType === 'page') {
        const gql = `query SearchPages($first: Int!, $query: String!) {
          pages(first: $first, query: $query) {
            nodes {
              id
              title
              handle
            }
          }
        }`;
        const result = await fetchGraphql(baseUrl, token, gql, { first: maxItems, query: searchExpr });
        const nodes = result?.data?.pages?.nodes || [];
        for (const node of nodes) {
          const entity: SearchEntity = {
            id: String(node.id || node.handle || crypto.randomUUID()),
            type: 'page',
            title: String(node.title || node.handle || 'Unavngivet side'),
            handle: String(node.handle || ''),
            path: `/pages/${String(node.handle || '')}`,
            imageUrl: null,
          };
          if (entity.handle && matchesSearch(entity, query)) entities.push(entity);
        }
      }
    }

    const deduped = Array.from(new Map(entities.map((e) => [e.path, e])).values()).slice(0, maxItems);

    return new Response(JSON.stringify({ success: true, entities: deduped }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('search-shopify-entities error:', error);
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
