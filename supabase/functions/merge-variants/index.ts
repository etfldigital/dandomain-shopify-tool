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
    const shopifyUrl = `https://${shopifyDomain}/admin/api/2024-01`;

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
    const SIZE_PATTERNS = [
      // Letter sizes (case insensitive)
      /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|xxxxl|xxxxxl)$/i,
      // Number sizes
      /^\d{1,3}$/,  // e.g., 36, 38, 40, 42, 128
      // Combined letter-number sizes
      /^(xs|s|m|l|xl|xxl)[-\/]?\d+$/i,  // e.g., S-36, M/38
      /^\d+[-\/]?(xs|s|m|l|xl|xxl)$/i,  // e.g., 36-S
      // Range sizes
      /^\d{2,3}[-\/]\d{2,3}$/,  // e.g., 35-38, 128/134
      // One size
      /^one[-\s]?size$/i,
      // Shoe sizes with half sizes
      /^\d{1,2}[.,]5$/,  // e.g., 7.5, 42,5
    ];

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

    function sortVariantsBySize<T extends { option1?: string }>(variants: T[]): T[] {
      return [...variants].sort((a, b) => {
        const priorityA = getSizeSortPriority(a.option1 || 'DEFAULT');
        const priorityB = getSizeSortPriority(b.option1 || 'DEFAULT');
        return priorityA - priorityB;
      });
    }

    function isValidSizeVariant(option: string): boolean {
      const trimmed = option.trim();
      return SIZE_PATTERNS.some(pattern => pattern.test(trimmed));
    }

    function extractSizeFromSku(sku: string): string | null {
      if (!sku) return null;
      
      const parts = sku.split('-');
      
      // First, try to find a simple size from the end (most common case)
      // Start from the last part and work backwards
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i].trim().toUpperCase();
        
        // Skip empty parts and common non-size parts
        if (!part || part.length === 0) continue;
        
        // Skip color-like values (common non-size patterns)
        const colorPatterns = /^(BLACK|WHITE|GREY|GRAY|BLUE|RED|GREEN|YELLOW|PINK|BROWN|BEIGE|NAVY|SAND|CREAM|ROSE|ORANGE|PURPLE|TAN|OLIVE|MINT|CORAL|CAMEL|COGNAC|NUDE|SILVER|GOLD|STONE|DARK|LIGHT|NATURAL)$/i;
        if (colorPatterns.test(part)) continue;
        
        // Check if it's a valid size
        if (isValidSizeVariant(part)) {
          return part;
        }
      }
      
      // Special case: check if last TWO parts form a size range like "36-38"
      if (parts.length >= 2) {
        const lastTwo = parts.slice(-2).join('-');
        if (/^\d{2,3}-\d{2,3}$/.test(lastTwo)) {
          // It's a range - take the last number as the size
          const lastNum = parts[parts.length - 1];
          if (/^\d{2,3}$/.test(lastNum)) {
            return lastNum;
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

    // If dry run, return the preview without making changes
    if (dryRun) {
      console.log(`[MERGE] Dry run complete - returning preview`);
      
      // Sort existing variants for display
      const sortedExistingVariants = sortVariantsBySize(
        primaryProduct.variants.map(v => ({ ...v, option1: v.option1 || 'Default' }))
      );
      
      return new Response(JSON.stringify({
        success: true,
        dryRun: true,
        preview: {
          primaryProduct: {
            id: String(primaryProduct.id),
            title: primaryProduct.title,
            variantCount: primaryProduct.variants.length,
            variants: sortedExistingVariants.map(v => ({
              sku: v.sku,
              option: v.option1 || 'Default',
              price: v.price,
            })),
          },
          duplicateProducts: duplicateProducts.map(p => ({
            id: String(p.id),
            title: p.title,
            variantCount: p.variants.length,
            variants: p.variants.map(v => ({
              sku: v.sku,
              option: v.option1 || 'Default',
              price: v.price,
            })),
          })),
          newVariantsToAdd: sortedNewVariants.map(v => ({
            sku: v.sku,
            option: v.option1,
            price: v.price,
          })),
          productsToDelete: duplicateProducts.length,
          summary: {
            totalVariantsAfterMerge: primaryProduct.variants.length + sortedNewVariants.length,
            variantsToAdd: sortedNewVariants.length,
            productsToDelete: duplicateProducts.length,
          },
        },
      }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    if (sortedNewVariants.length === 0) {
      // No new variants to add, just delete duplicates
      console.log(`[MERGE] No new variants found, proceeding to delete duplicates only`);
    } else {
      // Step 4: Add new variants to the primary product
      // First, update the product's options to include all variant values (sorted)
      const allVariantsForSorting = [
        ...primaryProduct.variants.map(v => ({ option1: v.option1 || 'Default' })),
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
