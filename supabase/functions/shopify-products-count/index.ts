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
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    if (!jwt) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: userRes, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userRes?.user) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { projectId, entityTypes }: Body = await req.json();
    if (!projectId) throw new Error("projectId required");

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,user_id,shopify_store_domain,shopify_access_token_encrypted")
      .eq("id", projectId)
      .single();

    if (projectError || !project) throw new Error("Project not found");
    if (project.user_id !== userRes.user.id) {
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

    const baseUrl = `https://${shopifyDomain}/admin/api/2024-01`;
    const headers = {
      "X-Shopify-Access-Token": shopifyToken,
      Accept: "application/json",
    };

    const typesToFetch = entityTypes || ["products"];
    const counts: Record<string, number | null> = {};

    for (const et of typesToFetch) {
      try {
        counts[et] = await fetchCountForEntity(baseUrl, headers, et);
      } catch (e) {
        console.error(`[shopify-counts] Failed to fetch ${et}:`, e);
        counts[et] = null;
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
      const r = await fetch(`${baseUrl}/products/count.json?status=any`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j.count ?? 0;
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
      // Sum smart_collections + custom_collections
      const [r1, r2] = await Promise.all([
        fetch(`${baseUrl}/smart_collections/count.json`, { headers }),
        fetch(`${baseUrl}/custom_collections/count.json`, { headers }),
      ]);
      if (!r1.ok) throw new Error(`smart_collections HTTP ${r1.status}`);
      if (!r2.ok) throw new Error(`custom_collections HTTP ${r2.status}`);
      const [j1, j2] = await Promise.all([r1.json(), r2.json()]);
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
