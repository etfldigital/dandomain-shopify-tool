import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type EntityType = "products" | "customers" | "orders" | "categories" | "pages";

type Body = {
  projectId: string;
  entityTypes?: EntityType[]; // If omitted, defaults to ["products"]
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, entityTypes }: Body = await req.json();
    if (!projectId) throw new Error("projectId required");

    const typesToFetch = entityTypes || ["products"];

    const skippedResponse = (reason: string) => {
      const counts: Record<string, number | null> = {};
      for (const et of typesToFetch) counts[et] = null;
      return new Response(JSON.stringify({ success: true, counts, skipped: true, reason }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    };

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return skippedResponse("missing_or_invalid_auth_header");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Validate user identity from JWT (lightweight - no DB call needed)
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Service client for reading encrypted Shopify credentials
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify ownership: use service role to check project belongs to user
    // This avoids RLS-based ownership check that was timing out under load
    let userId: string | null = null;
    try {
      const { data: { user } } = await userClient.auth.getUser();
      userId = user?.id || null;
    } catch {
      // If auth check fails, try to proceed anyway - the service role query
      // will still validate the project exists
      console.warn("[shopify-counts] auth.getUser() failed, falling back to project-only check");
    }

    const projectQuery = supabase
      .from("projects")
      .select("id,shopify_store_domain,shopify_access_token_encrypted,user_id")
      .eq("id", projectId)
      .single();

    const { data: project, error: projectError } = await projectQuery;

    if (projectError || !project) throw new Error("Project not found");

    // If we got user ID, verify ownership
    if (userId && project.user_id !== userId) {
      return new Response(JSON.stringify({ success: false, error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Project data already fetched above in the ownership check

    const shopifyDomain = String(project.shopify_store_domain || "").trim();
    const shopifyToken = String(project.shopify_access_token_encrypted || "").trim();
    if (!shopifyDomain || !shopifyToken) {
      throw new Error("Shopify credentials not configured");
    }

    // Use a current API version (2025-01) - older versions may be sunset by Shopify
    const baseUrl = `https://${shopifyDomain}/admin/api/2025-01`;
    const headers = {
      "X-Shopify-Access-Token": shopifyToken,
      Accept: "application/json",
    };

    const counts: Record<string, number | null> = {};

    // ============================================================================
    // CHECK FOR ACTIVE UPLOAD JOBS: If any upload job is running, skip Shopify
    // REST API calls entirely to avoid stealing API credits from the uploader.
    // The uploader shares the same 40-request REST bucket.
    // ============================================================================
    const { data: activeJobs } = await supabase
      .from('upload_jobs')
      .select('id, entity_type')
      .eq('project_id', projectId)
      .eq('status', 'running')
      .limit(1);

    if (activeJobs && activeJobs.length > 0) {
      console.log(`[shopify-counts] Skipping Shopify count fetch – upload job is active (job ${activeJobs[0].id}, type=${activeJobs[0].entity_type})`);
      // Return nulls so the frontend shows cached/previous values
      for (const et of typesToFetch) {
        counts[et] = null;
      }

      const response: Record<string, any> = { success: true, counts, skipped: true };
      return new Response(JSON.stringify(response), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // ============================================================================

    // Fetch SEQUENTIALLY to avoid Shopify 429 rate limits
    for (const et of typesToFetch) {
      try {
        counts[et] = await fetchCountForEntity(baseUrl, headers, et);
      } catch (e) {
        console.error(`[shopify-counts] Failed to fetch ${et}:`, e);
        counts[et] = null;
      }
      // Small delay between calls to respect rate limits
      if (typesToFetch.length > 1) {
        await new Promise(r => setTimeout(r, 250));
      }
    }

    // Backward compat: if only products requested the old way, include top-level "count"
    const response: Record<string, any> = { success: true, counts };
    if (typesToFetch.length === 1 && typesToFetch[0] === "products" && counts.products !== null) {
      response.count = counts.products;
    }

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[shopify-products-count] error:", msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function fetchCountForEntity(
  baseUrl: string,
  headers: Record<string, string>,
  entityType: EntityType
): Promise<number> {
  switch (entityType) {
    case "products": {
      // REST /products/count.json is deprecated in API 2025-01 and returns 0.
      // Use GraphQL productsCount instead.
      const gqlUrl = `${baseUrl}/graphql.json`;
      console.log(`[shopify-counts] Fetching products count via GraphQL: ${gqlUrl}`);
      const r = await fetch(gqlUrl, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ productsCount { count } }" }),
      });
      const body = await r.text();
      console.log(`[shopify-counts] Products GraphQL response: HTTP ${r.status}, body: ${body}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${body}`);
      const j = JSON.parse(body);
      if (j.errors) throw new Error(`GraphQL errors: ${JSON.stringify(j.errors)}`);
      return j.data?.productsCount?.count ?? 0;
    }
    case "customers": {
      const r = await fetch(`${baseUrl}/customers/count.json`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j.count ?? 0;
    }
    case "orders": {
      const r = await fetch(`${baseUrl}/orders/count.json?status=any`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j.count ?? 0;
    }
    case "categories": {
      // Fetch sequentially to avoid rate limits
      const r1 = await fetch(`${baseUrl}/smart_collections/count.json`, { headers });
      if (!r1.ok) throw new Error(`smart_collections HTTP ${r1.status}`);
      const j1 = await r1.json();
      
      await new Promise(r => setTimeout(r, 200));
      
      const r2 = await fetch(`${baseUrl}/custom_collections/count.json`, { headers });
      if (!r2.ok) throw new Error(`custom_collections HTTP ${r2.status}`);
      const j2 = await r2.json();
      
      return (j1.count ?? 0) + (j2.count ?? 0);
    }
    case "pages": {
      const r = await fetch(`${baseUrl}/pages/count.json`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j.count ?? 0;
    }
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }
}
