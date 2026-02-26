import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface DuplicateGroup {
  fingerprint: string;
  customerEmail: string;
  totalPrice: string;
  orderDate: string;
  shopifyOrderIds: string[];
  shopifyOrderNames: string[];
  count: number;
  lineItemsSummary: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { projectId } = await req.json();
    if (!projectId) throw new Error('projectId required');

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('shopify_store_domain, shopify_access_token_encrypted')
      .eq('id', projectId)
      .single();

    if (projectError || !project) throw new Error('Project not found');
    if (!project.shopify_store_domain || !project.shopify_access_token_encrypted) {
      throw new Error('Shopify credentials not configured');
    }

    const shopifyDomain = project.shopify_store_domain;
    const shopifyToken = project.shopify_access_token_encrypted;
    const shopifyUrl = `https://${shopifyDomain}/admin/api/2025-01`;

    // Fetch ALL orders from Shopify (paginated)
    console.log('[DETECT-DUPES] Fetching all Shopify orders...');
    const allOrders: any[] = [];
    let pageInfo: string | null = null;
    let hasMore = true;
    let page = 0;

    while (hasMore) {
      const url = pageInfo
        ? `${shopifyUrl}/orders.json?limit=250&status=any&page_info=${pageInfo}`
        : `${shopifyUrl}/orders.json?limit=250&status=any`;

      const response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': shopifyToken },
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
        console.log(`[DETECT-DUPES] Rate limited, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Shopify API error: ${response.status}`);
      }

      const data = await response.json();
      const orders = data.orders || [];
      allOrders.push(...orders);
      page++;
      console.log(`[DETECT-DUPES] Page ${page}: fetched ${orders.length} orders (total: ${allOrders.length})`);

      // Check for next page
      const linkHeader = response.headers.get('Link');
      if (linkHeader?.includes('rel="next"')) {
        const match = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
        pageInfo = match ? match[1] : null;
        if (!pageInfo) hasMore = false;
      } else {
        hasMore = false;
      }

      // Rate limit courtesy delay
      await sleep(300);
    }

    console.log(`[DETECT-DUPES] Total orders fetched: ${allOrders.length}`);

    // Build fingerprints for duplicate detection
    const fingerprints: Map<string, any[]> = new Map();

    for (const order of allOrders) {
      const email = (order.email || order.contact_email || '').toLowerCase().trim();
      const totalPrice = String(order.total_price || '0');
      const createdAt = order.created_at ? order.created_at.substring(0, 10) : ''; // YYYY-MM-DD
      
      // Shipping address fingerprint
      const addr = order.shipping_address || {};
      const addrKey = [
        (addr.address1 || '').toLowerCase().trim(),
        (addr.city || '').toLowerCase().trim(),
        (addr.zip || '').trim(),
        (addr.country_code || addr.country || '').toLowerCase().trim(),
      ].join('|');

      // Line items fingerprint (sorted for consistency)
      const lineItemsKey = (order.line_items || [])
        .map((li: any) => `${(li.title || li.name || '').toLowerCase().trim()}:${li.quantity}`)
        .sort()
        .join(';');

      const fingerprint = `${email}||${totalPrice}||${createdAt}||${addrKey}||${lineItemsKey}`;

      if (!fingerprints.has(fingerprint)) {
        fingerprints.set(fingerprint, []);
      }
      fingerprints.get(fingerprint)!.push(order);
    }

    // Find duplicates (fingerprints with > 1 order)
    const duplicates: DuplicateGroup[] = [];

    for (const [fp, orders] of fingerprints) {
      if (orders.length <= 1) continue;

      const first = orders[0];
      const email = (first.email || first.contact_email || '').toLowerCase().trim();

      duplicates.push({
        fingerprint: fp,
        customerEmail: email,
        totalPrice: String(first.total_price || '0'),
        orderDate: first.created_at ? first.created_at.substring(0, 10) : '',
        shopifyOrderIds: orders.map((o: any) => String(o.id)),
        shopifyOrderNames: orders.map((o: any) => o.name || `#${o.order_number}`),
        count: orders.length,
        lineItemsSummary: (first.line_items || [])
          .map((li: any) => `${li.quantity}x ${li.title || li.name}`)
          .join(', '),
      });
    }

    // Sort by count descending
    duplicates.sort((a, b) => b.count - a.count);

    console.log(`[DETECT-DUPES] Found ${duplicates.length} duplicate groups out of ${allOrders.length} orders`);

    // Also check for dandomain_order_id duplicates (note_attributes)
    const dandoIdMap: Map<string, any[]> = new Map();
    for (const order of allOrders) {
      const noteAttrs = order.note_attributes || [];
      const dandoAttr = noteAttrs.find((a: any) => a.name === 'dandomain_order_id');
      if (dandoAttr?.value) {
        const key = String(dandoAttr.value);
        if (!dandoIdMap.has(key)) dandoIdMap.set(key, []);
        dandoIdMap.get(key)!.push(order);
      }
    }

    const dandoIdDuplicates: any[] = [];
    for (const [dandoId, orders] of dandoIdMap) {
      if (orders.length <= 1) continue;
      dandoIdDuplicates.push({
        dandomain_order_id: dandoId,
        shopifyOrderIds: orders.map((o: any) => String(o.id)),
        shopifyOrderNames: orders.map((o: any) => o.name || `#${o.order_number}`),
        count: orders.length,
      });
    }

    return new Response(JSON.stringify({
      success: true,
      totalOrdersScanned: allOrders.length,
      duplicateGroups: duplicates.length,
      duplicates,
      dandoIdDuplicates,
      summary: `Scanned ${allOrders.length} orders. Found ${duplicates.length} duplicate groups (matching email+price+date+address+line_items). Found ${dandoIdDuplicates.length} dandomain_order_id duplicates.`,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[DETECT-DUPES] Error:', msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
