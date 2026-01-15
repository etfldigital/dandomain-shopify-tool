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
    const shopifyUrl = `https://${shopifyDomain}/admin/api/2024-01`;

    let processed = 0;
    let errors = 0;
    let errorDetails: { externalId: string; message: string }[] = [];

    // Get pending items based on entity type
    const tableName = `canonical_${entityType}`;
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
          case 'products':
            shopifyId = await uploadProduct(shopifyUrl, shopifyToken, item.data, supabase, projectId);
            break;
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

async function uploadProduct(
  shopifyUrl: string, 
  token: string, 
  data: any,
  supabase: any,
  projectId: string
): Promise<string> {
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

  const productPayload = {
    product: {
      title: data.title,
      body_html: data.body_html || '',
      vendor: data.vendor || '',
      product_type: '',
      tags: [...new Set(tags)].join(', '),
      status: data.active ? 'active' : 'draft',
      variants: [{
        sku: data.sku || '',
        price: String(data.price || 0),
        compare_at_price: data.compare_at_price ? String(data.compare_at_price) : null,
        inventory_quantity: data.stock_quantity || 0,
        weight: data.weight || 0,
        weight_unit: 'kg',
        inventory_management: 'shopify',
      }],
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

async function uploadCustomer(shopifyUrl: string, token: string, data: any): Promise<string> {
  const customerPayload = {
    customer: {
      email: data.email,
      first_name: data.first_name || '',
      last_name: data.last_name || '',
      phone: data.phone || null,
      verified_email: true,
      accepts_marketing: data.accepts_marketing || false,
      addresses: (data.addresses || []).map((addr: any) => ({
        address1: addr.address1 || '',
        address2: addr.address2 || null,
        city: addr.city || '',
        zip: addr.zip || '',
        country: addr.country || 'DK',
        phone: addr.phone || null,
      })),
    }
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

async function uploadOrder(
  shopifyUrl: string, 
  token: string, 
  data: any,
  supabase: any,
  projectId: string
): Promise<string> {
  // Find Shopify customer ID
  let shopifyCustomerId: string | null = null;
  if (data.customer_external_id) {
    const { data: customer } = await supabase
      .from('canonical_customers')
      .select('shopify_id')
      .eq('project_id', projectId)
      .eq('external_id', data.customer_external_id)
      .single();
    
    if (customer?.shopify_id) {
      shopifyCustomerId = customer.shopify_id;
    }
  }

  // Map line items with Shopify variant IDs
  const lineItems = [];
  for (const item of data.line_items || []) {
    // Try to find the product's Shopify variant ID
    const { data: product } = await supabase
      .from('canonical_products')
      .select('shopify_id')
      .eq('project_id', projectId)
      .eq('external_id', item.product_external_id)
      .single();

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

  const orderPayload = {
    order: {
      customer: shopifyCustomerId ? { id: Number(shopifyCustomerId) } : undefined,
      email: data.billing_address?.email || undefined,
      line_items: lineItems,
      financial_status: mapFinancialStatus(data.financial_status),
      fulfillment_status: mapFulfillmentStatus(data.fulfillment_status),
      currency: data.currency || 'DKK',
      billing_address: data.billing_address ? {
        address1: data.billing_address.address1 || '',
        address2: data.billing_address.address2 || null,
        city: data.billing_address.city || '',
        zip: data.billing_address.zip || '',
        country: data.billing_address.country || 'DK',
        phone: data.billing_address.phone || null,
      } : undefined,
      shipping_address: data.shipping_address ? {
        address1: data.shipping_address.address1 || '',
        address2: data.shipping_address.address2 || null,
        city: data.shipping_address.city || '',
        zip: data.shipping_address.zip || '',
        country: data.shipping_address.country || 'DK',
        phone: data.shipping_address.phone || null,
      } : undefined,
      created_at: data.order_date,
      transactions: [{
        kind: 'sale',
        status: 'success',
        amount: String(data.total_price || 0),
      }],
    }
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
