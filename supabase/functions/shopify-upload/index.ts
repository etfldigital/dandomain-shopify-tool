import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// SHOPIFY RATE LIMITING - PRODUCTION SaaS GRADE
// ============================================================================
// Shopify uses a "leaky bucket" algorithm:
// - Standard stores: 40 requests bucket, 2 requests/second leak rate
// 
// This implementation:
// 1. Reads X-Shopify-Shop-Api-Call-Limit header to track bucket state
// 2. Uses adaptive delays to maximize throughput without hitting 429s
// 3. Implements exponential backoff for rate limit errors
// ============================================================================

// Rate limiting state
const SHOPIFY_BUCKET_SIZE = 40;
const SHOPIFY_LEAK_RATE = 2; // requests per second
let shopifyBucketUsed = 0;
let lastBucketUpdate = Date.now();
let lastShopifyRequest = 0;

// Delay settings
const MIN_DELAY = 500; // 2 req/sec = 500ms between requests
const ORDER_DELAY = 500;

// Error tracking for adaptive backoff
let consecutiveRateLimits = 0;
let backoffMultiplier = 1;

// Concurrency settings per entity type
const CONCURRENCY_BY_TYPE: Record<string, number> = {
  customers: 2,    
  orders: 1,       // MUST be 1 for rate limiting
  products: 2,
  categories: 1,
  pages: 2,
};

/**
 * Get the optimal delay for the current entity type.
 */
function getOptimalDelay(entityType: string): number {
  const baseDelay = entityType === 'orders' ? ORDER_DELAY : MIN_DELAY;
  return Math.round(baseDelay * backoffMultiplier);
}

/**
 * Check if an error is a transient network error that should be retried.
 */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('connection reset') ||
    message.includes('connection refused') ||
    message.includes('connection closed') ||
    message.includes('network error') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('socket hang up') ||
    message.includes('aborted') ||
    message.includes('failed to fetch')
  );
}

/**
 * Update bucket state from Shopify response headers.
 * Header format: "X/40" where X is currently used.
 */
function updateBucketFromHeaders(response: Response): void {
  const callLimit = response.headers.get('X-Shopify-Shop-Api-Call-Limit');
  if (callLimit) {
    const match = callLimit.match(/(\d+)\/(\d+)/);
    if (match) {
      shopifyBucketUsed = parseInt(match[1], 10);
      lastBucketUpdate = Date.now();
      
      // Log bucket state periodically for debugging
      if (shopifyBucketUsed > 30) {
        console.log(`[RATE LIMIT] Bucket: ${shopifyBucketUsed}/${match[2]}`);
      }
    }
  }
}

/**
 * Calculate how many requests are available in the bucket right now.
 * The bucket "leaks" at SHOPIFY_LEAK_RATE per second.
 */
function getAvailableBucketSpace(): number {
  const now = Date.now();
  const elapsed = (now - lastBucketUpdate) / 1000;
  const leaked = Math.floor(elapsed * SHOPIFY_LEAK_RATE);
  const currentUsed = Math.max(0, shopifyBucketUsed - leaked);
  return SHOPIFY_BUCKET_SIZE - currentUsed;
}

/**
 * Wait until there's space in the rate limit bucket.
 */
async function waitForBucketSpace(): Promise<void> {
  const available = getAvailableBucketSpace();
  const bufferSize = 5;
  
  if (available <= bufferSize) {
    const waitTime = Math.ceil((bufferSize + 1 - available) / SHOPIFY_LEAK_RATE * 1000);
    console.log(`[RATE LIMIT] Bucket near full (${SHOPIFY_BUCKET_SIZE - available}/${SHOPIFY_BUCKET_SIZE}), waiting ${waitTime}ms`);
    await sleep(waitTime);
  }
}

type ShopifyFetchLimits = {
  maxWaitMs?: number;
  entityType?: string;
};

/**
 * Rate-limited fetch wrapper for Shopify API with automatic retry on 429 and transient network errors.
 * Returns { response, body } to avoid double-consuming the response body.
 */
async function shopifyFetch(
  url: string,
  options: RequestInit,
  maxRetries = 5,
  limits: ShopifyFetchLimits = {}
): Promise<{ response: Response; body: string }> {
  const entityType = limits.entityType || 'default';
  
  // Wait for bucket space before making request
  await waitForBucketSpace();
  
  // Enforce optimal delay between requests
  const optimalDelay = getOptimalDelay(entityType);
  const now = Date.now();
  const timeSinceLastRequest = now - lastShopifyRequest;
  if (timeSinceLastRequest < optimalDelay) {
    await sleep(optimalDelay - timeSinceLastRequest);
  }
  lastShopifyRequest = Date.now();

  let attempt = 0;
  let lastError: Error | null = null;
  const maxWaitMs = Math.max(0, limits.maxWaitMs ?? 30_000);

  while (attempt < maxRetries) {
    try {
      const response = await fetch(url, options);
      const body = await response.text();

      // Handle rate limiting with intelligent backoff
      if (response.status === 429) {
        attempt++;
        consecutiveRateLimits++;
        
        // Aggressively increase backoff on 429
        backoffMultiplier = Math.min(backoffMultiplier * 2, 10);
        
        // Check Retry-After header
        const retryAfter = response.headers.get('Retry-After');
        let waitTime: number;
        
        if (retryAfter) {
          waitTime = parseInt(retryAfter, 10) * 1000;
          console.log(`[RATE LIMIT] 429 with Retry-After: ${retryAfter}s`);
        } else {
          // Exponential backoff with jitter
          const baseWait = 2000 * Math.pow(2, attempt);
          const jitter = Math.random() * 1000;
          waitTime = Math.min(baseWait + jitter, 60_000);
        }
        
        // Cap wait time
        waitTime = Math.min(waitTime, maxWaitMs);
        
        console.log(`[RATE LIMIT] 429 (attempt ${attempt}/${maxRetries}), backoff=${backoffMultiplier.toFixed(1)}x, waiting ${Math.round(waitTime/1000)}s`);
        await sleep(waitTime);
        lastShopifyRequest = Date.now();
        continue;
      }
      
      // Update bucket state from headers
      updateBucketFromHeaders(response);
      
      // Success - gradually reduce backoff
      if (response.ok) {
        consecutiveRateLimits = 0;
        // Slowly reduce backoff on success (multiplicative decrease)
        backoffMultiplier = Math.max(1, backoffMultiplier * 0.9);
      }

      return { response, body };
    } catch (error) {
      // Handle transient network errors with exponential backoff
      if (isTransientNetworkError(error)) {
        attempt++;
        lastError = error instanceof Error ? error : new Error(String(error));
        const baseWait = 2000 * Math.pow(2, attempt);
        const jitter = Math.random() * 1000;
        const waitTime = Math.min(baseWait + jitter, maxWaitMs);
        console.warn(`[NETWORK] Transient error (attempt ${attempt}/${maxRetries}): ${lastError.message}. Retrying in ${Math.round(waitTime/1000)}s...`);
        await sleep(waitTime);
        lastShopifyRequest = Date.now();
        continue;
      }
      // Non-transient error - throw immediately
      throw error;
    }
  }

  // Final attempt after all retries exhausted
  try {
    lastShopifyRequest = Date.now();
    const response = await fetch(url, options);
    const body = await response.text();
    return { response, body };
  } catch (finalError) {
    if (lastError) {
      throw new Error(`Failed after ${maxRetries} retries. Last error: ${lastError.message}`);
    }
    throw finalError;
  }
}

interface ShopifyUploadRequest {
  projectId: string;
  entityType: 'products' | 'customers' | 'orders' | 'categories' | 'pages';
  batchSize?: number;
  offset?: number;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { projectId, entityType, batchSize = 50, offset = 0 }: ShopifyUploadRequest = await req.json();

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

    let processed = 0;
    let errors = 0;
    let skipped = 0;
    let errorDetails: { externalId: string; message: string }[] = [];

    const tableName = `canonical_${entityType}`;
    
    // Special handling for products - group by title to create variants
    if (entityType === 'products') {
      const result = await uploadProductsWithVariants(supabase, projectId, shopifyUrl, shopifyToken, batchSize, dandomainBaseUrl);
      return new Response(JSON.stringify(result), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
    
    // Special handling for categories - use dedicated function with caching
    if (entityType === 'categories') {
      const result = await uploadCategoriesWithCache(supabase, projectId, shopifyUrl, shopifyToken, batchSize);
      return new Response(JSON.stringify(result), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
    
    const { data: items, error: fetchError } = await supabase
      .from(tableName)
      .select('*')
      .eq('project_id', projectId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (fetchError) {
      throw new Error(`Failed to fetch ${entityType}: ${fetchError.message}`);
    }

    if (!items || items.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        processed: 0,
        errors: 0,
        message: `No pending ${entityType} to upload`,
        hasMore: false,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // === ORDERS: Pre-load customer cache only (fast DB query) ===
    if (entityType === 'orders') {
      const customerExternalIds: string[] = [];
      
      for (const item of items) {
        if (item.data?.customer_external_id && !orderCustomerCache.has(item.data.customer_external_id)) {
          customerExternalIds.push(item.data.customer_external_id);
        }
      }
      
      if (customerExternalIds.length > 0) {
        console.log(`[ORDERS] Pre-loading ${customerExternalIds.length} customers from DB`);
        await preloadOrderCustomerCache(supabase, projectId, customerExternalIds);
      }
      console.log(`[ORDERS] Customer cache: ${orderCustomerCache.size}, Product cache: ${orderProductVariantCache.size}, Email cache: ${orderShopifyCustomerEmailCache.size}`);
    }

    const effectiveConcurrency = CONCURRENCY_BY_TYPE[entityType] || 1;

    // Time budget for order processing to avoid timeouts
    const requestStartedAt = Date.now();
    const timeBudgetMs = entityType === 'orders' ? 35_000 : null;

    // Process items
    const processItem = async (item: any): Promise<{ success: boolean; externalId: string; error?: string; wasExisting?: boolean }> => {
      try {
        let shopifyId: string | null = null;
        let wasExisting = false;

        switch (entityType) {
          case 'customers': {
            const result = await uploadCustomer(shopifyUrl, shopifyToken, item.data);
            shopifyId = result.shopifyId;
            wasExisting = result.wasExisting;
            break;
          }
          case 'orders':
            shopifyId = await uploadOrder(shopifyUrl, shopifyToken, item.data, supabase, projectId);
            break;
          case 'pages':
            shopifyId = await uploadPage(shopifyUrl, shopifyToken, item.data);
            break;
        }

        const updatePayload: Record<string, any> = {
          status: 'uploaded',
          shopify_id: shopifyId,
          updated_at: new Date().toISOString(),
        };

        const { error: updateError } = await supabase
          .from(tableName)
          .update(updatePayload)
          .eq('id', item.id);

        if (updateError) {
          throw new Error(`Failed to update ${entityType} row status: ${updateError.message}`);
        }

        return { success: true, externalId: item.external_id, wasExisting };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        await supabase
          .from(tableName)
          .update({ 
            status: 'failed', 
            error_message: errorMessage,
            updated_at: new Date().toISOString()
          })
          .eq('id', item.id);

        return { success: false, externalId: item.external_id, error: errorMessage };
      }
    };

    // Process in batches with dynamic concurrency
    for (let i = 0; i < items.length; i += effectiveConcurrency) {
      if (timeBudgetMs && Date.now() - requestStartedAt > timeBudgetMs) {
        console.log(`[${entityType.toUpperCase()}] Time budget hit after ${Date.now() - requestStartedAt}ms, pausing for next invocation`);
        break;
      }
      const batch = items.slice(i, i + effectiveConcurrency);
      const results = await Promise.all(batch.map(processItem));
      
      for (const result of results) {
        if (result.success) {
          if (result.wasExisting) {
            skipped++;
          } else {
            processed++;
          }
        } else {
          errors++;
          errorDetails.push({ externalId: result.externalId, message: result.error || 'Unknown error' });
        }
      }
    }

    // Check if there are more items
    const { count } = await supabase
      .from(tableName)
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('status', 'pending');

    return new Response(JSON.stringify({
      success: true,
      processed,
      skipped,
      errors,
      errorDetails,
      hasMore: (count || 0) > 0,
      remaining: count || 0,
      ...(entityType === 'orders' ? { timeBudgetMs, elapsedMs: Date.now() - requestStartedAt } : {}),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage,
    }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});

// Helper to extract variant option from SKU suffix
function extractVariantOption(baseSku: string, fullSku: string): string {
  if (fullSku === baseSku) return 'Default';
  const suffix = fullSku.substring(baseSku.length);
  return suffix.replace(/^[-_]/, '').toUpperCase() || 'Default';
}

// Extract base SKU from a full SKU
function extractBaseSku(sku: string): string {
  if (!sku) return '';
  
  // Handle size ranges like -35-38, -39-42, -ONE-SIZE
  const rangeMatch = sku.match(/^(.+)-(\d{2})-(\d{2})$/);
  if (rangeMatch) {
    return rangeMatch[1];
  }
  
  if (sku.endsWith('-ONE-SIZE') || sku.endsWith('-one-size')) {
    const base = sku.slice(0, sku.lastIndexOf('-ONE-SIZE'));
    return base.endsWith('-') ? base.slice(0, -1) : base;
  }
  
  const variantSuffixes = [
    '-XXS', '-XS', '-S', '-M', '-L', '-XL', '-XXL', '-XXXL', '-2XL', '-3XL', '-4XL', '-5XL',
    '-xxs', '-xs', '-s', '-m', '-l', '-xl', '-xxl', '-xxxl', '-2xl', '-3xl', '-4xl', '-5xl',
    '-35', '-36', '-37', '-38', '-39', '-40', '-41', '-42', '-43', '-44', '-45', '-46', '-47', '-48',
    '-BLK', '-WHT', '-RED', '-BLU', '-GRN', '-BRN', '-GRY', '-NAV', '-PNK',
    '-blk', '-wht', '-red', '-blu', '-grn', '-brn', '-gry', '-nav', '-pnk',
  ];
  
  for (const suffix of variantSuffixes) {
    if (sku.endsWith(suffix)) {
      return sku.slice(0, -suffix.length);
    }
  }
  
  // Detect pattern: base-VARIANT where VARIANT is short
  const lastDash = sku.lastIndexOf('-');
  if (lastDash > 0) {
    const suffix = sku.substring(lastDash + 1);
    if (suffix.length <= 4 && /^[A-Z0-9]+$/i.test(suffix)) {
      return sku.substring(0, lastDash);
    }
  }
  
  return sku;
}

/**
 * Normalize an image URL to be absolute and accessible.
 */
function normalizeImageUrl(url: string, baseUrl: string): string {
  if (!url) return '';
  
  const trimmed = url.trim();
  
  // Already absolute
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  
  // Relative path - prepend base URL
  if (baseUrl) {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const cleanPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return `${cleanBase}${cleanPath}`;
  }
  
  return trimmed;
}

// Track whether cost updates are supported (requires write_inventory scope)
let costUpdatesSupported: boolean | null = null;

/**
 * Set cost price on an inventory item.
 */
async function setInventoryItemCost(shopifyUrl: string, token: string, inventoryItemId: number | string, cost: number): Promise<void> {
  const payload = {
    inventory_item: {
      id: inventoryItemId,
      cost: cost.toFixed(2),
    }
  };
  
  const { response, body } = await shopifyFetch(
    `${shopifyUrl}/inventory_items/${inventoryItemId}.json`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify(payload),
    },
    3,
    { entityType: 'products' }
  );
  
  if (!response.ok) {
    throw new Error(`Failed to set inventory cost: ${response.status} - ${body}`);
  }
}

// Product grouping cache
const existingProducts: Map<string, string> = new Map();

/**
 * Upload products with variant grouping.
 */
async function uploadProductsWithVariants(
  supabase: any,
  projectId: string,
  shopifyUrl: string,
  token: string,
  batchSize: number,
  dandomainBaseUrl: string
): Promise<{ success: boolean; processed: number; errors: number; skipped: number; hasMore: boolean; errorDetails?: any[] }> {
  
  // Get pending products
  const { data: pendingProducts, error: fetchError } = await supabase
    .from('canonical_products')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize * 3); // Fetch more to allow grouping

  if (fetchError) {
    throw new Error(`Failed to fetch products: ${fetchError.message}`);
  }

  if (!pendingProducts || pendingProducts.length === 0) {
    return { success: true, processed: 0, errors: 0, skipped: 0, hasMore: false };
  }

  // Fetch ALL existing Shopify products once for deduplication
  if (existingProducts.size === 0) {
    console.log('Fetching existing Shopify products for deduplication...');
    let pageInfo: string | null = null;
    let hasMorePages = true;
    
    while (hasMorePages) {
      const url = pageInfo 
        ? `${shopifyUrl}/products.json?limit=250&page_info=${pageInfo}&fields=id,title`
        : `${shopifyUrl}/products.json?limit=250&fields=id,title`;
      
      const { response, body } = await shopifyFetch(url, {
        headers: { 'X-Shopify-Access-Token': token },
      }, 3, { entityType: 'products' });
      
      if (!response.ok) {
        console.error(`Failed to fetch existing products: ${response.status} - ${body}`);
        break;
      }
      
      const result = JSON.parse(body);
      const products = result.products || [];
      
      for (const product of products) {
        existingProducts.set(product.title.toLowerCase(), String(product.id));
      }
      
      const linkHeader = response.headers.get('Link');
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^>&]+).*rel="next"/);
        pageInfo = match ? match[1] : null;
        hasMorePages = !!pageInfo;
      } else {
        hasMorePages = false;
      }
    }
    
    console.log(`Found ${existingProducts.size} existing Shopify products`);
  }

  // Group products by transformed title (after vendor stripping)
  const productGroups: Map<string, any[]> = new Map();
  
  for (const product of pendingProducts) {
    const data = product.data || {};
    const title = String(data.title || '').trim();
    const vendor = String(data.vendor || '').trim();
    
    // Transform title: remove vendor prefix
    let transformedTitle = title;
    if (vendor && title.toLowerCase().startsWith(vendor.toLowerCase())) {
      transformedTitle = title.substring(vendor.length).replace(/^[\s\-–—:]+/, '').trim();
    }
    if (!transformedTitle) transformedTitle = title;
    
    const groupKey = transformedTitle.toLowerCase();
    
    if (!productGroups.has(groupKey)) {
      productGroups.set(groupKey, []);
    }
    productGroups.get(groupKey)!.push(product);
  }

  let processed = 0;
  let errors = 0;
  let skipped = 0;
  const errorDetails: { externalId: string; message: string }[] = [];
  let groupsProcessed = 0;

  for (const [groupKey, items] of productGroups) {
    // Limit number of groups per batch
    if (groupsProcessed >= batchSize) break;
    groupsProcessed++;

    try {
      const data = items[0].data || {};
      const title = String(data.title || '').trim();
      const vendor = String(data.vendor || '').trim();
      
      // Transform title
      let transformedTitle = title;
      if (vendor && title.toLowerCase().startsWith(vendor.toLowerCase())) {
        transformedTitle = title.substring(vendor.length).replace(/^[\s\-–—:]+/, '').trim();
      }
      if (!transformedTitle) transformedTitle = title;
      
      const titleLower = transformedTitle.toLowerCase();
      
      // Check if product already exists
      if (existingProducts.has(titleLower)) {
        const existingId = existingProducts.get(titleLower)!;
        console.log(`Product "${transformedTitle}" already exists (ID: ${existingId}), skipping`);
        
        const ids = items.map((it) => it.id);
        await supabase
          .from('canonical_products')
          .update({
            status: 'uploaded',
            shopify_id: existingId,
            updated_at: new Date().toISOString(),
          })
          .in('id', ids);
        
        skipped += items.length;
        continue;
      }

      // Build variants
      const hasMultipleVariants = items.length > 1;
      const variants = items.map((item) => {
        const itemData = item.data || {};
        const sku = String(itemData.sku || '');
        const baseSku = extractBaseSku(sku);
        const variantOption = hasMultipleVariants ? extractVariantOption(baseSku, sku) : null;
        
        const variant: any = {
          sku: sku,
          price: String(itemData.price || '0'),
          compare_at_price: itemData.compare_at_price ? String(itemData.compare_at_price) : null,
          inventory_management: 'shopify',
          inventory_quantity: parseInt(String(itemData.stock_quantity || 0), 10),
          weight: itemData.weight ? parseFloat(String(itemData.weight)) : 0,
          weight_unit: 'kg',
          requires_shipping: true,
        };
        
        if (hasMultipleVariants) {
          variant.option1 = variantOption;
        }
        
        if (itemData.barcode) {
          variant.barcode = String(itemData.barcode);
        }
        
        return variant;
      });

      // Collect all images
      const allImages: string[] = [];
      for (const item of items) {
        const itemData = item.data || {};
        const images = itemData.images || [];
        for (const img of images) {
          const normalized = normalizeImageUrl(String(img), dandomainBaseUrl);
          if (normalized && !allImages.includes(normalized)) {
            allImages.push(normalized);
          }
        }
      }

      // Collect tags
      const tags: string[] = data.tags || [];
      
      // Build product payload
      const productPayload: any = {
        product: {
          title: transformedTitle,
          body_html: data.body_html || '',
          vendor: vendor,
          product_type: '',
          tags: [...new Set(tags)].join(', '),
          status: data.active ? 'active' : 'draft',
          variants: variants,
          images: allImages.map((url: string) => ({ src: url })),
        }
      };
      
      // Add SEO meta tags
      if (data.meta_title && String(data.meta_title).trim()) {
        productPayload.product.metafields_global_title_tag = String(data.meta_title).trim();
      }
      if (data.meta_description && String(data.meta_description).trim()) {
        productPayload.product.metafields_global_description_tag = String(data.meta_description).trim();
      }

      // Add variant options if multiple variants
      if (hasMultipleVariants) {
        const uniqueOptions = [...new Set(variants.map(v => v.option1).filter(Boolean))];
        productPayload.product.options = [{ name: 'Størrelse', values: uniqueOptions }];
      }

      console.log(`Creating product "${transformedTitle}" with ${variants.length} variant(s)`);

      let { response, body: responseBody } = await shopifyFetch(`${shopifyUrl}/products.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify(productPayload),
      }, 5, { entityType: 'products' });

      // Retry without images if image URL error
      if (!response.ok && response.status === 422 && responseBody.includes('Image URL is invalid') && allImages.length > 0) {
        console.log(`Retrying product "${transformedTitle}" without images`);
        productPayload.product.images = [];
        const retryResult = await shopifyFetch(`${shopifyUrl}/products.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify(productPayload),
        }, 5, { entityType: 'products' });
        response = retryResult.response;
        responseBody = retryResult.body;
      }
      
      // Handle "already exists" error
      const isAlreadyExistsError = !response.ok && response.status === 422 && 
        (responseBody.includes('already exists') || responseBody.includes('Default'));
      
      if (isAlreadyExistsError) {
        console.log(`Product "${transformedTitle}" already exists, marking as uploaded`);
        
        const { response: searchResp, body: searchBody } = await shopifyFetch(
          `${shopifyUrl}/products.json?title=${encodeURIComponent(transformedTitle)}&limit=10`,
          { headers: { 'X-Shopify-Access-Token': token } },
          3,
          { entityType: 'products' }
        );
        
        let existingId: string | null = null;
        if (searchResp.ok) {
          const searchResult = JSON.parse(searchBody);
          let matchedProduct = searchResult.products?.find((p: any) => p.title.toLowerCase() === titleLower);
          if (!matchedProduct && searchResult.products?.length > 0) {
            matchedProduct = searchResult.products[0];
          }
          if (matchedProduct) {
            existingId = String(matchedProduct.id);
          }
        }
        
        const ids = items.map((it) => it.id);
        await supabase
          .from('canonical_products')
          .update({
            status: 'uploaded',
            shopify_id: existingId,
            updated_at: new Date().toISOString(),
          })
          .in('id', ids);

        skipped += items.length;
        if (existingId) {
          existingProducts.set(titleLower, existingId);
        }
        continue;
      }

      if (!response.ok) {
        throw new Error(`Shopify API error: ${response.status} - ${responseBody}`);
      }

      const result = JSON.parse(responseBody);
      const shopifyId = String(result.product.id);
      
      existingProducts.set(titleLower, shopifyId);

      // Create metafields
      const metafieldsToCreate: Array<{ namespace: string; key: string; value: string; type: string }> = [];
      
      if (data.field_1 && String(data.field_1).trim()) {
        metafieldsToCreate.push({ namespace: 'custom', key: 'materiale', value: String(data.field_1).trim(), type: 'single_line_text_field' });
      }
      if (data.field_2 && String(data.field_2).trim()) {
        metafieldsToCreate.push({ namespace: 'custom', key: 'farve', value: String(data.field_2).trim(), type: 'single_line_text_field' });
      }
      if (data.field_3 && String(data.field_3).trim()) {
        metafieldsToCreate.push({ namespace: 'custom', key: 'pasform', value: String(data.field_3).trim(), type: 'single_line_text_field' });
      }
      if (data.field_9 && String(data.field_9).trim()) {
        metafieldsToCreate.push({ namespace: 'custom', key: 'vaskeanvisning', value: String(data.field_9).trim(), type: 'single_line_text_field' });
      }
      
      for (const metafield of metafieldsToCreate) {
        try {
          const { response: metaResp } = await shopifyFetch(
            `${shopifyUrl}/products/${shopifyId}/metafields.json`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': token,
              },
              body: JSON.stringify({ metafield }),
            },
            3,
            { entityType: 'products' }
          );
          
          if (metaResp.ok) {
            console.log(`Created metafield "${metafield.key}" for product "${transformedTitle}"`);
          }
        } catch (metaError) {
          // Log but don't fail the product
        }
      }

      // Update cost price per variant
      const createdVariants = result?.product?.variants || [];
      for (const createdVariant of createdVariants) {
        if (costUpdatesSupported === false) break;

        const sku = createdVariant?.sku;
        const inventoryItemId = createdVariant?.inventory_item_id;
        const source = items.find((it) => it.data?.sku === sku)?.data;
        const cost = source?.cost_price;

        if (cost != null && inventoryItemId) {
          try {
            await setInventoryItemCost(shopifyUrl, token, inventoryItemId, Number(cost));
            if (costUpdatesSupported === null) costUpdatesSupported = true;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/(^|\s)403(\s|$)|merchant approval|write_inventory/i.test(msg)) {
              costUpdatesSupported = false;
              console.log('Inventory cost updates not permitted. Skipping for rest of run.');
              break;
            }
          }
        }
      }

      // Mark all items as uploaded
      const ids = items.map((it) => it.id);
      await supabase
        .from('canonical_products')
        .update({
          status: 'uploaded',
          shopify_id: shopifyId,
          updated_at: new Date().toISOString(),
        })
        .in('id', ids);

      processed += items.length;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error uploading product group "${groupKey}":`, errorMessage);
      
      const ids = items.map((it) => it.id);
      await supabase
        .from('canonical_products')
        .update({
          status: 'failed',
          error_message: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .in('id', ids);

      for (const item of items) {
        errorDetails.push({ externalId: item.external_id, message: errorMessage });
      }
      
      errors += items.length;
    }
  }

  // Check for more pending products
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
  };
}

/**
 * Upload categories with caching.
 */
async function uploadCategoriesWithCache(
  supabase: any,
  projectId: string,
  shopifyUrl: string,
  token: string,
  batchSize: number
): Promise<{ success: boolean; processed: number; errors: number; hasMore: boolean; errorDetails?: any[] }> {
  
  const { data: pendingCategories, error: fetchError } = await supabase
    .from('canonical_categories')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .eq('exclude', false)
    .limit(batchSize);

  if (fetchError) {
    throw new Error(`Failed to fetch categories: ${fetchError.message}`);
  }

  if (!pendingCategories || pendingCategories.length === 0) {
    return { success: true, processed: 0, errors: 0, hasMore: false };
  }

  // Fetch existing collections
  const existingCollections: Map<string, string> = new Map();
  let pageInfo: string | null = null;
  let hasMorePages = true;
  
  console.log('Fetching existing Shopify collections...');
  
  while (hasMorePages) {
    const url = pageInfo 
      ? `${shopifyUrl}/smart_collections.json?limit=250&page_info=${pageInfo}`
      : `${shopifyUrl}/smart_collections.json?limit=250`;
    
    const { response, body } = await shopifyFetch(url, {
      headers: { 'X-Shopify-Access-Token': token },
    }, 3, { entityType: 'categories' });
    
    if (!response.ok) {
      console.error(`Failed to fetch existing collections: ${response.status} - ${body}`);
      break;
    }
    
    const result = JSON.parse(body);
    const collections = result.smart_collections || [];
    
    for (const collection of collections) {
      existingCollections.set(collection.title.toLowerCase(), String(collection.id));
    }
    
    const linkHeader = response.headers.get('Link');
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/page_info=([^>&]+).*rel="next"/);
      pageInfo = match ? match[1] : null;
      hasMorePages = !!pageInfo;
    } else {
      hasMorePages = false;
    }
  }
  
  console.log(`Found ${existingCollections.size} existing Shopify collections`);

  let processed = 0;
  let errors = 0;
  const errorDetails: { externalId: string; message: string }[] = [];

  for (const category of pendingCategories) {
    try {
      const collectionTitle = category.name;
      const titleLower = collectionTitle.toLowerCase();
      
      let shopifyId: string;
      
      if (existingCollections.has(titleLower)) {
        shopifyId = existingCollections.get(titleLower)!;
        console.log(`Collection "${collectionTitle}" already exists, reusing`);
      } else {
        const tag = category.shopify_tag || category.name;
        
        const collectionPayload = {
          smart_collection: {
            title: collectionTitle,
            rules: [{
              column: 'tag',
              relation: 'equals',
              condition: tag,
            }],
            published: true,
          }
        };

        const { response, body } = await shopifyFetch(`${shopifyUrl}/smart_collections.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify(collectionPayload),
        }, 5, { entityType: 'categories' });

        if (!response.ok) {
          if (response.status === 422 && body.includes('already exists')) {
            console.log(`Collection "${collectionTitle}" created concurrently, fetching...`);
            const { response: retrySearch, body: retryBody } = await shopifyFetch(
              `${shopifyUrl}/smart_collections.json?title=${encodeURIComponent(collectionTitle)}`,
              { headers: { 'X-Shopify-Access-Token': token } },
              3,
              { entityType: 'categories' }
            );
            if (retrySearch.ok) {
              const retryResult = JSON.parse(retryBody);
              const existing = retryResult.smart_collections?.find(
                (c: any) => c.title.toLowerCase() === titleLower
              );
              if (existing) {
                shopifyId = String(existing.id);
                existingCollections.set(titleLower, shopifyId);
              } else {
                throw new Error(`Collection "${collectionTitle}" exists but could not be found`);
              }
            } else {
              throw new Error(`Shopify API error: ${response.status} - ${body}`);
            }
          } else {
            throw new Error(`Shopify API error: ${response.status} - ${body}`);
          }
        } else {
          const result = JSON.parse(body);
          shopifyId = String(result.smart_collection.id);
          existingCollections.set(titleLower, shopifyId);
          console.log(`Created collection "${collectionTitle}" with ID ${shopifyId}`);
        }
      }

      await supabase
        .from('canonical_categories')
        .update({
          status: 'uploaded',
          shopify_collection_id: shopifyId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', category.id);

      processed++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error uploading category "${category.name}":`, errorMessage);
      
      await supabase
        .from('canonical_categories')
        .update({
          status: 'failed',
          error_message: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', category.id);

      errorDetails.push({ externalId: category.external_id, message: errorMessage });
      errors++;
    }
  }

  const { count: remainingCount } = await supabase
    .from('canonical_categories')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .eq('exclude', false);

  return {
    success: true,
    processed,
    errors,
    hasMore: (remainingCount || 0) > 0,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
  };
}

// ============================================================================
// ORDER UPLOAD LOGIC
// ============================================================================

// Caches for order processing
const orderCustomerCache: Map<string, string> = new Map();
const orderProductVariantCache: Map<string, string> = new Map();
const orderShopifyCustomerEmailCache: Map<string, string> = new Map();

async function preloadOrderCustomerCache(supabase: any, projectId: string, externalIds: string[]) {
  if (externalIds.length === 0) return;
  
  const { data: customers } = await supabase
    .from('canonical_customers')
    .select('external_id, shopify_id, data')
    .eq('project_id', projectId)
    .in('external_id', externalIds)
    .not('shopify_id', 'is', null);
  
  if (customers) {
    for (const c of customers) {
      if (c.shopify_id) {
        orderCustomerCache.set(c.external_id, c.shopify_id);
        if (c.data?.email) {
          orderShopifyCustomerEmailCache.set(c.data.email.toLowerCase(), c.shopify_id);
        }
      }
    }
  }
}

function normalizePhoneNumber(phone: string | null | undefined, country: string | null | undefined): string | null {
  if (!phone) return null;
  
  let cleaned = phone.replace(/[^\d+]/g, '');
  
  if (!cleaned.startsWith('+')) {
    const countryCode = (country || '').toUpperCase();
    const prefixes: Record<string, string> = {
      'DK': '+45', 'DENMARK': '+45', 'DANMARK': '+45',
      'SE': '+46', 'SWEDEN': '+46', 'SVERIGE': '+46',
      'NO': '+47', 'NORWAY': '+47', 'NORGE': '+47',
      'DE': '+49', 'GERMANY': '+49', 'DEUTSCHLAND': '+49',
      'GB': '+44', 'UK': '+44', 'UNITED KINGDOM': '+44',
      'US': '+1', 'USA': '+1', 'UNITED STATES': '+1',
    };
    
    const prefix = prefixes[countryCode] || '+45';
    cleaned = prefix + cleaned;
  }
  
  return cleaned.length >= 8 ? cleaned : null;
}

function normalizeCountryForShopify(country: string | null | undefined): string {
  if (!country) return 'DK';
  
  const upper = country.toUpperCase().trim();
  const mapping: Record<string, string> = {
    'DENMARK': 'DK', 'DANMARK': 'DK', 'DA': 'DK',
    'SWEDEN': 'SE', 'SVERIGE': 'SE',
    'NORWAY': 'NO', 'NORGE': 'NO',
    'GERMANY': 'DE', 'DEUTSCHLAND': 'DE',
    'UNITED KINGDOM': 'GB', 'UK': 'GB', 'GREAT BRITAIN': 'GB',
    'UNITED STATES': 'US', 'USA': 'US', 'AMERICA': 'US',
    'FRANCE': 'FR', 'FRANKRIG': 'FR',
    'NETHERLANDS': 'NL', 'HOLLAND': 'NL',
    'SPAIN': 'ES', 'SPANIEN': 'ES',
    'ITALY': 'IT', 'ITALIEN': 'IT',
    'AUSTRIA': 'AT', 'ØSTRIG': 'AT',
    'BELGIUM': 'BE', 'BELGIEN': 'BE',
    'SWITZERLAND': 'CH', 'SCHWEIZ': 'CH',
    'POLAND': 'PL', 'POLEN': 'PL',
    'FINLAND': 'FI', 'SUOMI': 'FI',
    'PORTUGAL': 'PT',
    'IRELAND': 'IE', 'IRLAND': 'IE',
    'GREECE': 'GR', 'GRÆKENLAND': 'GR',
    'CZECH REPUBLIC': 'CZ', 'CZECHIA': 'CZ',
  };
  
  return mapping[upper] || (upper.length === 2 ? upper : 'DK');
}

function buildShopifyAddress(addr: any, fallbackPhone: string | null) {
  if (!addr) return null;
  
  const country = normalizeCountryForShopify(addr.country);
  const phone = normalizePhoneNumber(addr.phone || fallbackPhone, country);
  
  return {
    address1: addr.address1 || '',
    address2: addr.address2 || '',
    city: addr.city || '',
    zip: addr.zip || '',
    country_code: country,
    phone: phone,
  };
}

function hasMeaningfulAddress(addr: any): boolean {
  if (!addr) return false;
  return !!(addr.address1 || addr.city || addr.zip);
}

async function findShopifyCustomerIdByEmail(email: string, shopifyUrl: string, token: string): Promise<string | null> {
  const lowerEmail = email.toLowerCase();
  
  if (orderShopifyCustomerEmailCache.has(lowerEmail)) {
    return orderShopifyCustomerEmailCache.get(lowerEmail)!;
  }
  
  const { response, body } = await shopifyFetch(
    `${shopifyUrl}/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`,
    { headers: { 'X-Shopify-Access-Token': token } },
    3,
    { entityType: 'customers' }
  );
  
  if (response.ok) {
    const result = JSON.parse(body);
    const customers = result.customers || [];
    if (customers.length > 0) {
      const id = String(customers[0].id);
      orderShopifyCustomerEmailCache.set(lowerEmail, id);
      return id;
    }
  }
  
  return null;
}

async function uploadCustomer(shopifyUrl: string, token: string, data: any): Promise<{ shopifyId: string | null; wasExisting: boolean }> {
  const email = String(data.email || '').trim().toLowerCase();
  
  // Search by email first
  if (email) {
    const existingId = await findShopifyCustomerIdByEmail(email, shopifyUrl, token);
    if (existingId) {
      console.log(`Customer ${email} already exists in Shopify (ID: ${existingId}), skipping`);
      return { shopifyId: existingId, wasExisting: true };
    }
  }
  
  // Search by phone if no email match
  const phone = normalizePhoneNumber(data.phone, data.country);
  if (phone) {
    const { response: phoneSearch, body: phoneBody } = await shopifyFetch(
      `${shopifyUrl}/customers/search.json?query=phone:${encodeURIComponent(phone)}&limit=1`,
      { headers: { 'X-Shopify-Access-Token': token } },
      3,
      { entityType: 'customers' }
    );
    
    if (phoneSearch.ok) {
      const result = JSON.parse(phoneBody);
      if (result.customers?.length > 0) {
        const existingId = String(result.customers[0].id);
        console.log(`Customer with phone ${phone} already exists (ID: ${existingId}), skipping`);
        return { shopifyId: existingId, wasExisting: true };
      }
    }
  }
  
  // Create new customer
  const customerPayload: any = {
    customer: {
      email: email || undefined,
      first_name: data.first_name || '',
      last_name: data.last_name || '',
      phone: phone,
      accepts_marketing: data.accepts_marketing || false,
      tags: 'imported,dandomain',
    }
  };
  
  // Add addresses
  const addresses: any[] = [];
  if (data.addresses && Array.isArray(data.addresses)) {
    for (const addr of data.addresses) {
      if (hasMeaningfulAddress(addr)) {
        const shopifyAddr = buildShopifyAddress(addr, data.phone);
        if (shopifyAddr) {
          addresses.push({
            ...shopifyAddr,
            first_name: data.first_name || '',
            last_name: data.last_name || '',
            company: data.company || '',
          });
        }
      }
    }
  }
  
  if (addresses.length > 0) {
    customerPayload.customer.addresses = addresses;
  }
  
  const { response, body } = await shopifyFetch(`${shopifyUrl}/customers.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(customerPayload),
  }, 5, { entityType: 'customers' });
  
  if (!response.ok) {
    // Handle duplicate
    if (response.status === 422 && (body.includes('has already been taken') || body.includes('Email has already been taken'))) {
      console.log(`Customer ${email || phone} was created concurrently, searching...`);
      if (email) {
        const existingId = await findShopifyCustomerIdByEmail(email, shopifyUrl, token);
        if (existingId) {
          return { shopifyId: existingId, wasExisting: true };
        }
      }
    }
    throw new Error(`Failed to create customer: ${response.status} - ${body}`);
  }
  
  const result = JSON.parse(body);
  const shopifyId = String(result.customer.id);
  
  if (email) {
    orderShopifyCustomerEmailCache.set(email, shopifyId);
  }
  
  console.log(`Created customer ${email || phone} with ID ${shopifyId}`);
  return { shopifyId, wasExisting: false };
}

async function uploadOrder(shopifyUrl: string, token: string, data: any, supabase: any, projectId: string): Promise<string | null> {
  const customerExternalId = data.customer_external_id;
  const customerEmail = data.customer_email?.toLowerCase();
  
  // Resolve customer ID
  let customerId: string | null = null;
  
  // Check cache first
  if (customerExternalId && orderCustomerCache.has(customerExternalId)) {
    customerId = orderCustomerCache.get(customerExternalId)!;
  } else if (customerEmail && orderShopifyCustomerEmailCache.has(customerEmail)) {
    customerId = orderShopifyCustomerEmailCache.get(customerEmail)!;
  }
  
  // Search Shopify by email if not cached
  if (!customerId && customerEmail) {
    customerId = await findShopifyCustomerIdByEmail(customerEmail, shopifyUrl, token);
    if (customerId && customerExternalId) {
      orderCustomerCache.set(customerExternalId, customerId);
    }
  }
  
  // Build line items
  const lineItems: any[] = [];
  for (const item of (data.line_items || [])) {
    lineItems.push({
      title: item.title || 'Unknown Product',
      quantity: item.quantity || 1,
      price: String(item.price || 0),
      sku: item.sku || '',
      requires_shipping: true,
      taxable: true,
    });
  }
  
  if (lineItems.length === 0) {
    throw new Error('Ingen linjer i ordren');
  }
  
  // Build addresses
  const billingAddress = hasMeaningfulAddress(data.billing_address) 
    ? buildShopifyAddress(data.billing_address, data.customer_phone)
    : null;
  
  const shippingAddress = hasMeaningfulAddress(data.shipping_address)
    ? buildShopifyAddress(data.shipping_address, data.customer_phone)
    : billingAddress;
  
  // Build order payload
  const orderPayload: any = {
    order: {
      line_items: lineItems,
      financial_status: mapFinancialStatus(data.financial_status),
      fulfillment_status: mapFulfillmentStatus(data.fulfillment_status),
      currency: data.currency || 'DKK',
      created_at: data.order_date || new Date().toISOString(),
      tags: 'imported,dandomain',
      send_receipt: false,
      send_fulfillment_receipt: false,
      inventory_behaviour: 'bypass',
    }
  };
  
  if (customerId) {
    orderPayload.order.customer = { id: parseInt(customerId, 10) };
  } else if (customerEmail) {
    orderPayload.order.email = customerEmail;
  }
  
  if (billingAddress) {
    orderPayload.order.billing_address = {
      ...billingAddress,
      first_name: data.customer_first_name || '',
      last_name: data.customer_last_name || '',
    };
  }
  
  if (shippingAddress) {
    orderPayload.order.shipping_address = {
      ...shippingAddress,
      first_name: data.customer_first_name || '',
      last_name: data.customer_last_name || '',
    };
  }
  
  // Add shipping
  if (data.shipping_price && parseFloat(String(data.shipping_price)) > 0) {
    orderPayload.order.shipping_lines = [{
      title: 'Shipping',
      price: String(data.shipping_price),
      code: 'STANDARD',
    }];
  }
  
  // Add discounts
  if (data.discount_total && parseFloat(String(data.discount_total)) > 0) {
    orderPayload.order.discount_codes = [{
      code: 'IMPORT_DISCOUNT',
      amount: String(data.discount_total),
      type: 'fixed_amount',
    }];
  }
  
  const { response, body } = await shopifyFetch(`${shopifyUrl}/orders.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(orderPayload),
  }, 5, { entityType: 'orders' });
  
  if (!response.ok) {
    throw new Error(`Failed to create order: ${response.status} - ${body}`);
  }
  
  const result = JSON.parse(body);
  return String(result.order.id);
}

async function uploadPage(shopifyUrl: string, token: string, data: any): Promise<string | null> {
  const pagePayload = {
    page: {
      title: data.title || 'Untitled Page',
      body_html: data.body_html || '',
      published: data.published !== false,
      handle: data.slug || undefined,
    }
  };
  
  const { response, body } = await shopifyFetch(`${shopifyUrl}/pages.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(pagePayload),
  }, 5, { entityType: 'pages' });
  
  if (!response.ok) {
    throw new Error(`Failed to create page: ${response.status} - ${body}`);
  }
  
  const result = JSON.parse(body);
  return String(result.page.id);
}

function mapFinancialStatus(status: string | null | undefined): string {
  if (!status) return 'paid';
  
  const lower = status.toLowerCase();
  const mapping: Record<string, string> = {
    'paid': 'paid',
    'betalt': 'paid',
    'pending': 'pending',
    'afventer': 'pending',
    'authorized': 'authorized',
    'partially_paid': 'partially_paid',
    'refunded': 'refunded',
    'voided': 'voided',
  };
  
  return mapping[lower] || 'paid';
}

function mapFulfillmentStatus(status: string | null | undefined): string | null {
  if (!status) return 'fulfilled';
  
  const lower = status.toLowerCase();
  const mapping: Record<string, string | null> = {
    'fulfilled': 'fulfilled',
    'afsendt': 'fulfilled',
    'shipped': 'fulfilled',
    'delivered': 'fulfilled',
    'leveret': 'fulfilled',
    'unfulfilled': null,
    'pending': null,
    'afventer': null,
    'partial': 'partial',
    'partially_fulfilled': 'partial',
  };
  
  return mapping[lower] ?? 'fulfilled';
}
