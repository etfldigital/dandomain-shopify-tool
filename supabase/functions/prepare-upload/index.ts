import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * PRE-UPLOAD GROUPING & VALIDATION
 * 
 * This function prepares products for upload by:
 * 1. Grouping product records by normalized title (Parent Grouping Key)
 * 2. Extracting and validating variant options (sizes)
 * 3. Merging fields using best-non-empty logic
 * 4. Rejecting invalid records (no valid variants, missing required data)
 * 5. Returning a dedupe report for UI display
 * 
 * NO Shopify writes occur here - this is purely preparation.
 */

// ============================================================================
// SIZE VALIDATION
// ============================================================================

const SIZE_PATTERNS = [
  /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|xxxxl|xxxxxl)$/i,
  /^(xs|s|m|l|xl|xxl)[-\/]?\d+$/i,
  /^\d+[-\/]?(xs|s|m|l|xl|xxl)$/i,
  /^\d{2}[-\/]\d{2}$/,
  /^one[-\s]?size$/i,
  /^\d{1,2}[.,]5$/,
];

const VALID_NUMERIC_SIZE_RANGES = [
  { min: 0, max: 20 },    // US/UK shoe sizes, baby sizes
  { min: 32, max: 60 },   // European clothing sizes
  { min: 86, max: 194 },  // Kids clothing sizes (height-based)
];

const COLOR_PATTERNS = /^(BLACK|WHITE|GREY|GRAY|BLUE|RED|GREEN|YELLOW|PINK|BROWN|BEIGE|NAVY|SAND|CREAM|ROSE|ORANGE|PURPLE|TAN|OLIVE|MINT|CORAL|CAMEL|COGNAC|NUDE|SILVER|GOLD|STONE|DARK|LIGHT|NATURAL|MULCH|MELANGE|STRIPE)$/i;

function isValidNumericSize(num: number): boolean {
  return VALID_NUMERIC_SIZE_RANGES.some(range => num >= range.min && num <= range.max);
}

function isValidSizeVariant(option: string): boolean {
  const trimmed = option.trim();
  if (!trimmed || trimmed.toLowerCase() === 'default' || trimmed.toLowerCase() === 'default title') {
    return false;
  }
  if (SIZE_PATTERNS.some(pattern => pattern.test(trimmed))) {
    return true;
  }
  const numMatch = trimmed.match(/^(\d+)$/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    return isValidNumericSize(num);
  }
  return false;
}

function extractSizeFromSku(sku: string): string | null {
  if (!sku) return null;
  const parts = sku.split('-');
  
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i].trim().toUpperCase();
    if (!part || part.length === 0) continue;
    if (COLOR_PATTERNS.test(part)) continue;
    if (i < parts.length - 1 && /^\d{3,}$/.test(part)) continue;
    if (i === parts.length - 1 && /^\d{3,}$/.test(part)) {
      const num = parseInt(part, 10);
      if (!isValidNumericSize(num)) continue;
    }
    if (isValidSizeVariant(part)) {
      return part;
    }
  }
  
  if (parts.length >= 2) {
    const lastTwo = parts.slice(-2).join('-');
    if (/^\d{2}-\d{2}$/.test(lastTwo)) {
      const nums = lastTwo.split('-').map(n => parseInt(n, 10));
      if (nums.every(n => isValidNumericSize(n))) {
        return lastTwo;
      }
    }
  }
  
  return null;
}

// ============================================================================
// SIZE SORTING
// ============================================================================

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
  'ONE-SIZE': 100, 'ONESIZE': 100, 'ONE SIZE': 100,
};

function getSizeSortPriority(size: string): number {
  const upper = size.toUpperCase().trim();
  if (SIZE_ORDER[upper] !== undefined) return SIZE_ORDER[upper];
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
}

interface ProductGroup {
  key: string;           // Normalized title (lowercase)
  title: string;         // Display title
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

function normalizeTitle(title: string, vendor: string): string {
  let normalized = title.trim();
  if (vendor && normalized.toLowerCase().startsWith(vendor.toLowerCase())) {
    normalized = normalized.substring(vendor.length).replace(/^[\s\-–—:]+/, '').trim();
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
    
    // Validate required fields
    if (!title) {
      rejected.push({
        recordId: product.id,
        externalId: product.external_id,
        reason: 'Mangler titel',
      });
      continue;
    }
    
    // Determine variant size
    let variantSize: string | null = null;
    
    // First check if there's an explicit variant field
    if (data.variant_option && isValidSizeVariant(data.variant_option)) {
      variantSize = data.variant_option.toUpperCase();
    }
    // Then try to extract from SKU
    else if (sku) {
      variantSize = extractSizeFromSku(sku);
    }
    
    // If no valid size found, this could be a single-variant product or invalid
    // For now, we'll allow it as a single product (no variant grouping)
    
    // Create group key
    const normalizedTitle = normalizeTitle(title, vendor);
    const groupKey = normalizedTitle.toLowerCase();
    
    // Get or create group
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
    
    // Merge fields (longest wins)
    group.bodyHtml = mergeText(group.bodyHtml, data.body_html);
    group.vendor = mergeText(group.vendor, vendor);
    
    // Merge tags
    const productTags = data.tags || [];
    for (const tag of productTags) {
      if (tag && !group.tags.includes(tag)) {
        group.tags.push(tag);
      }
    }
    
    // Merge images
    const productImages = data.images || [];
    for (const img of productImages) {
      if (img && !group.images.includes(img)) {
        group.images.push(img);
      }
    }
    
    // Add variant
    if (variantSize) {
      // Check for duplicate size in group
      const existingVariant = group.variants.find(v => v.size.toUpperCase() === variantSize!.toUpperCase());
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
      // No valid size - add as single variant without option
      // Only if this is the first item in group
      if (group.variants.length === 0) {
        group.variants.push({
          recordId: product.id,
          externalId: product.external_id,
          sku: sku,
          size: '', // No size option
          price: String(data.price || '0'),
          compareAtPrice: data.compare_at_price ? String(data.compare_at_price) : null,
          stockQuantity: parseInt(String(data.stock_quantity || 0), 10),
          weight: data.weight ? parseFloat(String(data.weight)) : 0,
          barcode: data.barcode || null,
        });
      } else if (group.variants.every(v => v.size)) {
        // Group already has sized variants, but this one has no size - warn
        group.warnings.push(`Produkt uden størrelse (SKU: ${sku}) kan ikke tilføjes til gruppe med størrelsesvarianter`);
        rejected.push({
          recordId: product.id,
          externalId: product.external_id,
          reason: 'Ingen gyldig størrelse fundet, og produktgruppen har allerede størrelsesvarianter',
        });
        continue;
      }
    }
    
    group.recordIds.push(product.id);
    group.externalIds.push(product.external_id);
  }
  
  // Sort variants within each group
  for (const group of groups.values()) {
    if (group.variants.length > 1 && group.variants.every(v => v.size)) {
      group.variants.sort((a, b) => getSizeSortPriority(a.size) - getSizeSortPriority(b.size));
    }
  }
  
  // Final validation - reject groups with no valid variants
  const validGroups: ProductGroup[] = [];
  for (const group of groups.values()) {
    if (group.variants.length === 0) {
      for (const recordId of group.recordIds) {
        const externalId = group.externalIds[group.recordIds.indexOf(recordId)];
        rejected.push({
          recordId,
          externalId,
          reason: 'Ingen gyldige varianter efter gruppering',
        });
      }
    } else {
      validGroups.push(group);
    }
  }
  
  // Calculate stats
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
// MAIN HANDLER
// ============================================================================

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { projectId, entityType, previewOnly = true }: { 
      projectId: string; 
      entityType: 'products' | 'customers' | 'orders' | 'categories' | 'pages';
      previewOnly?: boolean;
    } = await req.json();

    console.log(`[PREPARE] Starting ${previewOnly ? 'preview' : 'commit'} for ${entityType}`);

    if (entityType === 'products') {
      // Fetch all pending products
      let allProducts: ProductRecord[] = [];
      let page = 0;
      const pageSize = 1000;
      
      while (true) {
        const { data, error } = await supabase
          .from('canonical_products')
          .select('id, external_id, data, status')
          .eq('project_id', projectId)
          .eq('status', 'pending')
          .range(page * pageSize, (page + 1) * pageSize - 1);
        
        if (error) throw error;
        if (!data || data.length === 0) break;
        
        allProducts = [...allProducts, ...data];
        if (data.length < pageSize) break;
        page++;
      }
      
      console.log(`[PREPARE] Fetched ${allProducts.length} pending products`);
      
      // Group and validate
      const result = groupProducts(allProducts);
      
      console.log(`[PREPARE] Created ${result.stats.groupsCreated} groups with ${result.stats.variantsTotal} variants`);
      console.log(`[PREPARE] Rejected ${result.stats.recordsRejected} records`);
      
      // If not preview only, update the database with grouped data
      if (!previewOnly) {
        const now = new Date().toISOString();
        
        // BATCH 1: Mark rejected records as 'mapped' with rejection reason
        // Store the reason in error_message so users can see WHY it was skipped
        for (const rejected of result.rejected) {
          await supabase
            .from('canonical_products')
            .update({ 
              status: 'mapped',
              error_message: `Afvist: ${rejected.reason}`,
              updated_at: now,
            })
            .eq('id', rejected.recordId);
        }
        console.log(`[PREPARE] Marked ${result.rejected.length} records as rejected with reasons`);
        
        // BATCH 2: Collect all secondary record IDs for bulk status update
        const secondaryIds: string[] = [];
        const primaryUpdates: Array<{ id: string; data: any }> = [];
        const secondaryDataUpdates: Array<{ id: string; data: any }> = [];
        
        for (const group of result.groups) {
          if (group.recordIds.length === 0) continue;
          
          const primaryId = group.recordIds[0];
          const primaryRecord = allProducts.find(p => p.id === primaryId);
          
          // Primary record update data
          primaryUpdates.push({
            id: primaryId,
            data: {
              ...(primaryRecord?.data || {}),
              _groupKey: group.key,
              _groupTitle: group.title,
              _variantCount: group.variants.length,
              _isPrimary: true,
              _mergedVariants: group.variants,
            }
          });
          
          // Secondary records
          for (let i = 1; i < group.recordIds.length; i++) {
            const secId = group.recordIds[i];
            secondaryIds.push(secId);
            const secRecord = allProducts.find(p => p.id === secId);
            secondaryDataUpdates.push({
              id: secId,
              data: {
                ...(secRecord?.data || {}),
                _groupKey: group.key,
                _isPrimary: false,
                _primaryRecordId: primaryId,
              }
            });
          }
        }
        
        // BATCH 3: Update primary records in parallel chunks
        for (let i = 0; i < primaryUpdates.length; i += 100) {
          const chunk = primaryUpdates.slice(i, i + 100);
          await Promise.all(chunk.map(u =>
            supabase
              .from('canonical_products')
              .update({ data: u.data, updated_at: now })
              .eq('id', u.id)
          ));
        }
        console.log(`[PREPARE] Updated ${primaryUpdates.length} primary records`);
        
        // BATCH 4: Bulk update secondary records' status to 'mapped'
        for (let i = 0; i < secondaryIds.length; i += 500) {
          const chunk = secondaryIds.slice(i, i + 500);
          await supabase
            .from('canonical_products')
            .update({ status: 'mapped', updated_at: now })
            .in('id', chunk);
        }
        console.log(`[PREPARE] Set ${secondaryIds.length} secondary records to mapped`);
        
        // BATCH 5: Update secondary records' data in parallel chunks
        for (let i = 0; i < secondaryDataUpdates.length; i += 100) {
          const chunk = secondaryDataUpdates.slice(i, i + 100);
          await Promise.all(chunk.map(u =>
            supabase
              .from('canonical_products')
              .update({ data: u.data })
              .eq('id', u.id)
          ));
        }
        
        console.log(`[PREPARE] Committed grouping to database`);
        
        // After commit, get TOTAL counts across all records (not just newly processed)
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
        
        // Calculate totals: primary = shopify products, primary + secondary = total variants
        const shopifyProducts = primaryCount || 0;
        const totalVariants = (primaryCount || 0) + (secondaryCount || 0);
        
        return new Response(JSON.stringify({
          success: true,
          groups: result.groups,
          rejected: result.rejected,
          stats: {
            totalRecords: totalRecords || 0,
            groupsCreated: shopifyProducts,
            variantsTotal: totalVariants,
            recordsRejected: result.stats.recordsRejected,
          },
        }), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }
      
      return new Response(JSON.stringify(result), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
    
    // For other entity types, return simple stats (no grouping needed)
    const tableName = `canonical_${entityType}` as const;
    const { count } = await supabase
      .from(tableName)
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('status', 'pending');
    
    return new Response(JSON.stringify({
      success: true,
      groups: [],
      rejected: [],
      stats: {
        totalRecords: count || 0,
        groupsCreated: count || 0,
        variantsTotal: count || 0,
        recordsRejected: 0,
      },
    }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[PREPARE] Error:', errorMessage);
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage,
    }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
