import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
    // Used to turn relative image paths (e.g. /images/x.webp) into full URLs.
    // Fallback to the shop URL if base URL isn't configured.
    const dandomainBaseUrl = String(project.dandomain_base_url || project.dandomain_shop_url || '').trim();
    const shopifyUrl = `https://${shopifyDomain}/admin/api/2024-01`;

    let processed = 0;
    let errors = 0;
    let errorDetails: { externalId: string; message: string }[] = [];

    // Get pending items based on entity type
    const tableName = `canonical_${entityType}`;
    
    // Special handling for products - group by title to create variants
    if (entityType === 'products') {
      const result = await uploadProductsWithVariants(supabase, projectId, shopifyUrl, shopifyToken, batchSize, dandomainBaseUrl);
      return new Response(JSON.stringify(result), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
    
    const { data: items, error: fetchError } = await supabase
      .from(tableName)
      .select('*')
      .eq('project_id', projectId)
      .eq('status', 'pending')
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

    // Process each item
    for (const item of items) {
      try {
        let shopifyId: string | null = null;

        switch (entityType) {
          case 'customers':
            shopifyId = await uploadCustomer(shopifyUrl, shopifyToken, item.data);
            break;
          case 'orders':
            shopifyId = await uploadOrder(shopifyUrl, shopifyToken, item.data, supabase, projectId);
            break;
          case 'categories':
            shopifyId = await uploadCollection(shopifyUrl, shopifyToken, item);
            break;
          case 'pages':
            shopifyId = await uploadPage(shopifyUrl, shopifyToken, item.data);
            break;
        }

        // Update status to uploaded
        await supabase
          .from(tableName)
          .update({
            status: 'uploaded', 
            shopify_id: shopifyId,
            updated_at: new Date().toISOString()
          })
          .eq('id', item.id);

        processed++;
      } catch (error) {
        errors++;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errorDetails.push({ externalId: item.external_id, message: errorMessage });

        // Update status to failed
        await supabase
          .from(tableName)
          .update({ 
            status: 'failed', 
            error_message: errorMessage,
            updated_at: new Date().toISOString()
          })
          .eq('id', item.id);
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
      errors,
      errorDetails,
      hasMore: (count || 0) > 0,
      remaining: count || 0,
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
  // Remove leading dash/separator
  return suffix.replace(/^[-_]/, '').toUpperCase() || 'Default';
}

function normalizeImageUrl(raw: string, baseUrl: string): string {
  let img = String(raw || '').trim();
  if (!img) return '';

  // Already absolute
  if (/^https?:\/\//i.test(img)) {
    // URL-encode spaces and other special characters in the path
    try {
      const url = new URL(img);
      url.pathname = url.pathname.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');
      return url.toString();
    } catch {
      // If URL parsing fails, just encode spaces
      return img.replace(/ /g, '%20');
    }
  }

  // Protocol-relative URL
  if (img.startsWith('//')) {
    img = `https:${img}`;
    try {
      const url = new URL(img);
      url.pathname = url.pathname.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');
      return url.toString();
    } catch {
      return img.replace(/ /g, '%20');
    }
  }

  // No base to join with (will likely be rejected by Shopify)
  const base = String(baseUrl || '').trim();
  if (!base) return img.replace(/ /g, '%20');

  const baseClean = base.replace(/\/$/, '');
  let fullUrl = img.startsWith('/') ? baseClean + img : baseClean + '/' + img;
  
  // URL-encode spaces and special characters
  try {
    const url = new URL(fullUrl);
    url.pathname = url.pathname.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');
    return url.toString();
  } catch {
    return fullUrl.replace(/ /g, '%20');
  }
}

async function setInventoryItemCost(
  shopifyUrl: string,
  token: string,
  inventoryItemId: number | string,
  cost: number
): Promise<void> {
  const id = Number(inventoryItemId);
  if (!id || !Number.isFinite(cost)) return;

  const response = await fetch(`${shopifyUrl}/inventory_items/${id}.json`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({
      inventory_item: {
        id,
        cost,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`InventoryItem cost update failed: ${response.status} - ${errorBody}`);
  }
}
async function uploadProductsWithVariants(
  supabase: any,
  projectId: string,
  shopifyUrl: string,
  token: string,
  batchSize: number,
  dandomainBaseUrl: string
): Promise<{ success: boolean; processed: number; errors: number; hasMore: boolean; errorDetails?: any[] }> {
  
  // Get all pending products
  const { data: allPending, error: fetchError } = await supabase
    .from('canonical_products')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .order('data->>title');

  if (fetchError) {
    throw new Error(`Failed to fetch products: ${fetchError.message}`);
  }

  if (!allPending || allPending.length === 0) {
    return { success: true, processed: 0, errors: 0, hasMore: false };
  }

  // Group products by title (same title = variants of same product)
  const productGroups: Map<string, any[]> = new Map();
  
  for (const item of allPending) {
    const title = item.data?.title || '';
    if (!title || title === 'Untitled') continue;
    
    if (!productGroups.has(title)) {
      productGroups.set(title, []);
    }
    productGroups.get(title)!.push(item);
  }

  let processed = 0;
  let errors = 0;
  const errorDetails: { externalId: string; message: string }[] = [];
  
  // Process up to batchSize product groups
  const groupsToProcess = Array.from(productGroups.entries()).slice(0, batchSize);

  for (const [title, items] of groupsToProcess) {
    try {
      // Sort items by SKU length (shortest first = base product)
      items.sort((a, b) => (a.data?.sku || '').length - (b.data?.sku || '').length);
      
      const baseProduct = items[0];
      const baseSku = baseProduct.data?.sku || '';
      const data = baseProduct.data;
      
      // Skip untitled/empty products
      if (!data.title || data.title === 'Untitled') {
        throw new Error('Produktet har ingen titel og blev sprunget over');
      }

      // Transform title: strip vendor from title if present
      let transformedTitle = data.title;
      const vendor = data.vendor || '';
      
      if (vendor && transformedTitle.includes(vendor)) {
        const separators = [' - ', ' – ', ' — ', ': ', ' | '];
        for (const sep of separators) {
          if (transformedTitle.startsWith(vendor + sep)) {
            transformedTitle = transformedTitle.substring(vendor.length + sep.length).trim();
            break;
          }
        }
      }

      // Get tags from categories
      const tags: string[] = [...(data.tags || [])];
      
      if (data.category_external_ids && data.category_external_ids.length > 0) {
        const { data: categories } = await supabase
          .from('canonical_categories')
          .select('shopify_tag, name')
          .eq('project_id', projectId)
          .in('external_id', data.category_external_ids)
          .eq('exclude', false);
        
        if (categories) {
          for (const cat of categories) {
            if (cat.shopify_tag) {
              tags.push(cat.shopify_tag);
            } else if (cat.name) {
              tags.push(cat.name);
            }
          }
        }
      }

      // Build variants from all items in the group
      const variants = items.map((item, index) => {
        const variantData = item.data;
        const option = extractVariantOption(baseSku, variantData?.sku || '');
        
        const variant: any = {
          sku: variantData?.sku || '',
          price: String(variantData?.price || 0),
          compare_at_price: variantData?.compare_at_price ? String(variantData.compare_at_price) : null,
          inventory_quantity: variantData?.stock_quantity || 0,
          weight: variantData?.weight || 0,
          weight_unit: 'kg',
          inventory_management: 'shopify',
          option1: option,
          position: index + 1,
        };
        
        // Shopify uses 'cost' for inventory cost (cost price)
        if (variantData?.cost_price) {
          variant.cost = String(variantData.cost_price);
        }
        
        return variant;
      });

      // Determine if we need variant options
      const hasVariants = items.length > 1;
      
      // Collect all unique images from variants and build full URLs
      // Use first product's images as primary, then add unique variant images
      const primaryImages: string[] = [];
      const variantImages: string[] = [];
      
      for (let i = 0; i < items.length; i++) {
        const imgs = items[i].data?.images || [];
        for (const rawImg of imgs) {
          const fullUrl = normalizeImageUrl(rawImg, dandomainBaseUrl);
          if (!fullUrl) continue;
          
          if (i === 0) {
            // First product's images are primary
            if (!primaryImages.includes(fullUrl)) {
              primaryImages.push(fullUrl);
            }
          } else {
            // Other variants' images - only add if not already in primary
            if (!primaryImages.includes(fullUrl) && !variantImages.includes(fullUrl)) {
              variantImages.push(fullUrl);
            }
          }
        }
      }
      
      // Combine: primary images first, then variant images
      const allImages = [...primaryImages, ...variantImages];

      if (allImages.length > 0) {
        console.log(`Product "${transformedTitle}" images:`, allImages.slice(0, 3));
      }

      // Build product payload - try without images first if we have problematic URLs
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

      // Add options if there are variants
      if (hasVariants) {
        productPayload.product.options = [{ name: 'Størrelse', values: variants.map(v => v.option1) }];
      }

      console.log(`Uploading product "${transformedTitle}" with ${variants.length} variant(s)`);

      let response = await fetch(`${shopifyUrl}/products.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify(productPayload),
      });

      // If image URL error, retry without images
      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 422 && errorBody.includes('Image URL is invalid') && allImages.length > 0) {
          console.log(`Retrying product "${transformedTitle}" without images due to invalid URL`);
          
          // Retry without images
          productPayload.product.images = [];
          response = await fetch(`${shopifyUrl}/products.json`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': token,
            },
            body: JSON.stringify(productPayload),
          });
        }
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Shopify API error: ${response.status} - ${errorBody}`);
      }

      const result = await response.json();
      const shopifyId = String(result.product.id);

      // Update cost price (inventory cost) per variant via InventoryItem API
      const createdVariants = result?.product?.variants || [];
      for (const createdVariant of createdVariants) {
        const sku = createdVariant?.sku;
        const inventoryItemId = createdVariant?.inventory_item_id;
        const source = items.find((it) => it.data?.sku === sku)?.data;
        const cost = source?.cost_price;

        if (cost != null && inventoryItemId) {
          try {
            await setInventoryItemCost(shopifyUrl, token, inventoryItemId, Number(cost));
          } catch (e) {
            console.log(`Could not set cost for SKU ${sku}:`, e instanceof Error ? e.message : e);
          }
        }
      }

      // Update all items in this group as uploaded
      for (const item of items) {
        await supabase
          .from('canonical_products')
          .update({
            status: 'uploaded',
            shopify_id: shopifyId,
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);
      }

      processed += items.length;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error uploading product group "${title}":`, errorMessage);
      
      // Mark all items in this group as failed
      for (const item of items) {
        await supabase
          .from('canonical_products')
          .update({
            status: 'failed',
            error_message: errorMessage,
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);
        
        errorDetails.push({ externalId: item.external_id, message: errorMessage });
      }
      
      errors += items.length;
    }
  }

  // Check if there are more pending products
  const { count: remainingCount } = await supabase
    .from('canonical_products')
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

async function uploadProduct(
  shopifyUrl: string, 
  token: string, 
  data: any,
  supabase: any,
  projectId: string
): Promise<string> {
  // Skip untitled/empty products
  if (!data.title || data.title === 'Untitled') {
    throw new Error('Produktet har ingen titel og blev sprunget over');
  }

  // Transform title: strip vendor from title if present
  let transformedTitle = data.title;
  const vendor = data.vendor || '';
  
  if (vendor && transformedTitle.includes(vendor)) {
    // Common separators
    const separators = [' - ', ' – ', ' — ', ': ', ' | '];
    for (const sep of separators) {
      if (transformedTitle.startsWith(vendor + sep)) {
        transformedTitle = transformedTitle.substring(vendor.length + sep.length).trim();
        break;
      }
    }
  }

  // Get tags from categories
  const tags: string[] = [...(data.tags || [])];
  
  if (data.category_external_ids && data.category_external_ids.length > 0) {
    const { data: categories } = await supabase
      .from('canonical_categories')
      .select('shopify_tag, name')
      .eq('project_id', projectId)
      .in('external_id', data.category_external_ids)
      .eq('exclude', false);
    
    if (categories) {
      for (const cat of categories) {
        if (cat.shopify_tag) {
          tags.push(cat.shopify_tag);
        } else if (cat.name) {
          tags.push(cat.name);
        }
      }
    }
  }

  const variant: any = {
    sku: data.sku || '',
    price: String(data.price || 0),
    compare_at_price: data.compare_at_price ? String(data.compare_at_price) : null,
    inventory_quantity: data.stock_quantity || 0,
    weight: data.weight || 0,
    weight_unit: 'kg',
    inventory_management: 'shopify',
  };
  
  // Shopify uses 'cost' for inventory cost (cost price)
  if (data.cost_price) {
    variant.cost = String(data.cost_price);
  }

  const productPayload = {
    product: {
      title: transformedTitle,
      body_html: data.body_html || '',
      vendor: vendor,
      product_type: '',
      tags: [...new Set(tags)].join(', '),
      status: data.active ? 'active' : 'draft',
      variants: [variant],
      images: (data.images || []).map((url: string) => ({ src: url })),
    }
  };

  const response = await fetch(`${shopifyUrl}/products.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(productPayload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Shopify API error: ${response.status} - ${errorBody}`);
  }

  const result = await response.json();
  return String(result.product.id);
}

// Normalize phone number for Shopify:
// - Strip Danish country codes (45, +45, 0045) from the beginning
// - Return null if the result is empty or invalid
function normalizePhoneNumber(raw: unknown): string | undefined {
  let phone = String(raw ?? '').trim();
  if (!phone) return undefined;

  // Remove all spaces, dashes, parentheses
  phone = phone.replace(/[\s\-\(\)]/g, '');

  // Strip Danish country codes from the beginning
  // Order matters: check longer patterns first
  if (phone.startsWith('+45')) {
    phone = phone.substring(3);
  } else if (phone.startsWith('0045')) {
    phone = phone.substring(4);
  } else if (phone.startsWith('45') && phone.length > 8) {
    // Only strip "45" if phone is longer than 8 digits (Danish numbers are 8 digits)
    phone = phone.substring(2);
  }

  // If empty or too short, return undefined
  if (!phone || phone.length < 6) return undefined;

  return phone;
}

function normalizeCountryForShopify(raw: unknown): { country?: string; country_code?: string } {
  const value = String(raw ?? '').trim();
  if (!value) return { country: 'Denmark', country_code: 'DK' };

  const lower = value.toLowerCase();
  if (lower === 'dk' || lower === 'dnk' || lower === 'danmark' || lower === 'denmark') {
    return { country: 'Denmark', country_code: 'DK' };
  }

  // If it looks like an ISO country code, send it as country_code
  if (/^[a-z]{2}$/i.test(value)) {
    return { country_code: value.toUpperCase() };
  }

  return { country: value };
}

function buildShopifyAddress(
  source: any,
  fallback: any,
  person: { first_name?: string; last_name?: string; phone?: string; company?: string }
) {
  const address1 = source?.address1 || fallback?.address1 || '';
  const address2 = source?.address2 ?? fallback?.address2 ?? null;
  const city = source?.city || fallback?.city || '';
  const zip = source?.zip || fallback?.zip || '';
  const rawPhone = person.phone ?? source?.phone ?? fallback?.phone ?? null;
  const phone = normalizePhoneNumber(rawPhone);
  const company = person.company ?? source?.company ?? fallback?.company ?? null;
  const countryRaw = source?.country ?? fallback?.country ?? 'DK';
  const { country, country_code } = normalizeCountryForShopify(countryRaw);

  const address: Record<string, any> = {
    first_name: person.first_name || '',
    last_name: person.last_name || '',
    company,
    address1,
    address2,
    city,
    zip,
    phone,
  };

  if (country) address.country = country;
  if (country_code) address.country_code = country_code;

  return address;
}

function hasMeaningfulAddress(addr: any): boolean {
  if (!addr) return false;
  return Boolean(
    String(addr.address1 || '').trim() ||
      String(addr.city || '').trim() ||
      String(addr.zip || '').trim()
  );
}

async function uploadCustomer(shopifyUrl: string, token: string, data: any): Promise<string> {
  const firstName = String(data.first_name || '').trim();
  const lastName = String(data.last_name || '').trim();
  const customerPhone = normalizePhoneNumber(data.phone);

  const addresses = (data.addresses || []).map((addr: any) =>
    buildShopifyAddress(
      addr,
      null,
      {
        first_name: addr?.first_name ?? firstName,
        last_name: addr?.last_name ?? lastName,
        phone: addr?.phone ?? data.phone ?? null,
        company: addr?.company ?? data.company ?? null,
      }
    )
  );

  const customerPayload = {
    customer: {
      email: data.email,
      first_name: firstName,
      last_name: lastName,
      phone: customerPhone,
      verified_email: true,
      accepts_marketing: data.accepts_marketing || false,
      addresses,
    },
  };

  const response = await fetch(`${shopifyUrl}/customers.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(customerPayload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    // Check if customer already exists
    if (response.status === 422 && errorBody.includes('email')) {
      // Try to find existing customer
      const searchResponse = await fetch(
        `${shopifyUrl}/customers/search.json?query=email:${encodeURIComponent(data.email)}`,
        {
          headers: { 'X-Shopify-Access-Token': token },
        }
      );
      if (searchResponse.ok) {
        const searchResult = await searchResponse.json();
        if (searchResult.customers && searchResult.customers.length > 0) {
          return String(searchResult.customers[0].id);
        }
      }
    }
    throw new Error(`Shopify API error: ${response.status} - ${errorBody}`);
  }

  const result = await response.json();
  return String(result.customer.id);
}

async function findShopifyCustomerIdByEmail(
  shopifyUrl: string,
  token: string,
  email: string
): Promise<string | null> {
  const normalized = String(email || '').trim();
  if (!normalized) return null;

  const searchResponse = await fetch(
    `${shopifyUrl}/customers/search.json?query=email:${encodeURIComponent(normalized)}`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );

  if (!searchResponse.ok) return null;
  const searchResult = await searchResponse.json();
  const first = searchResult?.customers?.[0];
  return first?.id ? String(first.id) : null;
}

async function uploadOrder(
  shopifyUrl: string,
  token: string,
  data: any,
  supabase: any,
  projectId: string
): Promise<string> {
  // Find Shopify customer ID and email for customer linking
  let shopifyCustomerId: string | null = null;
  let customerEmail: string | null = null;

  if (data.customer_external_id) {
    const { data: customer } = await supabase
      .from('canonical_customers')
      .select('shopify_id, data')
      .eq('project_id', projectId)
      .eq('external_id', data.customer_external_id)
      .maybeSingle();

    if (customer?.shopify_id) {
      shopifyCustomerId = customer.shopify_id;
    }
    // Also get email for fallback customer linking
    if (customer?.data?.email) {
      customerEmail = String(customer.data.email).trim();
    }
  }

  // Extra fallback: take customer email from the orders CSV (if present)
  if (!customerEmail && data.customer_email) {
    customerEmail = String(data.customer_email).trim();
  }

  // If we still don't have an ID, try to find the customer in Shopify by email
  if (!shopifyCustomerId && customerEmail) {
    shopifyCustomerId = await findShopifyCustomerIdByEmail(shopifyUrl, token, customerEmail);
  }

  const customerFirstName = String(data.customer_first_name || '').trim();
  const customerLastName = String(data.customer_last_name || '').trim();
  const rawPhone = data.customer_phone || data.billing_address?.phone || data.shipping_address?.phone || null;
  const customerPhone = normalizePhoneNumber(rawPhone);

  // Build a customer address from order data (used both for customer + order)
  const rawCustomerAddress = {
    address1: data.customer_address || data.billing_address?.address1 || data.shipping_address?.address1 || '',
    address2: data.billing_address?.address2 || data.shipping_address?.address2 || null,
    city: data.customer_city || data.billing_address?.city || data.shipping_address?.city || '',
    zip: data.customer_zip || data.billing_address?.zip || data.shipping_address?.zip || '',
    country: data.customer_country || data.billing_address?.country || data.shipping_address?.country || 'DK',
    phone: customerPhone,
  };

  // IMPORTANT: Shopify doesn't reliably persist address data when you create a customer via order payload.
  // So we create/find the customer first, then create the order linked to the customer id.
  if (!shopifyCustomerId && customerEmail) {
    shopifyCustomerId = await uploadCustomer(shopifyUrl, token, {
      email: customerEmail,
      first_name: customerFirstName,
      last_name: customerLastName,
      phone: customerPhone,
      accepts_marketing: false,
      addresses: [
        {
          ...rawCustomerAddress,
          first_name: customerFirstName,
          last_name: customerLastName,
        },
      ],
    });
  }

  // Map line items with Shopify variant IDs
  const lineItems = [];
  const sourceLineItems = data.line_items || [];

  // If no line items, create a fallback based on order total
  if (sourceLineItems.length === 0 && data.total_price > 0) {
    lineItems.push({
      title: 'Ordre total',
      quantity: 1,
      price: String(data.total_price),
    });
  }

  for (const item of sourceLineItems) {
    // Try to find the product's Shopify variant ID
    const { data: product } = await supabase
      .from('canonical_products')
      .select('shopify_id')
      .eq('project_id', projectId)
      .eq('external_id', item.product_external_id)
      .maybeSingle();

    if (product?.shopify_id) {
      // Get variant ID from product
      const variantResponse = await fetch(
        `${shopifyUrl}/products/${product.shopify_id}.json`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );

      if (variantResponse.ok) {
        const productData = await variantResponse.json();
        const variant = productData.product?.variants?.[0];
        if (variant) {
          lineItems.push({
            variant_id: variant.id,
            quantity: item.quantity,
            price: String(item.price),
          });
          continue;
        }
      }
    }

    // Fallback: create custom line item
    lineItems.push({
      title: item.title || item.sku,
      quantity: item.quantity,
      price: String(item.price),
    });
  }

  // Use the original order ID from DanDomain as the order name/number
  const orderName = data.external_id ? `#${data.external_id}` : undefined;

  const billingAddressPayload = buildShopifyAddress(
    data.billing_address,
    rawCustomerAddress,
    { first_name: customerFirstName, last_name: customerLastName, phone: customerPhone }
  );
  const shippingAddressPayload = buildShopifyAddress(
    data.shipping_address,
    rawCustomerAddress,
    { first_name: customerFirstName, last_name: customerLastName, phone: customerPhone }
  );

  const orderPayload = {
    order: {
      // Set the order name/number to match the original system
      name: orderName,
      // Link to customer (by id)
      customer: shopifyCustomerId ? { id: Number(shopifyCustomerId) } : undefined,
      email: customerEmail || undefined,
      phone: customerPhone || undefined,
      line_items: lineItems,
      financial_status: mapFinancialStatus(data.financial_status),
      fulfillment_status: mapFulfillmentStatus(data.fulfillment_status),
      currency: data.currency || 'DKK',
      billing_address: hasMeaningfulAddress(billingAddressPayload) ? billingAddressPayload : undefined,
      shipping_address: hasMeaningfulAddress(shippingAddressPayload) ? shippingAddressPayload : undefined,
      created_at: data.order_date,
      transactions: [{
        kind: 'sale',
        status: 'success',
        amount: String(data.total_price || 0),
      }],
    },
  };

  const response = await fetch(`${shopifyUrl}/orders.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(orderPayload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Shopify API error: ${response.status} - ${errorBody}`);
  }

  const result = await response.json();
  return String(result.order.id);
}


async function uploadCollection(shopifyUrl: string, token: string, category: any): Promise<string> {
  // Create a Smart Collection with a tag rule
  const tag = category.shopify_tag || category.name;
  
  const collectionPayload = {
    smart_collection: {
      title: category.name,
      rules: [{
        column: 'tag',
        relation: 'equals',
        condition: tag,
      }],
      published: true,
    }
  };

  const response = await fetch(`${shopifyUrl}/smart_collections.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(collectionPayload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Shopify API error: ${response.status} - ${errorBody}`);
  }

  const result = await response.json();
  return String(result.smart_collection.id);
}

async function uploadPage(shopifyUrl: string, token: string, data: any): Promise<string> {
  const pagePayload = {
    page: {
      title: data.title,
      body_html: data.body_html || '',
      handle: data.slug || undefined,
      published: data.published !== false,
    }
  };

  const response = await fetch(`${shopifyUrl}/pages.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(pagePayload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Shopify API error: ${response.status} - ${errorBody}`);
  }

  const result = await response.json();
  return String(result.page.id);
}

function mapFinancialStatus(status: string): string {
  const mapping: Record<string, string> = {
    'paid': 'paid',
    'betalt': 'paid',
    'pending': 'pending',
    'afventer': 'pending',
    'refunded': 'refunded',
    'refunderet': 'refunded',
  };
  return mapping[status?.toLowerCase()] || 'paid';
}

function mapFulfillmentStatus(status: string): string | null {
  const mapping: Record<string, string> = {
    'fulfilled': 'fulfilled',
    'afsendt': 'fulfilled',
    'shipped': 'fulfilled',
    'partial': 'partial',
    'delvist': 'partial',
  };
  return mapping[status?.toLowerCase()] || null;
}
