import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Shopify rate-limit helpers ──────────────────────────────────────────────
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

// ── Entity helpers ──────────────────────────────────────────────────────────

type EntityType = "products" | "customers" | "orders" | "categories" | "pages";

interface ShopifyRecord {
  id: number | string;
  matchKey: string;
  handle?: string;
  title?: string;
  email?: string;
  createdAt?: string;
  totalPrice?: string;
  dandoId?: string;
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
      url = `${shopifyUrl}/orders.json?limit=250&status=any&fields=id,name,order_number,note_attributes,email,created_at,total_price`;
      resourceKey = "orders";
      break;
    case "pages":
      url = `${shopifyUrl}/pages.json?limit=250&fields=id,handle,title`;
      resourceKey = "pages";
      break;
    default:
      throw new Error(`Unsupported entity type: ${entityType}`);
  }

  let currentUrl: string | null = url;
  while (currentUrl) {
    const { json, linkNext } = await shopifyGet(currentUrl, token);
    const items = json[resourceKey] || [];

    for (const item of items) {
      const matchKey = getMatchKey(item, entityType);
      if (matchKey || entityType === "orders") {
        const rec: ShopifyRecord = { id: item.id, matchKey: matchKey || "" };
        if (entityType === "categories") {
          rec.handle = (item.handle || "").toLowerCase().trim();
          rec.title = (item.title || "").toLowerCase().trim();
        }
        if (entityType === "orders") {
          const noteAttrs = item.note_attributes || [];
          const dandoAttr = noteAttrs.find((a: any) => a.name === "dandomain_order_id");
          if (dandoAttr?.value) rec.dandoId = String(dandoAttr.value);
          rec.email = (item.email || "").toLowerCase().trim();
          rec.totalPrice = String(item.total_price || "");
        }
        records.push(rec);
      }
    }

    console.log(`[SYNC] Fetched ${records.length} ${entityType} so far...`);
    currentUrl = linkNext;
  }

  if (entityType === "categories") {
    let customUrl: string | null = `${shopifyUrl}/custom_collections.json?limit=250`;
    while (customUrl) {
      const { json, linkNext } = await shopifyGet(customUrl, token);
      const items = json.custom_collections || [];
      for (const item of items) {
        const matchKey = getMatchKey(item, entityType);
        if (matchKey) {
          const rec: ShopifyRecord = { id: item.id, matchKey };
          rec.handle = (item.handle || "").toLowerCase().trim();
          rec.title = (item.title || "").toLowerCase().trim();
          records.push(rec);
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
      return (record.slug || record.name || "").toLowerCase().trim();
    case "products": {
      // With lightweight select, title is a flat field
      const title = record.product_title || record.data?.title || "";
      return title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "").trim();
    }
    case "customers":
      // With lightweight select, email is a flat field
      return (record.customer_email || record.data?.email || "").toLowerCase().trim();
    case "orders":
      return String(record.external_id || "").trim();
    case "pages":
      return (record.page_slug || record.data?.slug || "").toLowerCase().trim();
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

// The function now supports chunked processing.
// Phase "fetch" (default): fetches Shopify records, builds match plan, applies first chunk of updates.
// Phase "apply": continues applying updates from a given offset.

interface SyncRequest {
  projectId: string;
  entityType: EntityType;
  // Chunked processing fields:
  phase?: "fetch" | "apply";
  offset?: number; // offset into local records for the apply phase
  shopifyData?: any; // serialized match maps from fetch phase
}

const CHUNK_SIZE = 3000; // local records to process per invocation

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
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

    const isServiceRole = jwt === supabaseServiceKey;
    if (!isServiceRole) {
      const { data: userRes, error: userErr } = await supabase.auth.getUser(jwt);
      if (userErr || !userRes?.user) {
        return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const body: SyncRequest = await req.json();
    const { projectId, entityType, phase = "fetch", offset = 0, shopifyData } = body;
    if (!projectId || !entityType) throw new Error("projectId and entityType required");

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, user_id, shopify_store_domain, shopify_access_token_encrypted")
      .eq("id", projectId)
      .single();

    if (projectError || !project) throw new Error("Project not found");

    const shopifyDomain = String(project.shopify_store_domain || "").trim();
    const shopifyToken = String(project.shopify_access_token_encrypted || "").trim();
    if (!shopifyDomain || !shopifyToken) throw new Error("Shopify credentials not configured");

    const shopifyUrl = `https://${shopifyDomain}/admin/api/2025-01`;
    const table = getCanonicalTable(entityType);

    // ── Phase: FETCH ── Fetch Shopify records, build maps, then start applying
    if (phase === "fetch") {
      console.log(`[SYNC] Phase FETCH: starting sync for ${entityType} in project ${projectId}`);

      const shopifyRecords = await fetchAllShopifyRecords(shopifyUrl, shopifyToken, entityType);
      console.log(`[SYNC] Found ${shopifyRecords.length} ${entityType} in Shopify`);

      // Build serializable match maps
      const matchMap: Record<string, string> = {};
      const handleMap: Record<string, string> = {};
      const titleMap: Record<string, string> = {};
      const dandoIdMap: Record<string, string> = {};
      const fingerprintMap: Record<string, string> = {};

      for (const rec of shopifyRecords) {
        if (rec.matchKey) matchMap[rec.matchKey] = String(rec.id);
        if (entityType === "categories") {
          if (rec.handle) handleMap[rec.handle] = String(rec.id);
          if (rec.title) titleMap[rec.title] = String(rec.id);
        }
        if (entityType === "orders") {
          if (rec.dandoId) dandoIdMap[rec.dandoId] = String(rec.id);
          if (rec.email) {
            const normalizedPrice = parseFloat(rec.totalPrice || "0").toFixed(2);
            const fp = `${rec.email}|${normalizedPrice}`;
            if (!fingerprintMap[fp]) fingerprintMap[fp] = String(rec.id);
          }
        }
      }

      const serializedShopifyData = {
        matchMap,
        handleMap,
        titleMap,
        dandoIdMap,
        fingerprintMap,
        totalShopify: shopifyRecords.length,
      };

      // Now start applying from offset 0
      const result = await applyChunk(supabase, table, entityType, projectId, serializedShopifyData, 0);

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Phase: APPLY ── Continue applying updates from offset
    if (phase === "apply" && shopifyData) {
      console.log(`[SYNC] Phase APPLY: continuing from offset ${offset} for ${entityType}`);
      const result = await applyChunk(supabase, table, entityType, projectId, shopifyData, offset);

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error("Invalid phase or missing shopifyData for apply phase");
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[shopify-sync] error:", msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ── Apply a chunk of local records ──────────────────────────────────────────

interface ShopifyMatchData {
  matchMap: Record<string, string>;
  handleMap: Record<string, string>;
  titleMap: Record<string, string>;
  dandoIdMap: Record<string, string>;
  fingerprintMap: Record<string, string>;
  totalShopify: number;
  // Accumulated counters from previous chunks
  accMatched?: number;
  accNotFound?: number;
  accAlreadyUploaded?: number;
  accAlreadyDuplicate?: number;
  accMarkedDuplicate?: number;
  // Seen match keys from previous chunks (for duplicate detection across chunks)
  seenKeys?: string[];
}

async function applyChunk(
  supabase: any,
  table: string,
  entityType: EntityType,
  projectId: string,
  shopifyData: ShopifyMatchData,
  offset: number
) {
  const shopifyMap = shopifyData.matchMap;
  const handleMap = shopifyData.handleMap;
  const titleMap = shopifyData.titleMap;
  const dandoIdMap = shopifyData.dandoIdMap;
  const fingerprintMap = shopifyData.fingerprintMap;

  // Fetch a chunk of local records — select only fields needed for matching (NOT full data blob)
  const shopifyIdCol = entityType === "categories" ? "shopify_collection_id" : "shopify_id";
  let selectCols: string;
  if (entityType === "categories") {
    selectCols = `id, external_id, status, ${shopifyIdCol}, name, slug`;
  } else if (entityType === "customers") {
    // Only need email for matching — avoid fetching full JSONB data
    selectCols = `id, external_id, status, ${shopifyIdCol}, customer_email:data->>email`;
  } else if (entityType === "orders") {
    // Only need email + total_price for fingerprint matching
    selectCols = `id, external_id, status, ${shopifyIdCol}, order_email:data->>customer_email, order_email2:data->>email, order_total:data->>total_price`;
  } else if (entityType === "products") {
    // Only need title for handle generation
    selectCols = `id, external_id, status, ${shopifyIdCol}, product_title:data->>title`;
  } else {
    // pages: need slug
    selectCols = `id, external_id, status, ${shopifyIdCol}, page_slug:data->>slug`;
  }

  let localRecords: any[] = [];
  let from = offset;
  const PAGE_SIZE = 1000;
  const targetCount = CHUNK_SIZE;

  while (localRecords.length < targetCount) {
    let query = supabase
      .from(table)
      .select(selectCols)
      .eq("project_id", projectId)
      .range(from, from + PAGE_SIZE - 1);

    if (entityType === "products") {
      query = query.eq("data->>_isPrimary", "true");
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to fetch local ${entityType}: ${error.message}`);
    if (!data || data.length === 0) break;
    localRecords = localRecords.concat(data);
    from += PAGE_SIZE;
    if (data.length < PAGE_SIZE) break;
  }

  const totalFetched = localRecords.length;
  console.log(`[SYNC] Chunk at offset ${offset}: fetched ${totalFetched} local records`);

  // Initialize counters from accumulated values
  let matched = shopifyData.accMatched || 0;
  let notFound = shopifyData.accNotFound || 0;
  let alreadyUploaded = shopifyData.accAlreadyUploaded || 0;
  let alreadyDuplicate = shopifyData.accAlreadyDuplicate || 0;
  let markedDuplicate = shopifyData.accMarkedDuplicate || 0;

  // Restore seen keys from previous chunks
  const seenMatchKeys = new Set<string>(shopifyData.seenKeys || []);

  const updates: { id: string; shopify_id: string }[] = [];
  const duplicateIds: string[] = [];

  for (const local of localRecords) {
    const existingShopifyId = entityType === "categories" ? local.shopify_collection_id : local.shopify_id;
    if (local.status === "uploaded" && existingShopifyId) {
      alreadyUploaded++;
      const key = getLocalMatchKey(local, entityType);
      if (key) seenMatchKeys.add(key);
      continue;
    }
    if (local.status === "duplicate") {
      alreadyDuplicate++;
      continue;
    }

    let shopifyId: string | undefined;

    if (entityType === "categories") {
      const localSlug = (local.slug || "").toLowerCase().trim();
      if (localSlug) shopifyId = handleMap[localSlug];

      if (!shopifyId) {
        const localName = (local.name || "").toLowerCase().trim();
        if (localName) shopifyId = titleMap[localName];
      }

      if (!shopifyId) {
        const localName = (local.name || "").toLowerCase().trim();
        const slugified = localName.replace(/\s+/g, "-").replace(/[æ]/g, "ae").replace(/[ø]/g, "oe").replace(/[å]/g, "aa").replace(/[^a-z0-9\-]/g, "");
        if (slugified) shopifyId = handleMap[slugified];
      }
    } else if (entityType === "orders") {
      const extId = String(local.external_id || "").trim();
      if (extId) shopifyId = dandoIdMap[extId];

      if (!shopifyId) {
        const email = (local.data?.customer_email || local.data?.email || "").toLowerCase().trim();
        const totalPrice = parseFloat(String(local.data?.total_price || "0")).toFixed(2);
        if (email) {
          const fp = `${email}|${totalPrice}`;
          shopifyId = fingerprintMap[fp];
        }
      }
    } else {
      const localKey = getLocalMatchKey(local, entityType);
      if (localKey) shopifyId = shopifyMap[localKey];
    }

    if (shopifyId) {
      updates.push({ id: local.id, shopify_id: shopifyId });
      matched++;
      const key = getLocalMatchKey(local, entityType);
      if (key) seenMatchKeys.add(key);
    } else {
      const key = getLocalMatchKey(local, entityType);
      if (key && seenMatchKeys.has(key)) {
        duplicateIds.push(local.id);
        markedDuplicate++;
      } else {
        notFound++;
        if (key) seenMatchKeys.add(key);
      }
    }
  }

  // Apply matched updates — batch by using parallel promises (groups of 25)
  const BATCH_SIZE = 25;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((upd) => {
      const updatePayload: Record<string, any> = {
        status: "uploaded",
        updated_at: new Date().toISOString(),
      };
      if (entityType === "categories") {
        updatePayload.shopify_collection_id = upd.shopify_id;
      } else {
        updatePayload.shopify_id = upd.shopify_id;
      }
      return supabase.from(table).update(updatePayload).eq("id", upd.id);
    }));
    if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= updates.length) {
      console.log(`[SYNC] Updated ${Math.min(i + BATCH_SIZE, updates.length)}/${updates.length} matched records`);
    }
  }

  // Mark duplicates in bulk using .in() — much faster
  const DUP_BATCH = 500;
  for (let i = 0; i < duplicateIds.length; i += DUP_BATCH) {
    const batch = duplicateIds.slice(i, i + DUP_BATCH);
    await supabase
      .from(table)
      .update({ status: "duplicate", updated_at: new Date().toISOString() })
      .in("id", batch);
    if ((i + DUP_BATCH) % 2000 === 0 || i + DUP_BATCH >= duplicateIds.length) {
      console.log(`[SYNC] Marked ${Math.min(i + DUP_BATCH, duplicateIds.length)}/${duplicateIds.length} as duplicate`);
    }
  }

  // Determine if there are more records to process
  const nextOffset = offset + totalFetched;
  const hasMore = totalFetched >= CHUNK_SIZE;

  if (!hasMore) {
    // Final chunk — update upload_jobs
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
          processed_count: matched + alreadyUploaded,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingJob.id);
    }
  }

  const result: any = {
    success: true,
    done: !hasMore,
    matched,
    notFound,
    alreadyUploaded,
    alreadyDuplicate,
    markedDuplicate,
    totalShopify: shopifyData.totalShopify,
    chunkProcessed: totalFetched,
    nextOffset: hasMore ? nextOffset : undefined,
  };

  // If there's more, include shopifyData with accumulated counters so client can continue
  if (hasMore) {
    result.shopifyData = {
      ...shopifyData,
      accMatched: matched,
      accNotFound: notFound,
      accAlreadyUploaded: alreadyUploaded,
      accAlreadyDuplicate: alreadyDuplicate,
      accMarkedDuplicate: markedDuplicate,
      seenKeys: Array.from(seenMatchKeys),
    };
  }

  console.log(`[SYNC] Chunk done: matched=${matched}, dup=${markedDuplicate}, notFound=${notFound}, hasMore=${hasMore}`);

  return result;
}
