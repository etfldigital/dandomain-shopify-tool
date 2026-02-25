import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Shopify rate-limit helpers (same pattern as shopify-upload) ──────────────
let shopifyBucketUsed = 0;
let lastBucketUpdate = Date.now();

function updateBucketFromHeaders(response: Response): void {
  const callLimit = response.headers.get("X-Shopify-Shop-Api-Call-Limit");
  if (callLimit) {
    const match = callLimit.match(/(\d+)\/(\d+)/);
    if (match) {
      shopifyBucketUsed = parseInt(match[1], 10);
      lastBucketUpdate = Date.now();
    }
  }
}

function getCurrentBucketUsage(): number {
  const elapsed = (Date.now() - lastBucketUpdate) / 1000;
  const leaked = Math.floor(elapsed * 2);
  return Math.max(0, shopifyBucketUsed - leaked);
}

function getPreRequestDelay(): number {
  const usage = getCurrentBucketUsage();
  if (usage >= 38) return 2000;
  if (usage >= 35) return 1000;
  if (usage >= 32) return 500;
  if (usage >= 28) return 200;
  return 0;
}

async function shopifyGet(
  url: string,
  token: string,
  maxRetries = 3
): Promise<{ json: any; linkNext: string | null }> {
  const preDelay = getPreRequestDelay();
  if (preDelay > 0) await sleep(preDelay);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": token,
        Accept: "application/json",
      },
    });
    const body = await response.text();
    updateBucketFromHeaders(response);

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 3000;
      console.log(`[SYNC] Rate limited, waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Shopify GET failed (${response.status}): ${body.substring(0, 200)}`);
    }

    // Parse Link header for pagination
    let linkNext: string | null = null;
    const linkHeader = response.headers.get("Link");
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) linkNext = nextMatch[1];
    }

    return { json: JSON.parse(body), linkNext };
  }
  throw new Error("Max retries exceeded for Shopify GET");
}

// ── Entity-specific fetchers & matchers ─────────────────────────────────────

type EntityType = "products" | "customers" | "orders" | "categories" | "pages";

interface ShopifyRecord {
  id: number | string;
  matchKey: string; // The value we match against local DB
}

async function fetchAllShopifyRecords(
  shopifyUrl: string,
  token: string,
  entityType: EntityType
): Promise<ShopifyRecord[]> {
  const records: ShopifyRecord[] = [];
  let url: string;
  let resourceKey: string;

  switch (entityType) {
    case "categories":
      // Smart collections + custom collections
      url = `${shopifyUrl}/smart_collections.json?limit=250`;
      resourceKey = "smart_collections";
      break;
    case "products":
      url = `${shopifyUrl}/products.json?limit=250&fields=id,handle`;
      resourceKey = "products";
      break;
    case "customers":
      url = `${shopifyUrl}/customers.json?limit=250&fields=id,email`;
      resourceKey = "customers";
      break;
    case "orders":
      url = `${shopifyUrl}/orders.json?limit=250&status=any&fields=id,name,order_number`;
      resourceKey = "orders";
      break;
    case "pages":
      url = `${shopifyUrl}/pages.json?limit=250&fields=id,handle,title`;
      resourceKey = "pages";
      break;
    default:
      throw new Error(`Unsupported entity type: ${entityType}`);
  }

  // Paginate through all pages
  let currentUrl: string | null = url;
  while (currentUrl) {
    const { json, linkNext } = await shopifyGet(currentUrl, token);
    const items = json[resourceKey] || [];

    for (const item of items) {
      const matchKey = getMatchKey(item, entityType);
      if (matchKey) {
        records.push({ id: item.id, matchKey });
      }
    }

    console.log(`[SYNC] Fetched ${records.length} ${entityType} so far...`);
    currentUrl = linkNext;
  }

  // For categories, also fetch custom collections
  if (entityType === "categories") {
    let customUrl: string | null = `${shopifyUrl}/custom_collections.json?limit=250`;
    while (customUrl) {
      const { json, linkNext } = await shopifyGet(customUrl, token);
      const items = json.custom_collections || [];
      for (const item of items) {
        const matchKey = getMatchKey(item, entityType);
        if (matchKey) {
          records.push({ id: item.id, matchKey });
        }
      }
      customUrl = linkNext;
    }
    console.log(`[SYNC] Total collections (smart+custom): ${records.length}`);
  }

  return records;
}

function getMatchKey(item: any, entityType: EntityType): string {
  switch (entityType) {
    case "categories":
      return (item.handle || item.title || "").toLowerCase().trim();
    case "products":
      return (item.handle || "").toLowerCase().trim();
    case "customers":
      return (item.email || "").toLowerCase().trim();
    case "orders":
      return String(item.name || item.order_number || "").trim();
    case "pages":
      return (item.handle || "").toLowerCase().trim();
    default:
      return "";
  }
}

function getLocalMatchKey(record: any, entityType: EntityType): string {
  switch (entityType) {
    case "categories":
      // canonical_categories has slug and name
      return (record.slug || record.name || "").toLowerCase().trim();
    case "products":
      // canonical_products data has title which gets converted to handle
      // The handle is title lowercased with spaces replaced by dashes
      const title = record.data?.title || "";
      return title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "").trim();
    case "customers":
      return (record.data?.email || "").toLowerCase().trim();
    case "orders":
      return String(record.external_id || "").trim();
    case "pages":
      return (record.data?.slug || "").toLowerCase().trim();
    default:
      return "";
  }
}

function getCanonicalTable(entityType: EntityType): string {
  switch (entityType) {
    case "categories": return "canonical_categories";
    case "products": return "canonical_products";
    case "customers": return "canonical_customers";
    case "orders": return "canonical_orders";
    case "pages": return "canonical_pages";
  }
}

// ── Main handler ────────────────────────────────────────────────────────────

interface SyncRequest {
  projectId: string;
  entityType: EntityType;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
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

    const { projectId, entityType }: SyncRequest = await req.json();
    if (!projectId || !entityType) throw new Error("projectId and entityType required");

    // Fetch project + verify ownership
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, user_id, shopify_store_domain, shopify_access_token_encrypted")
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

    const shopifyUrl = `https://${shopifyDomain}/admin/api/2024-01`;

    console.log(`[SYNC] Starting sync for ${entityType} in project ${projectId}`);

    // 1. Fetch all Shopify records
    const shopifyRecords = await fetchAllShopifyRecords(shopifyUrl, shopifyToken, entityType);
    console.log(`[SYNC] Found ${shopifyRecords.length} ${entityType} in Shopify`);

    // Build lookup map: matchKey -> shopifyId
    const shopifyMap = new Map<string, string>();
    for (const rec of shopifyRecords) {
      shopifyMap.set(rec.matchKey, String(rec.id));
    }

    // 2. Fetch all local records (paginate to avoid 1000-row limit)
    const table = getCanonicalTable(entityType);
    let allLocalRecords: any[] = [];
    let from = 0;
    const PAGE_SIZE = 1000;

    while (true) {
      const shopifyIdCol = entityType === "categories" ? "shopify_collection_id" : "shopify_id";
      let query = supabase
        .from(table)
        .select(`id, external_id, status, ${shopifyIdCol}` + (entityType === "categories" ? ", name, slug" : ", data"))
        .eq("project_id", projectId)
        .range(from, from + PAGE_SIZE - 1);

      // For products, only sync primary records
      if (entityType === "products") {
        query = query.eq("data->>_isPrimary", "true");
      }

      const { data, error } = await query;
      if (error) throw new Error(`Failed to fetch local ${entityType}: ${error.message}`);
      if (!data || data.length === 0) break;
      allLocalRecords = allLocalRecords.concat(data);
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    console.log(`[SYNC] Found ${allLocalRecords.length} local ${entityType} records`);

    // 3. Match and update
    let matched = 0;
    let notFound = 0;
    let alreadyUploaded = 0;
    const BATCH_SIZE = 50;

    // Collect updates to batch them
    const updates: { id: string; shopify_id: string }[] = [];

    for (const local of allLocalRecords) {
      const existingShopifyId = entityType === "categories" ? local.shopify_collection_id : local.shopify_id;
      if (local.status === "uploaded" && existingShopifyId) {
        alreadyUploaded++;
        continue;
      }

      const localKey = getLocalMatchKey(local, entityType);
      if (!localKey) {
        notFound++;
        continue;
      }

      const shopifyId = shopifyMap.get(localKey);
      if (shopifyId) {
        updates.push({ id: local.id, shopify_id: shopifyId });
        matched++;
      } else {
        notFound++;
      }
    }

    // Apply updates in batches
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      // Update each record in the batch
      for (const upd of batch) {
        const updatePayload: Record<string, any> = {
          status: "uploaded",
          updated_at: new Date().toISOString(),
        };
        if (entityType === "categories") {
          updatePayload.shopify_collection_id = upd.shopify_id;
        } else {
          updatePayload.shopify_id = upd.shopify_id;
        }
        await supabase
          .from(table)
          .update(updatePayload)
          .eq("id", upd.id);
      }
      console.log(`[SYNC] Updated ${Math.min(i + BATCH_SIZE, updates.length)}/${updates.length} records`);
    }

    // 4. Update upload_jobs if one exists for this entity type
    const { data: existingJob } = await supabase
      .from("upload_jobs")
      .select("id")
      .eq("project_id", projectId)
      .eq("entity_type", entityType)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingJob) {
      await supabase
        .from("upload_jobs")
        .update({
          status: "completed",
          processed_count: matched + alreadyUploaded,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingJob.id);
    }

    const summary = {
      success: true,
      matched,
      notFound,
      alreadyUploaded,
      totalShopify: shopifyRecords.length,
      totalLocal: allLocalRecords.length,
    };

    console.log(`[SYNC] Done: ${JSON.stringify(summary)}`);

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[shopify-sync] error:", msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
