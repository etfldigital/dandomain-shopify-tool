import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type EntityType = "products" | "customers" | "orders" | "categories" | "pages";

type Body = {
  projectId: string;
  entityTypes?: EntityType[];
};

// Abort-safe fetch with timeout
async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const { timeout = 8000, ...fetchOptions } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

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

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      console.error("[shopify-counts] Missing env vars:", {
        hasUrl: !!supabaseUrl, hasAnon: !!supabaseAnonKey, hasService: !!supabaseServiceKey,
      });
      return skippedResponse("missing_env_vars");
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let userId: string | null = null;
    try {
      const { data: { user } } = await userClient.auth.getUser();
      userId = user?.id || null;
    } catch {
      console.warn("[shopify-counts] auth.getUser() failed, falling back to project-only check");
    }

    // Single attempt project lookup (no retry loop to save time)
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,shopify_store_domain,shopify_access_token_encrypted,user_id")
      .eq("id", projectId)
      .maybeSingle();

    if (projectError || !project) {
      const reason = projectError ? `db_error: ${projectError.message}` : "project_not_found";
      console.error(`[shopify-counts] Project lookup failed: ${reason}`);
      return skippedResponse(reason);
    }

    if (userId && project.user_id !== userId) {
      return new Response(JSON.stringify({ success: false, error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const shopifyDomain = String(project.shopify_store_domain || "").trim();
    const shopifyToken = String(project.shopify_access_token_encrypted || "").trim();
    if (!shopifyDomain || !shopifyToken) {
      throw new Error("Shopify credentials not configured");
    }

    const baseUrl = `https://${shopifyDomain}/admin/api/2025-01`;
    const headers = {
      "X-Shopify-Access-Token": shopifyToken,
      Accept: "application/json",
    };

    const counts: Record<string, number | null> = {};

    for (const et of typesToFetch) {
      try {
        counts[et] = await fetchCountForEntity(baseUrl, headers, et);
      } catch (e) {
        console.error(`[shopify-counts] Failed to fetch ${et}:`, e);
        counts[et] = null;
      }
      if (typesToFetch.length > 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

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
      const gqlUrl = `${baseUrl}/graphql.json`;
      const r = await fetchWithTimeout(gqlUrl, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ productsCount { count } }" }),
        timeout: 10000,
      });
      if (r.status === 429) throw new Error("HTTP 429");
      const body = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${body}`);
      const j = JSON.parse(body);
      if (j.errors) throw new Error(`GraphQL errors: ${JSON.stringify(j.errors)}`);
      return j.data?.productsCount?.count ?? 0;
    }
    case "customers": {
      const r = await fetchWithTimeout(`${baseUrl}/customers/count.json`, { headers, timeout: 10000 });
      if (r.status === 429) throw new Error("HTTP 429");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j.count ?? 0;
    }
    case "orders": {
      const r = await fetchWithTimeout(`${baseUrl}/orders/count.json?status=any`, { headers, timeout: 10000 });
      if (r.status === 429) throw new Error("HTTP 429");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j.count ?? 0;
    }
    case "categories": {
      const r1 = await fetchWithTimeout(`${baseUrl}/smart_collections/count.json`, { headers, timeout: 10000 });
      if (r1.status === 429) throw new Error("HTTP 429");
      if (!r1.ok) throw new Error(`smart_collections HTTP ${r1.status}`);
      const j1 = await r1.json();

      await new Promise(r => setTimeout(r, 300));

      const r2 = await fetchWithTimeout(`${baseUrl}/custom_collections/count.json`, { headers, timeout: 10000 });
      if (r2.status === 429) throw new Error("HTTP 429");
      if (!r2.ok) throw new Error(`custom_collections HTTP ${r2.status}`);
      const j2 = await r2.json();

      return (j1.count ?? 0) + (j2.count ?? 0);
    }
    case "pages": {
      const r = await fetchWithTimeout(`${baseUrl}/pages/count.json`, { headers, timeout: 10000 });
      if (r.status === 429) throw new Error("HTTP 429");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j.count ?? 0;
    }
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }
}
