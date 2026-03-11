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
  lookupCache?: {
    products: Record<string, { shopifyProductId: string; shopifyVariantId: string }>;
    customers: Record<string, string>;
    builtAt: string;
    lastBucketUsed?: number;
  } | null;
  jobId?: string;
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

    const { projectId, entityType, batchSize = 10, lookupCache, jobId: reqJobId }: ShopifyUploadRequest = await req.json();

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
    const shopifyUrl = `https://${shopifyDomain}/admin/api/2025-01`;

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
      const result = await uploadOrders(supabase, projectId, shopifyUrl, shopifyToken, batchSize, requestStartTime, TIME_BUDGET_MS, lookupCache, reqJobId);
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
let activePeriodIds: Set<string> = new Set();
let manufacturerNameCache: Map<string, string> = new Map();

// Lock duration: 2 minutes - if a worker crashes, the lock expires and another can take over
const LOCK_DURATION_MS = 2 * 60 * 1000;

type VendorExtractionMode = 'none' | 'extract_from_title';

type ProductTransformationRules = {
  stripVendorFromTitle: boolean;
  vendorSeparator: string;
  vendorExtractionMode: VendorExtractionMode;
  useSpecialOfferPrice: boolean;
  inheritProductBarcode: boolean;
  applyPeriodPricing: boolean;
};

const defaultProductTransformationRules: ProductTransformationRules = {
  stripVendorFromTitle: true,
  vendorSeparator: ' - ',
  vendorExtractionMode: 'none',
  useSpecialOfferPrice: false,
  inheritProductBarcode: false,
  applyPeriodPricing: false,
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

    const applyPeriodPricing =
      typeof rules?.applyPeriodPricing === 'boolean'
        ? rules.applyPeriodPricing
        : defaultProductTransformationRules.applyPeriodPricing;

    return { stripVendorFromTitle, vendorSeparator, vendorExtractionMode, useSpecialOfferPrice, inheritProductBarcode, applyPeriodPricing };
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

async function loadActivePeriodIds(supabase: any, projectId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const { data, error } = await supabase
      .from('price_periods')
      .select('period_id, start_date, end_date, disabled')
      .eq('project_id', projectId);
    
    if (error || !data) return ids;
    
    const now = new Date();
    for (const p of data) {
      if (p.disabled) continue;
      if (p.start_date && p.end_date) {
        const start = new Date(p.start_date);
        const end = new Date(p.end_date);
        end.setHours(23, 59, 59, 999);
        if (now >= start && now <= end) {
          ids.add(p.period_id);
        }
      } else {
        // No date range = assume active
        ids.add(p.period_id);
      }
    }
    console.log(`[PRODUCTS] Loaded ${ids.size} active period IDs`);
  } catch (e) {
    console.warn('[PRODUCTS] Failed to load period IDs:', e);
  }
  return ids;
}

async function ensureManufacturerFileReady(supabase: any, projectId: string): Promise<{ ready: boolean; reason?: string }> {
  const { data, error } = await supabase
    .from('project_files')
    .select('file_name, status')
    .eq('project_id', projectId)
    .eq('entity_type', 'manufacturers')
    .maybeSingle();

  if (error) {
    console.error('[PRODUCTS] Failed reading manufacturer file status:', error.message);
    return { ready: false, reason: 'status_error' };
  }

  if (!data) return { ready: false, reason: 'missing_file' };

  const status = String(data.status || '').toLowerCase();
  if (status !== 'processed') return { ready: false, reason: `file_${status || 'pending'}` };

  return { ready: true };
}

async function loadManufacturerNames(supabase: any, projectId: string): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  const normalizeManufacturerKey = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();

  try {
    const { data, error } = await supabase
      .from('canonical_manufacturers')
      .select('external_id, name')
      .eq('project_id', projectId);
    
    if (error || !data) return cache;
    
    for (const m of data) {
      const externalId = String(m.external_id || '').trim();
      const manufacturerName = String(m.name || '').trim();

      if (externalId && manufacturerName) {
        cache.set(externalId, manufacturerName);
        cache.set(normalizeManufacturerKey(externalId), manufacturerName);
      }
    }
    console.log(`[PRODUCTS] Loaded ${cache.size} manufacturer name mappings`);
  } catch (e) {
    console.warn('[PRODUCTS] Failed to load manufacturer names:', e);
  }
  return cache;
}

function formatInferredVendor(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (word === '&') return '&';
      const clean = word.replace(/[^A-Za-z0-9ÆØÅæøå]/g, '');
      if (!clean) return word;
      if (clean.length === 1) return clean.toUpperCase();
      if (clean.length <= 4 && clean === clean.toUpperCase()) return clean;
      return `${clean.charAt(0).toUpperCase()}${clean.slice(1).toLowerCase()}`;
    })
    .join(' ');
}

function inferVendorFromTitle(manufacturerId: string, fallbackTitle?: string): string {
  const normalizeManufacturerKey = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const normalizedId = normalizeManufacturerKey(manufacturerId).replace(/[^a-z0-9]/g, '');
  if (!normalizedId) return '';

  const leadingTitlePart = String(fallbackTitle || '').split(',')[0]?.trim() || '';
  if (!leadingTitlePart) return '';

  const words = leadingTitlePart.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';

  const stopWords = new Set([
    'top', 'bluse', 'kjole', 'ring', 'ørering', 'oerering', 'sneakers', 'boots', 'cardigan',
    'blazer', 'sandaler', 'sandal', 'jakke', 'taske', 'belt', 'bælte', 'pumps', 'strømper',
    'stroemper', 'bukser', 'leggings', 'skjorte', 'tee', 't-shirt', 'tshirt', 'creme', 'cream',
  ]);

  const sanitizeWord = (word: string): string =>
    normalizeManufacturerKey(word).replace(/[^a-z0-9]/g, '');

  let initials = '';
  for (let index = 0; index < Math.min(words.length, 5); index += 1) {
    const currentWord = sanitizeWord(words[index]);
    if (!currentWord) continue;
    initials += currentWord.charAt(0);
    if (initials === normalizedId) {
      return formatInferredVendor(words.slice(0, index + 1).join(' '));
    }
  }

  const firstWord = sanitizeWord(words[0]);
  if (firstWord !== normalizedId) return '';

  if (words.length >= 3) {
    const connector = normalizeManufacturerKey(words[1]);
    if (connector === '&' || connector === 'og') {
      return formatInferredVendor(words.slice(0, 3).join(' '));
    }
  }

  if (words.length >= 2) {
    const secondWord = sanitizeWord(words[1]);
    if (secondWord && !stopWords.has(secondWord)) {
      return formatInferredVendor(words.slice(0, 2).join(' '));
    }
  }

  return formatInferredVendor(words[0]);
}

function resolveVendorName(rawId: string, ...fallbackTitles: Array<string | undefined>): string {
  const manufacId = String(rawId || '').trim();
  const normalizeManufacturerKey = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const normalizedId = normalizeManufacturerKey(manufacId);
  const normalizedIdAlnum = normalizedId.replace(/[^a-z0-9]/g, '');

  if (!manufacId) return '';

  const directVendor = manufacturerNameCache.get(manufacId) ?? manufacturerNameCache.get(normalizedId);

  const candidateNames = Array.from(new Set(manufacturerNameCache.values()));

  const findExpandedFromCandidates = (): string | null => {
    if (!normalizedIdAlnum) return null;

    // Fallback 1: Prefix match (e.g. ARKK -> ARKK COPENHAGEN)
    const prefixMatches = candidateNames.filter((name) => {
      const normalizedName = normalizeManufacturerKey(name);
      const normalizedNameAlnum = normalizedName.replace(/[^a-z0-9]/g, '');
      return (
        normalizedNameAlnum === normalizedIdAlnum ||
        normalizedName.startsWith(`${normalizedId} `)
      );
    });

    if (prefixMatches.length === 1) return prefixMatches[0];

    // Fallback 2: Abbreviation -> initials (e.g. SA -> Stine A)
    if (normalizedIdAlnum.length <= 5 && /^[a-z0-9]+$/i.test(normalizedIdAlnum)) {
      const initialMatches = candidateNames.filter((name) => {
        const initialsFromName = normalizeManufacturerKey(name)
          .split(' ')
          .filter(Boolean)
          .map((part) => part[0])
          .join('');
        return initialsFromName === normalizedIdAlnum;
      });

      if (initialMatches.length === 1) return initialMatches[0];
    }

    return null;
  };

  const findInferredFromTitles = (): string | null => {
    const seen = new Set<string>();
    for (const title of fallbackTitles) {
      const normalizedTitle = String(title || '').trim();
      if (!normalizedTitle || seen.has(normalizedTitle)) continue;
      seen.add(normalizedTitle);

      const inferred = inferVendorFromTitle(manufacId, normalizedTitle);
      if (inferred) return inferred;
    }
    return null;
  };

  if (directVendor) {
    const trimmedDirect = String(directVendor).trim();
    const directAlnum = normalizeManufacturerKey(trimmedDirect).replace(/[^a-z0-9]/g, '');
    const looksLikeAbbreviation = normalizedIdAlnum.length > 0 && normalizedIdAlnum.length <= 5;

    // If mapping already expands the ID, keep it.
    if (directAlnum && directAlnum !== normalizedIdAlnum) return trimmedDirect;

    // If mapping equals ID (e.g. SA -> SA), try stronger fallbacks before returning raw ID.
    if (looksLikeAbbreviation) {
      const expandedFromNames = findExpandedFromCandidates();
      if (expandedFromNames) return expandedFromNames;

      const inferredFromTitles = findInferredFromTitles();
      if (inferredFromTitles) return inferredFromTitles;
    }

    return trimmedDirect;
  }

  const expandedFromNames = findExpandedFromCandidates();
  if (expandedFromNames) return expandedFromNames;

  const inferredFromTitles = findInferredFromTitles();
  if (inferredFromTitles) return inferredFromTitles;

  return manufacId;
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
  activePeriodIds = transformationRules.applyPeriodPricing 
    ? await loadActivePeriodIds(supabase, projectId) 
    : new Set();

  const manufacturerFile = await ensureManufacturerFileReady(supabase, projectId);
  if (!manufacturerFile.ready) {
    throw new Error('Producentfil mangler eller er ikke behandlet endnu. Upload og kør udtræk af export-MANUFACTURERS før produktmigrering.');
  }

  manufacturerNameCache = await loadManufacturerNames(supabase, projectId);
  
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
  let rateLimited = false;
  let retryAfterSeconds = 0;

  // ============================================================================
  // PARALLEL PRODUCT UPLOAD: Process up to 5 products concurrently.
  // Each product uses ~2-4 Shopify API calls (1 create + 1-3 images).
  // With 5 concurrent products, we use ~10-20 API calls in flight,
  // well within Shopify's 40-request bucket.
  // ============================================================================
  const PRODUCT_CONCURRENCY = 5;
  const productLimit = createConcurrencyLimiter(PRODUCT_CONCURRENCY);
  
  const entries = Array.from(productGroups.entries()).slice(0, batchSize);
  
  const processOne = async (groupKey: string, items: any[]) => {
    if (rateLimited) return; // Stop processing if rate limited
    if (Date.now() - startTime > timeBudget) return; // Time budget check
    
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
        return;
      }
      
      if (result.lockBusy) {
        // Lock busy = another worker is handling it
      } else if (result.skipped) {
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
  };

  // Launch all products through the concurrency limiter
  await Promise.all(
    entries.map(([groupKey, items]) => productLimit(() => processOne(groupKey, items)))
  );

  console.log(`[PRODUCTS] Batch complete: processed=${processed}, skipped=${skipped}, errors=${errors} (${PRODUCT_CONCURRENCY} concurrent)`);

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
    const originalTitle = String(data.title || '').trim();
    const vendor = resolveVendorName(String(data.vendor || '').trim(), originalTitle, title);

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

async function resolveGroupProductBarcode(
  supabase: any,
  projectId: string,
  primaryData: any,
  groupKey: string,
  fallbackTitle: string
): Promise<string> {
  const directPrimaryBarcode = String(primaryData?.barcode || '').trim();
  if (directPrimaryBarcode) return directPrimaryBarcode;

  const mergedVariants = Array.isArray(primaryData?._mergedVariants) ? primaryData._mergedVariants : [];
  const mergedVariantBarcode = mergedVariants
    .map((v: any) => String(v?.barcode || '').trim())
    .find((v: string) => v.length > 0);
  if (mergedVariantBarcode) return mergedVariantBarcode;

  try {
    let query = supabase
      .from('canonical_products')
      .select('external_id, data')
      .eq('project_id', projectId)
      .limit(100);

    if (groupKey) {
      query = query.eq('data->>_groupKey', groupKey);
    } else if (fallbackTitle) {
      query = query.eq('data->>title', fallbackTitle);
    } else {
      return '';
    }

    const { data: groupRows, error } = await query;
    if (error || !groupRows || groupRows.length === 0) return '';

    const extractBarcode = (row: any) => String(row?.data?.barcode || '').trim();
    const looksLikeBaseSku = (row: any) => {
      const sku = String(row?.data?.sku || row?.external_id || '').trim();
      return sku.length > 0 && !sku.includes('-');
    };

    const preferred = groupRows.find((row: any) => looksLikeBaseSku(row) && extractBarcode(row));
    if (preferred) return extractBarcode(preferred);

    const anyNonEmpty = groupRows.map(extractBarcode).find((v: string) => v.length > 0);
    return anyNonEmpty || '';
  } catch (error) {
    console.warn('[PRODUCTS] Failed resolving group barcode fallback:', error);
    return '';
  }
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
): Promise<{ skipped?: boolean; lockBusy?: boolean; error?: string; rateLimited?: boolean; retryAfterMs?: number }> {
  
  const data = items[0].data || {};
  const originalTitle = String(data.title || '').trim();
  const groupedTitle = String(data._groupTitle || originalTitle || '').trim();

  const allowTitleTransform = rules.stripVendorFromTitle || rules.vendorExtractionMode === 'extract_from_title';

  // If title transforms are disabled ("Brug eksisterende vendor felt"), keep the title exactly as-is.
  const title = allowTitleTransform ? groupedTitle : originalTitle;

  const primaryItem = items[0];
  const manufacId = String(data.vendor || '').trim();
  const vendor = resolveVendorName(manufacId, originalTitle, groupedTitle);
  console.log(`[PRODUCTS][VENDOR] SKU=${String(data.sku || primaryItem.external_id || '')} MANUFAC_ID="${manufacId}" RESOLVED_VENDOR="${vendor}"`);
  const dbGroupKey = String(data._groupKey || '').trim().toLowerCase();

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
    return { lockBusy: true };
  }
  
  console.log(`[PRODUCTS] Acquired lock ${lockId} for "${dbGroupKey || title}"`);

  // ============================================================================
  // PHASE 2: CHECK IF GROUP ALREADY UPLOADED (post-lock)
  // Now that we own the lock, double-check if any record with same _groupKey
  // already has a shopify_id. This handles the race where another worker
  // completed between our fetch and lock acquisition.
  // ============================================================================
  if (dbGroupKey) {
    // Targeted query: only fetch records with the SAME _groupKey that already have a shopify_id.
    // This replaces the old full-table scan which was a major performance bottleneck.
    const { data: existingInGroup } = await supabase
      .from('canonical_products')
      .select('shopify_id')
      .eq('project_id', projectId)
      .eq('data->>_groupKey', dbGroupKey)
      .not('shopify_id', 'is', null)
      .limit(1);
    
    if (existingInGroup && existingInGroup.length > 0 && existingInGroup[0].shopify_id) {
      const existingShopifyId = existingInGroup[0].shopify_id;
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

      // Apply period pricing if enabled and primary product has a period_id in an active period
      const hasPeriodPricing = rules.applyPeriodPricing && primaryData.period_id && activePeriodIds.has(String(primaryData.period_id)) && primaryData.special_offer_price && parseFloat(String(primaryData.special_offer_price)) > 0;

      let mvPrice = String(mv?.price ?? '0');
      let mvCompareAtPrice = mv?.compareAtPrice ? String(mv.compareAtPrice) : null;

      if (hasPeriodPricing) {
        // Period pricing: use special_offer_price as sale price, UNIT_PRICE (primaryData.price) as compare_at_price
        // NOTE: mv.price may already be the special_offer_price from prepare-upload, so always use primaryData.price
        mvPrice = String(primaryData.special_offer_price);
        mvCompareAtPrice = String(primaryData.price || '0');
      }

      const v: VariantCandidate = {
        option1,
        sku,
        price: mvPrice,
        compare_at_price: mvCompareAtPrice,
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

      // Determine if period pricing applies to this item
      const hasPeriodPricing = rules.applyPeriodPricing && itemData.period_id && activePeriodIds.has(String(itemData.period_id)) && itemData.special_offer_price && parseFloat(String(itemData.special_offer_price)) > 0;

      let variantPrice: string;
      let variantCompareAtPrice: string | null;

      if (hasPeriodPricing) {
        // Period pricing: special_offer_price = sale price (Shopify price), base price = compare_at_price (strikethrough)
        variantPrice = String(itemData.special_offer_price);
        variantCompareAtPrice = String(itemData.price || '0');
      } else if (rules.useSpecialOfferPrice) {
        variantPrice = String(itemData.special_offer_price || itemData.price || '0');
        variantCompareAtPrice = itemData.special_offer_price ? String(itemData.compare_at_price || itemData.price || '0') : null;
      } else {
        variantPrice = String(
          itemData.compare_at_price && parseFloat(String(itemData.compare_at_price)) > parseFloat(String(itemData.price || '0'))
            ? itemData.compare_at_price
            : itemData.price || '0'
        );
        variantCompareAtPrice = null;
      }

      const v: VariantCandidate = {
        option1,
        sku,
        price: variantPrice,
        compare_at_price: variantCompareAtPrice,
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
    const resolvedProductBarcode = await resolveGroupProductBarcode(
      supabase,
      projectId,
      primaryData,
      dbGroupKey,
      title
    );

    if (resolvedProductBarcode) {
      let inherited = 0;
      for (const v of variants) {
        if (!v.barcode || String(v.barcode).trim() === '') {
          v.barcode = resolvedProductBarcode;
          inherited++;
        }
      }
      if (inherited > 0) {
        console.log(`[PRODUCTS] "${transformedTitle}": Inherited product barcode "${resolvedProductBarcode}" to ${inherited}/${variants.length} variant(s)`);
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

  // Add images – parallelized with max 3 concurrent uploads per product.
  // Images are independent of each other, so concurrency is safe here.
  // A single image failure must NOT fail the product (preserved from original).
  if (allImages.length > 0) {
    let added = 0;
    let failed = 0;
    const IMAGE_CONCURRENCY = 3;
    const imageLimit = createConcurrencyLimiter(IMAGE_CONCURRENCY);

    const imagePromises = allImages.map((imageUrl, imgIndex) =>
      imageLimit(async () => {
        const normalizedUrl = normalizeImageUrl(imageUrl, dandomainBaseUrl);
        // Explicitly set position to preserve DanDomain image order.
        // position 1 = main image in Shopify. This guarantees correct order
        // even when images are uploaded concurrently (max 3 at a time).
        const imagePosition = imgIndex + 1;

        try {
          const srcUploadResult = await shopifyFetch(
            `${shopifyUrl}/products/${shopifyId}/images.json`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
              body: JSON.stringify({ image: { src: normalizedUrl, position: imagePosition } }),
            }
          );

          if ('rateLimited' in srcUploadResult) {
            // Wait out the rate limit, then count as failed (will be retried on next run if needed)
            await sleep(srcUploadResult.retryAfterMs);
            failed++;
            return;
          }

          if (srcUploadResult.response.ok) {
            added++;
            return;
          }

          // Fallback: fetch image ourselves (with browser-like headers) and upload as attachment.
          const attachmentFallback = await uploadProductImageAsAttachment(
            shopifyUrl,
            shopifyId,
            token,
            normalizedUrl,
            dandomainBaseUrl,
            imagePosition
          );

          if (attachmentFallback.rateLimited) {
            await sleep(attachmentFallback.retryAfterMs ?? 2000);
            failed++;
            return;
          }

          if (attachmentFallback.uploaded) {
            added++;
            return;
          }

          failed++;
          console.warn(
            `[PRODUCTS] "${transformedTitle}": image upload failed for ${normalizedUrl}. src_status=${srcUploadResult.response.status}, src_body=${truncateForLog(srcUploadResult.body)}, fallback_error=${attachmentFallback.error || 'unknown'}`
          );
        } catch (e) {
          failed++;
          const message = e instanceof Error ? e.message : String(e);
          console.warn(`[PRODUCTS] "${transformedTitle}": image upload exception for ${normalizedUrl}: ${message}`);
        }
      })
    );

    await Promise.all(imagePromises);
    console.log(`[PRODUCTS] "${transformedTitle}": image upload done (concurrent=${IMAGE_CONCURRENCY}). Added=${added}, Failed=${failed}`);
  }

  // ============================================================================
  // PHASE 6: CONSOLIDATED DB WRITE
  // Combine primary record update + group variant update into fewer round-trips.
  // The lock acquisition (Phase 1) is NOT changed – it remains atomic.
  // ============================================================================
  const updatedData = { 
    ...primaryItem.data, 
    shopify_handle: shopifyHandle,
    _shopify_product_id: shopifyId,
  };
  const nowTs = new Date().toISOString();
  const successUpdate = {
    status: 'uploaded' as const,
    shopify_id: shopifyId,
    error_message: null,
    upload_lock_id: null,
    upload_locked_at: null,
    upload_locked_until: null,
    updated_at: nowTs,
  };

  if (dbGroupKey) {
    // Fetch group member IDs + update primary in parallel
    const [, groupResult] = await Promise.all([
      supabase
        .from('canonical_products')
        .update({ ...successUpdate, data: updatedData })
        .eq('id', primaryItem.id),
      supabase
        .from('canonical_products')
        .select('id, data')
        .eq('project_id', projectId)
        .is('shopify_id', null),
    ]);

    // Filter matching group members in JS (JSONB filtering can be unreliable)
    const matchingIds = (groupResult.data || [])
      .filter((r: any) => {
        const rGroupKey = String(r.data?._groupKey || '').trim().toLowerCase();
        return rGroupKey === dbGroupKey && r.id !== primaryItem.id;
      })
      .map((r: any) => r.id);

    if (matchingIds.length > 0) {
      const { error: groupErr } = await supabase
        .from('canonical_products')
        .update({
          ...successUpdate,
          error_message: 'Variant grupperet med primær produkt',
        })
        .in('id', matchingIds);

      if (groupErr) {
        console.warn(`[PRODUCTS] Warning: Failed to update group "${dbGroupKey}": ${groupErr.message}`);
      } else {
        console.log(`[PRODUCTS] Updated ${matchingIds.length} records in group "${dbGroupKey}" with shopify_id ${shopifyId}`);
      }
    }
  } else {
    // No group – just update the primary record
    await supabase
      .from('canonical_products')
      .update({ ...successUpdate, data: updatedData })
      .eq('id', primaryItem.id);
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

function truncateForLog(value: string, maxLength = 220): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty)';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function extractFilenameFromImageUrl(imageUrl: string): string {
  try {
    const u = new URL(imageUrl);
    const segments = u.pathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1] || 'image';
    try {
      return decodeURIComponent(lastSegment);
    } catch {
      return lastSegment;
    }
  } catch {
    const fallback = imageUrl.split('/').pop()?.split('?')[0]?.split('#')[0] || 'image';
    try {
      return decodeURIComponent(fallback);
    } catch {
      return fallback;
    }
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

async function uploadProductImageAsAttachment(
  shopifyUrl: string,
  shopifyId: string,
  token: string,
  normalizedUrl: string,
  dandomainBaseUrl: string,
  position?: number
): Promise<{ uploaded: boolean; rateLimited?: true; retryAfterMs?: number; error?: string }> {
  const sourceHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  };

  if (dandomainBaseUrl) {
    let base = dandomainBaseUrl.trim().replace(/\/$/, '');
    if (!base.startsWith('http://') && !base.startsWith('https://')) {
      base = `https://${base}`;
    }
    sourceHeaders.Referer = `${base}/`;
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 20_000);

  let sourceResponse: Response;
  try {
    sourceResponse = await fetch(normalizedUrl, {
      method: 'GET',
      headers: sourceHeaders,
      redirect: 'follow',
      signal: timeoutController.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const message = error instanceof Error ? error.message : String(error);
    return { uploaded: false, error: `Source fetch exception: ${message}` };
  }

  clearTimeout(timeoutId);

  if (!sourceResponse.ok) {
    return {
      uploaded: false,
      error: `Source fetch failed (${sourceResponse.status} ${sourceResponse.statusText})`,
    };
  }

  const imageBytes = new Uint8Array(await sourceResponse.arrayBuffer());
  if (imageBytes.length === 0) {
    return { uploaded: false, error: 'Source image was empty' };
  }

  const filename = extractFilenameFromImageUrl(normalizedUrl);
  const attachmentPayload = uint8ArrayToBase64(imageBytes);

  const result = await shopifyFetch(
    `${shopifyUrl}/products/${shopifyId}/images.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ image: { attachment: attachmentPayload, filename, ...(position ? { position } : {}) } }),
    }
  );

  if ('rateLimited' in result) {
    return { uploaded: false, rateLimited: true, retryAfterMs: result.retryAfterMs };
  }

  if (!result.response.ok) {
    return {
      uploaded: false,
      error: `Attachment upload failed (${result.response.status}): ${truncateForLog(result.body)}`,
    };
  }

  return { uploaded: true };
}

function normalizeImageUrl(url: string, dandomainBaseUrl: string): string {
  if (!url) return url;

  const rawUrl = url.trim();
  if (!rawUrl) return rawUrl;

  // Already absolute URL
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    try {
      const u = new URL(rawUrl);
      // Encode filename portion only (last path segment), keep path separators
      u.pathname = encodePathSegments(u.pathname);
      return u.toString();
    } catch {
      return rawUrl;
    }
  }

  // Protocol-relative URL
  if (rawUrl.startsWith('//')) {
    try {
      const u = new URL(`https:${rawUrl}`);
      u.pathname = encodePathSegments(u.pathname);
      return u.toString();
    } catch {
      return `https:${rawUrl}`;
    }
  }

  // Split relative URL into path + optional query/hash so only path filename is encoded
  const pathMatch = rawUrl.match(/^([^?#]*)([?#].*)?$/);
  const pathPart = pathMatch?.[1] ?? rawUrl;
  const suffix = pathMatch?.[2] ?? '';
  const encodedPath = encodePathSegments(pathPart);

  // Relative URL starting with /
  if (pathPart.startsWith('/')) {
    if (dandomainBaseUrl) {
      let base = dandomainBaseUrl.trim().replace(/\/$/, '');
      if (!base.startsWith('http://') && !base.startsWith('https://')) {
        base = `https://${base}`;
      }
      return `${base}${encodedPath}${suffix}`;
    }
    return `${encodedPath}${suffix}`;
  }

  // Relative URL without leading /
  if (dandomainBaseUrl) {
    let base = dandomainBaseUrl.trim().replace(/\/$/, '');
    if (!base.startsWith('http://') && !base.startsWith('https://')) {
      base = `https://${base}`;
    }
    return `${base}/${encodedPath}${suffix}`;
  }

  return `${encodedPath}${suffix}`;
}

// Properly encode filename (last segment) of a URL path, preserving directory slashes.
// e.g. "/images/some file (1).webp" -> "/images/some%20file%20%281%29.webp"
function encodePathSegments(path: string): string {
  if (!path) return path;

  const segments = path.split('/');
  let filenameIndex = -1;

  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]) {
      filenameIndex = i;
      break;
    }
  }

  if (filenameIndex === -1) return path;

  const filename = segments[filenameIndex];
  let decodedFilename = filename;

  try {
    decodedFilename = decodeURIComponent(filename);
  } catch {
    decodedFilename = filename;
  }

  // Encode the filename but restore characters that DanDomain servers expect literal:
  // parentheses (), asterisks *, exclamation marks !, single quotes ', tildes ~
  segments[filenameIndex] = encodeURIComponent(decodedFilename)
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%2A/g, '*')
    .replace(/%21/g, '!')
    .replace(/%27/g, "'")
    .replace(/%7E/g, '~');
  return segments.join('/');
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
    // Leading-zero 2-digit numbers (01-09) are product codes, not sizes
    if (numMatch[1].length === 2 && numMatch[1].startsWith('0')) return false;
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
): Promise<{ success: boolean; processed: number; errors: number; skipped: number; hasMore: boolean; errorDetails?: any[]; rateLimited?: boolean; retryAfterSeconds?: number }> {
  
  const { data: items, error: fetchError } = await supabase
    .from('canonical_customers')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .limit(batchSize);

  if (fetchError) throw new Error(`Failed to fetch customers: ${fetchError.message}`);
  if (!items || items.length === 0) {
    return { success: true, processed: 0, errors: 0, skipped: 0, hasMore: false };
  }

  let processed = 0;
  let errors = 0;
  let skipped = 0;
  const errorDetails: { externalId: string; message: string }[] = [];

  const CUSTOMER_CONCURRENCY = 5;
  const customerLimit = createConcurrencyLimiter(CUSTOMER_CONCURRENCY);

  const processCustomer = async (item: any): Promise<{ result: 'processed' | 'skipped' | 'error' | 'rateLimited'; errorDetail?: { externalId: string; message: string } }> => {
    const data = item.data || {};
    const email = data.email?.trim();
    
    if (!email) {
      await supabase
        .from('canonical_customers')
        .update({ status: 'failed', error_message: 'Missing email', updated_at: new Date().toISOString() })
        .eq('id', item.id);
      return { result: 'error', errorDetail: { externalId: item.external_id, message: 'Missing email' } };
    }

    // Check if customer already exists in Shopify by email
    const searchResult = await shopifyFetch(
      `${shopifyUrl}/customers/search.json?query=email:${encodeURIComponent(email)}`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );

    if ('rateLimited' in searchResult) {
      return { result: 'rateLimited' };
    }

    if (searchResult.response.ok) {
      try {
        const searchData = JSON.parse(searchResult.body);
        if (searchData.customers && searchData.customers.length > 0) {
          const existingCustomer = searchData.customers[0];
          await supabase
            .from('canonical_customers')
            .update({ 
              status: 'duplicate', 
              shopify_id: String(existingCustomer.id), 
              error_message: 'Skipped: duplicate email already in Shopify',
              updated_at: new Date().toISOString() 
            })
            .eq('id', item.id);
          // Return 'skipped' — NOT an error, NOT a processed success
          return { result: 'skipped' };
        }
      } catch { /* proceed to create */ }
    }

    // Build customer payload
    const customerPayload: any = {
      customer: {
        email: email,
        first_name: data.first_name || '',
        last_name: data.last_name || '',
        verified_email: true,
        send_email_welcome: false,
        addresses: data.addresses || [],
      },
    };

    // Include phone only if present
    if (data.phone) {
      customerPayload.customer.phone = data.phone;
    }

    const createResult = await shopifyFetch(
      `${shopifyUrl}/customers.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify(customerPayload),
      }
    );

    if ('rateLimited' in createResult) {
      return { result: 'rateLimited' };
    }

    // If creation failed due to phone number issue, retry WITHOUT phone
    if (!createResult.response.ok && data.phone) {
      const errorBody = createResult.body.toLowerCase();
      const isPhoneError = errorBody.includes('phone') || errorBody.includes('telefon');
      
      if (isPhoneError) {
        console.log(`[CUSTOMERS] Retrying ${email} without phone (phone error: ${createResult.body.slice(0, 100)})`);
        
        // Remove phone and retry
        delete customerPayload.customer.phone;
        const retryResult = await shopifyFetch(
          `${shopifyUrl}/customers.json`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify(customerPayload),
          }
        );

        if ('rateLimited' in retryResult) {
          return { result: 'rateLimited' };
        }

        if (retryResult.response.ok) {
          try {
            const responseData = JSON.parse(retryResult.body);
            const customerId = String(responseData.customer.id);
            await supabase
              .from('canonical_customers')
              .update({ status: 'uploaded', shopify_id: customerId, error_message: 'Uploaded without phone (invalid/conflicting)', updated_at: new Date().toISOString() })
              .eq('id', item.id);
            return { result: 'processed' };
          } catch {
            return { result: 'error', errorDetail: { externalId: item.external_id, message: 'Parse error after phone retry' } };
          }
        }
        // If retry also failed, fall through to error handling below
        const retryErrorMsg = `${retryResult.response.status}: ${retryResult.body.slice(0, 100)}`;
        await supabase
          .from('canonical_customers')
          .update({ status: 'failed', error_message: retryErrorMsg, updated_at: new Date().toISOString() })
          .eq('id', item.id);
        return { result: 'error', errorDetail: { externalId: item.external_id, message: retryErrorMsg } };
      }
    }

    if (!createResult.response.ok) {
      // Check if it's a duplicate email error from Shopify (email already taken)
      const errorBody = createResult.body.toLowerCase();
      if (errorBody.includes('email') && (errorBody.includes('taken') || errorBody.includes('already') || errorBody.includes('duplicate'))) {
        await supabase
          .from('canonical_customers')
          .update({ 
            status: 'duplicate', 
            error_message: 'Skipped: email already exists in Shopify (create rejected)',
            updated_at: new Date().toISOString() 
          })
          .eq('id', item.id);
        return { result: 'skipped' };
      }

      const errorMsg = `${createResult.response.status}: ${createResult.body.slice(0, 100)}`;
      await supabase
        .from('canonical_customers')
        .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      return { result: 'error', errorDetail: { externalId: item.external_id, message: errorMsg } };
    }

    try {
      const responseData = JSON.parse(createResult.body);
      const customerId = String(responseData.customer.id);
      await supabase
        .from('canonical_customers')
        .update({ status: 'uploaded', shopify_id: customerId, error_message: null, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      return { result: 'processed' };
    } catch {
      return { result: 'error', errorDetail: { externalId: item.external_id, message: 'Failed to parse response' } };
    }
  };

  let rateLimitedEarly = false;

  const results = await Promise.all(
    items.map(item => customerLimit(async () => {
      if (rateLimitedEarly || Date.now() - startTime > timeBudget) return null;
      const r = await processCustomer(item);
      if (r.result === 'rateLimited') rateLimitedEarly = true;
      return r;
    }))
  );

  for (const r of results) {
    if (!r) continue;
    if (r.result === 'processed') processed++;
    else if (r.result === 'skipped') skipped++;
    else if (r.result === 'error') {
      errors++;
      if (r.errorDetail) errorDetails.push(r.errorDetail);
    }
  }

  if (rateLimitedEarly) {
    return { success: true, processed, errors, skipped, hasMore: true, rateLimited: true, retryAfterSeconds: 5 };
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
    skipped,
    hasMore: (remainingCount || 0) > 0,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
  };
}

// ============================================================================
// ORDERS UPLOAD — OPTIMIZED FOR SPEED & STABILITY
// ============================================================================

async function uploadOrders(
  supabase: any,
  projectId: string,
  shopifyUrl: string,
  token: string,
  batchSize: number,
  startTime: number,
  timeBudget: number,
  lookupCache?: {
    products: Record<string, { shopifyProductId: string; shopifyVariantId: string }>;
    customers: Record<string, string>;
    builtAt: string;
    lastBucketUsed?: number;
  } | null,
  jobId?: string | null
): Promise<{ success: boolean; processed: number; errors: number; skipped: number; hasMore: boolean; errorDetails?: any[]; rateLimited?: boolean; retryAfterSeconds?: number; newLookupCache?: any; lastBucketUsed?: number; newDuplicateCache?: any }> {
  
  // Fetch larger batch for parallel processing
  const { data: items, error: fetchError } = await supabase
    .from('canonical_orders')
    .select('id, external_id, data')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .limit(batchSize);

  if (fetchError) throw new Error(`Failed to fetch orders: ${fetchError.message}`);
  if (!items || items.length === 0) {
    return { success: true, processed: 0, errors: 0, skipped: 0, hasMore: false };
  }

  // ============================================================================
  // PRE-FLIGHT DUPLICATE CHECK CACHE (PERSISTED ACROSS BATCHES)
  // ============================================================================
  const knownDandoIds: Set<string> = new Set();
  const dandoIdToShopifyId: Map<string, string> = new Map();
  const emailQueryCache: Set<string> = new Set();

  let duplicateCacheFromJob: any = null;
  if (jobId) {
    const { data: jobRow } = await supabase
      .from('upload_jobs')
      .select('duplicate_cache')
      .eq('id', jobId)
      .single();
    duplicateCacheFromJob = jobRow?.duplicate_cache;
  }

  if (duplicateCacheFromJob) {
    for (const [k, v] of Object.entries(duplicateCacheFromJob.dandoIds || {})) {
      knownDandoIds.add(k);
      dandoIdToShopifyId.set(k, String(v));
    }
    for (const email of (duplicateCacheFromJob.queriedEmails || [])) {
      emailQueryCache.add(email);
    }
    console.log(`[ORDERS] Restored duplicate cache: ${knownDandoIds.size} IDs, ${emailQueryCache.size} queried emails`);
  }

  // PARALLEL pre-flight duplicate check (3 concurrent email queries)
  const buildDuplicateCache = async (): Promise<boolean> => {
    const cacheStartTime = Date.now();
    try {
      const uniqueEmails: string[] = [];
      for (const item of items) {
        const email = (item.data?.customer_email || item.data?.email || '').trim().toLowerCase();
        if (email && !emailQueryCache.has(email) && !uniqueEmails.includes(email)) {
          uniqueEmails.push(email);
        }
      }

      if (uniqueEmails.length === 0) {
        console.log(`[ORDERS] Pre-flight: all ${emailQueryCache.size} emails already cached`);
        return true;
      }

      // Query 3 emails concurrently
      const DUPE_CHECK_CONCURRENCY = 3;
      const dupeLimit = createConcurrencyLimiter(DUPE_CHECK_CONCURRENCY);
      let queriedCount = 0;

      await Promise.all(
        uniqueEmails.map(email => dupeLimit(async () => {
          if (Date.now() - startTime > timeBudget * 0.3) return; // Don't spend >30% of budget on pre-flight
          try {
            const searchResult = await shopifyFetch(
              `${shopifyUrl}/orders.json?email=${encodeURIComponent(email)}&status=any&limit=250`,
              { headers: { 'X-Shopify-Access-Token': token } },
              2,
              'orders'
            );

            if ('rateLimited' in searchResult) return;

            if (searchResult.response.ok) {
              const data = JSON.parse(searchResult.body);
              for (const order of (data.orders || [])) {
                const noteAttrs = order.note_attributes || [];
                const dandoAttr = noteAttrs.find((a: any) => a.name === 'dandomain_order_id');
                if (dandoAttr?.value) {
                  knownDandoIds.add(String(dandoAttr.value));
                  dandoIdToShopifyId.set(String(dandoAttr.value), String(order.id));
                }
              }
            }
            emailQueryCache.add(email);
            queriedCount++;
          } catch (e) {
            console.warn(`[ORDERS] Pre-flight check failed for ${email}:`, e instanceof Error ? e.message : e);
            emailQueryCache.add(email);
          }
        }))
      );

      console.log(`[ORDERS] Pre-flight cache: ${knownDandoIds.size} IDs, queried ${queriedCount} NEW emails in ${Date.now() - cacheStartTime}ms`);
      return true;
    } catch (e) {
      console.warn(`[ORDERS] Pre-flight cache build failed:`, e instanceof Error ? e.message : e);
      return false;
    }
  };

  await buildDuplicateCache();

  // ============================================================================
  // CACHED LOOKUPS (product/customer maps)
  // ============================================================================
  const productLookup: Map<string, { shopifyProductId: string; shopifyVariantId: string }> = new Map();
  const customerLookup: Map<string, string> = new Map();
  let cacheWasUsed = false;

  if (lookupCache && lookupCache.products && lookupCache.customers) {
    for (const [k, v] of Object.entries(lookupCache.products)) productLookup.set(k, v);
    for (const [k, v] of Object.entries(lookupCache.customers)) customerLookup.set(k, v);
    cacheWasUsed = true;
    console.log(`[ORDERS] Restored lookup cache: ${productLookup.size} products, ${customerLookup.size} customers`);
    shopifyBucketUsed = 0;
    lastBucketUpdate = Date.now();
  } else {
    // Build from scratch - parallel product + customer lookup
    const LOOKUP_PAGE_SIZE = 1000;

    const buildProductLookup = async () => {
      let offset = 0;
      while (true) {
        const { data: page } = await supabase
          .from('canonical_products')
          .select('external_id, shopify_id')
          .eq('project_id', projectId)
          .eq('status', 'uploaded')
          .not('shopify_id', 'is', null)
          .range(offset, offset + LOOKUP_PAGE_SIZE - 1);
        if (!page || page.length === 0) break;
        for (const p of page) {
          if (p.shopify_id) productLookup.set(p.external_id, { shopifyProductId: p.shopify_id, shopifyVariantId: '' });
        }
        if (page.length < LOOKUP_PAGE_SIZE) break;
        offset += LOOKUP_PAGE_SIZE;
      }
    };

    const buildCustomerLookup = async () => {
      let offset = 0;
      while (true) {
        const { data: page } = await supabase
          .from('canonical_customers')
          .select('external_id, shopify_id, data->>email')
          .eq('project_id', projectId)
          .in('status', ['uploaded', 'duplicate'])
          .not('shopify_id', 'is', null)
          .range(offset, offset + LOOKUP_PAGE_SIZE - 1);
        if (!page || page.length === 0) break;
        for (const c of page) {
          if (c.shopify_id) {
            customerLookup.set(c.external_id, c.shopify_id);
            if (c.email) customerLookup.set(c.email.toLowerCase(), c.shopify_id);
          }
        }
        if (page.length < LOOKUP_PAGE_SIZE) break;
        offset += LOOKUP_PAGE_SIZE;
      }
    };

    // Build both lookups in parallel
    await Promise.all([buildProductLookup(), buildCustomerLookup()]);
    console.log(`[ORDERS] Built lookups: ${productLookup.size} products, ${customerLookup.size} customers`);
    shopifyBucketUsed = 0;
    lastBucketUpdate = Date.now();
  }

  // ============================================================================
  // BATCH DB UPDATE COLLECTOR
  // Instead of updating each order individually, collect all status changes
  // and write them in bulk at the end of the batch.
  // ============================================================================
  interface OrderResult {
    id: string;
    externalId: string;
    status: 'uploaded' | 'failed' | 'duplicate';
    shopifyId?: string;
    errorMessage?: string | null;
  }
  const batchResults: OrderResult[] = [];

  let processed = 0;
  let errors = 0;
  let skipped = 0;
  const errorDetails: { externalId: string; message: string; step?: string }[] = [];
  let rateLimitedGlobal = false;
  let retryAfterSecondsGlobal = 0;

  // ============================================================================
  // PARALLEL ORDER PROCESSING with concurrency limiter
  // ============================================================================
  const ORDER_CONCURRENCY = 3; // 3 concurrent Shopify API calls
  const ORDER_MAX_RETRIES = 3;
  const orderLimit = createConcurrencyLimiter(ORDER_CONCURRENCY);

  const processOneOrder = async (item: any): Promise<void> => {
    if (Date.now() - startTime > timeBudget) return;
    if (rateLimitedGlobal) return;

    const data = item.data || {};
    const sourceOrderId = String(item.external_id || '');

    // Pre-flight duplicate check (dandomain_order_id only)
    if (sourceOrderId && knownDandoIds.has(sourceOrderId)) {
      const existingShopifyId = dandoIdToShopifyId.get(sourceOrderId) || 'unknown';
      batchResults.push({
        id: item.id,
        externalId: sourceOrderId,
        status: 'duplicate',
        shopifyId: existingShopifyId,
        errorMessage: `Duplicate: dandomain_order_id ${sourceOrderId} already in Shopify as ${existingShopifyId}`,
      });
      skipped++;
      return;
    }

    const lineItems = data.line_items || [];
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

    const orderPayload: any = {
      order: {
        line_items: shopifyLineItems,
        financial_status: 'paid',
        fulfillment_status: null,
        send_receipt: false,
        send_fulfillment_receipt: false,
        inventory_behaviour: 'bypass',
        note_attributes: [{ name: 'dandomain_order_id', value: sourceOrderId }],
        ...(shopifyCustomerId ? { customer: { id: parseInt(shopifyCustomerId) } } : {
          ...(customerEmail ? { email: customerEmail } : {}),
          ...(firstName || lastName ? {
            billing_address: { first_name: firstName, last_name: lastName, email: customerEmail || undefined }
          } : {}),
        }),
        ...(enrichAddress(data.shipping_address) ? { shipping_address: enrichAddress(data.shipping_address) } : {}),
        ...(enrichAddress(data.billing_address) ? { billing_address: enrichAddress(data.billing_address) } : {}),
        ...(data.order_date ? { created_at: data.order_date } : data.created_at ? { created_at: data.created_at } : {}),
        ...(data.note ? { note: data.note } : {}),
      },
    };

    // Retry loop with exponential backoff
    let lastError = '';
    for (let attempt = 1; attempt <= ORDER_MAX_RETRIES; attempt++) {
      try {
        const result = await shopifyFetch(
          `${shopifyUrl}/orders.json`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify(orderPayload),
          },
          1,
          'orders'
        );

        if ('rateLimited' in result) {
          if (attempt < ORDER_MAX_RETRIES) {
            console.log(`[ORDERS] ${sourceOrderId} rate limited, retry ${attempt}/${ORDER_MAX_RETRIES} in 5s`);
            await sleep(5000);
            continue;
          }
          rateLimitedGlobal = true;
          retryAfterSecondsGlobal = Math.ceil(result.retryAfterMs / 1000);
          return;
        }

        if (!result.response.ok) {
          lastError = `${result.response.status}: ${result.body.slice(0, 200)}`;
          if (result.response.status === 422) break; // Permanent error
          if (attempt < ORDER_MAX_RETRIES) {
            await sleep(1000 * Math.pow(2, attempt - 1));
            continue;
          }
          break;
        }

        // Success
        const responseData = JSON.parse(result.body);
        const orderId = String(responseData.order.id);
        batchResults.push({
          id: item.id,
          externalId: sourceOrderId,
          status: 'uploaded',
          shopifyId: orderId,
          errorMessage: unmappedItems > 0 ? `${unmappedItems} produkter ikke fundet` : null,
        });
        processed++;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < ORDER_MAX_RETRIES) {
          await sleep(1000 * Math.pow(2, attempt - 1));
          continue;
        }
      }
    }

    // All retries exhausted
    const errorMsg = `[create_order] ${lastError}`.slice(0, 500);
    console.error(`[ORDERS] ${sourceOrderId} permanently failed: ${errorMsg}`);
    batchResults.push({
      id: item.id,
      externalId: sourceOrderId,
      status: 'failed',
      errorMessage: errorMsg,
    });
    errors++;
    errorDetails.push({ externalId: sourceOrderId, message: errorMsg, step: 'create_order' });
  };

  // Process all orders in parallel with concurrency limit
  await Promise.all(
    items.map(item => orderLimit(async () => {
      if (rateLimitedGlobal || Date.now() - startTime > timeBudget) return;
      await processOneOrder(item);
    }))
  );

  // ============================================================================
  // BATCH DB UPDATES — write all status changes at once instead of per-order
  // ============================================================================
  const now = new Date().toISOString();

  // Group by status for efficient batch updates
  const uploadedResults = batchResults.filter(r => r.status === 'uploaded');
  const failedResults = batchResults.filter(r => r.status === 'failed');
  const duplicateResults = batchResults.filter(r => r.status === 'duplicate');

  // Batch update: uploaded orders (chunks of 100 to avoid payload limits)
  const BATCH_CHUNK = 100;
  for (let i = 0; i < uploadedResults.length; i += BATCH_CHUNK) {
    const chunk = uploadedResults.slice(i, i + BATCH_CHUNK);
    const ids = chunk.map(r => r.id);
    // For uploaded orders, we need individual updates because shopify_id differs
    // Use Promise.all for parallel DB writes
    await Promise.all(chunk.map(r =>
      supabase.from('canonical_orders').update({
        status: 'uploaded',
        shopify_id: r.shopifyId,
        error_message: r.errorMessage || null,
        updated_at: now,
      }).eq('id', r.id)
    ));
  }

  // Batch update: failed orders
  for (let i = 0; i < failedResults.length; i += BATCH_CHUNK) {
    const chunk = failedResults.slice(i, i + BATCH_CHUNK);
    await Promise.all(chunk.map(r =>
      supabase.from('canonical_orders').update({
        status: 'failed',
        error_message: r.errorMessage,
        updated_at: now,
      }).eq('id', r.id)
    ));
  }

  // Batch update: duplicate orders
  for (let i = 0; i < duplicateResults.length; i += BATCH_CHUNK) {
    const chunk = duplicateResults.slice(i, i + BATCH_CHUNK);
    await Promise.all(chunk.map(r =>
      supabase.from('canonical_orders').update({
        status: 'duplicate',
        shopify_id: r.shopifyId,
        error_message: r.errorMessage,
        updated_at: now,
      }).eq('id', r.id)
    ));
  }

  console.log(`[ORDERS] Batch DB update: ${uploadedResults.length} uploaded, ${failedResults.length} failed, ${duplicateResults.length} duplicate`);

  // Use hasMore from item count vs batch size (avoid expensive count query)
  const hasMore = items.length >= batchSize || rateLimitedGlobal;

  // Serialize caches for persistence
  const serializedCache: any = {
    products: Object.fromEntries(productLookup),
    customers: Object.fromEntries(customerLookup),
    builtAt: cacheWasUsed ? lookupCache!.builtAt : new Date().toISOString(),
    lastBucketUsed: getCurrentBucketUsage(),
  };

  const serializedDuplicateCache: any = {
    dandoIds: Object.fromEntries(dandoIdToShopifyId),
    queriedEmails: Array.from(emailQueryCache),
  };

  return {
    success: true,
    processed,
    errors,
    skipped,
    hasMore,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
    ...(rateLimitedGlobal ? { rateLimited: true, retryAfterSeconds: retryAfterSecondsGlobal } : {}),
    newLookupCache: serializedCache,
    lastBucketUsed: getCurrentBucketUsage(),
    newDuplicateCache: serializedDuplicateCache,
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
