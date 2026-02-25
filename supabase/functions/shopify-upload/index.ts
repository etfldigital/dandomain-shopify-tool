import { createClient } from "npm:@supabase/supabase-js@2.90.1";


const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// SHOPIFY RATE LIMITING - SIMPLIFIED & ROBUST
// ============================================================================

let shopifyBucketUsed = 0;
let lastBucketUpdate = Date.now();

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

function getCurrentBucketUsage(): number {
  const elapsed = (Date.now() - lastBucketUpdate) / 1000;
  const leaked = Math.floor(elapsed * 2);
  return Math.max(0, shopifyBucketUsed - leaked);
}

function getPreRequestDelay(entityType?: string): number {
  const usage = getCurrentBucketUsage();
  // 80% of 40-bucket = 32. Pause aggressively when close to limit.
  if (usage >= 38) return 2000;
  if (usage >= 35) return 1000;
  if (usage >= 32) return 500;  // 80% threshold
  if (usage >= 28) return 200;
  return 0;
}

// Returns true if bucket is above 80% full (should pause new requests)
function isBucketHot(): boolean {
  return getCurrentBucketUsage() >= 32; // 80% of 40
}

// Simple concurrency limiter (like p-limit)
function createConcurrencyLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (queue.length > 0 && active < concurrency) {
      active++;
      const resolve = queue.shift()!;
      resolve();
    }
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // Wait for bucket to cool down before acquiring slot
    while (isBucketHot()) {
      await sleep(500);
    }

    await new Promise<void>((resolve) => {
      queue.push(resolve);
      next();
    });

    try {
      return await fn();
    } finally {
      active--;
      next();
    }
  };
}

async function shopifyFetch(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  entityType?: string
): Promise<{ response: Response; body: string } | { rateLimited: true; retryAfterMs: number }> {
  const preDelay = getPreRequestDelay(entityType);
  if (preDelay > 0) await sleep(preDelay);
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      const body = await response.text();
      updateBucketFromHeaders(response);
      
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const requestStartTime = Date.now();
  const TIME_BUDGET_MS = 50_000;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { projectId, entityType, batchSize = 10 }: ShopifyUploadRequest = await req.json();

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projectError || !project) throw new Error('Project not found');
    if (!project.shopify_store_domain || !project.shopify_access_token_encrypted) {
      throw new Error('Shopify credentials not configured');
    }

    const shopifyDomain = project.shopify_store_domain;
    const shopifyToken = project.shopify_access_token_encrypted;
    const dandomainBaseUrl = String(project.dandomain_base_url || project.dandomain_shop_url || '').trim();
    const shopifyUrl = `https://${shopifyDomain}/admin/api/2024-01`;

    if (entityType === 'products') {
      const result = await uploadProducts(supabase, projectId, shopifyUrl, shopifyToken, batchSize, dandomainBaseUrl, requestStartTime, TIME_BUDGET_MS);
      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    if (entityType === 'categories') {
      const result = await uploadCategories(supabase, projectId, shopifyUrl, shopifyToken, batchSize, requestStartTime, TIME_BUDGET_MS);
      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    if (entityType === 'customers') {
      const result = await uploadCustomers(supabase, projectId, shopifyUrl, shopifyToken, batchSize, requestStartTime, TIME_BUDGET_MS);
      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    if (entityType === 'orders') {
      const result = await uploadOrders(supabase, projectId, shopifyUrl, shopifyToken, batchSize, requestStartTime, TIME_BUDGET_MS);
      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    if (entityType === 'pages') {
      const result = await uploadPages(supabase, projectId, shopifyUrl, shopifyToken, batchSize, requestStartTime, TIME_BUDGET_MS);
      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    throw new Error(`Unknown entity type: ${entityType}`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SHOPIFY-UPLOAD] Fatal error:', errorMessage);
    return new Response(JSON.stringify({ success: false, error: errorMessage }), { 
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});

// ============================================================================
// PRODUCT UPLOAD
// ============================================================================

const sessionProductCache: Map<string, string> = new Map();
let categoryTagCache: Map<string, string> = new Map();
const skuToShopifyMap: Map<string, { productId: string; variantId: string }> = new Map();

// Lock duration: 2 minutes - if a worker crashes, the lock expires and another can take over
const LOCK_DURATION_MS = 2 * 60 * 1000;

type VendorExtractionMode = 'none' | 'extract_from_title';

type ProductTransformationRules = {
  stripVendorFromTitle: boolean;
  vendorSeparator: string;
  vendorExtractionMode: VendorExtractionMode;
  useSpecialOfferPrice: boolean;
  inheritProductBarcode: boolean;
};

const defaultProductTransformationRules: ProductTransformationRules = {
  stripVendorFromTitle: true,
  vendorSeparator: ' - ',
  vendorExtractionMode: 'none',
  useSpecialOfferPrice: false,
  inheritProductBarcode: false,
};

async function loadProductTransformationRules(supabase: any, projectId: string): Promise<ProductTransformationRules> {
  try {
    const { data, error } = await supabase
      .from('mapping_profiles')
      .select('mappings')
      .eq('project_id', projectId)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !data?.mappings) return defaultProductTransformationRules;

    const mappings = Array.isArray(data.mappings) ? data.mappings : [];
    const rules = mappings.find((m: any) => m?.type === 'transformationRules')?.rules as any;

    const stripVendorFromTitle =
      typeof rules?.stripVendorFromTitle === 'boolean'
        ? rules.stripVendorFromTitle
        : defaultProductTransformationRules.stripVendorFromTitle;

    const vendorSeparator =
      typeof rules?.vendorSeparator === 'string' && rules.vendorSeparator.trim().length > 0
        ? rules.vendorSeparator
        : defaultProductTransformationRules.vendorSeparator;

    const vendorExtractionMode: VendorExtractionMode =
      rules?.vendorExtractionMode === 'extract_from_title' ? 'extract_from_title' : 'none';

    const useSpecialOfferPrice = mappings.some(
      (m: any) => m?.type === 'field' && m?.sourceField === 'SPECIAL_OFFER_PRICE'
    );

    const inheritProductBarcode =
      typeof rules?.inheritProductBarcode === 'boolean'
        ? rules.inheritProductBarcode
        : defaultProductTransformationRules.inheritProductBarcode;

    return { stripVendorFromTitle, vendorSeparator, vendorExtractionMode, useSpecialOfferPrice, inheritProductBarcode };
  } catch (e) {
    console.warn('[PRODUCTS] Failed to load transformation rules, using defaults:', e);
    return defaultProductTransformationRules;
  }
}

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

function getCategoryTagsForProduct(categoryExternalIds: string[], categoryCache: Map<string, string>): string[] {
  const tags: string[] = [];
  for (const catId of categoryExternalIds) {
    const shopifyTag = categoryCache.get(String(catId));
    if (shopifyTag && !tags.includes(shopifyTag)) tags.push(shopifyTag);
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
  
  categoryTagCache = await loadCategoryTags(supabase, projectId);
  const transformationRules = await loadProductTransformationRules(supabase, projectId);
  
  // ============================================================================
  // STEP 1: Clear expired locks from crashed workers
  // ============================================================================
  const now = new Date();
  await supabase
    .from('canonical_products')
    .update({ 
      upload_lock_id: null, 
      upload_locked_at: null, 
      upload_locked_until: null 
    })
    .eq('project_id', projectId)
    .lt('upload_locked_until', now.toISOString());

  // ============================================================================
  // STEP 2: Fetch unlocked, pending, PRIMARY products directly
  // ============================================================================
  // CRITICAL: Filter for _isPrimary=true in the query itself, not in JS.
  // Otherwise we may fetch a page full of secondary variants and find zero primaries.
  const { data: primaryProducts, error: fetchError } = await supabase
    .from('canonical_products')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .eq('data->>_isPrimary', 'true')
    .is('upload_lock_id', null)  // Not locked by another worker
    .order('created_at', { ascending: true })
    .limit(batchSize * 2);

  if (fetchError) throw new Error(`Failed to fetch products: ${fetchError.message}`);
  if (!primaryProducts || primaryProducts.length === 0) {
    console.log('[PRODUCTS] No prepared primary products found - prepare-upload needs to run first');
    return { success: true, processed: 0, errors: 0, skipped: 0, hasMore: true };
  }

  // Each primary product is its OWN group (variants are in _mergedVariants)
  const productGroups: Map<string, any[]> = new Map();
  for (const product of primaryProducts) {
    productGroups.set(product.id, [product]);
  }
  
  let processed = 0;
  let errors = 0;
  let skipped = 0;
  const errorDetails: { externalId: string; message: string }[] = [];
  let groupsProcessed = 0;
  let rateLimited = false;
  let retryAfterSeconds = 0;

  for (const [groupKey, items] of productGroups) {
    if (Date.now() - startTime > timeBudget) {
      console.log(`[PRODUCTS] Time budget reached after ${groupsProcessed} groups`);
      break;
    }
    if (groupsProcessed >= batchSize) break;
    groupsProcessed++;

    try {
      const result = await processProductGroup(
        supabase,
        shopifyUrl,
        token,
        groupKey,
        items,
        dandomainBaseUrl,
        projectId,
        transformationRules
      );
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
      
      const ids = items.map((it: any) => it.id);
      await supabase
        .from('canonical_products')
        .update({ 
          status: 'failed', 
          error_message: msg, 
          upload_lock_id: null,
          upload_locked_at: null,
          upload_locked_until: null,
          updated_at: new Date().toISOString() 
        })
        .in('id', ids);
      
      errors += items.length;
      for (const item of items) {
        errorDetails.push({ externalId: item.external_id, message: msg });
      }
    }
  }

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

function groupProductsByTitle(products: any[]): Map<string, any[]> {
  const groups: Map<string, any[]> = new Map();
  
  for (const product of products) {
    const data = product.data || {};
    const title = String(data._groupTitle || data.title || '').trim();
    const vendor = String(data.vendor || '').trim();

    const preKey = String(data._groupKey || '').trim();
    if (preKey) {
      const key = preKey.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(product);
      continue;
    }
    
    let transformedTitle = title;
    if (vendor && title.toLowerCase().startsWith(vendor.toLowerCase())) {
      transformedTitle = title.substring(vendor.length).replace(/^[\s\-–—:]+/, '').trim();
    }
    if (!transformedTitle) transformedTitle = title;
    transformedTitle = transformedTitle.replace(/\s+/g, ' ').trim();
    
    const groupKey = transformedTitle.toLowerCase();
    if (!groups.has(groupKey)) groups.set(groupKey, []);
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
  dandomainBaseUrl: string,
  projectId: string,
  rules: ProductTransformationRules
): Promise<{ skipped?: boolean; error?: string; rateLimited?: boolean; retryAfterMs?: number }> {
  
  const data = items[0].data || {};
  const originalTitle = String(data.title || '').trim();
  const groupedTitle = String(data._groupTitle || originalTitle || '').trim();

  const allowTitleTransform = rules.stripVendorFromTitle || rules.vendorExtractionMode === 'extract_from_title';

  // If title transforms are disabled ("Brug eksisterende vendor felt"), keep the title exactly as-is.
  const title = allowTitleTransform ? groupedTitle : originalTitle;

  const vendor = String(data.vendor || '').trim();
  const dbGroupKey = String(data._groupKey || '').trim().toLowerCase();
  const primaryItem = items[0];
  
  // ============================================================================
  // PHASE 1: ATOMIC LOCK ACQUISITION
  // Generate a unique lock ID and try to claim this product.
  // This uses a conditional UPDATE that only succeeds if:
  // 1. Status is still 'pending'
  // 2. No shopify_id exists
  // 3. No lock exists OR lock has expired
  // ============================================================================
  const lockId = crypto.randomUUID();
  const lockUntil = new Date(Date.now() + LOCK_DURATION_MS);

  // IMPORTANT: Avoid PostgREST `.or(...)` with ISO timestamps inside the string.
  // In practice this can lead to parsing issues and a silent "skip everything" behavior.
  // We instead do a two-step acquisition:
  // 1) try claim when unlocked
  // 2) if that fails, try claim when lock is expired
  const lockUpdate = {
    upload_lock_id: lockId,
    upload_locked_at: new Date().toISOString(),
    upload_locked_until: lockUntil.toISOString(),
    error_message: 'Processing...'
  };

  const tryAcquireLock = async (mode: 'unlocked' | 'expired') => {
    let q = supabase
      .from('canonical_products')
      .update(lockUpdate)
      .eq('id', primaryItem.id)
      .eq('status', 'pending')
      .is('shopify_id', null);

    if (mode === 'unlocked') {
      q = q.is('upload_lock_id', null);
    } else {
      q = q.lt('upload_locked_until', new Date().toISOString());
    }

    return await q.select('id');
  };

  let lockResult: any[] | null = null;
  let lockError: any = null;

  ({ data: lockResult, error: lockError } = await tryAcquireLock('unlocked'));

  // Only try the "expired" path if the first attempt didn't acquire anything.
  if ((!lockResult || lockResult.length === 0) && !lockError) {
    ({ data: lockResult, error: lockError } = await tryAcquireLock('expired'));
  }

  if (lockError) {
    console.warn(
      `[PRODUCTS] Lock acquisition error for "${dbGroupKey || title || primaryItem.id}": ${lockError.message || String(lockError)}`
    );
  }

  if (!lockResult || lockResult.length === 0) {
    console.log(`[PRODUCTS] Failed to acquire lock for "${dbGroupKey || primaryItem.id}" - another worker owns it`);
    return { skipped: true };
  }
  
  console.log(`[PRODUCTS] Acquired lock ${lockId} for "${dbGroupKey || title}"`);

  // ============================================================================
  // PHASE 2: CHECK IF GROUP ALREADY UPLOADED (post-lock)
  // Now that we own the lock, double-check if any record with same _groupKey
  // already has a shopify_id. This handles the race where another worker
  // completed between our fetch and lock acquisition.
  // ============================================================================
  if (dbGroupKey) {
    const { data: groupRecords, error: groupCheckError } = await supabase
      .from('canonical_products')
      .select('id, shopify_id')
      .eq('project_id', projectId)
      .not('shopify_id', 'is', null)
      .limit(500);
    
    if (!groupCheckError && groupRecords) {
      // Filter in JS since JSONB filtering in Supabase can be tricky
      const matchingWithShopifyId = groupRecords.filter((r: any) => {
        // We need to check the data column - but we didn't select it
        // Instead, we'll do a targeted query
        return false; // Will use a different approach
      });
    }
    
    // More reliable: Query specifically for this group key
    const { data: existingInGroup } = await supabase
      .from('canonical_products')
      .select('shopify_id, data')
      .eq('project_id', projectId)
      .not('shopify_id', 'is', null);
    
    if (existingInGroup) {
      const matchingRecord = existingInGroup.find((r: any) => {
        const rGroupKey = String(r.data?._groupKey || '').trim().toLowerCase();
        return rGroupKey === dbGroupKey && r.shopify_id;
      });
      
      if (matchingRecord?.shopify_id) {
        const existingShopifyId = matchingRecord.shopify_id;
        console.log(`[PRODUCTS] Group "${dbGroupKey}" already has shopify_id ${existingShopifyId} in database, marking and skipping`);
        
        // Release lock and mark as uploaded
        await supabase
          .from('canonical_products')
          .update({ 
            status: 'uploaded', 
            shopify_id: existingShopifyId, 
            error_message: 'Sprunget over: Produkt allerede oprettet i Shopify',
            upload_lock_id: null,
            upload_locked_at: null,
            upload_locked_until: null,
            updated_at: new Date().toISOString() 
          })
          .eq('id', primaryItem.id);
        
        return { skipped: true };
      }
    }
  }
  
  // ============================================================================
  // PHASE 3: PREPARE PRODUCT DATA
  // ============================================================================
  const normalizeBrand = (s: string) => s.toLowerCase().replace(/[+&]/g, ' ').replace(/\s+/g, ' ').trim();

  // Apply title stripping only when the user's transformation rules allow it.
  // When "Brug eksisterende vendor felt" is selected in the UI, we persist stripVendorFromTitle=false,
  // and we must NOT modify the product title during upload.
  let transformedTitle = title;
  if (allowTitleTransform && vendor) {
    const normalizedVendor = normalizeBrand(vendor);

    const separators = Array.from(
      new Set([
        rules.vendorSeparator,
        ' - ',
        ' – ',
        ' — ',
        ': ',
        ' | ',
      ].filter((s) => typeof s === 'string' && s.length > 0))
    );

    let stripped = false;

    for (const sep of separators) {
      const sepIndex = title.indexOf(sep);
      if (sepIndex > 0 && sepIndex < 60) {
        const prefix = title.slice(0, sepIndex).trim();
        const normalizedPrefix = normalizeBrand(prefix);

        if (
          normalizedPrefix === normalizedVendor ||
          normalizedVendor.startsWith(normalizedPrefix + ' ') ||
          normalizedVendor.startsWith(normalizedPrefix)
        ) {
          const rest = title.slice(sepIndex + sep.length).trim();
          if (rest) {
            transformedTitle = rest;
            stripped = true;
            break;
          }
        }
      }
    }

    if (!stripped && normalizeBrand(title).startsWith(normalizedVendor)) {
      const rest = title.substring(vendor.length).replace(/^[\s\-–—:]+/, '').trim();
      if (rest) transformedTitle = rest;
    }
  }

  transformedTitle = transformedTitle.replace(/\s+/g, ' ').trim();
  const titleLower = transformedTitle.toLowerCase();
  
  // Check session cache (secondary check)
  if (sessionProductCache.has(titleLower)) {
    const existingId = sessionProductCache.get(titleLower)!;
    console.log(`[PRODUCTS] "${transformedTitle}" already in session cache, skipping`);
    
    await supabase
      .from('canonical_products')
      .update({ 
        status: 'uploaded', 
        shopify_id: existingId, 
        error_message: 'Sprunget over: Variant grupperet med andet produkt',
        upload_lock_id: null,
        upload_locked_at: null,
        upload_locked_until: null,
        updated_at: new Date().toISOString() 
      })
      .eq('id', primaryItem.id);
    
    return { skipped: true };
  }

  // Build variants
  const primaryData = items.find((it) => (it.data || {})._isPrimary === true)?.data || data;
  const mergedVariants = Array.isArray(primaryData._mergedVariants) ? primaryData._mergedVariants : null;
  const expectedVariantCount = primaryData._variantCount || 1;

  if (mergedVariants && mergedVariants.length > 0) {
    if (expectedVariantCount > 1 && mergedVariants.length !== expectedVariantCount) {
      console.error(`[PRODUCTS] VARIANT MISMATCH: "${transformedTitle}" expects ${expectedVariantCount} variants but has ${mergedVariants.length} in _mergedVariants`);
    }
  } else if (expectedVariantCount > 1) {
    console.error(`[PRODUCTS] MISSING VARIANTS: "${transformedTitle}" expects ${expectedVariantCount} variants but _mergedVariants is empty or missing`);
  }

  type VariantCandidate = {
    option1: string | null;
    sku: string;
    price: string;
    compare_at_price: string | null;
    inventory_quantity: number;
    weight: number;
    barcode?: string;
    noVariantOption?: boolean;
  };

  const variantByOption: Map<string, VariantCandidate> = new Map();

  if (mergedVariants && mergedVariants.length > 0) {
    for (const mv of mergedVariants) {
      const sku = String(mv?.sku || '').trim();
      const hasNoVariantOption = mv?.noVariantOption === true;
      // Re-extract size from SKU to pick up compound sizes (e.g. S-M, L-XL)
      // that may have been stored incorrectly by older prepare-upload versions
      const reExtracted = sku ? extractSizeFromSku(sku) : null;
      const bestSize = reExtracted || String(mv?.size || '');
      const option1 = hasNoVariantOption ? null : normalizeSizeOption(bestSize);
      const dedupeKey = option1 ?? `__no_option_${sku}`;
      if (variantByOption.has(dedupeKey)) continue;

      const v: VariantCandidate = {
        option1,
        sku,
        price: String(mv?.price ?? '0'),
        compare_at_price: mv?.compareAtPrice ? String(mv.compareAtPrice) : null,
        inventory_quantity: parseInt(String(mv?.stockQuantity ?? 0), 10),
        weight: mv?.weight ? parseFloat(String(mv.weight)) : 0,
        noVariantOption: hasNoVariantOption,
      };
      if (mv?.barcode) v.barcode = String(mv.barcode);
      variantByOption.set(dedupeKey, v);
    }
  } else {
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
        price: rules.useSpecialOfferPrice
          ? String(itemData.special_offer_price || itemData.price || '0')
          : String(
              itemData.compare_at_price && parseFloat(String(itemData.compare_at_price)) > parseFloat(String(itemData.price || '0'))
                ? itemData.compare_at_price
                : itemData.price || '0'
            ),
        compare_at_price: rules.useSpecialOfferPrice
          ? (itemData.special_offer_price ? String(itemData.compare_at_price || itemData.price || '0') : null)
          : null,
        inventory_quantity: parseInt(String(itemData.stock_quantity || 0), 10),
        weight: itemData.weight ? parseFloat(String(itemData.weight)) : 0,
      };
      if (itemData.barcode) v.barcode = String(itemData.barcode);
      variantByOption.set(option1, v);
    }
  }

  const hasNoVariantOption = Array.from(variantByOption.values()).some(v => v.noVariantOption === true);

  const variants: any[] = Array.from(variantByOption.values()).map((v) => {
    const variantData: any = {
      sku: v.sku,
      price: v.price,
      compare_at_price: v.compare_at_price,
      inventory_management: 'shopify',
      inventory_quantity: v.inventory_quantity,
      weight: v.weight,
      weight_unit: 'kg',
      requires_shipping: true,
      ...(v.barcode ? { barcode: v.barcode } : {}),
    };
    
    if (!v.noVariantOption && v.option1) {
      variantData.option1 = v.option1;
    }
    
    return variantData;
  });

  // ============================================================================
  // BARCODE INHERITANCE: Apply product-level barcode to variants missing one
  // Only when the toggle is enabled in migration rules
  // ============================================================================
  if (rules.inheritProductBarcode) {
    const productBarcode = String(primaryData.barcode || '').trim();
    if (productBarcode) {
      let inherited = 0;
      for (const v of variants) {
        if (!v.barcode || String(v.barcode).trim() === '') {
          v.barcode = productBarcode;
          inherited++;
        }
      }
      if (inherited > 0) {
        console.log(`[PRODUCTS] "${transformedTitle}": Inherited product barcode "${productBarcode}" to ${inherited}/${variants.length} variant(s)`);
      }
    }
  }

  // Collect images
  const allImages: string[] = [];
  
  if (Array.isArray(primaryData._mergedImages)) {
    for (const img of primaryData._mergedImages) {
      if (img && typeof img === 'string' && !allImages.includes(img)) allImages.push(img);
    }
  }
  if (Array.isArray(primaryData.images)) {
    for (const img of primaryData.images) {
      if (img && typeof img === 'string' && !allImages.includes(img)) allImages.push(img);
    }
  }
  for (const item of items) {
    const itemImages = item.data?.images || [];
    for (const img of itemImages) {
      if (img && typeof img === 'string' && !allImages.includes(img)) allImages.push(img);
    }
  }

  console.log(`[PRODUCTS] "${transformedTitle}": Found ${allImages.length} images from merged data`);

  // Get category tags
  const categoryExternalIds: string[] = primaryData.category_external_ids || [];
  const categoryTags = getCategoryTagsForProduct(categoryExternalIds, categoryTagCache);
  if (categoryTags.length > 0) {
    console.log(`[PRODUCTS] "${transformedTitle}": Added ${categoryTags.length} category tags: ${categoryTags.join(', ')}`);
  }

  // Build tags
  const existingTags: string[] = primaryData.tags || [];
  const allTags = [...new Set([...existingTags, ...categoryTags])];

  // ============================================================================
  // PHASE 4: CREATE IN SHOPIFY
  // ============================================================================
  const hasRealVariantOptions = variants.some(v => v.option1);
  const productPayload: any = {
    product: {
      title: transformedTitle,
      body_html: primaryData.body_html || '',
      vendor: vendor || undefined,
      product_type: primaryData.product_type || '',
      status: 'active',
      tags: allTags.join(', '),
      variants: variants,
    },
  };

  if (hasRealVariantOptions) {
    productPayload.product.options = [{ name: 'Size', values: variants.map(v => v.option1).filter(Boolean) }];
  }

  console.log(`[PRODUCTS] Creating "${transformedTitle}" with ${variants.length} variant(s)`);

  const createResult = await shopifyFetch(
    `${shopifyUrl}/products.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify(productPayload),
    },
    3,
    'products'
  );

  if ('rateLimited' in createResult) {
    // Release lock on rate limit
    await supabase
      .from('canonical_products')
      .update({ 
        upload_lock_id: null,
        upload_locked_at: null,
        upload_locked_until: null,
        error_message: null
      })
      .eq('id', primaryItem.id);
    return createResult;
  }

  if (!createResult.response.ok) {
    const errorBody = createResult.body;
    
    // Handle "already exists" - try to find existing product
    if (createResult.response.status === 422 && errorBody.includes('has already been taken')) {
      console.log(`[PRODUCTS] "${transformedTitle}": Handle already exists, searching for existing product...`);
      
      const handle = generateHandle(transformedTitle);
      const searchResult = await shopifyFetch(
        `${shopifyUrl}/products.json?handle=${encodeURIComponent(handle)}`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      
      if (!('rateLimited' in searchResult) && searchResult.response.ok) {
        try {
          const searchData = JSON.parse(searchResult.body);
          if (searchData.products && searchData.products.length > 0) {
            const existingProduct = searchData.products[0];
            const existingShopifyId = String(existingProduct.id);
            
            console.log(`[PRODUCTS] "${transformedTitle}": Found existing product ${existingShopifyId}`);
            
            sessionProductCache.set(titleLower, existingShopifyId);
            
            // Update all items in this group
            await supabase
              .from('canonical_products')
              .update({ 
                status: 'uploaded', 
                shopify_id: existingShopifyId, 
                error_message: 'Produkt fandtes allerede i Shopify',
                upload_lock_id: null,
                upload_locked_at: null,
                upload_locked_until: null,
                updated_at: new Date().toISOString() 
              })
              .eq('id', primaryItem.id);
            
            // Update entire group
            if (dbGroupKey) {
              await updateEntireGroup(supabase, projectId, dbGroupKey, existingShopifyId);
            }
            
            return { skipped: true };
          }
        } catch (e) { /* ignore parse errors */ }
      }
    }
    
    const errorMsg = `Shopify API error ${createResult.response.status}: ${errorBody.slice(0, 200)}`;
    console.error(`[PRODUCTS] "${transformedTitle}": ${errorMsg}`);
    
    await supabase
      .from('canonical_products')
      .update({ 
        status: 'failed', 
        error_message: errorMsg,
        upload_lock_id: null,
        upload_locked_at: null,
        upload_locked_until: null,
        updated_at: new Date().toISOString() 
      })
      .eq('id', primaryItem.id);
    
    return { error: errorMsg };
  }

  // ============================================================================
  // PHASE 5: SUCCESS - UPDATE DATABASE
  // ============================================================================
  let responseData: any;
  try {
    responseData = JSON.parse(createResult.body);
  } catch (e) {
    const errorMsg = 'Failed to parse Shopify response';
    await supabase
      .from('canonical_products')
      .update({ 
        status: 'failed', 
        error_message: errorMsg,
        upload_lock_id: null,
        upload_locked_at: null,
        upload_locked_until: null,
        updated_at: new Date().toISOString() 
      })
      .eq('id', primaryItem.id);
    return { error: errorMsg };
  }

  const shopifyId = String(responseData.product.id);
  const shopifyVariants = responseData.product.variants || [];
  const shopifyHandle = responseData.product.handle;
  
  sessionProductCache.set(titleLower, shopifyId);

  // Map SKUs to Shopify variant IDs
  const skuMap: Record<string, string> = {};
  for (const sv of shopifyVariants) {
    if (sv.sku) skuMap[sv.sku.toLowerCase()] = String(sv.id);
    skuToShopifyMap.set(sv.sku, { productId: shopifyId, variantId: String(sv.id) });
  }
  console.log(`[PRODUCTS] "${transformedTitle}": mapped ${Object.keys(skuMap).length} variant SKUs to Shopify IDs`);

  // Add images
  if (allImages.length > 0) {
    let added = 0;
    let failed = 0;
    for (const imageUrl of allImages) {
      try {
        const normalizedUrl = normalizeImageUrl(imageUrl, dandomainBaseUrl);
        const imgResult = await shopifyFetch(
          `${shopifyUrl}/products/${shopifyId}/images.json`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({ image: { src: normalizedUrl } }),
          }
        );
        if ('rateLimited' in imgResult) {
          await sleep(imgResult.retryAfterMs);
          continue;
        }
        if (imgResult.response.ok) {
          added++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
    }
    console.log(`[PRODUCTS] "${transformedTitle}": post-create image repair done. Added=${added}, Failed=${failed}`);
  }

  // Update primary record
  const updatedData = { 
    ...primaryItem.data, 
    shopify_handle: shopifyHandle,
    _shopify_product_id: shopifyId,
  };
  
  await supabase
    .from('canonical_products')
    .update({ 
      status: 'uploaded', 
      shopify_id: shopifyId, 
      error_message: null, 
      data: updatedData,
      upload_lock_id: null,
      upload_locked_at: null,
      upload_locked_until: null,
      updated_at: new Date().toISOString() 
    })
    .eq('id', primaryItem.id);

  // ============================================================================
  // PHASE 6: UPDATE ENTIRE GROUP
  // Mark ALL records with same _groupKey as uploaded with the new shopify_id
  // ============================================================================
  if (dbGroupKey) {
    await updateEntireGroup(supabase, projectId, dbGroupKey, shopifyId);
  }
  
  console.log(`[PRODUCTS] "${transformedTitle}": Successfully uploaded as ${shopifyId}`);

  return {};
}

/**
 * Update all records in the same group with the given shopify_id.
 * Uses JS filtering since JSONB querying can be unreliable.
 */
async function updateEntireGroup(
  supabase: any, 
  projectId: string, 
  groupKey: string, 
  shopifyId: string
): Promise<void> {
  // Fetch all records without shopify_id
  const { data: allPending } = await supabase
    .from('canonical_products')
    .select('id, data')
    .eq('project_id', projectId)
    .is('shopify_id', null);
  
  if (!allPending || allPending.length === 0) return;
  
  // Filter by groupKey in JS
  const matchingIds = allPending
    .filter((r: any) => {
      const rGroupKey = String(r.data?._groupKey || '').trim().toLowerCase();
      return rGroupKey === groupKey;
    })
    .map((r: any) => r.id);
  
  if (matchingIds.length === 0) return;
  
  const { error } = await supabase
    .from('canonical_products')
    .update({ 
      status: 'uploaded', 
      shopify_id: shopifyId,
      error_message: 'Variant grupperet med primær produkt',
      upload_lock_id: null,
      upload_locked_at: null,
      upload_locked_until: null,
      updated_at: new Date().toISOString() 
    })
    .in('id', matchingIds);
  
  if (error) {
    console.warn(`[PRODUCTS] Warning: Failed to update group "${groupKey}": ${error.message}`);
  } else {
    console.log(`[PRODUCTS] Updated ${matchingIds.length} records in group "${groupKey}" with shopify_id ${shopifyId}`);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function generateHandle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeImageUrl(url: string, dandomainBaseUrl: string): string {
  if (!url) return url;
  
  // Strategy: URL-encode the path so the original filename (with spaces, parentheses, etc.)
  // is preserved but made URL-safe. The DanDomain server can still locate the file.
  // We do NOT rename the file — just encode each path segment properly.

  // Already absolute URL
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const u = new URL(url);
      // Re-encode pathname segments to fix un-encoded spaces/special chars
      u.pathname = encodePathSegments(u.pathname);
      return u.toString();
    } catch { return url; }
  }
  
  // Protocol-relative URL
  if (url.startsWith('//')) {
    try {
      const u = new URL('https:' + url);
      u.pathname = encodePathSegments(u.pathname);
      return u.toString();
    } catch { return 'https:' + url; }
  }

  const encodedPath = encodePathSegments(url);
  
  // Relative URL starting with /
  if (url.startsWith('/')) {
    if (dandomainBaseUrl) {
      let base = dandomainBaseUrl.trim().replace(/\/$/, '');
      if (!base.startsWith('http://') && !base.startsWith('https://')) {
        base = `https://${base}`;
      }
      return `${base}${encodedPath}`;
    }
    return encodedPath;
  }
  
  // Relative URL without leading /
  if (dandomainBaseUrl) {
    let base = dandomainBaseUrl.trim().replace(/\/$/, '');
    if (!base.startsWith('http://') && !base.startsWith('https://')) {
      base = `https://${base}`;
    }
    return `${base}/${encodedPath}`;
  }
  
  return encodedPath;
}

// Properly encode each segment of a URL path, preserving slashes.
// e.g. "/images/preview (4)_277722719.jpg" -> "/images/preview%20(4)_277722719.jpg"
function encodePathSegments(path: string): string {
  if (!path) return path;
  return path
    .split('/')
    .map(segment => segment ? encodeURIComponent(decodeURIComponent(segment)) : segment)
    .join('/');
}

const SIZE_PATTERNS = [
  /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|xxxxl|xxxxxl)$/i,
  /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl)[\/](xxxs|xxs|xs|s|m|l|xl|xxl|xxxl)$/i,
  // Hyphenated compound letter sizes: S-M, L-XL, XS-S, etc.
  /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl)[-](xxxs|xxs|xs|s|m|l|xl|xxl|xxxl)$/i,
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

function isValidNumericSize(num: number): boolean {
  return VALID_NUMERIC_SIZE_RANGES.some(range => num >= range.min && num <= range.max);
}

function isValidSizeVariant(option: string): boolean {
  const trimmed = option.trim();
  if (!trimmed || trimmed.toLowerCase() === 'default' || trimmed.toLowerCase() === 'default title') return false;
  if (SIZE_PATTERNS.some(pattern => pattern.test(trimmed))) return true;
  const numMatch = trimmed.match(/^(\d+)$/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    if (numMatch[1].length >= 4) return false;
    return isValidNumericSize(num);
  }
  return false;
}

function extractSizeFromSku(sku: string): string | null {
  if (!sku) return null;
  
  // Check for slash-separated compound sizes first: e.g. 10041-S/M
  const slashSizeMatch = sku.match(/-((?:xxxs|xxs|xs|s|m|l|xl|xxl|xxxl)\/(?:xxxs|xxs|xs|s|m|l|xl|xxl|xxxl))$/i);
  if (slashSizeMatch) return slashSizeMatch[1].toUpperCase();
  
  // Check for hyphen-separated compound letter sizes: e.g. 10041-S-M, 10041-L-XL
  const parts = sku.split('-');
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('-').toUpperCase();
    if (/^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)-(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)$/.test(lastTwo)) {
      return lastTwo;
    }
  }
  
  if (parts.length >= 2) {
    const secondLast = parts[parts.length - 2].trim();
    const lastPart = parts[parts.length - 1].trim();
    const lastNumericMatch = lastPart.match(/^(\d{2})/);
    
    if (/^\d{2}$/.test(secondLast) && lastNumericMatch) {
      const lastNumeric = lastNumericMatch[1];
      const nums = [parseInt(secondLast, 10), parseInt(lastNumeric, 10)];
      if (nums.every(n => isValidNumericSize(n))) return `${secondLast}-${lastNumeric}`;
    }
  }
  
  if (parts.length >= 2) {
    const lastTwo = parts.slice(-2).join('-');
    if (/^\d{2}-\d{2}$/.test(lastTwo)) {
      const nums = lastTwo.split('-').map(n => parseInt(n, 10));
      if (nums.every(n => isValidNumericSize(n))) return lastTwo;
    }
  }
  
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i].trim().toUpperCase();
    if (!part) continue;
    if (/^\d{3,}$/.test(part) && i < parts.length - 1) continue;
    if (i === parts.length - 1 && /^\d{3,}$/.test(part)) {
      const num = parseInt(part, 10);
      if (!isValidNumericSize(num)) continue;
    }
    if (isValidSizeVariant(part)) return part;
  }
  
  return null;
}

const SIZE_ORDER: Record<string, number> = {
  'XXXS': 1, '3XS': 1, 'XXS': 2, '2XS': 2, 'XS': 3, 'S': 4, 'M': 5, 'L': 6,
  'XL': 7, 'XXL': 8, '2XL': 8, 'XXXL': 9, '3XL': 9, 'XXXXL': 10, '4XL': 10,
  'ONE-SIZE': 100, 'ONESIZE': 100, 'ONE SIZE': 100,
  'XXS/XS': 2.5, 'XS/S': 3.5, 'S/M': 4.5, 'M/L': 5.5, 'L/XL': 6.5, 'XL/XXL': 7.5, 'XXL/XXXL': 8.5,
  // Hyphenated compound sizes
  'XXS-XS': 2.5, 'XS-S': 3.5, 'S-M': 4.5, 'M-L': 5.5, 'L-XL': 6.5, 'XL-XXL': 7.5, 'XXL-XXXL': 8.5,
};

function getSizeSortPriority(size: string): number {
  const upper = size.toUpperCase().trim();
  if (SIZE_ORDER[upper] !== undefined) return SIZE_ORDER[upper];
  const comboMatch = upper.match(/^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)\/(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)$/);
  if (comboMatch) {
    const firstSize = comboMatch[1];
    const baseOrder = SIZE_ORDER[firstSize] || 5;
    return baseOrder + 0.5;
  }
  const numMatch = upper.match(/^(\d+)$/);
  if (numMatch) return 1000 + parseInt(numMatch[1], 10);
  const rangeMatch = upper.match(/^(\d+)[-\/](\d+)$/);
  if (rangeMatch) return 1000 + parseInt(rangeMatch[1], 10);
  const halfMatch = upper.match(/^(\d+)[.,]5$/);
  if (halfMatch) return 1000 + parseInt(halfMatch[1], 10) + 0.5;
  return 9999;
}

function normalizeSizeOption(size: string | null): string {
  if (!size) return 'ONE-SIZE';
  const s = size.trim().toUpperCase();
  if (!s || s === 'DEFAULT' || s === 'DEFAULT TITLE') return 'ONE-SIZE';
  return s;
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
    
    try {
      const data = JSON.parse(result.body);
      for (const col of data.smart_collections || []) {
        existingCollections.set(col.title.toLowerCase(), String(col.id));
      }
      
      const linkHeader = result.response.headers.get('Link');
      if (linkHeader?.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^>&]+)/);
        pageInfo = match ? match[1] : null;
      } else {
        hasMorePages = false;
      }
    } catch {
      hasMorePages = false;
    }
  }

  console.log(`[CATEGORIES] Found ${existingCollections.size} existing collections`);

  let processed = 0;
  let errors = 0;
  const errorDetails: { externalId: string; message: string }[] = [];

  for (const item of items) {
    if (Date.now() - startTime > timeBudget) break;

    const tagName = item.shopify_tag || item.name;
    const existingId = existingCollections.get(tagName.toLowerCase());
    
    if (existingId) {
      await supabase
        .from('canonical_categories')
        .update({ status: 'uploaded', shopify_collection_id: existingId, error_message: null, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      processed++;
      continue;
    }

    const collectionPayload = {
      smart_collection: {
        title: tagName,
        rules: [{ column: 'tag', relation: 'equals', condition: tagName }],
        disjunctive: false,
        published: true,
      },
    };

    const result = await shopifyFetch(
      `${shopifyUrl}/smart_collections.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify(collectionPayload),
      }
    );

    if ('rateLimited' in result) {
      return { success: true, processed, errors, hasMore: true, rateLimited: true, retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000) };
    }

    if (!result.response.ok) {
      const errorMsg = `${result.response.status}: ${result.body.slice(0, 100)}`;
      await supabase
        .from('canonical_categories')
        .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      errors++;
      errorDetails.push({ externalId: item.external_id, message: errorMsg });
      continue;
    }

    try {
      const responseData = JSON.parse(result.body);
      const collectionId = String(responseData.smart_collection.id);
      await supabase
        .from('canonical_categories')
        .update({ status: 'uploaded', shopify_collection_id: collectionId, error_message: null, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      processed++;
    } catch {
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
): Promise<{ success: boolean; processed: number; errors: number; hasMore: boolean; errorDetails?: any[]; rateLimited?: boolean; retryAfterSeconds?: number }> {
  
  const { data: items, error: fetchError } = await supabase
    .from('canonical_customers')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .limit(batchSize);

  if (fetchError) throw new Error(`Failed to fetch customers: ${fetchError.message}`);
  if (!items || items.length === 0) {
    return { success: true, processed: 0, errors: 0, hasMore: false };
  }

  let processed = 0;
  let errors = 0;
  const errorDetails: { externalId: string; message: string }[] = [];

  for (const item of items) {
    if (Date.now() - startTime > timeBudget) break;

    const data = item.data || {};
    const email = data.email?.trim();
    
    if (!email) {
      await supabase
        .from('canonical_customers')
        .update({ status: 'failed', error_message: 'Missing email', updated_at: new Date().toISOString() })
        .eq('id', item.id);
      errors++;
      continue;
    }

    // Check if customer exists
    const searchResult = await shopifyFetch(
      `${shopifyUrl}/customers/search.json?query=email:${encodeURIComponent(email)}`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );

    if ('rateLimited' in searchResult) {
      return { success: true, processed, errors, hasMore: true, rateLimited: true, retryAfterSeconds: Math.ceil(searchResult.retryAfterMs / 1000) };
    }

    if (searchResult.response.ok) {
      try {
        const searchData = JSON.parse(searchResult.body);
        if (searchData.customers && searchData.customers.length > 0) {
          const existingCustomer = searchData.customers[0];
          await supabase
            .from('canonical_customers')
            .update({ 
              status: 'uploaded', 
              shopify_id: String(existingCustomer.id), 
              error_message: 'Kunde fandtes allerede',
              updated_at: new Date().toISOString() 
            })
            .eq('id', item.id);
          processed++;
          continue;
        }
      } catch { /* proceed to create */ }
    }

    const customerPayload = {
      customer: {
        email: email,
        first_name: data.first_name || '',
        last_name: data.last_name || '',
        phone: data.phone || undefined,
        verified_email: true,
        send_email_welcome: false,
        addresses: data.addresses || [],
      },
    };

    const result = await shopifyFetch(
      `${shopifyUrl}/customers.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify(customerPayload),
      }
    );

    if ('rateLimited' in result) {
      return { success: true, processed, errors, hasMore: true, rateLimited: true, retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000) };
    }

    if (!result.response.ok) {
      const errorMsg = `${result.response.status}: ${result.body.slice(0, 100)}`;
      await supabase
        .from('canonical_customers')
        .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      errors++;
      errorDetails.push({ externalId: item.external_id, message: errorMsg });
      continue;
    }

    try {
      const responseData = JSON.parse(result.body);
      const customerId = String(responseData.customer.id);
      await supabase
        .from('canonical_customers')
        .update({ status: 'uploaded', shopify_id: customerId, error_message: null, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      processed++;
    } catch {
      errors++;
    }
  }

  const { count: remainingCount } = await supabase
    .from('canonical_customers')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'pending');

  return {
    success: true,
    processed,
    errors,
    hasMore: (remainingCount || 0) > 0,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
  };
}

// ============================================================================
// ORDERS UPLOAD
// ============================================================================

async function uploadOrders(
  supabase: any,
  projectId: string,
  shopifyUrl: string,
  token: string,
  batchSize: number,
  startTime: number,
  timeBudget: number
): Promise<{ success: boolean; processed: number; errors: number; hasMore: boolean; errorDetails?: any[]; rateLimited?: boolean; retryAfterSeconds?: number }> {
  
  const { data: items, error: fetchError } = await supabase
    .from('canonical_orders')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .limit(batchSize);

  if (fetchError) throw new Error(`Failed to fetch orders: ${fetchError.message}`);
  if (!items || items.length === 0) {
    return { success: true, processed: 0, errors: 0, hasMore: false };
  }

  // Build product lookup - OPTIMIZED: Only fetch external_id and shopify_id
  // Avoid fetching the heavy 'data' JSONB column (contains body_html, images, etc.)
  // For 10K+ products this saves megabytes of unnecessary data transfer per batch.
  const productLookup: Map<string, { shopifyProductId: string; shopifyVariantId: string }> = new Map();
  let productOffset = 0;
  const LOOKUP_PAGE_SIZE = 1000;
  while (true) {
    const { data: productPage } = await supabase
      .from('canonical_products')
      .select('external_id, shopify_id')
      .eq('project_id', projectId)
      .eq('status', 'uploaded')
      .not('shopify_id', 'is', null)
      .range(productOffset, productOffset + LOOKUP_PAGE_SIZE - 1);
    
    if (!productPage || productPage.length === 0) break;
    for (const p of productPage) {
      if (p.shopify_id) {
        productLookup.set(p.external_id, { shopifyProductId: p.shopify_id, shopifyVariantId: '' });
      }
    }
    if (productPage.length < LOOKUP_PAGE_SIZE) break;
    productOffset += LOOKUP_PAGE_SIZE;
  }
  console.log(`[ORDERS] Built product lookup with ${productLookup.size} entries`);

  // Build customer lookup - OPTIMIZED: paginate and only select needed fields
  const customerLookup: Map<string, string> = new Map();
  let customerOffset = 0;
  while (true) {
    const { data: customerPage } = await supabase
      .from('canonical_customers')
      .select('external_id, shopify_id, data')
      .eq('project_id', projectId)
      .eq('status', 'uploaded')
      .not('shopify_id', 'is', null)
      .range(customerOffset, customerOffset + LOOKUP_PAGE_SIZE - 1);
    
    if (!customerPage || customerPage.length === 0) break;
    for (const c of customerPage) {
      if (c.shopify_id) {
        customerLookup.set(c.external_id, c.shopify_id);
        if (c.data?.email) customerLookup.set(c.data.email.toLowerCase(), c.shopify_id);
      }
    }
    if (customerPage.length < LOOKUP_PAGE_SIZE) break;
    customerOffset += LOOKUP_PAGE_SIZE;
  }
  console.log(`[ORDERS] Built customer lookup with ${customerLookup.size} entries`);

  let processed = 0;
  let errors = 0;
  const errorDetails: { externalId: string; message: string; step?: string }[] = [];
  let rateLimitedGlobal = false;
  let retryAfterSecondsGlobal = 0;

  // ============================================================================
  // CONCURRENT ORDER PROCESSING
  // Max 3 simultaneous orders. Each order fully completes before being marked done.
  // If bucket is >80% full, the limiter pauses automatically.
  // ============================================================================
  const ORDER_CONCURRENCY = 3;
  const ORDER_MAX_RETRIES = 3;
  const limit = createConcurrencyLimiter(ORDER_CONCURRENCY);

  const processOneOrder = async (item: any): Promise<void> => {
    // Check time budget
    if (Date.now() - startTime > timeBudget) return;
    // If another order triggered a global rate limit, stop starting new ones
    if (rateLimitedGlobal) return;

    const data = item.data || {};
    const lineItems = data.line_items || [];

    // Map line items to Shopify products
    const shopifyLineItems: any[] = [];
    let unmappedItems = 0;

    for (const li of lineItems) {
      const sku = li.sku || li.product_id || '';
      const productInfo = productLookup.get(sku);
      
      if (productInfo?.shopifyVariantId) {
        shopifyLineItems.push({
          variant_id: parseInt(productInfo.shopifyVariantId),
          quantity: li.quantity || 1,
          price: li.price || '0',
        });
      } else {
        unmappedItems++;
        shopifyLineItems.push({
          title: li.title || li.name || sku || 'Unknown product',
          quantity: li.quantity || 1,
          price: li.price || '0',
        });
      }
    }

    // Find customer
    const customerEmail = data.customer_email || data.email;
    const customerId = data.customer_external_id || data.customer_id;
    let shopifyCustomerId = customerLookup.get(customerId) || 
                           (customerEmail ? customerLookup.get(customerEmail.toLowerCase()) : undefined);

    const firstName = data.customer_first_name || '';
    const lastName = data.customer_last_name || '';

    const enrichAddress = (addr: any) => {
      if (!addr) return addr;
      return { ...addr, first_name: addr.first_name || firstName, last_name: addr.last_name || lastName };
    };

    const shippingAddress = enrichAddress(data.shipping_address);
    const billingAddress = enrichAddress(data.billing_address);

    const orderPayload: any = {
      order: {
        line_items: shopifyLineItems,
        financial_status: 'paid',
        fulfillment_status: null,
        send_receipt: false,
        send_fulfillment_receipt: false,
        inventory_behaviour: 'bypass',
        ...(shopifyCustomerId ? { customer: { id: parseInt(shopifyCustomerId) } } : {
          ...(customerEmail ? { email: customerEmail } : {}),
          ...(firstName || lastName ? {
            billing_address: { first_name: firstName, last_name: lastName, email: customerEmail || undefined }
          } : {}),
        }),
        ...(shippingAddress ? { shipping_address: shippingAddress } : {}),
        ...(billingAddress ? { billing_address: billingAddress } : {}),
        ...(data.order_date ? { created_at: data.order_date } : data.created_at ? { created_at: data.created_at } : {}),
        ...(data.note ? { note: data.note } : {}),
      },
    };

    // ========== RETRY LOOP (up to 3 attempts with exponential backoff) ==========
    let lastError = '';
    let failedStep = 'create_order';
    for (let attempt = 1; attempt <= ORDER_MAX_RETRIES; attempt++) {
      try {
        const result = await shopifyFetch(
          `${shopifyUrl}/orders.json`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify(orderPayload),
          },
          1, // shopifyFetch retries transient errors internally; we handle retries at this level
          'orders'
        );

        if ('rateLimited' in result) {
          // On rate limit, wait and retry (don't immediately fail the order)
          if (attempt < ORDER_MAX_RETRIES) {
            const waitMs = Math.max(result.retryAfterMs, 2000 * Math.pow(2, attempt - 1));
            console.log(`[ORDERS] Order ${item.external_id} rate limited, retry ${attempt}/${ORDER_MAX_RETRIES} in ${Math.ceil(waitMs/1000)}s`);
            await sleep(waitMs);
            continue;
          }
          // Final attempt still rate limited → signal global rate limit
          rateLimitedGlobal = true;
          retryAfterSecondsGlobal = Math.ceil(result.retryAfterMs / 1000);
          return; // Don't mark as failed - will be retried next batch
        }

        if (!result.response.ok) {
          lastError = `${result.response.status}: ${result.body.slice(0, 200)}`;
          // 422 (validation error) = permanent, don't retry
          if (result.response.status === 422) break;
          // Other errors: retry with backoff
          if (attempt < ORDER_MAX_RETRIES) {
            const waitMs = 1000 * Math.pow(2, attempt - 1);
            console.warn(`[ORDERS] Order ${item.external_id} failed (${result.response.status}), retry ${attempt}/${ORDER_MAX_RETRIES} in ${waitMs}ms`);
            await sleep(waitMs);
            continue;
          }
          break;
        }

        // Success!
        const responseData = JSON.parse(result.body);
        const orderId = String(responseData.order.id);
        await supabase
          .from('canonical_orders')
          .update({ 
            status: 'uploaded', 
            shopify_id: orderId, 
            error_message: unmappedItems > 0 ? `${unmappedItems} produkter ikke fundet` : null,
            updated_at: new Date().toISOString() 
          })
          .eq('id', item.id);
        processed++;
        return; // Done with this order
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        failedStep = 'create_order';
        if (attempt < ORDER_MAX_RETRIES) {
          const waitMs = 1000 * Math.pow(2, attempt - 1);
          console.warn(`[ORDERS] Order ${item.external_id} exception (attempt ${attempt}): ${lastError}, retrying in ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }
      }
    }

    // All retries exhausted → mark as failed with detailed info
    const errorMsg = `[${failedStep}] ${lastError}`.slice(0, 500);
    console.error(`[ORDERS] Order ${item.external_id} permanently failed after ${ORDER_MAX_RETRIES} attempts: ${errorMsg}`);
    await supabase
      .from('canonical_orders')
      .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
      .eq('id', item.id);
    errors++;
    errorDetails.push({ externalId: item.external_id, message: errorMsg, step: failedStep });
  };

  // Process all orders with concurrency limiter
  const promises = items.map((item: any) => limit(() => processOneOrder(item)));
  await Promise.all(promises);

  const { count: remainingCount } = await supabase
    .from('canonical_orders')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'pending');

  return {
    success: true,
    processed,
    errors,
    hasMore: (remainingCount || 0) > 0,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
    ...(rateLimitedGlobal ? { rateLimited: true, retryAfterSeconds: retryAfterSecondsGlobal } : {}),
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
        published: true,
      },
    };

    const result = await shopifyFetch(
      `${shopifyUrl}/pages.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify(pagePayload),
      }
    );

    if ('rateLimited' in result) {
      return { success: true, processed, errors, hasMore: true, rateLimited: true, retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000) };
    }

    if (!result.response.ok) {
      const errorMsg = `${result.response.status}: ${result.body.slice(0, 100)}`;
      await supabase
        .from('canonical_pages')
        .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      errors++;
      errorDetails.push({ externalId: item.external_id, message: errorMsg });
      continue;
    }

    try {
      const responseData = JSON.parse(result.body);
      const pageId = String(responseData.page.id);
      await supabase
        .from('canonical_pages')
        .update({ status: 'uploaded', shopify_id: pageId, error_message: null, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      processed++;
    } catch {
      errors++;
    }
  }

  const { count: remainingCount } = await supabase
    .from('canonical_pages')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'pending');

  return {
    success: true,
    processed,
    errors,
    hasMore: (remainingCount || 0) > 0,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
  };
}
