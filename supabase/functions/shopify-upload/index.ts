import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// SHOPIFY RATE LIMITING - SIMPLIFIED & ROBUST
// ============================================================================
// Shopify's leaky bucket: 40 requests bucket, 2 requests/second leak rate
// 
// Strategy: 
// 1. Don't preemptively wait - just send requests
// 2. On 429, return immediately with retry info (don't throw errors)
// 3. Track bucket via headers and add small delays when getting full
// ============================================================================

let shopifyBucketUsed = 0;
let lastBucketUpdate = Date.now();

/**
 * Update bucket state from Shopify response headers.
 */
function updateBucketFromHeaders(response: Response): void {
  const callLimit = response.headers.get('X-Shopify-Shop-Api-Call-Limit');
  if (callLimit) {
    const match = callLimit.match(/(\d+)\/(\d+)/);
    if (match) {
      shopifyBucketUsed = parseInt(match[1], 10);
      lastBucketUpdate = Date.now();
    }
  }
}

/**
 * Get estimated current bucket usage (accounting for leak rate)
 */
function getCurrentBucketUsage(): number {
  const elapsed = (Date.now() - lastBucketUpdate) / 1000;
  const leaked = Math.floor(elapsed * 2); // 2 requests/second leak
  return Math.max(0, shopifyBucketUsed - leaked);
}

/**
 * Check if we should add a small delay before the next request
 */
function getPreRequestDelay(): number {
  const usage = getCurrentBucketUsage();
  if (usage >= 38) return 1500; // Very full - wait a bit
  if (usage >= 35) return 500;  // Getting full - small wait
  return 0; // Bucket has room
}

/**
 * Robust fetch wrapper - handles transient errors with retry
 * Returns null on rate limit instead of throwing
 */
async function shopifyFetch(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<{ response: Response; body: string } | { rateLimited: true; retryAfterMs: number }> {
  
  // Add small delay if bucket is getting full
  const preDelay = getPreRequestDelay();
  if (preDelay > 0) {
    await sleep(preDelay);
  }
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      const body = await response.text();
      
      // Update bucket tracking
      updateBucketFromHeaders(response);
      
      // Handle rate limiting - DON'T throw, return gracefully
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
        console.log(`[SHOPIFY] Rate limited (429), need to wait ${Math.round(waitMs/1000)}s`);
        return { rateLimited: true, retryAfterMs: waitMs };
      }
      
      return { response, body };
      
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      const isTransient = 
        message.includes('connection reset') ||
        message.includes('connection closed') ||
        message.includes('timeout') ||
        message.includes('aborted') ||
        message.includes('network');
      
      if (isTransient && attempt < maxRetries - 1) {
        const waitMs = 1000 * Math.pow(2, attempt);
        console.warn(`[SHOPIFY] Transient error (attempt ${attempt + 1}/${maxRetries}): ${message}. Retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      
      throw error;
    }
  }
  
  throw new Error('Max retries exceeded');
}

interface ShopifyUploadRequest {
  projectId: string;
  entityType: 'products' | 'customers' | 'orders' | 'categories' | 'pages';
  batchSize?: number;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const requestStartTime = Date.now();
  // Time budget: leave 10s buffer before platform's 60s limit
  const TIME_BUDGET_MS = 50_000;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { projectId, entityType, batchSize = 10 }: ShopifyUploadRequest = await req.json();

    // Get project with Shopify credentials
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      throw new Error('Project not found');
    }

    if (!project.shopify_store_domain || !project.shopify_access_token_encrypted) {
      throw new Error('Shopify credentials not configured');
    }

    const shopifyDomain = project.shopify_store_domain;
    const shopifyToken = project.shopify_access_token_encrypted;
    const dandomainBaseUrl = String(project.dandomain_base_url || project.dandomain_shop_url || '').trim();
    const shopifyUrl = `https://${shopifyDomain}/admin/api/2024-01`;

    // Route to appropriate handler
    if (entityType === 'products') {
      const result = await uploadProducts(supabase, projectId, shopifyUrl, shopifyToken, batchSize, dandomainBaseUrl, requestStartTime, TIME_BUDGET_MS);
      return new Response(JSON.stringify(result), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
    
    if (entityType === 'categories') {
      const result = await uploadCategories(supabase, projectId, shopifyUrl, shopifyToken, batchSize, requestStartTime, TIME_BUDGET_MS);
      return new Response(JSON.stringify(result), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
    
    if (entityType === 'customers') {
      const result = await uploadCustomers(supabase, projectId, shopifyUrl, shopifyToken, batchSize, requestStartTime, TIME_BUDGET_MS);
      return new Response(JSON.stringify(result), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
    
    if (entityType === 'orders') {
      const result = await uploadOrders(supabase, projectId, shopifyUrl, shopifyToken, batchSize, requestStartTime, TIME_BUDGET_MS);
      return new Response(JSON.stringify(result), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
    
    if (entityType === 'pages') {
      const result = await uploadPages(supabase, projectId, shopifyUrl, shopifyToken, batchSize, requestStartTime, TIME_BUDGET_MS);
      return new Response(JSON.stringify(result), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    throw new Error(`Unknown entity type: ${entityType}`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SHOPIFY-UPLOAD] Fatal error:', errorMessage);
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage,
    }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});

// ============================================================================
// PRODUCT UPLOAD - NO PRE-LOADING, JUST CREATE & HANDLE DUPLICATES
// ============================================================================

// Cache products we've already uploaded in this session (title -> shopify_id)
const sessionProductCache: Map<string, string> = new Map();

// Cache for category external_id -> shopify_tag mapping
let categoryTagCache: Map<string, string> = new Map();

// ============================================================================
// SKU -> SHOPIFY ID TRANSLATION MAP
// ============================================================================
// This map is built during product upload and used during order upload
// to link line items to their actual Shopify products/variants
// Key: SKU or external_id, Value: { productId, variantId }
const skuToShopifyMap: Map<string, { productId: string; variantId: string }> = new Map();

/**
 * Load category tags from database for a project.
 * Maps category external_id to shopify_tag for fast lookup.
 */
async function loadCategoryTags(supabase: any, projectId: string): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  
  const { data: categories, error } = await supabase
    .from('canonical_categories')
    .select('external_id, shopify_tag')
    .eq('project_id', projectId);
  
  if (error) {
    console.error('[PRODUCTS] Failed to load category tags:', error.message);
    return cache;
  }
  
  for (const cat of (categories || [])) {
    if (cat.external_id && cat.shopify_tag) {
      cache.set(String(cat.external_id), String(cat.shopify_tag));
    }
  }
  
  console.log(`[PRODUCTS] Loaded ${cache.size} category tags for tag mapping`);
  return cache;
}

/**
 * Get Shopify tags for a product based on its category_external_ids.
 * Returns an array of shopify_tag values from matching categories.
 */
function getCategoryTagsForProduct(categoryExternalIds: string[], categoryCache: Map<string, string>): string[] {
  const tags: string[] = [];
  
  for (const catId of categoryExternalIds) {
    const shopifyTag = categoryCache.get(String(catId));
    if (shopifyTag && !tags.includes(shopifyTag)) {
      tags.push(shopifyTag);
    }
  }
  
  return tags;
}

async function uploadProducts(
  supabase: any,
  projectId: string,
  shopifyUrl: string,
  token: string,
  batchSize: number,
  dandomainBaseUrl: string,
  startTime: number,
  timeBudget: number
): Promise<{ success: boolean; processed: number; errors: number; skipped: number; hasMore: boolean; errorDetails?: any[]; rateLimited?: boolean; retryAfterSeconds?: number }> {
  
  // Load category tags for this project (for mapping category_external_ids to Shopify tags)
  categoryTagCache = await loadCategoryTags(supabase, projectId);
  
  // Fetch only PRIMARY pending products (those with _isPrimary=true after prepare-upload)
  // This ensures we only create one Shopify product per group
  const { data: pendingProducts, error: fetchError } = await supabase
    .from('canonical_products')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize * 2); // Fetch a bit extra for processing efficiency

  if (fetchError) {
    throw new Error(`Failed to fetch products: ${fetchError.message}`);
  }

  if (!pendingProducts || pendingProducts.length === 0) {
    return { success: true, processed: 0, errors: 0, skipped: 0, hasMore: false };
  }

  // Filter to only primary products (those prepared by prepare-upload)
  // If a product doesn't have _isPrimary set, treat it as primary (legacy behavior)
  const primaryProducts = pendingProducts.filter((p: any) => {
    const data = p.data || {};
    return data._isPrimary !== false; // Allow true or undefined
  });

  // IMPORTANT: Each primary product is its OWN group with pre-merged variants
  // Do NOT re-group by title - that causes duplicates!
  // The _mergedVariants array on each primary record contains all its variants.
  const productGroups: Map<string, any[]> = new Map();
  
  for (const product of primaryProducts) {
    const data = product.data || {};
    // Use a unique key per primary record (its ID) to prevent re-grouping
    const uniqueKey = product.id;
    productGroups.set(uniqueKey, [product]);
  }
  
  let processed = 0;
  let errors = 0;
  let skipped = 0;
  const errorDetails: { externalId: string; message: string }[] = [];
  let groupsProcessed = 0;
  let rateLimited = false;
  let retryAfterSeconds = 0;

  for (const [groupKey, items] of productGroups) {
    // Check time budget
    if (Date.now() - startTime > timeBudget) {
      console.log(`[PRODUCTS] Time budget reached after ${groupsProcessed} groups`);
      break;
    }
    
    // Limit groups per batch
    if (groupsProcessed >= batchSize) break;
    groupsProcessed++;

    try {
      const result = await processProductGroup(supabase, shopifyUrl, token, groupKey, items, dandomainBaseUrl);
      
      if ('rateLimited' in result && result.rateLimited) {
        rateLimited = true;
        retryAfterSeconds = Math.ceil((result.retryAfterMs || 2000) / 1000);
        console.log(`[PRODUCTS] Rate limited, stopping batch`);
        break;
      }
      
      if (result.skipped) {
        skipped += items.length;
      } else if (result.error) {
        errors += items.length;
        for (const item of items) {
          errorDetails.push({ externalId: item.external_id, message: result.error });
        }
      } else {
        processed += items.length;
      }
      
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[PRODUCTS] Error processing "${groupKey}":`, msg);
      
      // Mark as failed
      const ids = items.map((it: any) => it.id);
      await supabase
        .from('canonical_products')
        .update({ status: 'failed', error_message: msg, updated_at: new Date().toISOString() })
        .in('id', ids);
      
      errors += items.length;
      for (const item of items) {
        errorDetails.push({ externalId: item.external_id, message: msg });
      }
    }
  }

  // Check for remaining pending items (only pending status, not mapped)
  const { count: remainingCount } = await supabase
    .from('canonical_products')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'pending');

  return {
    success: true,
    processed,
    errors,
    skipped,
    hasMore: (remainingCount || 0) > 0,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
    ...(rateLimited ? { rateLimited: true, retryAfterSeconds } : {}),
  };
}

// REMOVED: loadExistingProducts - we handle duplicates via Shopify's 422 response instead
// This avoids rate limiting from fetching all products before uploading

function groupProductsByTitle(products: any[]): Map<string, any[]> {
  const groups: Map<string, any[]> = new Map();
  
  for (const product of products) {
    const data = product.data || {};
    const title = String(data._groupTitle || data.title || '').trim();
    const vendor = String(data.vendor || '').trim();

    // Prefer precomputed grouping key from prepare-upload
    const preKey = String(data._groupKey || '').trim();
    if (preKey) {
      const key = preKey.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(product);
      continue;
    }
    
    // Transform title: remove vendor prefix
    let transformedTitle = title;
    if (vendor && title.toLowerCase().startsWith(vendor.toLowerCase())) {
      transformedTitle = title.substring(vendor.length).replace(/^[\s\-–—:]+/, '').trim();
    }
    if (!transformedTitle) transformedTitle = title;

    // Normalize whitespace to improve grouping reliability
    transformedTitle = transformedTitle.replace(/\s+/g, ' ').trim();
    
    const groupKey = transformedTitle.toLowerCase();
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(product);
  }
  
  return groups;
}

async function processProductGroup(
  supabase: any,
  shopifyUrl: string,
  token: string,
  groupKey: string,
  items: any[],
  dandomainBaseUrl: string
): Promise<{ skipped?: boolean; error?: string; rateLimited?: boolean; retryAfterMs?: number }> {
  
  const data = items[0].data || {};
  const title = String(data._groupTitle || data.title || '').trim();
  const vendor = String(data.vendor || '').trim();
  
  // Transform title - fuzzy case-insensitive vendor stripping
  // Helper to normalize brand names for comparison (remove +, &, extra spaces)
  const normalizeBrand = (s: string) => s.toLowerCase().replace(/[+&]/g, ' ').replace(/\s+/g, ' ').trim();
  
  let transformedTitle = title;
  if (vendor) {
    const normalizedVendor = normalizeBrand(vendor);
    const separators = [' - ', ' – ', ' — ', ': ', ' | '];
    let stripped = false;
    
    // Try to find separator and compare prefix with fuzzy matching
    for (const sep of separators) {
      const sepIndex = title.indexOf(sep);
      if (sepIndex > 0 && sepIndex < 60) {
        const prefix = title.slice(0, sepIndex).trim();
        const normalizedPrefix = normalizeBrand(prefix);
        
        // Exact match OR vendor starts with the prefix (fuzzy)
        // e.g. "moshi moshi" matches "Moshi Moshi Mind"
        // e.g. "gai + lisva" matches "gai lisva"
        if (normalizedPrefix === normalizedVendor || 
            normalizedVendor.startsWith(normalizedPrefix + ' ') ||
            normalizedVendor.startsWith(normalizedPrefix)) {
          const rest = title.slice(sepIndex + sep.length).trim();
          if (rest) {
            transformedTitle = rest;
            stripped = true;
            break;
          }
        }
      }
    }
    
    // Fallback: simple startsWith with case-insensitive check
    if (!stripped && normalizeBrand(title).startsWith(normalizedVendor)) {
      const rest = title.substring(vendor.length).replace(/^[\s\-–—:]+/, '').trim();
      if (rest) {
        transformedTitle = rest;
      }
    }
  }

  transformedTitle = transformedTitle.replace(/\s+/g, ' ').trim();
  
  const titleLower = transformedTitle.toLowerCase();
  
  // Check session cache first (products we've uploaded in this function invocation)
  if (sessionProductCache.has(titleLower)) {
    const existingId = sessionProductCache.get(titleLower)!;
    console.log(`[PRODUCTS] "${transformedTitle}" already in session cache, skipping`);
    
    const ids = items.map((it) => it.id);
    await supabase
      .from('canonical_products')
      .update({ 
        status: 'uploaded', 
        shopify_id: existingId, 
        error_message: 'Sprunget over: Variant grupperet med andet produkt',
        updated_at: new Date().toISOString() 
      })
      .in('id', ids);
    
    return { skipped: true };
  }

  // Build variants
  const primaryData = items.find((it) => (it.data || {})._isPrimary === true)?.data || data;
  const mergedVariants = Array.isArray(primaryData._mergedVariants) ? primaryData._mergedVariants : null;
  const expectedVariantCount = primaryData._variantCount || 1;

  // SANITY CHECK: Log warning if variant count doesn't match
  if (mergedVariants && mergedVariants.length > 0) {
    if (expectedVariantCount > 1 && mergedVariants.length !== expectedVariantCount) {
      console.error(`[PRODUCTS] VARIANT MISMATCH: "${transformedTitle}" expects ${expectedVariantCount} variants but has ${mergedVariants.length} in _mergedVariants`);
    }
  } else if (expectedVariantCount > 1) {
    console.error(`[PRODUCTS] MISSING VARIANTS: "${transformedTitle}" expects ${expectedVariantCount} variants but _mergedVariants is empty or missing`);
  }

  type VariantCandidate = {
    option1: string;
    sku: string;
    price: string;
    compare_at_price: string | null;
    inventory_quantity: number;
    weight: number;
    barcode?: string;
  };

  const variantByOption: Map<string, VariantCandidate> = new Map();

  if (mergedVariants && mergedVariants.length > 0) {
    for (const mv of mergedVariants) {
      const sku = String(mv?.sku || '').trim();
      const option1 = normalizeSizeOption(String(mv?.size || ''));

      // Dedupe by option value (keep first)
      if (variantByOption.has(option1)) continue;

      const v: VariantCandidate = {
        option1,
        sku,
        price: String(mv?.price ?? '0'),
        compare_at_price: mv?.compareAtPrice ? String(mv.compareAtPrice) : null,
        inventory_quantity: parseInt(String(mv?.stockQuantity ?? 0), 10),
        weight: mv?.weight ? parseFloat(String(mv.weight)) : 0,
      };
      if (mv?.barcode) v.barcode = String(mv.barcode);
      variantByOption.set(option1, v);
    }
  } else {
    // Fallback: derive variants from raw items (pre-prepare upload)
    for (const item of items) {
      const itemData = item.data || {};
      const sku = String(itemData.sku || '').trim();
      const explicit = String(itemData.variant_option || '').trim();

      const option1 = explicit && isValidSizeVariant(explicit)
        ? normalizeSizeOption(explicit)
        : normalizeSizeOption(extractSizeFromSku(sku) || '');

      if (variantByOption.has(option1)) continue;

      const v: VariantCandidate = {
        option1,
        sku,
        price: String(itemData.price || '0'),
        compare_at_price: itemData.compare_at_price ? String(itemData.compare_at_price) : null,
        inventory_quantity: parseInt(String(itemData.stock_quantity || 0), 10),
        weight: itemData.weight ? parseFloat(String(itemData.weight)) : 0,
      };
      if (itemData.barcode) v.barcode = String(itemData.barcode);
      variantByOption.set(option1, v);
    }
  }

  const variants: any[] = Array.from(variantByOption.values()).map((v) => ({
    sku: v.sku,
    price: v.price,
    compare_at_price: v.compare_at_price,
    inventory_management: 'shopify',
    inventory_quantity: v.inventory_quantity,
    weight: v.weight,
    weight_unit: 'kg',
    requires_shipping: true,
    option1: v.option1, // ALWAYS set to avoid Shopify "Default Title"
    ...(v.barcode ? { barcode: v.barcode } : {}),
  }));

  // Collect images from the PRIMARY record (which has merged images from prepare-upload)
  // IMPORTANT: Use primaryData.images or _mergedImages as the primary source
  // The items array only contains the primary record after prepare-upload, 
  // so we must use the merged images that were consolidated during grouping
  const allImages: string[] = [];
  
  // First: Use _mergedImages from prepare-upload (explicit merged images)
  const mergedImages = primaryData._mergedImages || primaryData.images || [];
  for (const img of mergedImages) {
    const normalized = normalizeImageUrl(String(img), dandomainBaseUrl);
    if (normalized && !allImages.includes(normalized)) {
      allImages.push(normalized);
    }
  }
  
  // Fallback: Also check individual items in case prepare-upload wasn't run
  for (const item of items) {
    const images = item.data?.images || [];
    for (const img of images) {
      const normalized = normalizeImageUrl(String(img), dandomainBaseUrl);
      if (normalized && !allImages.includes(normalized)) {
        allImages.push(normalized);
      }
    }
  }
  
  console.log(`[PRODUCTS] "${transformedTitle}": Found ${allImages.length} images from merged data`);

  // If this canonical record already has a Shopify product id, don't try to create again.
  // Instead, ensure images are present on the existing product (useful for repairing products
  // that were created after an image-related 422 and therefore ended up without images).
  const existingShopifyIdRaw = items.find((it) => it.shopify_id)?.shopify_id;
  const existingShopifyId = existingShopifyIdRaw ? String(existingShopifyIdRaw) : '';
  if (existingShopifyId) {
    console.log(`[PRODUCTS] "${transformedTitle}" has existing shopify_id=${existingShopifyId}. Ensuring images...`);

    const desiredImages = allImages.slice(0, 10);

    // Fetch current images to avoid creating duplicates
    const fetchExisting = async () => {
      let res = await shopifyFetch(`${shopifyUrl}/products/${existingShopifyId}.json?fields=id,images`, {
        headers: { 'X-Shopify-Access-Token': token },
      });
      if ('rateLimited' in res) {
        await sleep(res.retryAfterMs);
        res = await shopifyFetch(`${shopifyUrl}/products/${existingShopifyId}.json?fields=id,images`, {
          headers: { 'X-Shopify-Access-Token': token },
        });
      }
      return res;
    };

    const existingSrcs = new Set<string>();
    try {
      const existingResult = await fetchExisting();
      if (!('rateLimited' in existingResult) && existingResult.response.ok) {
        const parsed = JSON.parse(existingResult.body);
        const imgs = parsed?.product?.images || [];
        for (const img of imgs) {
          const src = String(img?.src || '').trim();
          if (src) existingSrcs.add(src);
        }
      } else if (!('rateLimited' in existingResult)) {
        console.log(`[PRODUCTS] Warning: could not fetch existing images for ${existingShopifyId}: ${existingResult.response.status} ${existingResult.body.substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`[PRODUCTS] Warning: failed parsing existing product images for ${existingShopifyId}:`, e);
    }

    let added = 0;
    let failed = 0;
    for (const url of desiredImages) {
      if (existingSrcs.has(url)) continue;

      let imgRes = await shopifyFetch(`${shopifyUrl}/products/${existingShopifyId}/images.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ image: { src: url } }),
      });
      if ('rateLimited' in imgRes) {
        await sleep(imgRes.retryAfterMs);
        imgRes = await shopifyFetch(`${shopifyUrl}/products/${existingShopifyId}/images.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ image: { src: url } }),
        });
      }

      if (!('rateLimited' in imgRes) && imgRes.response.ok) {
        added++;
      } else if (!('rateLimited' in imgRes)) {
        failed++;
        console.log(`[PRODUCTS] Image upload failed for "${transformedTitle}" (${existingShopifyId}): ${imgRes.response.status} ${imgRes.body.substring(0, 200)}`);
      }
    }

    console.log(`[PRODUCTS] "${transformedTitle}": ensured images on existing product. Added=${added}, Failed=${failed}`);

    sessionProductCache.set(titleLower, existingShopifyId);
    for (const item of items) {
      const updatedData = { ...item.data };
      await supabase
        .from('canonical_products')
        .update({
          status: 'uploaded',
          shopify_id: existingShopifyId,
          error_message: null,
          data: updatedData,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);
    }

    return {};
  }

  // Sort variants by size (smallest to largest) and set explicit positions
  const sortedVariants = sortVariantsBySize(variants).map((v, idx) => ({ ...v, position: idx + 1 }));

  // Collect all tags: product tags + category-based tags
  const productTags: string[] = [...(data.tags || [])];
  
  // Add category tags based on category_external_ids
  const categoryExternalIds = Array.isArray(data.category_external_ids) 
    ? data.category_external_ids.map(String) 
    : [];
  
  if (categoryExternalIds.length > 0) {
    const categoryTags = getCategoryTagsForProduct(categoryExternalIds, categoryTagCache);
    for (const catTag of categoryTags) {
      if (!productTags.includes(catTag)) {
        productTags.push(catTag);
      }
    }
    if (categoryTags.length > 0) {
      console.log(`[PRODUCTS] "${transformedTitle}": Added ${categoryTags.length} category tags: ${categoryTags.join(', ')}`);
    }
  }

  // Build product payload
  const productPayload: any = {
    product: {
      title: transformedTitle,
      body_html: data.body_html || '',
      vendor: vendor,
      product_type: '',
      tags: [...new Set(productTags)].join(', '),
      status: data.active ? 'active' : 'draft',
      variants: sortedVariants,
      images: allImages.slice(0, 10).map((url: string) => ({ src: url })), // Limit images
    }
  };

  // Always set option values so Shopify never creates "Default" variants
  const sortedOptions = sortedVariants.map(v => v.option1).filter(Boolean);
  const uniqueOptions = [...new Set(sortedOptions)]; // Preserves order
  productPayload.product.options = [{ name: 'Størrelse', values: uniqueOptions.length > 0 ? uniqueOptions : ['ONE-SIZE'] }];

  console.log(`[PRODUCTS] Creating "${transformedTitle}" with ${variants.length} variant(s)`);

  // Create product
  const initialImageCount = (productPayload?.product?.images || []).length;
  let imageErrorBody: string | null = null;

  let result = await shopifyFetch(`${shopifyUrl}/products.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify(productPayload),
  });
  
  if ('rateLimited' in result) {
    return { rateLimited: true, retryAfterMs: result.retryAfterMs };
  }

  // Retry without images if image error
  if (!result.response.ok && result.response.status === 422 && result.body.includes('Image')) {
    imageErrorBody = result.body;
    console.log(`[PRODUCTS] Image error for "${transformedTitle}" (422): ${result.body.substring(0, 300)}`);
    console.log(`[PRODUCTS] Retrying "${transformedTitle}" without images`);
    productPayload.product.images = [];
    result = await shopifyFetch(`${shopifyUrl}/products.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify(productPayload),
    });
    
    if ('rateLimited' in result) {
      return { rateLimited: true, retryAfterMs: result.retryAfterMs };
    }
  }
  
  // Handle "already exists" error
  if (!result.response.ok && result.response.status === 422 && result.body.includes('already exists')) {
    console.log(`[PRODUCTS] "${transformedTitle}" already exists, marking as skipped`);
    
    const ids = items.map((it) => it.id);
    await supabase
      .from('canonical_products')
      .update({ 
        status: 'uploaded', 
        error_message: 'Sprunget over: Eksisterer allerede i Shopify',
        updated_at: new Date().toISOString() 
      })
      .in('id', ids);
    
    return { skipped: true };
  }

  if (!result.response.ok) {
    const errorMsg = `Shopify error ${result.response.status}: ${result.body.substring(0, 200)}`;
    
    const ids = items.map((it) => it.id);
    await supabase
      .from('canonical_products')
      .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
      .in('id', ids);
    
    return { error: errorMsg };
  }

  // Success!
  const responseData = JSON.parse(result.body);
  const shopifyId = String(responseData.product.id);
  const shopifyHandle = responseData.product.handle;
  
  sessionProductCache.set(titleLower, shopifyId);

  // ============================================================================
  // BUILD SKU -> SHOPIFY ID TRANSLATION MAP
  // ============================================================================
  // Map each variant's SKU to its Shopify product/variant IDs
  // This enables order line items to link correctly to products
  const shopifyVariants = responseData.product.variants || [];
  for (const sv of shopifyVariants) {
    const sku = String(sv.sku || '').trim();
    if (sku) {
      skuToShopifyMap.set(sku, {
        productId: shopifyId,
        variantId: String(sv.id),
      });
    }
  }
  
  // Also map by external_id for fallback lookup during order import
  for (const item of items) {
    const extId = String(item.external_id || '').trim();
    if (extId && !skuToShopifyMap.has(extId)) {
      // Find matching variant by SKU
      const itemSku = String(item.data?.sku || '').trim();
      const matchingVariant = shopifyVariants.find((sv: any) => 
        String(sv.sku || '').trim().toLowerCase() === itemSku.toLowerCase()
      );
      if (matchingVariant) {
        skuToShopifyMap.set(extId, {
          productId: shopifyId,
          variantId: String(matchingVariant.id),
        });
      } else if (shopifyVariants.length > 0) {
        // Default to first variant if no SKU match
        skuToShopifyMap.set(extId, {
          productId: shopifyId,
          variantId: String(shopifyVariants[0].id),
        });
      }
    }
  }
  
  console.log(`[PRODUCTS] "${transformedTitle}": mapped ${shopifyVariants.length} variant SKUs to Shopify IDs`);

  // If we had to drop images due to a 422 Image error, try to add them back one-by-one.
  // This avoids losing ALL images because a single URL was invalid.
  if (initialImageCount > 0 && (productPayload?.product?.images || []).length === 0 && allImages.length > 0) {
    console.log(`[PRODUCTS] "${transformedTitle}": post-create image repair. Reason=422 Image, images=${allImages.length}`);
    if (imageErrorBody) {
      console.log(`[PRODUCTS] "${transformedTitle}": image error body (trimmed): ${imageErrorBody.substring(0, 300)}`);
    }

    let added = 0;
    let failed = 0;
    for (const url of allImages.slice(0, 10)) {
      let imgRes = await shopifyFetch(`${shopifyUrl}/products/${shopifyId}/images.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ image: { src: url } }),
      });

      if ('rateLimited' in imgRes) {
        await sleep(imgRes.retryAfterMs);
        imgRes = await shopifyFetch(`${shopifyUrl}/products/${shopifyId}/images.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ image: { src: url } }),
        });
      }

      if (!('rateLimited' in imgRes) && imgRes.response.ok) {
        added++;
      } else if (!('rateLimited' in imgRes)) {
        failed++;
        console.log(`[PRODUCTS] Post-create image upload failed for "${transformedTitle}" (${shopifyId}): ${imgRes.response.status} ${imgRes.body.substring(0, 200)}`);
      }
    }

    console.log(`[PRODUCTS] "${transformedTitle}": post-create image repair done. Added=${added}, Failed=${failed}`);
  }

  // Update all items with Shopify variant IDs for future order linking
  for (const item of items) {
    const itemSku = String(item.data?.sku || '').trim();
    const matchingVariant = shopifyVariants.find((sv: any) => 
      String(sv.sku || '').trim().toLowerCase() === itemSku.toLowerCase()
    );
    const shopifyVariantId = matchingVariant ? String(matchingVariant.id) : (shopifyVariants[0] ? String(shopifyVariants[0].id) : null);
    
    const updatedData = { 
      ...item.data, 
      shopify_handle: shopifyHandle,
      _shopify_product_id: shopifyId,
      _shopify_variant_id: shopifyVariantId,
    };
    await supabase
      .from('canonical_products')
      .update({ status: 'uploaded', shopify_id: shopifyId, data: updatedData, updated_at: new Date().toISOString() })
      .eq('id', item.id);
  }

  return {};
}

// ============================================================================
// CATEGORIES UPLOAD
// ============================================================================

async function uploadCategories(
  supabase: any,
  projectId: string,
  shopifyUrl: string,
  token: string,
  batchSize: number,
  startTime: number,
  timeBudget: number
): Promise<{ success: boolean; processed: number; errors: number; hasMore: boolean; errorDetails?: any[]; rateLimited?: boolean; retryAfterSeconds?: number }> {
  
  const { data: items, error: fetchError } = await supabase
    .from('canonical_categories')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .eq('exclude', false)
    .limit(batchSize);

  if (fetchError) throw new Error(`Failed to fetch categories: ${fetchError.message}`);
  if (!items || items.length === 0) {
    return { success: true, processed: 0, errors: 0, hasMore: false };
  }

  // Load existing collections
  const existingCollections: Map<string, string> = new Map();
  console.log('[CATEGORIES] Fetching existing Shopify collections...');
  
  let pageInfo: string | null = null;
  let hasMorePages = true;
  
  while (hasMorePages) {
    const url = pageInfo 
      ? `${shopifyUrl}/smart_collections.json?limit=250&page_info=${pageInfo}`
      : `${shopifyUrl}/smart_collections.json?limit=250`;
    
    const result = await shopifyFetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    
    if ('rateLimited' in result) {
      await sleep(result.retryAfterMs);
      continue;
    }
    
    if (!result.response.ok) break;
    
    const data = JSON.parse(result.body);
    for (const c of (data.smart_collections || [])) {
      existingCollections.set(c.title.toLowerCase(), String(c.id));
    }
    
    const linkHeader = result.response.headers.get('Link');
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/page_info=([^>&]+).*rel="next"/);
      pageInfo = match ? match[1] : null;
      hasMorePages = !!pageInfo;
    } else {
      hasMorePages = false;
    }
  }
  
  console.log(`[CATEGORIES] Found ${existingCollections.size} existing collections`);

  let processed = 0;
  let errors = 0;
  const errorDetails: { externalId: string; message: string }[] = [];

  for (const item of items) {
    if (Date.now() - startTime > timeBudget) break;
    
    const title = item.name;
    const titleLower = title.toLowerCase();
    
    // Skip if exists
    if (existingCollections.has(titleLower)) {
      const existingId = existingCollections.get(titleLower)!;
      await supabase
        .from('canonical_categories')
        .update({ status: 'uploaded', shopify_collection_id: existingId, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      processed++;
      continue;
    }
    
    // Create collection
    const payload = {
      smart_collection: {
        title: title,
        rules: [{ column: 'tag', relation: 'equals', condition: title }]
      }
    };
    
    const result = await shopifyFetch(`${shopifyUrl}/smart_collections.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify(payload),
    });
    
    if ('rateLimited' in result) {
      return { 
        success: true, processed, errors, hasMore: true, 
        rateLimited: true, retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
        errorDetails: errorDetails.length > 0 ? errorDetails : undefined 
      };
    }
    
    if (!result.response.ok) {
      const errorMsg = `Shopify error ${result.response.status}`;
      await supabase
        .from('canonical_categories')
        .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      errors++;
      errorDetails.push({ externalId: item.external_id, message: errorMsg });
      continue;
    }
    
    const data = JSON.parse(result.body);
    const shopifyId = String(data.smart_collection.id);
    
    await supabase
      .from('canonical_categories')
      .update({ status: 'uploaded', shopify_collection_id: shopifyId, updated_at: new Date().toISOString() })
      .eq('id', item.id);
    
    existingCollections.set(titleLower, shopifyId);
    processed++;
  }

  const { count } = await supabase
    .from('canonical_categories')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .eq('exclude', false);

  return {
    success: true,
    processed,
    errors,
    hasMore: (count || 0) > 0,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
  };
}

// ============================================================================
// CUSTOMERS UPLOAD
// ============================================================================

async function uploadCustomers(
  supabase: any,
  projectId: string,
  shopifyUrl: string,
  token: string,
  batchSize: number,
  startTime: number,
  timeBudget: number
): Promise<{ success: boolean; processed: number; errors: number; skipped: number; hasMore: boolean; errorDetails?: any[]; rateLimited?: boolean; retryAfterSeconds?: number }> {
  
  const { data: items, error: fetchError } = await supabase
    .from('canonical_customers')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (fetchError) throw new Error(`Failed to fetch customers: ${fetchError.message}`);
  if (!items || items.length === 0) {
    return { success: true, processed: 0, errors: 0, skipped: 0, hasMore: false };
  }

  let processed = 0;
  let errors = 0;
  let skipped = 0;
  const errorDetails: { externalId: string; message: string }[] = [];

  for (const item of items) {
    if (Date.now() - startTime > timeBudget) break;
    
    const data = item.data || {};
    const email = data.email?.toLowerCase()?.trim();
    
    if (!email) {
      await supabase
        .from('canonical_customers')
        .update({ status: 'failed', error_message: 'Missing email', updated_at: new Date().toISOString() })
        .eq('id', item.id);
      errors++;
      errorDetails.push({ externalId: item.external_id, message: 'Missing email' });
      continue;
    }
    
    // Check if customer exists
    const searchResult = await shopifyFetch(
      `${shopifyUrl}/customers/search.json?query=email:${encodeURIComponent(email)}`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    
    if ('rateLimited' in searchResult) {
      return { 
        success: true, processed, errors, skipped, hasMore: true,
        rateLimited: true, retryAfterSeconds: Math.ceil(searchResult.retryAfterMs / 1000),
        errorDetails: errorDetails.length > 0 ? errorDetails : undefined
      };
    }
    
    if (searchResult.response.ok) {
      const searchData = JSON.parse(searchResult.body);
      const existingCustomer = searchData.customers?.find((c: any) => c.email?.toLowerCase() === email);
      
      if (existingCustomer) {
        await supabase
          .from('canonical_customers')
          .update({ status: 'uploaded', shopify_id: String(existingCustomer.id), updated_at: new Date().toISOString() })
          .eq('id', item.id);
        skipped++;
        continue;
      }
    }
    
    // Create customer
    const customerPayload = {
      customer: {
        email: email,
        first_name: data.first_name || '',
        last_name: data.last_name || '',
        phone: normalizePhone(data.phone),
        verified_email: true,
        send_email_welcome: false,
        addresses: data.address ? [buildAddress(data.address)] : undefined,
      }
    };
    
    const createResult = await shopifyFetch(`${shopifyUrl}/customers.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify(customerPayload),
    });
    
    if ('rateLimited' in createResult) {
      return { 
        success: true, processed, errors, skipped, hasMore: true,
        rateLimited: true, retryAfterSeconds: Math.ceil(createResult.retryAfterMs / 1000),
        errorDetails: errorDetails.length > 0 ? errorDetails : undefined
      };
    }
    
    if (!createResult.response.ok) {
      // Check if it's a duplicate error
      if (createResult.body.includes('already') || createResult.body.includes('taken')) {
        await supabase
          .from('canonical_customers')
          .update({ status: 'uploaded', updated_at: new Date().toISOString() })
          .eq('id', item.id);
        skipped++;
        continue;
      }
      
      const errorMsg = `Shopify error ${createResult.response.status}: ${createResult.body.substring(0, 100)}`;
      await supabase
        .from('canonical_customers')
        .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      errors++;
      errorDetails.push({ externalId: item.external_id, message: errorMsg });
      continue;
    }
    
    const responseData = JSON.parse(createResult.body);
    const shopifyId = String(responseData.customer.id);
    
    await supabase
      .from('canonical_customers')
      .update({ status: 'uploaded', shopify_id: shopifyId, updated_at: new Date().toISOString() })
      .eq('id', item.id);
    
    processed++;
  }

  const { count } = await supabase
    .from('canonical_customers')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'pending');

  return {
    success: true,
    processed,
    errors,
    skipped,
    hasMore: (count || 0) > 0,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
  };
}

// ============================================================================
// ORDERS UPLOAD
// ============================================================================

const orderCustomerCache: Map<string, string> = new Map();

// Cache for SKU/external_id -> {productId, variantId} loaded from DB
const orderProductCache: Map<string, { productId: string; variantId: string }> = new Map();

async function loadProductMappingForOrders(supabase: any, projectId: string): Promise<void> {
  // Load all uploaded products with their Shopify IDs
  // We need to map SKUs to Shopify product/variant IDs for order line items
  if (orderProductCache.size > 0) return; // Already loaded
  
  console.log('[ORDERS] Loading product SKU -> Shopify ID mapping...');
  
  let page = 0;
  const pageSize = 1000;
  let totalLoaded = 0;
  
  while (true) {
    const { data: products, error } = await supabase
      .from('canonical_products')
      .select('external_id, shopify_id, data')
      .eq('project_id', projectId)
      .eq('status', 'uploaded')
      .range(page * pageSize, (page + 1) * pageSize - 1);
    
    if (error) {
      console.error('[ORDERS] Error loading product mapping:', error.message);
      break;
    }
    
    if (!products || products.length === 0) break;
    
    for (const p of products) {
      const shopifyProductId = p.shopify_id ? String(p.shopify_id) : null;
      const shopifyVariantId = p.data?._shopify_variant_id ? String(p.data._shopify_variant_id) : null;
      const sku = String(p.data?.sku || '').trim();
      const extId = String(p.external_id || '').trim();
      
      if (shopifyProductId && shopifyVariantId) {
        // Map by SKU
        if (sku) {
          orderProductCache.set(sku.toLowerCase(), { productId: shopifyProductId, variantId: shopifyVariantId });
        }
        // Map by external_id
        if (extId) {
          orderProductCache.set(extId.toLowerCase(), { productId: shopifyProductId, variantId: shopifyVariantId });
        }
      }
    }
    
    totalLoaded += products.length;
    if (products.length < pageSize) break;
    page++;
  }
  
  console.log(`[ORDERS] Loaded ${orderProductCache.size} SKU/ID mappings from ${totalLoaded} products`);
}

async function uploadOrders(
  supabase: any,
  projectId: string,
  shopifyUrl: string,
  token: string,
  batchSize: number,
  startTime: number,
  timeBudget: number
): Promise<{ success: boolean; processed: number; errors: number; hasMore: boolean; errorDetails?: any[]; rateLimited?: boolean; retryAfterSeconds?: number }> {
  
  // Load product mapping for line item linking
  await loadProductMappingForOrders(supabase, projectId);
  
  const { data: items, error: fetchError } = await supabase
    .from('canonical_orders')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (fetchError) throw new Error(`Failed to fetch orders: ${fetchError.message}`);
  if (!items || items.length === 0) {
    return { success: true, processed: 0, errors: 0, hasMore: false };
  }

  // Pre-load customer mapping from DB
  const customerExternalIds = items
    .map((o: any) => o.data?.customer_external_id)
    .filter(Boolean);
  
  if (customerExternalIds.length > 0) {
    const { data: customers } = await supabase
      .from('canonical_customers')
      .select('external_id, shopify_id')
      .eq('project_id', projectId)
      .in('external_id', customerExternalIds);
    
    for (const c of (customers || [])) {
      if (c.shopify_id) {
        orderCustomerCache.set(c.external_id, c.shopify_id);
      }
    }
  }

  let processed = 0;
  let errors = 0;
  let linkedLineItems = 0;
  let unlinkedLineItems = 0;
  const errorDetails: { externalId: string; message: string }[] = [];

  for (const item of items) {
    if (Date.now() - startTime > timeBudget) break;
    
    const data = item.data || {};
    
    // Find customer Shopify ID
    let customerId: string | null = null;
    const customerExtId = data.customer_external_id;
    
    if (customerExtId && orderCustomerCache.has(customerExtId)) {
      customerId = orderCustomerCache.get(customerExtId)!;
    }
    
    // Build order payload with product linking
    const lineItems = (data.line_items || []).map((li: any) => {
      const lineItem: any = {
        title: li.title || 'Product',
        quantity: li.quantity || 1,
        price: String(li.price || '0'),
      };
      
      // Try to link to actual Shopify product/variant
      // Priority: 1) SKU, 2) product_external_id
      const sku = String(li.sku || '').trim().toLowerCase();
      const productExtId = String(li.product_external_id || '').trim().toLowerCase();
      
      let mapping = null;
      if (sku && orderProductCache.has(sku)) {
        mapping = orderProductCache.get(sku);
      } else if (productExtId && orderProductCache.has(productExtId)) {
        mapping = orderProductCache.get(productExtId);
      }
      
      if (mapping) {
        // Set explicit product_id and variant_id for proper linking
        lineItem.product_id = parseInt(mapping.productId, 10);
        lineItem.variant_id = parseInt(mapping.variantId, 10);
        linkedLineItems++;
      } else {
        unlinkedLineItems++;
      }
      
      return lineItem;
    });
    
    if (lineItems.length === 0) {
      lineItems.push({ title: 'Order Item', quantity: 1, price: '0' });
      unlinkedLineItems++;
    }
    
    const orderPayload: any = {
      order: {
        line_items: lineItems,
        financial_status: mapFinancialStatus(data.financial_status),
        fulfillment_status: mapFulfillmentStatus(data.fulfillment_status),
        send_receipt: false,
        send_fulfillment_receipt: false,
      }
    };
    
    if (customerId) {
      orderPayload.order.customer = { id: parseInt(customerId, 10) };
    }
    
    if (data.created_at) {
      orderPayload.order.created_at = data.created_at;
    }
    
    if (data.shipping_address) {
      orderPayload.order.shipping_address = buildAddress(data.shipping_address);
    }
    
    if (data.billing_address) {
      orderPayload.order.billing_address = buildAddress(data.billing_address);
    }
    
    // Create order
    const result = await shopifyFetch(`${shopifyUrl}/orders.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify(orderPayload),
    });
    
    if ('rateLimited' in result) {
      console.log(`[ORDERS] Batch complete before rate limit. Linked=${linkedLineItems}, Unlinked=${unlinkedLineItems}`);
      return {
        success: true, processed, errors, hasMore: true,
        rateLimited: true, retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
        errorDetails: errorDetails.length > 0 ? errorDetails : undefined
      };
    }
    
    if (!result.response.ok) {
      const errorMsg = `Shopify error ${result.response.status}: ${result.body.substring(0, 100)}`;
      await supabase
        .from('canonical_orders')
        .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      errors++;
      errorDetails.push({ externalId: item.external_id, message: errorMsg });
      continue;
    }
    
    const responseData = JSON.parse(result.body);
    const shopifyId = String(responseData.order.id);
    
    await supabase
      .from('canonical_orders')
      .update({ status: 'uploaded', shopify_id: shopifyId, updated_at: new Date().toISOString() })
      .eq('id', item.id);
    
    processed++;
  }

  console.log(`[ORDERS] Batch complete. Processed=${processed}, Errors=${errors}, Linked=${linkedLineItems}, Unlinked=${unlinkedLineItems}`);

  const { count } = await supabase
    .from('canonical_orders')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'pending');

  return {
    success: true,
    processed,
    errors,
    hasMore: (count || 0) > 0,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
  };
}

// ============================================================================
// PAGES UPLOAD
// ============================================================================

async function uploadPages(
  supabase: any,
  projectId: string,
  shopifyUrl: string,
  token: string,
  batchSize: number,
  startTime: number,
  timeBudget: number
): Promise<{ success: boolean; processed: number; errors: number; hasMore: boolean; errorDetails?: any[]; rateLimited?: boolean; retryAfterSeconds?: number }> {
  
  const { data: items, error: fetchError } = await supabase
    .from('canonical_pages')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .limit(batchSize);

  if (fetchError) throw new Error(`Failed to fetch pages: ${fetchError.message}`);
  if (!items || items.length === 0) {
    return { success: true, processed: 0, errors: 0, hasMore: false };
  }

  let processed = 0;
  let errors = 0;
  const errorDetails: { externalId: string; message: string }[] = [];

  for (const item of items) {
    if (Date.now() - startTime > timeBudget) break;
    
    const data = item.data || {};
    
    const pagePayload = {
      page: {
        title: data.title || 'Untitled',
        body_html: data.body_html || '',
        published: data.published !== false,
      }
    };
    
    const result = await shopifyFetch(`${shopifyUrl}/pages.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify(pagePayload),
    });
    
    if ('rateLimited' in result) {
      return {
        success: true, processed, errors, hasMore: true,
        rateLimited: true, retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
        errorDetails: errorDetails.length > 0 ? errorDetails : undefined
      };
    }
    
    if (!result.response.ok) {
      const errorMsg = `Shopify error ${result.response.status}`;
      await supabase
        .from('canonical_pages')
        .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      errors++;
      errorDetails.push({ externalId: item.external_id, message: errorMsg });
      continue;
    }
    
    const responseData = JSON.parse(result.body);
    const shopifyId = String(responseData.page.id);
    const shopifyHandle = responseData.page.handle;
    
    const updatedData = { ...data, shopify_handle: shopifyHandle };
    await supabase
      .from('canonical_pages')
      .update({ status: 'uploaded', shopify_id: shopifyId, data: updatedData, updated_at: new Date().toISOString() })
      .eq('id', item.id);
    
    processed++;
  }

  const { count } = await supabase
    .from('canonical_pages')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'pending');

  return {
    success: true,
    processed,
    errors,
    hasMore: (count || 0) > 0,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// ==========================================================================
// SIZE PARSING & VALIDATION (to avoid creating "Default" variants)
// ==========================================================================

const SIZE_PATTERNS = [
  /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|xxxxl|xxxxxl)$/i,
  /^(xs|s|m|l|xl|xxl)[-\/]?\d+$/i,
  /^\d+[-\/]?(xs|s|m|l|xl|xxl)$/i,
  /^\d{2}[-\/]\d{2}$/,
  /^one[-\s]?size$/i,
  /^\d{1,2}[.,]5$/,
];

const VALID_NUMERIC_SIZE_RANGES = [
  { min: 0, max: 20 },
  { min: 32, max: 60 },
  { min: 86, max: 194 },
];

const COLOR_PATTERNS = /^(BLACK|WHITE|GREY|GRAY|BLUE|RED|GREEN|YELLOW|PINK|BROWN|BEIGE|NAVY|SAND|CREAM|ROSE|ORANGE|PURPLE|TAN|OLIVE|MINT|CORAL|CAMEL|COGNAC|NUDE|SILVER|GOLD|STONE|DARK|LIGHT|NATURAL|MULCH|MELANGE|STRIPE)$/i;

function isValidNumericSize(num: number): boolean {
  return VALID_NUMERIC_SIZE_RANGES.some((r) => num >= r.min && num <= r.max);
}

function isValidSizeVariant(option: string): boolean {
  const trimmed = option.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower === 'default' || lower === 'default title') return false;
  if (SIZE_PATTERNS.some((p) => p.test(trimmed))) return true;
  const numMatch = trimmed.match(/^(\d+)$/);
  if (numMatch) return isValidNumericSize(parseInt(numMatch[1], 10));
  return false;
}

function extractSizeFromSku(sku: string): string | null {
  const clean = String(sku || '').trim();
  if (!clean) return null;
  const parts = clean.split('-');

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i].trim().toUpperCase();
    if (!part) continue;
    if (COLOR_PATTERNS.test(part)) continue;

    // Skip middle product codes (3+ digits)
    if (i < parts.length - 1 && /^\d{3,}$/.test(part)) continue;

    // For last part: only accept 3+ digits if in valid size range
    if (i === parts.length - 1 && /^\d{3,}$/.test(part)) {
      const num = parseInt(part, 10);
      if (!isValidNumericSize(num)) continue;
    }

    if (isValidSizeVariant(part)) return part;
  }

  // Special: last two parts as range, e.g. 35-38
  if (parts.length >= 2) {
    const lastTwo = parts.slice(-2).join('-');
    if (/^\d{2}-\d{2}$/.test(lastTwo)) {
      const nums = lastTwo.split('-').map((n) => parseInt(n, 10));
      if (nums.every((n) => isValidNumericSize(n))) return lastTwo;
    }
  }

  return null;
}

function normalizeSizeOption(sizeRaw: string): string {
  const s = String(sizeRaw || '').trim();
  if (!s) return 'ONE-SIZE';
  if (!isValidSizeVariant(s)) return 'ONE-SIZE';
  const upper = s.toUpperCase();
  if (upper === 'ONESIZE') return 'ONE-SIZE';
  if (upper === 'ONE SIZE') return 'ONE-SIZE';
  return upper;
}

// Size order for sorting variants from smallest to largest
const SIZE_ORDER: Record<string, number> = {
  'XXXS': 1, '3XS': 1,
  'XXS': 2, '2XS': 2,
  'XS': 3,
  'S': 4,
  'M': 5,
  'L': 6,
  'XL': 7,
  'XXL': 8, '2XL': 8,
  'XXXL': 9, '3XL': 9,
  'XXXXL': 10, '4XL': 10,
  'XXXXXL': 11, '5XL': 11,
  'ONE-SIZE': 100, 'ONESIZE': 100, 'ONE SIZE': 100,
};

/**
 * Get sort priority for a size string.
 * Lower number = smaller size = comes first.
 */
function getSizeSortPriority(size: string): number {
  const upper = size.toUpperCase().trim();
  
  // Check direct match
  if (SIZE_ORDER[upper] !== undefined) {
    return SIZE_ORDER[upper];
  }
  
  // Check if it's a numeric size (e.g., 36, 38, 40, 128)
  const numMatch = upper.match(/^(\d+)$/);
  if (numMatch) {
    return 1000 + parseInt(numMatch[1], 10); // Numeric sizes sorted numerically
  }
  
  // Check for range sizes (e.g., 35-38, 128/134)
  const rangeMatch = upper.match(/^(\d+)[-\/](\d+)$/);
  if (rangeMatch) {
    return 1000 + parseInt(rangeMatch[1], 10); // Sort by first number
  }
  
  // Check for half sizes (e.g., 7.5, 42,5)
  const halfMatch = upper.match(/^(\d+)[.,]5$/);
  if (halfMatch) {
    return 1000 + parseInt(halfMatch[1], 10) + 0.5;
  }
  
  // Unknown size - put at end
  return 9999;
}

/**
 * Sort variants by size from smallest to largest.
 */
function sortVariantsBySize<T extends { option1?: string }>(variants: T[]): T[] {
  return [...variants].sort((a, b) => {
    const priorityA = getSizeSortPriority(a.option1 || 'ONE-SIZE');
    const priorityB = getSizeSortPriority(b.option1 || 'ONE-SIZE');
    return priorityA - priorityB;
  });
}

function extractBaseSku(sku: string): string {
  if (!sku) return '';
  
  const rangeMatch = sku.match(/^(.+)-(\d{2})-(\d{2})$/);
  if (rangeMatch) return rangeMatch[1];
  
  if (sku.endsWith('-ONE-SIZE') || sku.endsWith('-one-size')) {
    const base = sku.slice(0, sku.lastIndexOf('-ONE-SIZE'));
    return base.endsWith('-') ? base.slice(0, -1) : base;
  }
  
  const variantSuffixes = [
    '-XXS', '-XS', '-S', '-M', '-L', '-XL', '-XXL', '-XXXL', '-2XL', '-3XL',
    '-xxs', '-xs', '-s', '-m', '-l', '-xl', '-xxl', '-xxxl', '-2xl', '-3xl',
    '-35', '-36', '-37', '-38', '-39', '-40', '-41', '-42', '-43', '-44', '-45', '-46',
  ];
  
  for (const suffix of variantSuffixes) {
    if (sku.endsWith(suffix)) return sku.slice(0, -suffix.length);
  }
  
  const lastDash = sku.lastIndexOf('-');
  if (lastDash > 0) {
    const suffix = sku.substring(lastDash + 1);
    if (suffix.length <= 4 && /^[A-Z0-9]+$/i.test(suffix)) {
      return sku.substring(0, lastDash);
    }
  }
  
  return sku;
}

function normalizeImageUrl(url: string, baseUrl: string): string {
  if (!url) return '';
  let trimmed = url.trim();
  
  // Build full URL if relative
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    if (baseUrl) {
      const cleanBase = baseUrl.replace(/\/$/, '');
      const cleanPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
      trimmed = `${cleanBase}${cleanPath}`;
    } else {
      return ''; // Cannot use relative URL without base
    }
  }
  
  // Ensure https
  if (trimmed.startsWith('http://')) {
    trimmed = trimmed.replace('http://', 'https://');
  }
  
  // URI-encode the path portion to handle special characters (æ, ø, å, spaces, etc.)
  // Shopify rejects URLs with unencoded special characters
  try {
    const urlObj = new URL(trimmed);
    // encodeURI handles the full path but preserves /, :, etc.
    // We need to re-encode the pathname specifically
    urlObj.pathname = urlObj.pathname
      .split('/')
      .map(segment => encodeURIComponent(decodeURIComponent(segment)))
      .join('/');
    return urlObj.toString();
  } catch {
    // Fallback: simple encodeURI on the whole thing
    return encodeURI(trimmed);
  }
}

function normalizePhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned || cleaned.length < 8) return undefined;
  if (!cleaned.startsWith('+')) {
    return `+45${cleaned}`;
  }
  return cleaned;
}

function buildAddress(addr: any): any {
  if (!addr) return {};
  return {
    first_name: addr.first_name || '',
    last_name: addr.last_name || '',
    address1: addr.address1 || addr.street || '',
    address2: addr.address2 || '',
    city: addr.city || '',
    province: addr.province || addr.state || '',
    zip: addr.zip || addr.postal_code || '',
    country: normalizeCountry(addr.country),
    phone: normalizePhone(addr.phone),
  };
}

function normalizeCountry(country: string | undefined): string {
  if (!country) return 'DK';
  const c = country.toLowerCase().trim();
  if (c === 'danmark' || c === 'denmark' || c === 'dk') return 'DK';
  if (c === 'sverige' || c === 'sweden' || c === 'se') return 'SE';
  if (c === 'norge' || c === 'norway' || c === 'no') return 'NO';
  if (c === 'tyskland' || c === 'germany' || c === 'de') return 'DE';
  return country.substring(0, 2).toUpperCase();
}

function mapFinancialStatus(status: string | undefined): string {
  if (!status) return 'paid';
  const s = status.toLowerCase();
  if (s.includes('paid') || s.includes('betalt')) return 'paid';
  if (s.includes('pending') || s.includes('afvent')) return 'pending';
  if (s.includes('refund')) return 'refunded';
  return 'paid';
}

function mapFulfillmentStatus(status: string | undefined): string | null {
  if (!status) return 'fulfilled';
  const s = status.toLowerCase();
  if (s.includes('fulfilled') || s.includes('sendt') || s.includes('shipped')) return 'fulfilled';
  if (s.includes('partial')) return 'partial';
  return null; // unfulfilled
}
