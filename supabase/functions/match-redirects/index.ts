import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface MatchRequest {
  projectId: string;
  oldPaths: string[];
  useAi?: boolean;
}

interface MatchedRedirect {
  old_path: string;
  entity_type: 'product' | 'category' | 'page';
  entity_id: string;
  new_path: string;
  confidence_score: number;
  matched_by: 'exact' | 'external_id' | 'sku' | 'handle' | 'title' | 'ai';
  ai_suggestions?: Array<{
    entity_id: string;
    new_path: string;
    title: string;
    score: number;
  }>;
}

interface UnmatchedUrl {
  old_path: string;
  ai_suggestions: Array<{
    entity_id: string;
    new_path: string;
    title: string;
    score: number;
  }>;
}

interface UploadedEntity {
  id: string;
  source_path: string | null;
  shopify_handle: string;
  entity_type: 'product' | 'category' | 'page';
  title: string;
  sku?: string;
  external_id?: string;
  internal_id?: string;
}

// Normalize path for comparison
function normalizePath(path: string): string {
  let normalized = path.trim().toLowerCase();
  normalized = normalized.replace(/^https?:\/\/[^\/]+/, '');
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// Extract slug from URL path
function extractSlugFromPath(path: string): string {
  const cleanPath = path
    .replace(/^\/shop\//, '')
    .replace(/^\/products\//, '')
    .replace(/^\/collections\//, '')
    .replace(/^\/pages\//, '')
    .replace(/\/$/, '')
    .replace(/\.html$/, '');
  const segments = cleanPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

// Normalize text for comparison (Danish chars, special chars)
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'oe')
    .replace(/[å]/g, 'aa')
    .replace(/[^a-z0-9]/g, '');
}

// Extract potential name from URL slug (removes ID suffix for both products and categories)
function extractProductNameFromSlug(slug: string): string {
  const withoutExtension = slug.replace(/\.html$/, '');
  // Remove product ID suffix: -32129p, -0641p, -10001-0DA-39-40p
  // Remove category ID suffix: -100c1, -42c1, -174s1
  // Remove section suffix: -4s1, -6s1, -7s1
  const withoutId = withoutExtension
    .replace(/-\d+[pP]$/, '')           // product: -32129p
    .replace(/-[\w-]+-[\w-]+[pP]$/, '') // product with complex SKU: -10001-0DA-39-40p  
    .replace(/-\d+[cCsS]\d*$/, '')      // category/section: -100c1, -4s1
    .replace(/-[A-Z0-9]+p$/, '');       // fallback
  return withoutId;
}

// Generate Shopify handle from title
function generateShopifyHandle(title: string): string {
  const handle = title
    .toLowerCase()
    .trim()
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'oe')
    .replace(/[å]/g, 'aa')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 255);

  // Safety check — handle must NEVER contain spaces
  if (handle.includes(' ')) {
    console.error(`[REDIRECT] generateShopifyHandle produced handle with spaces: "${handle}" from title "${title}"`);
    return handle.replace(/\s+/g, '-');
  }
  return handle;
}

// Compute Dice coefficient between two strings
function diceCoefficient(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const getBigrams = (s: string): Set<string> => {
    const bigrams = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      bigrams.add(s.substring(i, i + 2));
    }
    return bigrams;
  };
  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);
  let common = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) common++;
  }
  return (2 * common) / (bigramsA.size + bigramsB.size);
}

// Call Lovable AI for semantic matching
async function callAiForMatching(
  oldPath: string,
  extractedName: string,
  candidates: Array<{ id: string; title: string; handle: string; type: string }>
): Promise<Array<{ entity_id: string; new_path: string; title: string; score: number }>> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  
  if (!LOVABLE_API_KEY) {
    console.warn('LOVABLE_API_KEY not configured, skipping AI matching');
    return [];
  }

  const limitedCandidates = candidates.slice(0, 50);

  const systemPrompt = `Du er en ekspert i at matche gamle DanDomain URLs til Shopify produkter og kollektioner.
Din opgave er at finde det bedste match mellem en gammel URL og en liste af mulige Shopify-destinationer.

REGLER:
1. Analyser produktnavnet/slug i den gamle URL
2. Find det mest sandsynlige match baseret på navnelighed
3. Returner KUN matches der er semantisk relaterede
4. Returner en liste af op til 3 bedste matches med confidence scores (0-100)
5. Hvis intet match er sandsynligt, returner en tom liste

Vær opmærksom på:
- Danske specialtegn (æ, ø, å) konverteres til ae, oe, aa
- Produktnavne kan være forkortet eller modificeret
- SKU-koder kan være del af URL'en`;

  const userPrompt = `Gammel URL: ${oldPath}
Ekstraheret navn: ${extractedName}

Mulige matches:
${limitedCandidates.map((c, i) => `${i + 1}. [${c.type}] "${c.title}" → ${c.handle}`).join('\n')}

Find de bedste matches og returner som JSON array:
[{"index": 1, "score": 85}, {"index": 2, "score": 60}]

Returner KUN JSON array, ingen anden tekst.`;

  try {
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI API error:', response.status, errorText);
      return [];
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    
    if (!content) {
      return [];
    }

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn('Could not parse AI response as JSON:', content);
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{ index: number; score: number }>;
    
    return parsed
      .filter(p => p.index >= 1 && p.index <= limitedCandidates.length && p.score >= 50)
      .map(p => {
        const candidate = limitedCandidates[p.index - 1];
        return {
          entity_id: candidate.id,
          new_path: candidate.handle,
          title: candidate.title,
          score: p.score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  } catch (err) {
    console.error('AI matching error:', err);
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { projectId, oldPaths, useAi } = (await req.json()) as MatchRequest;
    const shouldUseAi = useAi === true;

    if (!projectId || !oldPaths || !Array.isArray(oldPaths)) {
      return new Response(
        JSON.stringify({ error: 'Missing projectId or oldPaths array' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Matching ${oldPaths.length} URLs for project ${projectId} (useAi=${shouldUseAi})`);

    // ── Handle backfill: fetch real Shopify handles for categories missing them ──
    {
      const { data: missingHandles } = await supabase
        .from('canonical_categories')
        .select('id, shopify_collection_id')
        .eq('project_id', projectId)
        .not('shopify_collection_id', 'is', null)
        .is('shopify_handle', null);

      if (missingHandles && missingHandles.length > 0) {
        console.log(`[BACKFILL] ${missingHandles.length} categories missing shopify_handle, fetching from Shopify...`);

        // Get project credentials
        const { data: project } = await supabase
          .from('projects')
          .select('shopify_store_domain, shopify_access_token_encrypted')
          .eq('id', projectId)
          .single();

        if (project?.shopify_store_domain && project?.shopify_access_token_encrypted) {
          const domain = project.shopify_store_domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
          const token = project.shopify_access_token_encrypted;

          // Fetch all smart collections from Shopify (paginated)
          const collectionMap = new Map<string, string>(); // collection_id → handle
          let pageInfo: string | null = null;
          let hasMore = true;

          while (hasMore) {
            const url = pageInfo
              ? `https://${domain}/admin/api/2025-01/smart_collections.json?limit=250&page_info=${pageInfo}`
              : `https://${domain}/admin/api/2025-01/smart_collections.json?limit=250`;

            try {
              const resp = await fetch(url, {
                headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
              });

              if (!resp.ok) {
                console.error(`[BACKFILL] Shopify API error: ${resp.status}`);
                break;
              }

              const data = await resp.json();
              for (const col of data.smart_collections || []) {
                collectionMap.set(String(col.id), String(col.handle || ''));
              }

              // Check Link header for pagination
              const linkHeader = resp.headers.get('link') || '';
              const nextMatch = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
              if (nextMatch) {
                pageInfo = nextMatch[1];
              } else {
                hasMore = false;
              }
            } catch (err) {
              console.error(`[BACKFILL] Fetch error:`, err);
              hasMore = false;
            }
          }

          // Also fetch custom collections
          pageInfo = null;
          hasMore = true;
          while (hasMore) {
            const url = pageInfo
              ? `https://${domain}/admin/api/2025-01/custom_collections.json?limit=250&page_info=${pageInfo}`
              : `https://${domain}/admin/api/2025-01/custom_collections.json?limit=250`;

            try {
              const resp = await fetch(url, {
                headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
              });

              if (!resp.ok) break;

              const data = await resp.json();
              for (const col of data.custom_collections || []) {
                collectionMap.set(String(col.id), String(col.handle || ''));
              }

              const linkHeader = resp.headers.get('link') || '';
              const nextMatch = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
              if (nextMatch) {
                pageInfo = nextMatch[1];
              } else {
                hasMore = false;
              }
            } catch (err) {
              console.error(`[BACKFILL] Custom collections fetch error:`, err);
              hasMore = false;
            }
          }

          console.log(`[BACKFILL] Fetched ${collectionMap.size} collections from Shopify`);

          // Update categories with their real handles
          let backfilled = 0;
          for (const cat of missingHandles) {
            const handle = collectionMap.get(cat.shopify_collection_id!);
            if (handle) {
              await supabase
                .from('canonical_categories')
                .update({ shopify_handle: handle, updated_at: new Date().toISOString() })
                .eq('id', cat.id);
              backfilled++;
            }
          }
          console.log(`[BACKFILL] Updated ${backfilled}/${missingHandles.length} category handles`);
        } else {
          console.warn(`[BACKFILL] No Shopify credentials found for project ${projectId}`);
        }
      }
    }

    // Only include entities that actually exist in Shopify (uploaded with valid IDs)
    const entities: UploadedEntity[] = [];

    // Products — only uploaded with a shopify_id
    const { data: products } = await supabase
      .from('canonical_products')
      .select('id, external_id, data, shopify_id')
      .eq('project_id', projectId)
      .eq('status', 'uploaded')
      .not('shopify_id', 'is', null);

    for (const product of products || []) {
      const data = product.data as Record<string, unknown>;
      const title = (data?.title as string) || '';
      const sku = (data?.sku as string) || '';
      const sourcePath = data?.source_path as string | null;
      const storedHandle = data?.shopify_handle as string | null;
      const handle = storedHandle || generateShopifyHandle(title);
      const internalId = (data?.internal_id as string) || '';

      if (title) {
        entities.push({
          id: product.id,
          source_path: sourcePath,
          shopify_handle: `/products/${handle}`,
          entity_type: 'product',
          title,
          sku,
          external_id: product.external_id,
          internal_id: internalId,
        });
      }
    }

    // Categories — only uploaded with a shopify_collection_id
    const { data: categories } = await supabase
      .from('canonical_categories')
      .select('id, external_id, slug, shopify_collection_id, name, shopify_tag, shopify_handle')
      .eq('project_id', projectId)
      .eq('status', 'uploaded')
      .not('shopify_collection_id', 'is', null);

    for (const category of categories || []) {
      // Use the ACTUAL Shopify handle (stored during upload), not the tag name
      const handle = (category as Record<string, unknown>).shopify_handle as string
        || generateShopifyHandle(category.shopify_tag || category.name);
      const slug = category.slug;
      const extId = category.external_id;
      // Build DanDomain sitemap-style path for matching: /shop/{slug}-{id}c1.html
      const sitemapPath = slug && extId ? `/shop/${slug}-${extId}c1.html` : null;
      const cleanSlugPath = slug ? `/shop/${slug}/` : null;

      if (category.name) {
        entities.push({
          id: category.id,
          source_path: sitemapPath || cleanSlugPath,
          shopify_handle: `/collections/${handle}`,
          entity_type: 'category',
          title: category.name,
          external_id: category.external_id,
        });

        // Also register the clean slug path as an alternative for matching
        if (sitemapPath && cleanSlugPath) {
          const idx = entities.length - 1;
          // We'll add to pathToEntity map below after entities array is complete
          // Store as additional source path
          entities.push({
            id: category.id,
            source_path: cleanSlugPath,
            shopify_handle: `/collections/${handle}`,
            entity_type: 'category',
            title: category.name,
            external_id: category.external_id,
          });
        }
      }
    }

    // Pages — only uploaded with a shopify_id
    const { data: pages } = await supabase
      .from('canonical_pages')
      .select('id, external_id, data, shopify_id')
      .eq('project_id', projectId)
      .eq('status', 'uploaded')
      .not('shopify_id', 'is', null);

    for (const page of pages || []) {
      const data = page.data as Record<string, unknown>;
      const title = (data?.title as string) || '';
      const slug = (data?.slug as string) || '';
      const storedHandle = data?.shopify_handle as string | null;
      const handle = storedHandle || slug || generateShopifyHandle(title);

      if (title) {
        entities.push({
          id: page.id,
          source_path: slug ? `/${slug}` : null,
          shopify_handle: `/pages/${handle}`,
          entity_type: 'page',
          title,
          external_id: page.external_id,
        });
      }
    }

    console.log(`Found ${entities.length} entities for matching (${products?.length || 0} products, ${categories?.length || 0} categories, ${pages?.length || 0} pages)`);

    // Build lookup maps
    const pathToEntity = new Map<string, UploadedEntity>();
    const skuToEntity = new Map<string, UploadedEntity>();
    const normalizedTitleToEntity = new Map<string, UploadedEntity>();

    for (const entity of entities) {
      if (entity.source_path) {
        pathToEntity.set(normalizePath(entity.source_path), entity);
      }
      if (entity.sku) {
        skuToEntity.set(entity.sku.toLowerCase(), entity);
      }
      if (entity.title) {
        const normalized = normalizeForComparison(entity.title);
        if (!normalizedTitleToEntity.has(normalized)) {
          normalizedTitleToEntity.set(normalized, entity);
        }
      }
    }

    // Process each old path
    const matchedRedirects: MatchedRedirect[] = [];
    const unmatchedUrls: UnmatchedUrl[] = [];
    const urlsForAiMatching: Array<{ path: string; extractedName: string }> = [];

    // Separate entities by type for prioritized matching
    const productEntities = entities.filter(e => e.entity_type === 'product');
    const pageEntities = entities.filter(e => e.entity_type === 'page');
    const categoryEntities = entities.filter(e => e.entity_type === 'category');

    for (const oldPath of oldPaths) {
      const normalized = normalizePath(oldPath);
      const slug = extractSlugFromPath(normalized);
      const extractedName = extractProductNameFromSlug(slug);
      const normalizedName = normalizeForComparison(extractedName);

      let matched: UploadedEntity | null = null;
      let matchedBy: MatchedRedirect['matched_by'] = 'exact';
      let confidence = 0;

      // Strategy 1: Exact source_path match (prioritize products)
      for (const entity of productEntities) {
        if (entity.source_path && normalizePath(entity.source_path) === normalized) {
          matched = entity;
          confidence = 100;
          matchedBy = 'exact';
          break;
        }
      }

      if (!matched) {
        for (const entity of pageEntities) {
          if (entity.source_path && normalizePath(entity.source_path) === normalized) {
            matched = entity;
            confidence = 100;
            matchedBy = 'exact';
            break;
          }
        }
      }

      if (!matched) {
        for (const entity of categoryEntities) {
          if (entity.source_path && normalizePath(entity.source_path) === normalized) {
            matched = entity;
            confidence = 100;
            matchedBy = 'exact';
            break;
          }
        }
      }

      // Strategy 1.3: Compare source_path name parts (ignore ID suffixes)
      // DanDomain sitemap URLs and XML source_paths often have the same slug but different IDs
      if (!matched && slug) {
        const urlNamePart = normalizeForComparison(extractProductNameFromSlug(slug));
        if (urlNamePart && urlNamePart.length > 3) {
          for (const entity of entities) {
            if (entity.source_path) {
              const entitySlug = extractSlugFromPath(normalizePath(entity.source_path));
              const entityNamePart = normalizeForComparison(extractProductNameFromSlug(entitySlug));
              if (entityNamePart && entityNamePart === urlNamePart) {
                matched = entity;
                confidence = 96;
                matchedBy = 'exact';
                break;
              }
            }
          }
        }
      }

      // Strategy 1.5: Extract numeric ID from DanDomain URL and match against external_id
      if (!matched) {
        const productIdMatch = normalized.match(/-(\d+)p\.html$/i);
        if (productIdMatch) {
          const dandoId = productIdMatch[1];
          const entity = productEntities.find(e => e.external_id === dandoId);
          if (entity) {
            matched = entity;
            confidence = 98;
            matchedBy = 'external_id';
          }
        }

        if (!matched) {
          const catIdMatch = normalized.match(/-(\d+)[cs]\d*\.html$/i);
          if (catIdMatch) {
            const dandoId = catIdMatch[1];
            const entity = categoryEntities.find(e => e.external_id === dandoId);
            if (entity) {
              // Validate: URL slug should roughly match category name to prevent wrong matches
              const urlSlug = extractProductNameFromSlug(slug);
              const normalizedUrlSlug = normalizeForComparison(urlSlug);
              const normalizedCatName = normalizeForComparison(entity.title);
              
              // Use Dice coefficient to verify slug-to-name similarity (threshold 0.3 = loose match)
              const similarity = diceCoefficient(normalizedUrlSlug, normalizedCatName);
              if (similarity >= 0.3 || normalizedCatName.includes(normalizedUrlSlug) || normalizedUrlSlug.includes(normalizedCatName)) {
                matched = entity;
                confidence = 98;
                matchedBy = 'external_id';
              } else {
                console.log(`[STRATEGY 1.5] Rejected category external_id match: URL slug "${urlSlug}" vs category "${entity.title}" (dice=${similarity.toFixed(2)})`);
              }
            }
          }
        }
      }

      // Strategy 2: SKU-based match (check if SKU appears as distinct segment in URL)
      if (!matched && slug) {
        for (const entity of productEntities) {
          if (entity.sku && entity.sku.length >= 3) {
            const skuLower = entity.sku.toLowerCase();
            const skuPattern = new RegExp(`(?:^|-)${skuLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-|$)`);
            if (skuPattern.test(slug.toLowerCase())) {
              matched = entity;
              confidence = 95;
              matchedBy = 'sku';
              break;
            }
          }
        }
      }

      // Strategy 2.5: Shopify handle matching
      // Extract the slug from the old DanDomain URL, strip the numeric ID suffix,
      // and compare against Shopify handles
      if (!matched && slug) {
        const cleanSlug = extractProductNameFromSlug(slug);
        const normalizedSlug = normalizeForComparison(cleanSlug);

        if (normalizedSlug && normalizedSlug.length > 3) {
          // Try exact handle match first
          for (const entity of entities) {
            const entityHandle = entity.shopify_handle.split('/').pop() || '';
            const normalizedHandle = normalizeForComparison(entityHandle);

            if (normalizedHandle === normalizedSlug) {
              matched = entity;
              confidence = 92;
              matchedBy = 'handle';
              break;
            }
          }

          // Try partial handle match (slug contains handle or vice versa)
          if (!matched) {
            for (const entity of entities) {
              const entityHandle = entity.shopify_handle.split('/').pop() || '';
              const normalizedHandle = normalizeForComparison(entityHandle);

              if (normalizedHandle.length > 5 && normalizedSlug.length > 5) {
                if (normalizedHandle.includes(normalizedSlug) || normalizedSlug.includes(normalizedHandle)) {
                  matched = entity;
                  confidence = 75;
                  matchedBy = 'handle';
                  break;
                }
              }
            }
          }
        }
      }

      // Strategy 3: Exact normalized title match
      if (!matched && normalizedName) {
        for (const entity of productEntities) {
          if (normalizeForComparison(entity.title) === normalizedName) {
            matched = entity;
            confidence = 90;
            matchedBy = 'title';
            break;
          }
        }

        if (!matched) {
          for (const entity of pageEntities) {
            if (normalizeForComparison(entity.title) === normalizedName) {
              matched = entity;
              confidence = 90;
              matchedBy = 'title';
              break;
            }
          }
        }

        if (!matched) {
          for (const entity of categoryEntities) {
            if (normalizeForComparison(entity.title) === normalizedName) {
              matched = entity;
              confidence = 85;
              matchedBy = 'title';
              break;
            }
          }
        }
      }

      // Strategy 4: Partial title match (products only)
      if (!matched && normalizedName && normalizedName.length > 5) {
        for (const entity of productEntities) {
          const entityNormalized = normalizeForComparison(entity.title);
          if (entityNormalized.includes(normalizedName)) {
            matched = entity;
            confidence = 70;
            matchedBy = 'title';
            break;
          }
          if (normalizedName.includes(entityNormalized) && entityNormalized.length > 5) {
            matched = entity;
            confidence = 65;
            matchedBy = 'title';
            break;
          }
        }
      }

      // Strategy 4.5: Fuzzy matching using Dice coefficient
      if (!matched && normalizedName && normalizedName.length > 5) {
        let bestScore = 0;
        let bestEntity: UploadedEntity | null = null;

        for (const entity of entities) {
          const entityNormalized = normalizeForComparison(entity.title);
          if (!entityNormalized || entityNormalized.length < 3) continue;

          const score = diceCoefficient(normalizedName, entityNormalized);

          if (score > bestScore && score >= 0.6) {
            bestScore = score;
            bestEntity = entity;
          }
        }

        if (bestEntity && bestScore >= 0.6) {
          matched = bestEntity;
          confidence = Math.round(bestScore * 80); // 60% Dice = 48, 80% = 64, 100% = 80
          matchedBy = 'title';
        }
      }

      if (matched) {
        matchedRedirects.push({
          old_path: normalized,
          entity_type: matched.entity_type,
          entity_id: matched.id,
          new_path: matched.shopify_handle,
          confidence_score: confidence,
          matched_by: matchedBy,
        });
      } else {
        urlsForAiMatching.push({ path: normalized, extractedName });
      }
    }

    console.log(`Direct matching: ${matchedRedirects.length} matched, ${urlsForAiMatching.length} unmatched after deterministic strategies`);

    if (shouldUseAi) {
      const AI_BATCH_SIZE = 10;
      const candidates = entities.map(e => ({
        id: e.id,
        title: e.title,
        handle: e.shopify_handle,
        type: e.entity_type,
      }));

      for (let i = 0; i < urlsForAiMatching.length; i += AI_BATCH_SIZE) {
        const batch = urlsForAiMatching.slice(i, i + AI_BATCH_SIZE);

        for (const { path, extractedName } of batch) {
          const aiSuggestions = await callAiForMatching(path, extractedName, candidates);

          if (aiSuggestions.length > 0 && aiSuggestions[0].score >= 70) {
            const best = aiSuggestions[0];
            const entity = entities.find(e => e.id === best.entity_id);

            if (entity) {
              matchedRedirects.push({
                old_path: path,
                entity_type: entity.entity_type,
                entity_id: entity.id,
                new_path: entity.shopify_handle,
                confidence_score: best.score,
                matched_by: 'ai',
                ai_suggestions: aiSuggestions.slice(1),
              });
            } else {
              unmatchedUrls.push({
                old_path: path,
                ai_suggestions: aiSuggestions,
              });
            }
          } else {
            unmatchedUrls.push({
              old_path: path,
              ai_suggestions: aiSuggestions,
            });
          }
        }

        if (i + AI_BATCH_SIZE < urlsForAiMatching.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      console.log(`After AI: ${matchedRedirects.length} matched, ${unmatchedUrls.length} unmatched`);
    } else {
      for (const u of urlsForAiMatching) {
        unmatchedUrls.push({ old_path: u.path, ai_suggestions: [] });
      }
      console.log(`AI disabled: ${matchedRedirects.length} matched, ${unmatchedUrls.length} unmatched`);
    }

    // Store results in database
    if (matchedRedirects.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < matchedRedirects.length; i += batchSize) {
        const batch = matchedRedirects.slice(i, i + batchSize);
        const { error } = await supabase
          .from('project_redirects')
          .upsert(
            batch.map(r => ({
              project_id: projectId,
              entity_type: r.entity_type,
              entity_id: r.entity_id,
              old_path: r.old_path,
              new_path: r.new_path,
              confidence_score: r.confidence_score,
              matched_by: r.matched_by,
              ai_suggestions: r.ai_suggestions || [],
              status: 'pending',
            })),
            { onConflict: 'project_id,old_path' }
          );

        if (error) {
          console.error('Error storing matched redirects:', error);
        }
      }
    }

    // Store unmatched with low confidence for manual review
    if (unmatchedUrls.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < unmatchedUrls.length; i += batchSize) {
        const batch = unmatchedUrls.slice(i, i + batchSize);
        const { error } = await supabase
          .from('project_redirects')
          .upsert(
            batch.map(u => ({
              project_id: projectId,
              entity_type: 'product' as const,
              entity_id: '00000000-0000-0000-0000-000000000000',
              old_path: u.old_path,
              new_path: u.ai_suggestions[0]?.new_path || '/not-found',
              confidence_score: u.ai_suggestions[0]?.score || 0,
              matched_by: shouldUseAi ? 'ai' : 'none',
              ai_suggestions: u.ai_suggestions,
              status: 'pending',
            })),
            { onConflict: 'project_id,old_path' }
          );

        if (error) {
          console.error('Error storing unmatched URLs:', error);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        matched: matchedRedirects.length,
        unmatched: unmatchedUrls.length,
        total: oldPaths.length,
        matchedByStrategy: {
          exact: matchedRedirects.filter(r => r.matched_by === 'exact').length,
          external_id: matchedRedirects.filter(r => r.matched_by === 'external_id').length,
          sku: matchedRedirects.filter(r => r.matched_by === 'sku').length,
          handle: matchedRedirects.filter(r => r.matched_by === 'handle').length,
          title: matchedRedirects.filter(r => r.matched_by === 'title').length,
          ai: matchedRedirects.filter(r => r.matched_by === 'ai').length,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in match-redirects:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
