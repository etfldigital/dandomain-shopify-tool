import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Merge "duplicate" products as variants into existing Shopify products.
 * 
 * When products with the same title were uploaded as separate products instead
 * of as variants of the same product, this function:
 * 1. Picks one product as the "primary" (the one to keep)
 * 2. Fetches the variants from the "duplicate" products
 * 3. Adds those variants to the primary product
 * 4. Deletes the duplicate products from Shopify
 * 5. Updates the canonical_products records to point to the merged product
 */

interface MergeRequest {
  projectId: string;
  dryRun?: boolean; // If true, only return what would happen without making changes
  excludeVariants?: string[]; // SKUs to exclude from merge (user removed them)
  duplicateGroup: {
    key: string;
    shopifyIds: string[]; // Unique Shopify product IDs with same title
    itemIds: string[];    // All canonical_products IDs in this group
  };
}

interface ShopifyVariant {
  id: number;
  sku: string;
  price: string;
  compare_at_price: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  inventory_quantity: number;
  weight: number;
  weight_unit: string;
  barcode: string | null;
  requires_shipping: boolean;
  inventory_management: string | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string;
  vendor: string;
  product_type: string;
  tags: string;
  status: string;
  variants: ShopifyVariant[];
  options: { name: string; values: string[] }[];
  images: { id: number; src: string }[];
}

async function shopifyFetch(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<{ response: Response; body: string } | { rateLimited: true; retryAfterMs: number }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      const body = await response.text();
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
        console.log(`[MERGE] Rate limited, need to wait ${Math.round(waitMs/1000)}s`);
        return { rateLimited: true, retryAfterMs: waitMs };
      }
      
      return { response, body };
      
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      const isTransient = 
        message.includes('connection reset') ||
        message.includes('timeout') ||
        message.includes('network');
      
      if (isTransient && attempt < maxRetries - 1) {
        const waitMs = 1000 * Math.pow(2, attempt);
        console.warn(`[MERGE] Transient error, retrying in ${waitMs}ms: ${message}`);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { projectId, duplicateGroup, dryRun = false, excludeVariants = [] }: MergeRequest = await req.json();
    const excludeSkusSet = new Set(excludeVariants.map(s => s.toLowerCase()));

    console.log(`[MERGE] ${dryRun ? 'DRY RUN - ' : ''}Starting merge for group "${duplicateGroup.key}" with ${duplicateGroup.shopifyIds.length} Shopify products`);

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
    const shopifyUrl = `https://${shopifyDomain}/admin/api/2025-01`;

    const shopifyIds = duplicateGroup.shopifyIds.filter(Boolean);
    
    if (shopifyIds.length < 2) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Need at least 2 Shopify products to merge',
      }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    // Step 1: Fetch all products from Shopify
    console.log(`[MERGE] Fetching ${shopifyIds.length} products from Shopify...`);
    const products: ShopifyProduct[] = [];
    
    for (const shopifyId of shopifyIds) {
      const result = await shopifyFetch(
        `${shopifyUrl}/products/${shopifyId}.json`,
        { headers: { 'X-Shopify-Access-Token': shopifyToken } }
      );
      
      if ('rateLimited' in result) {
        return new Response(JSON.stringify({
          success: false,
          rateLimited: true,
          retryAfterMs: result.retryAfterMs,
        }), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }
      
      if (!result.response.ok) {
        console.warn(`[MERGE] Could not fetch product ${shopifyId}: ${result.response.status}`);
        continue;
      }
      
      const data = JSON.parse(result.body);
      products.push(data.product);
      
      await sleep(300); // Small delay between fetches
    }

    if (products.length < 2) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Could not fetch enough products from Shopify to merge',
      }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    // Step 2: Pick the primary product (the one with most variants, or first one)
    products.sort((a, b) => b.variants.length - a.variants.length);
    const primaryProduct = products[0];
    const duplicateProducts = products.slice(1);
    
    console.log(`[MERGE] Primary product: ${primaryProduct.id} (${primaryProduct.title}) with ${primaryProduct.variants.length} variants`);
    console.log(`[MERGE] Duplicate products to merge: ${duplicateProducts.map(p => p.id).join(', ')}`);

    // Valid size patterns - only these will be added as variants
    // IMPORTANT: Numeric sizes must be in realistic ranges to avoid matching product codes
    const SIZE_PATTERNS = [
      // Letter sizes (case insensitive)
      /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|xxxxl|xxxxxl)$/i,
      // Hyphenated compound letter sizes: S-M, L-XL, XS-S, etc.
      /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl)[-](xxxs|xxs|xs|s|m|l|xl|xxl|xxxl)$/i,
      // Combined letter-number sizes
      /^(xs|s|m|l|xl|xxl)[-\/]?\d+$/i,  // e.g., S-36, M/38
      /^\d+[-\/]?(xs|s|m|l|xl|xxl)$/i,  // e.g., 36-S
      // Range sizes (must be 2-digit numbers in valid ranges)
      /^\d{2}[-\/]\d{2}$/,  // e.g., 35-38
      // One size
      /^one[-\s]?size$/i,
      // Shoe sizes with half sizes
      /^\d{1,2}[.,]5$/,  // e.g., 7.5, 42,5
    ];

    // Valid numeric size ranges (to filter out product codes like 601)
    const VALID_NUMERIC_SIZE_RANGES = [
      { min: 0, max: 20 },    // US/UK shoe sizes, baby sizes
      { min: 32, max: 60 },   // European clothing sizes (pants, shirts)
      { min: 86, max: 194 },  // Kids clothing sizes (height-based: 86, 92, 98... 176, 194)
    ];

    function isValidNumericSize(num: number): boolean {
      return VALID_NUMERIC_SIZE_RANGES.some(range => num >= range.min && num <= range.max);
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
      'DEFAULT': 200,
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

    function sortVariantsBySize<T extends { option1?: string | null }>(variants: T[]): T[] {
      return [...variants].sort((a, b) => {
        const priorityA = getSizeSortPriority(a.option1 || 'DEFAULT');
        const priorityB = getSizeSortPriority(b.option1 || 'DEFAULT');
        return priorityA - priorityB;
      });
    }

    function isValidSizeVariant(option: string): boolean {
      const trimmed = option.trim();
      
      // First check pattern-based sizes (letters, combinations, etc.)
      if (SIZE_PATTERNS.some(pattern => pattern.test(trimmed))) {
        return true;
      }
      
      // Then check if it's a pure number in a valid size range
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

      // Check for hyphen-separated compound letter sizes first: e.g. 10041-S-M, 10041-L-XL
      if (parts.length >= 3) {
        const lastTwo = parts.slice(-2).join('-').toUpperCase();
        if (/^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)-(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)$/.test(lastTwo)) {
          return lastTwo;
        }
      }
      
      // Start from the last part (most common location for size)
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i].trim().toUpperCase();
        
        // Skip empty parts
        if (!part || part.length === 0) continue;
        
        // Skip color-like values (common non-size patterns)
        const colorPatterns = /^(BLACK|WHITE|GREY|GRAY|BLUE|RED|GREEN|YELLOW|PINK|BROWN|BEIGE|NAVY|SAND|CREAM|ROSE|ORANGE|PURPLE|TAN|OLIVE|MINT|CORAL|CAMEL|COGNAC|NUDE|SILVER|GOLD|STONE|DARK|LIGHT|NATURAL|MULCH|MELANGE|STRIPE)$/i;
        if (colorPatterns.test(part)) continue;
        
        // Skip parts that look like product codes (3+ digit numbers in SKU middle parts)
        // Product codes are usually: first or middle parts with 3+ digits
        // e.g. GL10300-681-L -> 10300 and 681 are product codes, L is size
        if (i < parts.length - 1 && /^\d{3,}$/.test(part)) {
          console.log(`[MERGE] Skipping middle SKU part ${part} - likely product code`);
          continue;
        }
        
        // For the last part: only accept if it's a letter size or valid numeric size
        if (i === parts.length - 1 && /^\d{3,}$/.test(part)) {
          // 3+ digit number at end - check if it's a valid size
          const num = parseInt(part, 10);
          if (!isValidNumericSize(num)) {
            console.log(`[MERGE] Skipping end SKU part ${part} - 3+ digit number not in valid size range`);
            continue;
          }
        }
        
        // Check if it's a valid size
        if (isValidSizeVariant(part)) {
          return part;
        }
      }
      
      // Special case: check if last TWO parts form a size range like "36-38"
      if (parts.length >= 2) {
        const lastTwo = parts.slice(-2).join('-');
        if (/^\d{2}-\d{2}$/.test(lastTwo)) {
          const nums = lastTwo.split('-').map(n => parseInt(n, 10));
          // Both numbers must be in valid size ranges
          if (nums.every(n => isValidNumericSize(n))) {
            return lastTwo;
          }
        }
      }
      
      return null;
    }

    // Step 3: Collect all variants from duplicate products
    const newVariants: any[] = [];
    const existingSkus = new Set(primaryProduct.variants.map(v => v.sku?.toLowerCase() || ''));
    const existingOptions = new Set(primaryProduct.variants.map(v => v.option1?.toLowerCase() || ''));
    
    for (const dupProduct of duplicateProducts) {
      for (const variant of dupProduct.variants) {
        const skuLower = variant.sku?.toLowerCase() || '';
        const optionLower = variant.option1?.toLowerCase() || '';
        
        // Skip if user excluded this variant
        if (skuLower && excludeSkusSet.has(skuLower)) {
          console.log(`[MERGE] Skipping variant ${variant.sku} - excluded by user`);
          continue;
        }
        
        // Skip if variant already exists (by SKU or option)
        if (skuLower && existingSkus.has(skuLower)) {
          console.log(`[MERGE] Skipping variant ${variant.sku} - already exists`);
          continue;
        }
        
        // Determine variant option - ONLY accept size variants
        let variantOption = variant.option1;
        
        // If the option is not a valid size, try to extract from SKU
        if (!variantOption || variantOption === 'Default Title' || !isValidSizeVariant(variantOption)) {
          const sizeFromSku = extractSizeFromSku(variant.sku || '');
          if (sizeFromSku) {
            variantOption = sizeFromSku;
          } else {
            // Not a size variant - skip it (this filters out color variants like -grey)
            console.log(`[MERGE] Skipping variant ${variant.sku} - not a valid size variant (option: ${variant.option1})`);
            continue;
          }
        }
        
        // Skip if this option value already exists
        if (existingOptions.has(variantOption.toLowerCase())) {
          console.log(`[MERGE] Skipping variant with option "${variantOption}" - already exists`);
          continue;
        }
        
        newVariants.push({
          sku: variant.sku,
          price: variant.price,
          compare_at_price: variant.compare_at_price,
          option1: variantOption.toUpperCase(),
          inventory_quantity: variant.inventory_quantity || 0,
          weight: variant.weight || 0,
          weight_unit: variant.weight_unit || 'kg',
          barcode: variant.barcode,
          requires_shipping: variant.requires_shipping ?? true,
          inventory_management: 'shopify',
          sourceProductId: String(dupProduct.id), // Track source for UI
        });
        
        existingSkus.add(skuLower);
        existingOptions.add(variantOption.toLowerCase());
      }
    }

    console.log(`[MERGE] Found ${newVariants.length} new variants to add`);

    // Sort new variants by size (smallest to largest)
    const sortedNewVariants = sortVariantsBySize(newVariants);

    // Check if any existing variants on primary product need size correction (Default Title → actual size)
    const variantsToCorrect: { variantId: number; sku: string; newOption: string }[] = [];
    for (const variant of primaryProduct.variants) {
      const option = variant.option1?.toLowerCase() || '';
      // Check if it's Default Title or not a valid size
      if (option === 'default title' || option === 'default' || !isValidSizeVariant(variant.option1 || '')) {
        const sizeFromSku = extractSizeFromSku(variant.sku || '');
        if (sizeFromSku) {
          variantsToCorrect.push({
            variantId: variant.id,
            sku: variant.sku || '',
            newOption: sizeFromSku.toUpperCase(),
          });
          console.log(`[MERGE] Will correct existing variant ${variant.sku}: "${variant.option1}" → "${sizeFromSku.toUpperCase()}"`);
        }
      }
    }

    // Build corrected existing variants for preview/sorting
    // IMPORTANT: Filter out any variant that would end up with "Default" as option
    const correctedExistingVariants = primaryProduct.variants
      .map(v => {
        const correction = variantsToCorrect.find(c => c.variantId === v.id);
        const finalOption = correction ? correction.newOption : v.option1;
        return {
          ...v,
          option1: finalOption,
          willBeCorrect: !!correction,
        };
      })
      .filter(v => {
        // NEVER include Default variants in preview - they should not exist after merge
        const option = (v.option1 || '').toLowerCase().trim();
        if (option === 'default title' || option === 'default' || option === '') {
          console.log(`[MERGE] Filtering out Default variant from preview: ${v.sku}`);
          return false;
        }
        // Also ensure it's a valid size
        if (!isValidSizeVariant(v.option1 || '')) {
          console.log(`[MERGE] Filtering out non-size variant from preview: ${v.sku} (${v.option1})`);
          return false;
        }
        return true;
      });

    // If dry run, return the preview without making changes
    if (dryRun) {
      console.log(`[MERGE] Dry run complete - returning preview`);
      
      // Sort existing variants for display (with corrections applied)
      const sortedExistingVariants = sortVariantsBySize(correctedExistingVariants);
      
      // Filter duplicate product variants similarly - only show valid size variants
      const filteredDuplicateProducts = duplicateProducts.map(p => ({
        id: String(p.id),
        title: p.title,
        variantCount: p.variants.length,
        variants: p.variants
          .filter(v => {
            const option = (v.option1 || '').toLowerCase().trim();
            // Skip Default Title
            if (option === 'default title' || option === 'default' || option === '') {
              // BUT check if we can extract a size from SKU
              const sizeFromSku = extractSizeFromSku(v.sku || '');
              return !!sizeFromSku; // Only include if we can extract a valid size
            }
            return isValidSizeVariant(v.option1 || '');
          })
          .map(v => {
            const option = (v.option1 || '').toLowerCase().trim();
            let displayOption = v.option1;
            // Replace Default Title with extracted size
            if (option === 'default title' || option === 'default' || option === '') {
              const sizeFromSku = extractSizeFromSku(v.sku || '');
              displayOption = sizeFromSku ? sizeFromSku.toUpperCase() : v.option1;
            }
            return {
              sku: v.sku,
              option: displayOption || 'Default',
              price: v.price,
            };
          }),
      }));
      
      return new Response(JSON.stringify({
        success: true,
        dryRun: true,
        preview: {
          primaryProduct: {
            id: String(primaryProduct.id),
            title: primaryProduct.title,
            variantCount: sortedExistingVariants.length, // Only count valid variants
            variants: sortedExistingVariants.map(v => ({
              sku: v.sku,
              option: v.option1,
              originalOption: variantsToCorrect.find(c => c.variantId === v.id) ? 
                primaryProduct.variants.find(pv => pv.id === v.id)?.option1 : undefined,
              price: v.price,
              willBeCorrected: !!variantsToCorrect.find(c => c.variantId === v.id),
            })),
          },
          duplicateProducts: filteredDuplicateProducts,
          newVariantsToAdd: sortedNewVariants.map(v => ({
            sku: v.sku,
            option: v.option1,
            price: v.price,
          })),
          variantsToCorrect: variantsToCorrect.map(v => ({
            sku: v.sku,
            newOption: v.newOption,
          })),
          productsToDelete: duplicateProducts.length,
          summary: {
            totalVariantsAfterMerge: sortedExistingVariants.length + sortedNewVariants.length,
            variantsToAdd: sortedNewVariants.length,
            variantsToCorrect: variantsToCorrect.length,
            productsToDelete: duplicateProducts.length,
          },
        },
      }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    // Step 4a: Correct existing variants with Default Title
    if (variantsToCorrect.length > 0) {
      console.log(`[MERGE] Correcting ${variantsToCorrect.length} existing variants...`);
      for (const correction of variantsToCorrect) {
        const variantResult = await shopifyFetch(
          `${shopifyUrl}/variants/${correction.variantId}.json`,
          {
            method: 'PUT',
            headers: { 
              'Content-Type': 'application/json', 
              'X-Shopify-Access-Token': shopifyToken 
            },
            body: JSON.stringify({
              variant: {
                id: correction.variantId,
                option1: correction.newOption,
              }
            }),
          }
        );
        
        if ('rateLimited' in variantResult) {
          return new Response(JSON.stringify({
            success: false,
            rateLimited: true,
            retryAfterMs: variantResult.retryAfterMs,
          }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }
        
        if (!variantResult.response.ok) {
          console.warn(`[MERGE] Could not correct variant ${correction.sku}: ${variantResult.body}`);
        } else {
          console.log(`[MERGE] Corrected variant ${correction.sku} to "${correction.newOption}"`);
        }
        
        await sleep(300);
      }
    }

    if (sortedNewVariants.length === 0 && variantsToCorrect.length === 0) {
      // No new variants to add or correct, just delete duplicates
      console.log(`[MERGE] No new variants or corrections, proceeding to delete duplicates only`);
    } else if (sortedNewVariants.length > 0) {
      // Step 4b: Add new variants to the primary product
      // First, update the product's options to include all variant values (sorted)
      const allVariantsForSorting = [
        ...correctedExistingVariants.map(v => ({ option1: v.option1 })),
        ...sortedNewVariants.map(v => ({ option1: v.option1 })),
      ];
      const sortedAllVariants = sortVariantsBySize(allVariantsForSorting);
      const sortedUniqueOptions = [...new Set(sortedAllVariants.map(v => v.option1).filter(Boolean))];
      
      // Update product options first
      const optionsResult = await shopifyFetch(
        `${shopifyUrl}/products/${primaryProduct.id}.json`,
        {
          method: 'PUT',
          headers: { 
            'Content-Type': 'application/json', 
            'X-Shopify-Access-Token': shopifyToken 
          },
          body: JSON.stringify({
            product: {
              id: primaryProduct.id,
              options: [{ name: 'Størrelse', values: sortedUniqueOptions }],
            }
          }),
        }
      );
      
      if ('rateLimited' in optionsResult) {
        return new Response(JSON.stringify({
          success: false,
          rateLimited: true,
          retryAfterMs: optionsResult.retryAfterMs,
        }), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }
      
      if (!optionsResult.response.ok) {
        console.warn(`[MERGE] Could not update product options: ${optionsResult.body}`);
      }
      
      await sleep(500);
      
      // Add each new variant (in sorted order from smallest to largest)
      let variantsAdded = 0;
      for (const variant of sortedNewVariants) {
        const variantResult = await shopifyFetch(
          `${shopifyUrl}/products/${primaryProduct.id}/variants.json`,
          {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json', 
              'X-Shopify-Access-Token': shopifyToken 
            },
            body: JSON.stringify({ variant }),
          }
        );
        
        if ('rateLimited' in variantResult) {
          console.log(`[MERGE] Rate limited after adding ${variantsAdded} variants, will continue on retry`);
          return new Response(JSON.stringify({
            success: false,
            rateLimited: true,
            retryAfterMs: variantResult.retryAfterMs,
            partial: true,
            variantsAdded,
          }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }
        
        if (!variantResult.response.ok) {
          console.warn(`[MERGE] Could not add variant ${variant.sku}: ${variantResult.body}`);
        } else {
          variantsAdded++;
          console.log(`[MERGE] Added variant ${variant.sku} (${variant.option1})`);
        }
        
        await sleep(300);
      }
      
      console.log(`[MERGE] Successfully added ${variantsAdded} variants to primary product`);
      
      // Step 4c: Reorder all variants by size (S, M, L, XL order)
      // Fetch the updated product to get all variant IDs
      await sleep(500);
      
      const updatedProductResult = await shopifyFetch(
        `${shopifyUrl}/products/${primaryProduct.id}.json`,
        { headers: { 'X-Shopify-Access-Token': shopifyToken } }
      );
      
      if (!('rateLimited' in updatedProductResult) && updatedProductResult.response.ok) {
        const updatedProduct = JSON.parse(updatedProductResult.body).product;
        
        // Sort variants by size
        const sortedVariantIds = updatedProduct.variants
          .map((v: any) => ({
            id: v.id,
            option1: v.option1 || 'Default',
          }))
          .sort((a: any, b: any) => {
            const priorityA = getSizeSortPriority(a.option1);
            const priorityB = getSizeSortPriority(b.option1);
            return priorityA - priorityB;
          })
          .map((v: any) => ({ id: v.id }));
        
        console.log(`[MERGE] Reordering ${sortedVariantIds.length} variants by size...`);
        
        // Use Shopify's variant set positions endpoint to reorder without affecting images
        // We update each variant's position individually
        let positionUpdated = 0;
        for (let i = 0; i < sortedVariantIds.length; i++) {
          const variantId = sortedVariantIds[i].id;
          const position = i + 1;
          
          const positionResult = await shopifyFetch(
            `${shopifyUrl}/variants/${variantId}.json`,
            {
              method: 'PUT',
              headers: { 
                'Content-Type': 'application/json', 
                'X-Shopify-Access-Token': shopifyToken 
              },
              body: JSON.stringify({
                variant: {
                  id: variantId,
                  position: position,
                }
              }),
            }
          );
          
          if (!('rateLimited' in positionResult) && positionResult.response.ok) {
            positionUpdated++;
          }
          
          await sleep(200);
        }
        
        console.log(`[MERGE] Successfully reordered ${positionUpdated}/${sortedVariantIds.length} variants by size`);
      }
    }

    // Step 5: Delete duplicate products from Shopify
    let productsDeleted = 0;
    for (const dupProduct of duplicateProducts) {
      const deleteResult = await shopifyFetch(
        `${shopifyUrl}/products/${dupProduct.id}.json`,
        {
          method: 'DELETE',
          headers: { 'X-Shopify-Access-Token': shopifyToken },
        }
      );
      
      if ('rateLimited' in deleteResult) {
        console.log(`[MERGE] Rate limited during deletion, deleted ${productsDeleted} so far`);
        // Don't return - continue with DB update for what we've done
        break;
      }
      
      if (deleteResult.response.ok) {
        productsDeleted++;
        console.log(`[MERGE] Deleted duplicate product ${dupProduct.id}`);
      } else {
        console.warn(`[MERGE] Could not delete product ${dupProduct.id}: ${deleteResult.body}`);
      }
      
      await sleep(300);
    }

    console.log(`[MERGE] Deleted ${productsDeleted}/${duplicateProducts.length} duplicate products`);

    // Step 6: Update canonical_products records
    // All items should now point to the primary product's Shopify ID
    const primaryShopifyId = String(primaryProduct.id);
    const { error: updateError } = await supabase
      .from('canonical_products')
      .update({ 
        shopify_id: primaryShopifyId, 
        status: 'uploaded',
        updated_at: new Date().toISOString(),
      })
      .in('id', duplicateGroup.itemIds);
    
    if (updateError) {
      console.error(`[MERGE] Error updating canonical_products: ${updateError.message}`);
    } else {
      console.log(`[MERGE] Updated ${duplicateGroup.itemIds.length} canonical_products records to point to ${primaryShopifyId}`);
    }

    return new Response(JSON.stringify({
      success: true,
      primaryProductId: primaryShopifyId,
      variantsAdded: sortedNewVariants.length,
      productsDeleted,
      itemsUpdated: duplicateGroup.itemIds.length,
    }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MERGE] Fatal error:', errorMessage);
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage,
    }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
