import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

/**
 * PRE-UPLOAD GROUPING & VALIDATION (RESUMABLE)
 *
 * This function prepares products for upload by:
 * 1. Grouping product records by normalized title (Parent Grouping Key)
 * 2. Extracting and validating variant options (sizes)
 * 3. Merging fields using best-non-empty logic
 * 4. Rejecting invalid records (no valid variants, missing required data)
 * 5. Returning a dedupe report for UI display
 *
 * CRITICAL: This is a resumable function. It reads `prepare_offset` from the
 * upload_jobs row and writes a limited number of records per invocation,
 * then returns `{ continue: true }` so the caller can re-invoke.
 *
 * NO Shopify writes occur here - this is purely preparation.
 */

// ============================================================================
// SIZE VALIDATION
// ============================================================================

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

const COLOR_PATTERNS = /^(BLACK|WHITE|GREY|GRAY|BLUE|RED|GREEN|YELLOW|PINK|BROWN|BEIGE|NAVY|SAND|CREAM|ROSE|ORANGE|PURPLE|TAN|OLIVE|MINT|CORAL|CAMEL|COGNAC|NUDE|SILVER|GOLD|STONE|DARK|LIGHT|NATURAL|MULCH|MELANGE|STRIPE)$/i;

const PRODUCT_CODE_PATTERNS = [
  /^601$/,
  /^12$/,
  /^7\d{4}$/,
  /^0\d{3}$/,
  /^\d{4,}$/,
];

function isLikelyProductCode(segment: string, position: number, totalParts: number): boolean {
  if (PRODUCT_CODE_PATTERNS.some((pattern) => pattern.test(segment))) {
    return true;
  }
  if (position < Math.min(2, totalParts - 1) && /^\d{2,}$/.test(segment)) {
    return true;
  }
  return false;
}

function isValidNumericSize(num: number): boolean {
  return VALID_NUMERIC_SIZE_RANGES.some((range) => num >= range.min && num <= range.max);
}

function isValidSizeVariant(option: string): boolean {
  const trimmed = option.trim();
  if (!trimmed || trimmed.toLowerCase() === 'default' || trimmed.toLowerCase() === 'default title') {
    return false;
  }
  if (PRODUCT_CODE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return false;
  }
  if (SIZE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true;
  }
  const numMatch = trimmed.match(/^(\d+)$/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    if (numMatch[1].length >= 4) {
      return false;
    }
    return isValidNumericSize(num);
  }
  return false;
}

function extractSizeFromSku(sku: string): string | null {
  if (!sku) return null;

  // Check for slash-separated compound sizes first: e.g. 10041-S/M
  const slashSizeMatch = sku.match(/-((?:xxxs|xxs|xs|s|m|l|xl|xxl|xxxl)\/(?:xxxs|xxs|xs|s|m|l|xl|xxl|xxxl))$/i);
  if (slashSizeMatch) {
    return slashSizeMatch[1].toUpperCase();
  }

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
      if (nums.every((n) => isValidNumericSize(n))) {
        return `${secondLast}-${lastNumeric}`;
      }
    }
  }

  if (parts.length >= 2) {
    const lastTwo = parts.slice(-2).join('-');
    if (/^\d{2}-\d{2}$/.test(lastTwo)) {
      const nums = lastTwo.split('-').map((n) => parseInt(n, 10));
      if (nums.every((n) => isValidNumericSize(n))) {
        return lastTwo;
      }
    }
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i].trim().toUpperCase();
    if (!part || part.length === 0) continue;

    if (COLOR_PATTERNS.test(part)) continue;
    if (isLikelyProductCode(part, i, parts.length)) continue;
    if (i < parts.length - 1 && /^\d{3,}$/.test(part)) continue;

    if (i === parts.length - 1 && /^\d{3,}$/.test(part)) {
      const num = parseInt(part, 10);
      if (!isValidNumericSize(num)) continue;
    }

    if (isValidSizeVariant(part)) {
      return part;
    }
  }

  return null;
}

// ============================================================================
// SIZE SORTING
// ============================================================================

const SIZE_ORDER: Record<string, number> = {
  XXXS: 1, '3XS': 1,
  XXS: 2, '2XS': 2,
  XS: 3,
  S: 4,
  M: 5,
  L: 6,
  XL: 7,
  XXL: 8, '2XL': 8,
  XXXL: 9, '3XL': 9,
  XXXXL: 10, '4XL': 10,
  'ONE-SIZE': 100, ONESIZE: 100, 'ONE SIZE': 100,
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

// ============================================================================
// GROUPING & VALIDATION LOGIC
// ============================================================================

interface ProductRecord {
  id: string;
  external_id: string;
  data: any;
  status: string;
}

interface ValidatedVariant {
  recordId: string;
  externalId: string;
  sku: string;
  size: string;
  price: string;
  compareAtPrice: string | null;
  stockQuantity: number;
  weight: number;
  barcode: string | null;
  noVariantOption?: boolean;
}

interface ProductGroup {
  key: string;
  title: string;
  vendor: string;
  bodyHtml: string;
  tags: string[];
  images: string[];
  variants: ValidatedVariant[];
  recordIds: string[];
  externalIds: string[];
  warnings: string[];
}

interface RejectedRecord {
  recordId: string;
  externalId: string;
  reason: string;
}

interface PrepareResult {
  success: boolean;
  groups: ProductGroup[];
  rejected: RejectedRecord[];
  stats: {
    totalRecords: number;
    groupsCreated: number;
    variantsTotal: number;
    recordsRejected: number;
  };
}

function normalizeBrand(s: string): string {
  return s.toLowerCase().replace(/[+&]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(title: string, vendor: string): string {
  const normalized = title.trim();
  const normalizedVendor = normalizeBrand(vendor);
  const separators = [' - ', ' – ', ' — ', ': ', ' | '];

  if (normalizedVendor) {
    for (const sep of separators) {
      const sepIndex = normalized.indexOf(sep);
      if (sepIndex > 0 && sepIndex < 60) {
        const prefix = normalized.slice(0, sepIndex).trim();
        const normalizedPrefix = normalizeBrand(prefix);
        if (
          normalizedPrefix === normalizedVendor ||
          normalizedVendor.startsWith(normalizedPrefix + ' ') ||
          normalizedVendor.startsWith(normalizedPrefix)
        ) {
          const rest = normalized.slice(sepIndex + sep.length).trim();
          if (rest) return rest;
        }
      }
    }
    if (normalizeBrand(normalized).startsWith(normalizedVendor)) {
      const rest = normalized.substring(vendor.length).replace(/^[\s\-–—:|]+/, '').trim();
      if (rest) return rest;
    }
  }

  for (const sep of separators) {
    const idx = normalized.indexOf(sep);
    if (idx > 0 && idx < 50) {
      const prefix = normalized.slice(0, idx).trim();
      const rest = normalized.slice(idx + sep.length).trim();
      if (prefix.length >= 2 && prefix.length <= 40 && rest.length >= 3) {
        return rest;
      }
    }
  }

  return normalized || title;
}

function mergeText(a: string | undefined, b: string | undefined): string {
  const aVal = (a || '').trim();
  const bVal = (b || '').trim();
  return aVal.length >= bVal.length ? aVal : bVal;
}

function groupProducts(products: ProductRecord[]): PrepareResult {
  const groups: Map<string, ProductGroup> = new Map();
  const rejected: RejectedRecord[] = [];

  for (const product of products) {
    const data = product.data || {};
    const title = String(data.title || '').trim();
    const vendor = String(data.vendor || '').trim();
    const sku = String(data.sku || '').trim();

    if (!title) {
      rejected.push({ recordId: product.id, externalId: product.external_id, reason: 'Mangler titel' });
      continue;
    }

    let variantSize: string | null = null;
    const skuSize = sku ? extractSizeFromSku(sku) : null;
    const skuIsRange = !!(skuSize && /^\d+[-\/]\d+$/.test(skuSize));

    if (skuIsRange) {
      variantSize = skuSize;
    } else if (data.variant_option && isValidSizeVariant(String(data.variant_option))) {
      variantSize = String(data.variant_option).trim().toUpperCase();
    } else if (skuSize) {
      variantSize = skuSize;
    }

    const normalizedTitle = normalizeTitle(title, vendor);
    const groupKey = normalizedTitle.toLowerCase();

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        key: groupKey,
        title: normalizedTitle,
        vendor: vendor,
        bodyHtml: data.body_html || '',
        tags: [],
        images: [],
        variants: [],
        recordIds: [],
        externalIds: [],
        warnings: [],
      });
    }

    const group = groups.get(groupKey)!;
    group.bodyHtml = mergeText(group.bodyHtml, data.body_html);
    group.vendor = mergeText(group.vendor, vendor);

    const productTags = data.tags || [];
    for (const tag of productTags) {
      if (tag && !group.tags.includes(tag)) {
        group.tags.push(tag);
      }
    }

    const productImages = data.images || [];
    for (const img of productImages) {
      if (img && !group.images.includes(img)) {
        group.images.push(img);
      }
    }

    if (variantSize) {
      const existingVariant = group.variants.find((v) => v.size.toUpperCase() === variantSize!.toUpperCase());
      if (existingVariant) {
        group.warnings.push(`Duplikat størrelse ${variantSize} (SKU: ${sku}) - bruger eksisterende`);
      } else {
        group.variants.push({
          recordId: product.id,
          externalId: product.external_id,
          sku: sku,
          size: variantSize.toUpperCase(),
          price: String(data.price || '0'),
          compareAtPrice: data.compare_at_price ? String(data.compare_at_price) : null,
          stockQuantity: parseInt(String(data.stock_quantity || 0), 10),
          weight: data.weight ? parseFloat(String(data.weight)) : 0,
          barcode: data.barcode || null,
        });
      }
    } else {
      if (group.variants.length === 0) {
        group.variants.push({
          recordId: product.id,
          externalId: product.external_id,
          sku: sku,
          size: '',
          price: String(data.price || '0'),
          compareAtPrice: data.compare_at_price ? String(data.compare_at_price) : null,
          stockQuantity: parseInt(String(data.stock_quantity || 0), 10),
          weight: data.weight ? parseFloat(String(data.weight)) : 0,
          barcode: data.barcode || null,
          noVariantOption: true,
        });
      } else if (group.variants.some((v) => v.size)) {
        const isBaseSku = group.variants.some((v) => v.size && v.sku.startsWith(sku + '-'));
        if (isBaseSku) {
          group.warnings.push(`Base-SKU ${sku} bruges til produkt-metadata (ikke som variant)`);
        } else {
          group.warnings.push(`Produkt uden størrelse (SKU: ${sku}) springes over - gruppe har størrelsesvarianter`);
        }
      }
    }

    group.recordIds.push(product.id);
    group.externalIds.push(product.external_id);
  }

  for (const group of groups.values()) {
    const sizedVariants = group.variants.filter((v) => v.size && v.size.trim() !== '');
    const unsizedVariants = group.variants.filter((v) => !v.size || v.size.trim() === '');

    if (sizedVariants.length > 0 && unsizedVariants.length > 0) {
      for (const unsized of unsizedVariants) {
        const isBaseSku = sizedVariants.some((v) => v.sku.startsWith(unsized.sku + '-'));
        if (isBaseSku) {
          group.warnings.push(`Base-SKU ${unsized.sku} fjernet fra varianter (bruges kun til metadata)`);
        } else {
          group.warnings.push(`Variant uden størrelse (${unsized.sku}) fjernet - gruppe har størrelsesvarianter`);
        }
      }
      group.variants = sizedVariants;
    }
  }

  for (const group of groups.values()) {
    if (group.variants.length > 1 && group.variants.every((v) => v.size)) {
      group.variants.sort((a, b) => getSizeSortPriority(a.size) - getSizeSortPriority(b.size));
    }
  }

  const validGroups: ProductGroup[] = [];
  for (const group of groups.values()) {
    if (group.variants.length === 0) {
      for (const recordId of group.recordIds) {
        const externalId = group.externalIds[group.recordIds.indexOf(recordId)];
        rejected.push({ recordId, externalId, reason: 'Ingen gyldige varianter efter gruppering' });
      }
    } else {
      validGroups.push(group);
    }
  }

  const totalVariants = validGroups.reduce((sum, g) => sum + g.variants.length, 0);

  return {
    success: true,
    groups: validGroups,
    rejected,
    stats: {
      totalRecords: products.length,
      groupsCreated: validGroups.length,
      variantsTotal: totalVariants,
      recordsRejected: rejected.length,
    },
  };
}

// ============================================================================
// MAIN HANDLER (RESUMABLE)
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const {
      projectId,
      entityType,
      previewOnly = true,
      includeGroups = false,
      jobId,
      isTestMode = false,
      testLimit = 3,
    }: {
      projectId: string;
      entityType: 'products' | 'customers' | 'orders' | 'categories' | 'pages';
      previewOnly?: boolean;
      includeGroups?: boolean;
      jobId?: string;
      isTestMode?: boolean;
      testLimit?: number;
    } = await req.json();

    console.log(`[PREPARE] Starting ${previewOnly ? 'preview' : 'commit'} for ${entityType} (testMode=${isTestMode}, limit=${testLimit})`);

    if (entityType === 'products') {
      // CRITICAL FIX: For test mode, do NOT fetch the entire catalogue.
      // We only need a safe subset of pending rows to generate the primaries the test-run will upload.
      let allProducts: ProductRecord[] = [];
      let page = 0;

      const testFetchMax = Math.min(5000, Math.max(1500, testLimit * 800));
      const pageSize = isTestMode ? 500 : 1000;
      const maxProducts = isTestMode ? testFetchMax : Infinity;

      while (allProducts.length < maxProducts) {
        let query = supabase
          .from('canonical_products')
          .select('id, external_id, data, status')
          .eq('project_id', projectId)
          .order('id', { ascending: true })
          .range(page * pageSize, (page + 1) * pageSize - 1);

        if (isTestMode) {
          // Test uploads only care about uploadable (pending) items.
          query = query.eq('status', 'pending');
        } else {
          query = query.in('status', ['pending', 'mapped', 'uploaded']);
        }

        const { data, error } = await query;
        if (error) throw error;
        if (!data || data.length === 0) break;

        allProducts = [...allProducts, ...data];

        if (data.length < pageSize) break;
        page++;
      }

      const pendingCount = allProducts.filter((p) => p.status === 'pending').length;
      console.log(
        `[PREPARE] Fetched ${allProducts.length} products for ${isTestMode ? 'TEST' : 'FULL'} regrouping (pending=${pendingCount}) (testFetchMax=${isTestMode ? testFetchMax : 'n/a'})`
      );

      const result = groupProducts(allProducts);

      console.log(`[PREPARE] Created ${result.stats.groupsCreated} groups with ${result.stats.variantsTotal} variants`);
      console.log(`[PREPARE] Rejected ${result.stats.recordsRejected} records`);

      if (!previewOnly) {
        const now = new Date().toISOString();

        // ==================== RESUMABLE WRITE ====================
        // Get current offset from the job (if provided)
        let offset = 0;
        if (jobId) {
          const { data: jobRow } = await supabase
            .from('upload_jobs')
            .select('prepare_offset')
            .eq('id', jobId)
            .single();
          offset = jobRow?.prepare_offset || 0;
        }

        // Collect all updates
        const allUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];

        // Rejected records
        for (const rejected of result.rejected) {
          const rejectedRecord = allProducts.find((p) => p.id === rejected.recordId);
          if (rejectedRecord?.status === 'uploaded') continue;
          allUpdates.push({
            id: rejected.recordId,
            patch: { status: 'mapped', error_message: `Afvist: ${rejected.reason}`, updated_at: now },
          });
        }

        // Primary + secondary updates
        for (const group of result.groups) {
          if (group.recordIds.length === 0) continue;

          const uploadedInGroup = group.recordIds
            .map((id) => allProducts.find((p) => p.id === id))
            .find((p) => p?.status === 'uploaded');

          let primaryId: string;
          if (uploadedInGroup) {
            primaryId = uploadedInGroup.id;
          } else {
            const firstSizedVariant = group.variants.find((v) => v.size && v.size.trim() !== '');
            if (firstSizedVariant) {
              primaryId = firstSizedVariant.recordId;
            } else if (group.variants.length > 0) {
              primaryId = group.variants[0].recordId;
            } else {
              primaryId = group.recordIds[0];
            }
          }
          const primaryRecord = allProducts.find((p) => p.id === primaryId);

          const groupRecords = group.recordIds.map((id) => allProducts.find((p) => p.id === id)).filter(Boolean) as any[];

          const pickBestNonEmpty = (key: string) => {
            for (const r of groupRecords) {
              const v = r?.data?.[key];
              if (typeof v === 'string') {
                const t = v.trim();
                if (t !== '') return t;
              }
              if (v !== null && v !== undefined) return v;
            }
            return undefined;
          };

          // Primary update
          allUpdates.push({
            id: primaryId,
            patch: {
              data: {
                ...(primaryRecord?.data || {}),
                body_html: group.bodyHtml || primaryRecord?.data?.body_html || '',
                vendor: group.vendor || primaryRecord?.data?.vendor || '',
                tags: group.tags.length > 0 ? group.tags : primaryRecord?.data?.tags || [],
                images: group.images.length > 0 ? group.images : primaryRecord?.data?.images || [],
                field_1: pickBestNonEmpty('field_1') ?? primaryRecord?.data?.field_1 ?? null,
                field_2: pickBestNonEmpty('field_2') ?? primaryRecord?.data?.field_2 ?? null,
                field_3: pickBestNonEmpty('field_3') ?? primaryRecord?.data?.field_3 ?? null,
                field_9: pickBestNonEmpty('field_9') ?? primaryRecord?.data?.field_9 ?? null,
                meta_title: pickBestNonEmpty('meta_title') ?? primaryRecord?.data?.meta_title ?? null,
                meta_description: pickBestNonEmpty('meta_description') ?? primaryRecord?.data?.meta_description ?? null,
                source_path: pickBestNonEmpty('source_path') ?? primaryRecord?.data?.source_path ?? null,
                _groupKey: group.key,
                _groupTitle: group.title,
                _variantCount: group.variants.length,
                _isPrimary: true,
                _mergedVariants: group.variants,
                _mergedImages: group.images,
              },
              updated_at: now,
            },
          });

          // Secondary updates
          for (const secId of group.recordIds) {
            if (secId === primaryId) continue;
            const secRecord = allProducts.find((p) => p.id === secId);
            const isUploaded = secRecord?.status === 'uploaded';
            allUpdates.push({
              id: secId,
              patch: {
                data: {
                  ...(secRecord?.data || {}),
                  _groupKey: group.key,
                  _groupTitle: group.title,
                  _isPrimary: false,
                  _primaryRecordId: primaryId,
                  _variantCount: null,
                  _mergedVariants: null,
                  _mergedImages: null,
                },
                ...(isUploaded ? {} : { status: 'mapped' }),
                updated_at: now,
              },
            });
          }
        }

        console.log(`[PREPARE] Total updates: ${allUpdates.length}, starting from offset ${offset}`);

        // Process a chunk this invocation
        const CHUNK_SIZE = 200;
        const chunk = allUpdates.slice(offset, offset + CHUNK_SIZE);

        if (chunk.length > 0) {
          const BATCH_SIZE = 20;
          for (let i = 0; i < chunk.length; i += BATCH_SIZE) {
            const batch = chunk.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(({ id, patch }) => supabase.from('canonical_products').update(patch).eq('id', id)));
          }
        }

        const newOffset = offset + chunk.length;

        // Update job offset
        if (jobId) {
          await supabase.from('upload_jobs').update({ prepare_offset: newOffset }).eq('id', jobId);
        }

        // Did we finish?
        const done = newOffset >= allUpdates.length;
        console.log(`[PREPARE] Processed ${chunk.length} updates (${newOffset}/${allUpdates.length}), done=${done}`);

        if (!done) {
          return new Response(
            JSON.stringify({
              success: true,
              continue: true,
              progress: newOffset,
              total: allUpdates.length,
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Final counts
        const { count: totalRecords } = await supabase
          .from('canonical_products')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', projectId);

        const { count: primaryCount } = await supabase
          .from('canonical_products')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', projectId)
          .filter('data->>_isPrimary', 'eq', 'true');

        const { count: secondaryCount } = await supabase
          .from('canonical_products')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', projectId)
          .filter('data->>_isPrimary', 'eq', 'false');

        const shopifyProducts = primaryCount || 0;
        const totalVariants = (primaryCount || 0) + (secondaryCount || 0);

        return new Response(
          JSON.stringify({
            success: true,
            continue: false,
            groups: includeGroups ? result.groups : [],
            rejected: includeGroups ? result.rejected : [],
            stats: {
              totalRecords: totalRecords || 0,
              groupsCreated: shopifyProducts,
              variantsTotal: totalVariants,
              recordsRejected: result.stats.recordsRejected,
            },
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // For other entity types, return simple stats
    const tableName = `canonical_${entityType}` as const;
    const { count } = await supabase
      .from(tableName)
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('status', 'pending');

    return new Response(
      JSON.stringify({
        success: true,
        groups: [],
        rejected: [],
        stats: {
          totalRecords: count || 0,
          groupsCreated: count || 0,
          variantsTotal: count || 0,
          recordsRejected: 0,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[PREPARE] Error:', errorMessage);
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
