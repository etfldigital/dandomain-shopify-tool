import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, dryRun = true } = await req.json();
    if (!projectId) {
      return new Response(JSON.stringify({ error: 'projectId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get project Shopify credentials
    const { data: project, error: projErr } = await supabase
      .from('projects')
      .select('shopify_store_domain, shopify_access_token_encrypted')
      .eq('id', projectId)
      .single();

    if (projErr || !project?.shopify_store_domain || !project?.shopify_access_token_encrypted) {
      return new Response(JSON.stringify({ error: 'Project not found or missing Shopify credentials' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const shopifyDomain = project.shopify_store_domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const shopifyToken = project.shopify_access_token_encrypted;

    // Find active periods
    const { data: activePeriods } = await supabase
      .from('price_periods')
      .select('period_id')
      .eq('project_id', projectId)
      .eq('disabled', false)
      .lte('start_date', new Date().toISOString().split('T')[0])
      .gte('end_date', new Date().toISOString().split('T')[0]);

    if (!activePeriods || activePeriods.length === 0) {
      return new Response(JSON.stringify({ message: 'No active periods found', affected: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const activePeriodIds = new Set(activePeriods.map(p => p.period_id));

    // Find all uploaded primary products with active period pricing
    const { data: products, error: prodErr } = await supabase
      .from('canonical_products')
      .select('shopify_id, data, external_id')
      .eq('project_id', projectId)
      .eq('status', 'uploaded')
      .not('shopify_id', 'is', null)
      .limit(5000);

    if (prodErr || !products) {
      return new Response(JSON.stringify({ error: 'Failed to query products', details: prodErr }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Filter to primary products with active period and special_offer_price
    const affectedProducts = products.filter(p => {
      const d = p.data as any;
      return d?._isPrimary === true
        && d?.period_id
        && activePeriodIds.has(String(d.period_id))
        && d?.special_offer_price
        && parseFloat(String(d.special_offer_price)) > 0;
    });

    // Dedupe by shopify_id
    const uniqueByShopifyId = new Map<string, any>();
    for (const p of affectedProducts) {
      if (!uniqueByShopifyId.has(p.shopify_id!)) {
        uniqueByShopifyId.set(p.shopify_id!, p);
      }
    }

    const toFix = Array.from(uniqueByShopifyId.values());
    const results: any[] = [];
    let fixed = 0;
    let errors = 0;

    if (dryRun) {
      // Dry run: just show what would be fixed
      for (const p of toFix) {
        const d = p.data as any;
        results.push({
          shopify_id: p.shopify_id,
          title: d.title || d._groupTitle,
          unit_price: d.price,
          special_offer_price: d.special_offer_price,
          period_id: d.period_id,
          fix: `compare_at_price should be ${d.price}, price should be ${d.special_offer_price}`,
        });
      }
    } else {
      // Live fix: fetch variants from Shopify and update compare_at_price
      for (const p of toFix) {
        const d = p.data as any;
        const correctCompareAtPrice = String(d.price);

        try {
          // Fetch product variants from Shopify
          const fetchUrl = `https://${shopifyDomain}/admin/api/2025-01/products/${p.shopify_id}.json?fields=id,variants`;
          const fetchResp = await fetch(fetchUrl, {
            headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
          });

          if (!fetchResp.ok) {
            errors++;
            results.push({ shopify_id: p.shopify_id, title: d.title, error: `Fetch failed: ${fetchResp.status}` });
            continue;
          }

          const productData = await fetchResp.json();
          const variants = productData.product?.variants || [];

          // Update each variant's compare_at_price
          for (const variant of variants) {
            const variantCompare = parseFloat(String(variant.compare_at_price || '0'));
            const variantPrice = parseFloat(String(variant.price || '0'));

            // Only fix if compare_at_price equals price (the bug) or is null/0
            if (variantCompare === variantPrice || variantCompare === 0 || !variant.compare_at_price) {
              const updateUrl = `https://${shopifyDomain}/admin/api/2025-01/variants/${variant.id}.json`;
              const updateResp = await fetch(updateUrl, {
                method: 'PUT',
                headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  variant: {
                    id: variant.id,
                    compare_at_price: correctCompareAtPrice,
                  },
                }),
              });

              if (updateResp.ok) {
                console.log(`[FIX] ${d.title || d._groupTitle}: variant ${variant.id} compare_at_price → ${correctCompareAtPrice}`);
              } else {
                const errBody = await updateResp.text();
                console.error(`[FIX] Failed variant ${variant.id}: ${updateResp.status} ${errBody}`);
              }

              // Rate limit: ~2 calls per second
              await sleep(500);
            }
          }

          fixed++;
          results.push({
            shopify_id: p.shopify_id,
            title: d.title || d._groupTitle,
            variants_updated: variants.length,
            compare_at_price_set_to: correctCompareAtPrice,
          });
        } catch (e) {
          errors++;
          results.push({ shopify_id: p.shopify_id, title: d.title, error: e.message });
        }
      }
    }

    return new Response(JSON.stringify({
      dryRun,
      totalAffected: toFix.length,
      fixed,
      errors,
      results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
