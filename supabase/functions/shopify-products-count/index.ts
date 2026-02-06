import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type Body = {
  projectId: string;
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

    const { projectId }: Body = await req.json();
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

    const url = `https://${shopifyDomain}/admin/api/2024-01/products/count.json`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": shopifyToken,
        Accept: "application/json",
      },
    });

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Shopify count failed (HTTP ${resp.status}): ${text.substring(0, 200)}`);
    }

    const json = JSON.parse(text) as { count?: number };
    const count = typeof json.count === "number" ? json.count : null;

    return new Response(JSON.stringify({ success: true, count }), {
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
