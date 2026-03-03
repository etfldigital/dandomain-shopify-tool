import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

/**
 * Fetch DanDomain period pricing data for a project.
 * 
 * 1. Queries canonical_products to find all unique period_id values and counts.
 * 2. Optionally tries to fetch period definitions from DanDomain API for date ranges.
 * 
 * Returns: { periods: [{ periodId, productCount, startDate?, endDate?, isActive? }] }
 */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId } = await req.json();
    if (!projectId) {
      return new Response(JSON.stringify({ error: 'projectId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get project info for DanDomain API credentials
    const { data: project, error: projError } = await supabase
      .from('projects')
      .select('dandomain_shop_url, dandomain_api_key_encrypted')
      .eq('id', projectId)
      .single();

    if (projError || !project) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Query canonical_products for unique period_id values and product counts
    // We need to aggregate from the JSONB data field
    const { data: periodData, error: queryError } = await supabase.rpc(
      'get_period_stats',
      { p_project_id: projectId }
    ).maybeSingle();

    // Fallback: direct query if RPC doesn't exist
    let periods: { periodId: string; productCount: number; startDate: string | null; endDate: string | null; isActive: boolean }[] = [];

    if (queryError || !periodData) {
      // Direct query approach: fetch products with period_id set
      const { data: products, error: prodError } = await supabase
        .from('canonical_products')
        .select('data')
        .eq('project_id', projectId)
        .not('data->>period_id', 'is', null)
        .neq('data->>period_id', '')
        .limit(10000);

      if (!prodError && products) {
        const periodCounts = new Map<string, number>();
        for (const p of products) {
          const data = p.data as any;
          const pid = data?.period_id;
          if (pid) {
            periodCounts.set(pid, (periodCounts.get(pid) || 0) + 1);
          }
        }

        periods = Array.from(periodCounts.entries()).map(([periodId, productCount]) => ({
          periodId,
          productCount,
          startDate: null,
          endDate: null,
          isActive: true, // Default: assume active since we can't fetch dates
        }));
      }
    }

    // Try to fetch period definitions from DanDomain API (best-effort)
    if (project.dandomain_shop_url && project.dandomain_api_key_encrypted) {
      try {
        const shopUrl = project.dandomain_shop_url.replace(/\/$/, '');
        const apiKey = project.dandomain_api_key_encrypted;
        
        // DanDomain Webshop 9 API endpoint for settings/periods
        // Try common endpoints
        const periodEndpoints = [
          `${shopUrl}/admin/webapi/endpoints/v1_0/SettingService/GetPeriods`,
          `${shopUrl}/admin/webapi/endpoints/v1_0/ProductService/GetPeriods`,
        ];

        for (const endpoint of periodEndpoints) {
          try {
            const response = await fetch(endpoint, {
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
            });

            if (response.ok) {
              const data = await response.json();
              // If we get period data, enrich our periods with dates
              if (Array.isArray(data)) {
                const now = new Date();
                for (const apiPeriod of data) {
                  const matchingPeriod = periods.find(p => 
                    p.periodId === String(apiPeriod.Id || apiPeriod.id || apiPeriod.Name || apiPeriod.name)
                  );
                  if (matchingPeriod) {
                    matchingPeriod.startDate = apiPeriod.StartDate || apiPeriod.startDate || null;
                    matchingPeriod.endDate = apiPeriod.EndDate || apiPeriod.endDate || null;
                    if (matchingPeriod.startDate && matchingPeriod.endDate) {
                      const start = new Date(matchingPeriod.startDate);
                      const end = new Date(matchingPeriod.endDate);
                      matchingPeriod.isActive = now >= start && now <= end;
                    }
                  }
                }
              }
              break; // Got data, stop trying endpoints
            }
          } catch {
            // Endpoint doesn't exist, try next
          }
        }
      } catch (e) {
        console.warn('Could not fetch DanDomain period definitions:', e);
        // Non-fatal - we still have period IDs and counts from products
      }
    }

    // Sort by product count descending
    periods.sort((a, b) => b.productCount - a.productCount);

    // Also get total product count for context
    const { count: totalProducts } = await supabase
      .from('canonical_products')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId);

    return new Response(JSON.stringify({
      periods,
      totalProducts: totalProducts || 0,
      totalWithPeriod: periods.reduce((sum, p) => sum + p.productCount, 0),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error fetching period data:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
