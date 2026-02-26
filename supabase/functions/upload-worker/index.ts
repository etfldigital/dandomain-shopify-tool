import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal scheduling delay between batches
const WORKER_SCHEDULE_DELAY_MS = 500;

// Fire-and-forget background task runner
const runInBackground = (task: Promise<unknown>) => {
  const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof waitUntil === 'function') {
    waitUntil(task);
    return;
  }
  task.catch((e) => console.error('[WORKER] Background task failed:', e));
};

// Default batch sizes per entity type
const DEFAULT_BATCH_SIZE: Record<string, number> = {
  pages: 20,
  categories: 20,
  products: 25, // ~6 API calls per product (1 create + ~5 images), parallelized images fit within 50s budget
  customers: 20,
  orders: 25, // Sequential processing with 400ms spacing, single-worker mutex
};

// Enforce strict upload order for dependent entities.
// (Collections == categories in our schema)
const ENTITY_SEQUENCE = ['categories', 'products', 'customers', 'orders'] as const;
type SequencedEntity = (typeof ENTITY_SEQUENCE)[number];

// Full job order used for "test upload (3 stk)" runs.
// Pages are independent, but keeping a deterministic order makes the UX clearer.
const TEST_ENTITY_SEQUENCE = ['pages', ...ENTITY_SEQUENCE] as const;
type TestEntity = (typeof TEST_ENTITY_SEQUENCE)[number];

interface WorkerRequest {
  jobId?: string;
  projectId?: string;
  action: 'start' | 'process' | 'pause' | 'resume' | 'cancel' | 'force-restart';
  entityTypes?: string[];
  isTestMode?: boolean;
  skipPrepare?: boolean; // If true, skip prepare-upload (already done by UI)
  triggerMode?: 'manual' | 'full' | 'force'; // 'manual' = single entity, 'full' = run all in sequence, 'force' = bypass sequencing gate
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const nowIso = () => new Date().toISOString();

    const isSequencedEntity = (t: string): t is SequencedEntity =>
      (ENTITY_SEQUENCE as readonly string[]).includes(t);

    const seqIndex = (t: string) =>
      isSequencedEntity(t) ? ENTITY_SEQUENCE.indexOf(t) : -1;

    // Reliable count helper for canonical_* tables.
    // IMPORTANT: For products we ONLY count primary records to match what actually uploads.
    // Each primary record = one Shopify product (with all variants from _mergedVariants).
    const countCanonicalStatus = async (entityType: string, status: string): Promise<number> => {
      const tableName = `canonical_${entityType}`;

      let query = supabase
        .from(tableName)
        .select('*', { count: 'exact', head: true })
        .eq('project_id', projectIdForCounts!)
        .eq('status', status);

      // Entity-specific filters
      if (entityType === 'categories') {
        query = query.eq('exclude', false);
      }

      // Products: ONLY count records explicitly marked as primary.
      // Each primary = 1 Shopify product (secondary variants don't count as separate products).
      // Records with _isPrimary=null have NOT been processed by prepare-upload yet.
      if (entityType === 'products') {
        query = query.eq('data->>_isPrimary', 'true');
      }

      const { count, error } = await query;

      if (!error && typeof count === 'number') return count;

      if (error) {
        console.warn(`[WORKER] Count error for ${tableName}/${status}: ${error.message} (fallback to id scan)`);
      } else {
        console.warn(`[WORKER] Count returned null for ${tableName}/${status} (fallback to id scan)`);
      }

      // Fallback: ID scan (limited, but safer than incorrectly returning 0 and breaking sequencing)
      let scan = supabase
        .from(tableName)
        .select('id')
        .eq('project_id', projectIdForCounts!)
        .eq('status', status)
        .limit(200000);

      if (entityType === 'categories') {
        scan = scan.eq('exclude', false);
      }

      // Products: ONLY count primary records (each primary = 1 Shopify product)
      if (entityType === 'products') {
        scan = scan.eq('data->>_isPrimary', 'true');
      }

      const { data: ids, error: scanErr } = await scan;
      if (scanErr) {
        throw new Error(`Failed to count ${tableName}/${status}: ${scanErr.message}`);
      }
      return ids?.length || 0;
    };

    // NOTE: We can only know projectId after parsing the body, but we want helpers above.
    // We'll assign this once we parse the request.
    let projectIdForCounts: string | null = null;

    const getEarliestIncompleteEntity = async (pid: string): Promise<SequencedEntity | null> => {
      projectIdForCounts = pid;
      for (const entity of ENTITY_SEQUENCE) {
        const pending = await countCanonicalStatus(entity, 'pending');
        if (pending > 0) return entity;
      }
      return null;
    };

    // Like getEarliestIncompleteEntity, but also checks Shopify live counts.
    // If Shopify has >= local total items for an entity, consider it "effectively complete"
    // even if local DB still shows pending records (not yet synced).
    const getEarliestIncompleteEntityWithShopifyCheck = async (pid: string): Promise<SequencedEntity | null> => {
      projectIdForCounts = pid;
      const { data: proj } = await supabase
        .from('projects')
        .select('shopify_store_domain, shopify_access_token_encrypted')
        .eq('id', pid)
        .single();
      const shopifyDomain = (proj?.shopify_store_domain || '').trim();
      const shopifyToken = (proj?.shopify_access_token_encrypted || '').trim();

      for (const entity of ENTITY_SEQUENCE) {
        const pending = await countCanonicalStatus(entity, 'pending');
        if (pending <= 0) continue;

        if (shopifyDomain && shopifyToken) {
          const uploaded = await countCanonicalStatus(entity, 'uploaded');
          const failed = await countCanonicalStatus(entity, 'failed');
          const localTotal = pending + uploaded + failed;
          try {
            const shopifyUrl = `https://${shopifyDomain}/admin/api/2025-01`;
            let liveCount = 0;
            if (entity === 'categories') {
              const r1 = await fetch(`${shopifyUrl}/smart_collections/count.json`, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
              const b1 = await r1.json();
              const r2 = await fetch(`${shopifyUrl}/custom_collections/count.json`, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
              const b2 = await r2.json();
              liveCount = (b1.count || 0) + (b2.count || 0);
            } else if (entity === 'products') {
              // REST /products/count.json deprecated in API 2025-01 – use GraphQL
              const r = await fetch(`${shopifyUrl}/graphql.json`, {
                method: 'POST',
                headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: '{ productsCount { count } }' }),
              });
              const j = await r.json();
              liveCount = j.data?.productsCount?.count || 0;
            } else if (entity === 'customers') {
              const r = await fetch(`${shopifyUrl}/customers/count.json`, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
              liveCount = (await r.json()).count || 0;
            } else if (entity === 'orders') {
              const r = await fetch(`${shopifyUrl}/orders/count.json?status=any`, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
              liveCount = (await r.json()).count || 0;
            }
            if (liveCount >= localTotal) {
              console.log(`[WORKER] Sequencing: ${entity} has ${pending} pending locally but Shopify has ${liveCount}>=${localTotal} – treating as complete`);
              continue;
            }
          } catch (e) {
            console.warn(`[WORKER] Failed Shopify count check for ${entity}, using local count`);
          }
        }
        return entity;
      }
      return null;
    };

    const ensureEntityJobRunning = async (pid: string, entity: SequencedEntity) => {
      // Try running first
      const { data: running } = await supabase
        .from('upload_jobs')
        .select('*')
        .eq('project_id', pid)
        .eq('entity_type', entity)
        .eq('status', 'running')
        .order('created_at', { ascending: false })
        .limit(1);

      if (running?.[0]) {
        runInBackground(
          fetch(`${supabaseUrl}/functions/v1/upload-worker`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
            body: JSON.stringify({ jobId: running[0].id, action: 'process' }),
          })
        );
        return;
      }

      // Then paused/pending
      const { data: candidate } = await supabase
        .from('upload_jobs')
        .select('*')
        .eq('project_id', pid)
        .eq('entity_type', entity)
        .in('status', ['paused', 'pending'])
        .order('created_at', { ascending: true })
        .limit(1);

      if (candidate?.[0]) {
        await supabase
          .from('upload_jobs')
          .update({ status: 'running', started_at: candidate[0].started_at || nowIso(), last_heartbeat_at: nowIso(), next_attempt_at: null })
          .eq('id', candidate[0].id);

        runInBackground(
          fetch(`${supabaseUrl}/functions/v1/upload-worker`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
            body: JSON.stringify({ jobId: candidate[0].id, action: 'process' }),
          })
        );
        return;
      }

      // As last resort, create a job if there is actually work.
      projectIdForCounts = pid;
      const pending = await countCanonicalStatus(entity, 'pending');
      if (pending <= 0) return;

      const uploaded = await countCanonicalStatus(entity, 'uploaded');
      const failed = await countCanonicalStatus(entity, 'failed');
      const total = pending + uploaded + failed;

      const batchSize = DEFAULT_BATCH_SIZE[entity] || 10;
      const { data: newJob, error } = await supabase
        .from('upload_jobs')
        .insert({
          project_id: pid,
          entity_type: entity,
          status: 'running',
          total_count: total,
          processed_count: uploaded + failed,
          batch_size: batchSize,
          is_test_mode: false,
          started_at: nowIso(),
          last_heartbeat_at: nowIso(),
          trigger_mode: 'full',
        })
        .select()
        .single();
      if (error) throw error;

      runInBackground(
        fetch(`${supabaseUrl}/functions/v1/upload-worker`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
          body: JSON.stringify({ jobId: newJob.id, action: 'process' }),
        })
      );
    };

    const { jobId, projectId, action, entityTypes, isTestMode, skipPrepare, triggerMode }: WorkerRequest = await req.json();

    // Make count helpers work for this request.
    projectIdForCounts = projectId || null;

    switch (action) {
      case 'start': {
        if (!projectId) throw new Error('projectId required');

        // ========== CLEAR HARD STOP: Set uploads_paused=false ==========
        // This allows workers to process. Only happens on explicit "start" action.
        await supabase
          .from('projects')
          .update({ uploads_paused: false, updated_at: new Date().toISOString() })
          .eq('id', projectId);
        console.log(`[WORKER] Cleared uploads_paused flag for project ${projectId}`);
        // ================================================================

        // Cancel existing jobs
        await supabase
          .from('upload_jobs')
          .update({ status: 'cancelled', completed_at: new Date().toISOString() })
          .eq('project_id', projectId)
          .in('status', ['pending', 'running', 'paused']);

        const entitiesToProcess = entityTypes || ['pages', 'categories', 'products', 'customers', 'orders'];
        const jobs = [];

        let skipPrepareOverride: boolean | null = null; // null = use original skipPrepare
        for (const entityType of entitiesToProcess) {
          // Use robust counting to avoid accidentally skipping an entity (which breaks sequencing)
          projectIdForCounts = projectId;

          let pendingCount = await countCanonicalStatus(entityType, 'pending');
          const uploadedCount = await countCanonicalStatus(entityType, 'uploaded');
          const failedCount = await countCanonicalStatus(entityType, 'failed');
          const duplicateCount = entityType === 'orders' ? await countCanonicalStatus(entityType, 'duplicate') : 0;

          // PRODUCTS FALLBACK:
          // If products haven't been prepared yet, primary-only counting returns 0.
          // We still want to create a job so the worker can run prepare-upload first.
          if (entityType === 'products' && (!pendingCount || pendingCount <= 0)) {
            const { count: rawPending, error: probeError } = await supabase
              .from('canonical_products')
              .select('*', { count: 'exact', head: true })
              .eq('project_id', projectId)
              .eq('status', 'pending');

            if (probeError) throw probeError;
            if (rawPending && rawPending > 0) {
              // Products exist but aren't prepared yet – use raw count and force prepare step
              pendingCount = isTestMode ? Math.min(3, rawPending) : rawPending;
              // Override skipPrepare so the worker runs prepare-upload for this job
              skipPrepareOverride = false;
              console.log(`[WORKER] Products: primary count=0 but raw pending=${rawPending} – will run prepare-upload`);
            }
          }

          const totalCount = pendingCount + uploadedCount + failedCount + duplicateCount;
          const alreadyProcessedCount = uploadedCount + failedCount + duplicateCount;
          
          console.log(`[WORKER] ${entityType}: pending=${pendingCount}, uploaded=${uploadedCount}, failed=${failedCount}, duplicate=${duplicateCount}, total=${totalCount}`);
          
           if (pendingCount && pendingCount > 0) {
            const batchSize = isTestMode ? 3 : (DEFAULT_BATCH_SIZE[entityType] || 10);
            
             // IMPORTANT: For products, the UI may already have run prepare-upload.
             // In that case, skip the worker-side prepare step by starting at current_batch=1.
             const effectiveSkipPrepare = skipPrepareOverride !== null ? skipPrepareOverride : skipPrepare;
             const initialBatch = entityType === 'products' && effectiveSkipPrepare ? 1 : 0;

             const { data: job, error } = await supabase
              .from('upload_jobs')
              .insert({
                project_id: projectId,
                entity_type: entityType,
                status: 'pending',
                total_count: isTestMode ? Math.min(Math.max(pendingCount, 1), 3) : totalCount,
                processed_count: isTestMode ? 0 : alreadyProcessedCount,
                batch_size: batchSize,
                is_test_mode: isTestMode || false,
                 current_batch: initialBatch,
                trigger_mode: triggerMode || 'full',
              })
              .select()
              .single();

            if (error) throw error;
            jobs.push(job);
          }
        }

        // Start first job (sequential processing)
        if (jobs.length > 0) {
          const firstJob = jobs[0];
          
          await supabase
            .from('upload_jobs')
            .update({ 
              status: 'running', 
              started_at: new Date().toISOString(),
              last_heartbeat_at: new Date().toISOString()
            })
            .eq('id', firstJob.id);

          const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
          runInBackground(
            fetch(functionUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
              body: JSON.stringify({ jobId: firstJob.id, action: 'process' }),
            }).then(() => {
              console.log(`[WORKER] Started job ${firstJob.id} (${firstJob.entity_type})`);
            })
          );
        }

        // Kick off the server-side watchdog loop.
        // This ensures stalled jobs are detected and restarted even if the browser is closed.
        runInBackground(
          fetch(`${supabaseUrl}/functions/v1/job-watchdog`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
            body: JSON.stringify({ source: 'upload-worker-start' }),
          }).catch(e => console.warn('[WORKER] Failed to start watchdog loop:', e))
        );

        await supabase.from('projects').update({ status: 'migrating' }).eq('id', projectId);

        return new Response(JSON.stringify({
          success: true,
          message: `Started ${jobs.length} jobs`,
          jobs,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      case 'process': {
        if (!jobId) throw new Error('jobId required');

        const { data: job, error: jobError } = await supabase
          .from('upload_jobs')
          .select('*')
          .eq('id', jobId)
          .single();

        if (jobError || !job) throw new Error('Job not found');

        // ==================== ORDERS MUTEX LOCK ====================
        // Only ONE worker may process orders at a time. This prevents
        // the watchdog + self-scheduling from spawning duplicate workers
        // that exhaust the Shopify API bucket (2 req/s leak rate).
        // Other entity types are NOT affected by this lock.
        let workerLockId: string | null = null;
        if (job.entity_type === 'orders') {
          const nowMs = Date.now();
          const nowIsoString = new Date(nowMs).toISOString();

          // Read lock state directly from DB on every invocation (never from memory)
          const { data: mutexState, error: mutexReadErr } = await supabase
            .from('upload_jobs')
            .select('worker_lock_id, worker_locked_until')
            .eq('id', jobId)
            .eq('entity_type', 'orders')
            .single();

          if (mutexReadErr || !mutexState) {
            throw new Error(`Orders mutex read failed for job ${jobId}: ${mutexReadErr?.message || 'No row returned'}`);
          }

          // Raw DB values at check moment (requested for debugging)
          console.log(
            `[WORKER] Orders mutex DB state for job ${jobId}: worker_lock_id=${mutexState.worker_lock_id ?? 'null'}, worker_locked_until=${mutexState.worker_locked_until ?? 'null'}`
          );

          const lockExpired =
            !!mutexState.worker_locked_until &&
            new Date(mutexState.worker_locked_until).getTime() <= nowMs;
          const lockAvailable = mutexState.worker_lock_id === null || lockExpired;

          if (!lockAvailable) {
            console.log(`[WORKER] Orders mutex: another worker holds the lock for job ${jobId}, exiting`);
            return new Response(JSON.stringify({ success: true, message: 'Lock held by another worker' }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          workerLockId = crypto.randomUUID();
          const lockUntil = new Date(nowMs + 60_000).toISOString();

          // Atomic compare-and-swap based on raw DB values read above
          let casQuery = supabase
            .from('upload_jobs')
            .update({
              worker_lock_id: workerLockId,
              worker_locked_until: lockUntil,
              last_heartbeat_at: nowIsoString,
            })
            .eq('id', jobId)
            .eq('entity_type', 'orders');

          casQuery = mutexState.worker_lock_id === null
            ? casQuery.is('worker_lock_id', null)
            : casQuery.eq('worker_lock_id', mutexState.worker_lock_id);

          casQuery = mutexState.worker_locked_until === null
            ? casQuery.is('worker_locked_until', null)
            : casQuery.eq('worker_locked_until', mutexState.worker_locked_until);

          const { data: casResult, error: casErr } = await casQuery.select('id');

          if (casErr) {
            throw new Error(`Orders mutex CAS failed for job ${jobId}: ${casErr.message}`);
          }

          if (!casResult || casResult.length === 0) {
            console.log(`[WORKER] Orders mutex: CAS lost race for job ${jobId}, exiting`);
            return new Response(JSON.stringify({ success: true, message: 'Lock held by another worker' }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          console.log(`[WORKER] Orders mutex: acquired lock ${workerLockId} for job ${jobId}`);
        }
        // ===========================================================

        // ================= SEQUENCING GATE =================
        // IMPORTANT: Sequencing only applies when MULTIPLE entities are being uploaded together.
        // If the user clicks "Test 3 stk" on a SINGLE entity type (e.g. just products),
        // we should NOT block waiting for other entities that weren't requested.
        // 
        // For test mode: Only enforce sequencing between jobs that were actually created together.
        // For full mode: Enforce sequencing based on pending database counts (existing behavior).
        
        const getEarliestIncompleteTestEntity = async (pid: string): Promise<SequencedEntity | null> => {
          // Only look at jobs from the SAME test run (created within a short window)
          const { data } = await supabase
            .from('upload_jobs')
            .select('entity_type')
            .eq('project_id', pid)
            .eq('is_test_mode', true)
            .in('status', ['pending', 'running', 'paused']);

          if (!data || data.length === 0) return null;

          const set = new Set<string>(data.map((d: any) => String(d.entity_type)));
          
          // Only return an entity if it's ACTUALLY in the pending job set
          // This prevents blocking products when categories wasn't even requested
          for (const ent of ENTITY_SEQUENCE) {
            if (set.has(ent)) return ent;
          }
          return null;
        };

        const ensureTestEntityJobRunning = async (pid: string, entity: SequencedEntity) => {
          // Prefer already running
          const { data: running } = await supabase
            .from('upload_jobs')
            .select('*')
            .eq('project_id', pid)
            .eq('entity_type', entity)
            .eq('is_test_mode', true)
            .eq('status', 'running')
            .order('created_at', { ascending: false })
            .limit(1);

          if (running?.[0]) {
            runInBackground(
              fetch(`${supabaseUrl}/functions/v1/upload-worker`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
                body: JSON.stringify({ jobId: running[0].id, action: 'process' }),
              })
            );
            return;
          }

          // Then pending/paused
          const { data: candidate } = await supabase
            .from('upload_jobs')
            .select('*')
            .eq('project_id', pid)
            .eq('entity_type', entity)
            .eq('is_test_mode', true)
            .in('status', ['paused', 'pending'])
            .order('created_at', { ascending: true })
            .limit(1);

          if (!candidate?.[0]) return;

          await supabase
            .from('upload_jobs')
            .update({ status: 'running', started_at: candidate[0].started_at || nowIso(), last_heartbeat_at: nowIso(), next_attempt_at: null })
            .eq('id', candidate[0].id);

          runInBackground(
            fetch(`${supabaseUrl}/functions/v1/upload-worker`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
              body: JSON.stringify({ jobId: candidate[0].id, action: 'process' }),
            })
          );
        };

        if (isSequencedEntity(job.entity_type) && job.trigger_mode !== 'force') {
          // For manual trigger_mode: check if predecessor is "effectively complete"
          // by comparing Shopify live count vs local total. This handles the case where
          // all items exist in Shopify but local DB hasn't been synced yet.
          // trigger_mode === 'force' skips the gate entirely (user override).
          const isManualMode = job.trigger_mode === 'manual';

          let earliest: SequencedEntity | null;
          if (job.is_test_mode) {
            earliest = await getEarliestIncompleteTestEntity(job.project_id);
          } else if (isManualMode) {
            // For manual mode: skip predecessors that are "effectively complete" in Shopify
            earliest = await getEarliestIncompleteEntityWithShopifyCheck(job.project_id);
          } else {
            earliest = await getEarliestIncompleteEntity(job.project_id);
          }

          // Block only if:
          // 1. There IS an earlier entity with pending work, AND
          // 2. The current job depends on it (seqIndex comparison)
          if (earliest && earliest !== job.entity_type && seqIndex(job.entity_type) > seqIndex(earliest)) {
            console.log(`[WORKER] Sequencing gate: blocking ${job.entity_type} until ${earliest} is complete`);

            // Put this job back to pending so it won't keep running.
            await supabase
              .from('upload_jobs')
              .update({ status: 'pending', last_heartbeat_at: nowIso(), next_attempt_at: null })
              .eq('id', jobId);

            // For manual mode: don't try to start the predecessor (user didn't request it)
            if (!isManualMode) {
              if (job.is_test_mode) {
                await ensureTestEntityJobRunning(job.project_id, earliest);
              } else {
                await ensureEntityJobRunning(job.project_id, earliest);
              }
            }

            return new Response(JSON.stringify({
              success: true,
              blocked: true,
              message: `Blocked ${job.entity_type} until ${earliest} is complete`,
              required_entity: earliest,
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        } else if (job.trigger_mode === 'force') {
          console.log(`[WORKER] Sequencing gate BYPASSED for ${job.entity_type} (trigger_mode=force)`);
        }
        // ===================================================

        // ========== HARD STOP CHECK ==========
        // If uploads_paused is true on the project, DO NOT PROCESS anything.
        // This prevents background workers/watchdogs from continuing after user clicks Stop.
        const { data: projectCheck } = await supabase
          .from('projects')
          .select('uploads_paused')
          .eq('id', job.project_id)
          .single();
        
        if (projectCheck?.uploads_paused === true) {
          console.log(`[WORKER] HARD STOP: Project has uploads_paused=true, refusing to process`);
          return new Response(JSON.stringify({ success: true, message: 'Hard stop active - uploads paused' }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }
        // =====================================

        // Ensure only newest job for this entity runs
        const { data: newestJobs } = await supabase
          .from('upload_jobs')
          .select('id')
          .eq('project_id', job.project_id)
          .eq('entity_type', job.entity_type)
          .in('status', ['running', 'paused'])
          .order('created_at', { ascending: false })
          .limit(1);

        if (newestJobs?.[0]?.id && newestJobs[0].id !== job.id) {
          console.log(`[WORKER] Job ${job.id} superseded, cancelling`);
          await supabase
            .from('upload_jobs')
            .update({ status: 'cancelled', completed_at: new Date().toISOString() })
            .eq('id', job.id);
          return new Response(JSON.stringify({ success: true, message: 'Superseded' }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }

        // CRITICAL: Only process jobs that are explicitly running.
        // A 'pending' job must never process by itself (prevents "auto-start" after reset).
        if (job.status !== 'running') {
          return new Response(JSON.stringify({ success: true, message: `Not processing because job status is ${job.status}` }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }

        console.log(`[WORKER] Processing ${job.entity_type} (${job.processed_count}/${job.total_count})`);

        // Exponential backoff for consecutive rate limits.
        // Uses last_batch_items to detect consecutive zero-progress batches.
        const getRetryMs = (entityType: string, retryAfterSeconds?: number | null, consecutiveEmpty: number = 0) => {
          const raw = Math.max(0, (retryAfterSeconds || 0) * 1000);
          const min = 2000;
          // Exponential backoff: 2s, 4s, 8s, 16s, 30s max
          const backoff = min * Math.pow(2, Math.min(consecutiveEmpty, 4));
          const jitter = Math.floor(Math.random() * 1000);
          return Math.min(Math.max(raw, backoff) + jitter, 30_000);
        };

        // If scheduled retry is in future, wait
        if (job.next_attempt_at) {
          const waitMs = new Date(job.next_attempt_at).getTime() - Date.now();
          if (waitMs > 0) {
            await supabase
              .from('upload_jobs')
              .update({ last_heartbeat_at: new Date().toISOString() })
              .eq('id', jobId);

            // IMPORTANT: Do NOT self-schedule here.
            // Multiple concurrent invocations can otherwise stack up and create a 429 loop.
            return new Response(JSON.stringify({ 
              success: true, waiting: true, waitSeconds: Math.ceil(waitMs / 1000) 
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        }

        // Clear next_attempt_at and update heartbeat (+ refresh mutex for orders)
        const heartbeatUpdate: Record<string, any> = { 
          last_heartbeat_at: new Date().toISOString(), 
          next_attempt_at: null 
        };
        if (workerLockId) {
          heartbeatUpdate.worker_locked_until = new Date(Date.now() + 60_000).toISOString();
        }
        await supabase
          .from('upload_jobs')
          .update(heartbeatUpdate)
          .eq('id', jobId);

        // ==================== PRODUCT PREPARATION ====================
        // CRITICAL: Products MUST be prepared (grouped with variants) before upload.
        // prepare-upload groups products by title and marks one as primary per group.
        // Without this, each record would be uploaded as a separate Shopify product.
        let effectiveCurrentBatch = typeof job.current_batch === 'number' ? job.current_batch : 0;

        if (job.entity_type === 'products' && effectiveCurrentBatch === 0) {
          const nowIso = () => new Date().toISOString();

          // Check if ALL products have been prepared (no records with _isPrimary=null).
          // Previously this only checked if *enough* primaries existed, which caused
          // prepare to be skipped when only 1 chunk (2000 records) out of 10k+ was processed.
          const { count: unpreparedCount, error: unpreparedError } = await supabase
            .from('canonical_products')
            .select('*', { count: 'exact', head: true })
            .eq('project_id', job.project_id)
            .in('status', ['pending', 'mapped'])
            .is('data->>_isPrimary', null);

          const allPrepared = !unpreparedError && (unpreparedCount ?? 0) === 0;

          // Also check we actually have some primaries (not zero)
          const { count: preparedPrimariesCount } = await supabase
            .from('canonical_products')
            .select('*', { count: 'exact', head: true })
            .eq('project_id', job.project_id)
            .eq('status', 'pending')
            .eq('data->>_isPrimary', 'true');

          if (allPrepared && (preparedPrimariesCount ?? 0) > 0) {
            console.log(`[WORKER] Skipping prepare-upload (all records prepared, ${preparedPrimariesCount} pending primaries)`);

            await supabase
              .from('upload_jobs')
              .update({ current_batch: 1, last_heartbeat_at: nowIso() })
              .eq('id', jobId)
              .eq('current_batch', 0);

            effectiveCurrentBatch = 1;
          } else {
            console.log(`[WORKER] Need to run prepare-upload (unprepared=${unpreparedCount ?? '?'}, primaries=${preparedPrimariesCount ?? 0})`);

            console.log('[WORKER] Running prepare-upload for product grouping...');

            const isTestMode = job.is_test_mode || false;
            const testLimit = isTestMode ? 3 : undefined;

            const prepResponse = await fetch(`${supabaseUrl}/functions/v1/prepare-upload`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
              body: JSON.stringify({
                projectId: job.project_id,
                entityType: 'products',
                previewOnly: false,
                jobId,
                isTestMode,
                testLimit,
              }),
            });

            if (!prepResponse.ok) {
              const errText = await prepResponse.text();
              throw new Error(`prepare-upload failed: ${errText}`);
            }

            const prepResult = await prepResponse.json();
            console.log(`[WORKER] prepare-upload progress: ${prepResult.progress || 'done'}/${prepResult.total || '?'}`);

            if (prepResult.continue === true) {
              // Preparation isn't done yet. Schedule another worker tick soon.
              await supabase
                .from('upload_jobs')
                .update({ last_heartbeat_at: nowIso() })
                .eq('id', jobId);

              const retryDelay = 400;
              runInBackground((async () => {
                await sleep(retryDelay);
                const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
                await fetch(functionUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
                  body: JSON.stringify({ jobId, action: 'process' }),
                });
              })());

              return new Response(JSON.stringify({ success: true, preparing: true, continue: true }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }

            // Preparation complete
            console.log(`[WORKER] prepare-upload complete. Groups: ${prepResult.stats?.groupsCreated || 'N/A'}`);

            await supabase
              .from('upload_jobs')
              .update({ current_batch: 1, last_heartbeat_at: nowIso() })
              .eq('id', jobId)
              .eq('current_batch', 0);

            effectiveCurrentBatch = 1;
          }
        }
        // ==============================================================

        // Call shopify-upload
        const startTime = Date.now();
        let result: any;

        try {
          // For orders: pass cached lookup tables to avoid rebuilding every batch
          const uploadBody: any = {
            projectId: job.project_id,
            entityType: job.entity_type,
            batchSize: job.batch_size,
          };
          if (job.entity_type === 'orders' && job.lookup_cache) {
            uploadBody.lookupCache = job.lookup_cache;
            uploadBody.jobId = job.id;
            console.log(`[WORKER] Passing cached lookups to shopify-upload (built ${job.lookup_cache?.builtAt || 'unknown'})`);
          }

          const response = await fetch(`${supabaseUrl}/functions/v1/shopify-upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
            body: JSON.stringify(uploadBody),
          });

          const responseText = await response.text();
          
          if (!responseText || !responseText.trim()) {
            throw new Error(`Empty response (status ${response.status})`);
          }

          try {
            result = JSON.parse(responseText);
          } catch {
            throw new Error(`Invalid JSON: ${responseText.substring(0, 100)}`);
          }

          if (!response.ok) {
            throw new Error(result.error || `HTTP ${response.status}`);
          }
        } catch (fetchError) {
          const message = fetchError instanceof Error ? fetchError.message : 'Unknown error';
          console.error('[WORKER] shopify-upload failed:', message);

          // Schedule retry
          const retryDelay = 5000;
          const nextAttemptAt = new Date(Date.now() + retryDelay).toISOString();

          await supabase
            .from('upload_jobs')
            .update({ 
              last_heartbeat_at: new Date().toISOString(),
              next_attempt_at: nextAttemptAt,
            })
            .eq('id', jobId);

          runInBackground((async () => {
            await sleep(retryDelay);
            const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
            await fetch(functionUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
              body: JSON.stringify({ jobId, action: 'process' }),
            });
            console.log(`[WORKER] Retrying after error`);
          })());

          return new Response(JSON.stringify({ success: false, error: message, retrying: true }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }

        const elapsed = Date.now() - startTime;
        const itemsProcessed = (result.processed || 0) + (result.skipped || 0) + (result.errors || 0);
        const batchSpeed = elapsed > 0 && itemsProcessed > 0 ? (itemsProcessed / (elapsed / 60000)) : 0;

        console.log(`[WORKER] Batch: processed=${result.processed}, skipped=${result.skipped}, errors=${result.errors}, elapsed=${elapsed}ms, speed=${batchSpeed.toFixed(1)}/min`);

        // Calculate rolling average speed
        // Use overall job progress as fallback when batch speed is 0 (rate limited batches)
        let itemsPerMinute = batchSpeed;
        if (job.items_per_minute && job.items_per_minute > 0 && batchSpeed > 0) {
          itemsPerMinute = job.items_per_minute * 0.7 + batchSpeed * 0.3;
        } else if (batchSpeed === 0 && job.started_at) {
          // Fallback: calculate from total job progress
          const jobElapsedMs = Date.now() - new Date(job.started_at).getTime();
          if (jobElapsedMs > 0 && (job.processed_count || 0) > 0) {
            const overallSpeed = (job.processed_count / (jobElapsedMs / 60000));
            itemsPerMinute = overallSpeed;
          }
        }

        // Get actual database counts using reliable method
        // NOTE: Supabase .count queries can return null/partial on large tables (HTTP 206)
        // Use direct SQL count via rpc or ensure we get exact counts
        const tableName = `canonical_${job.entity_type}`;
        
        // Use the same canonical counting logic as in start(), including product primary filtering.
        projectIdForCounts = job.project_id;
        const actualPending = await countCanonicalStatus(job.entity_type, 'pending');
        const actualUploaded = await countCanonicalStatus(job.entity_type, 'uploaded');
        const actualFailed = await countCanonicalStatus(job.entity_type, 'failed');
        // Count duplicates as "processed" (deliberately skipped, not pending)
        const actualDuplicate = job.entity_type === 'orders' ? await countCanonicalStatus(job.entity_type, 'duplicate') : 0;
        
        console.log(`[WORKER] Counts for ${job.entity_type}: pending=${actualPending}, uploaded=${actualUploaded}, failed=${actualFailed}, duplicate=${actualDuplicate}`);

        const actualTotal = actualPending + actualUploaded + actualFailed + actualDuplicate;
        const actualProcessed = actualUploaded + actualFailed + actualDuplicate;

        // For test mode: track how many items we've uploaded in this job specifically
        // Test mode should ONLY upload up to 3 items total, then stop
        const testModeItemsUploaded = job.is_test_mode 
          ? (job.processed_count || 0) + itemsProcessed 
          : 0;
        const testModeLimitReached = job.is_test_mode && testModeItemsUploaded >= 3;

        // Prepare update - IMPORTANT: In test mode, keep original total_count (which is capped at 3)
        const updateData: Record<string, any> = {
          // In test mode: track items processed in THIS job (not total DB counts)
          // In normal mode: use actual DB counts
          processed_count: job.is_test_mode 
            ? Math.min(testModeItemsUploaded, job.total_count)
            : actualProcessed,
          // In test mode: keep the original total_count (capped at 3)
          // In normal mode: update to actual total
          total_count: job.is_test_mode ? job.total_count : actualTotal,
          error_count: job.is_test_mode ? (job.error_count || 0) + (result.errors || 0) : (actualFailed || 0),
          skipped_count: job.skipped_count + (result.skipped || 0),
          items_per_minute: itemsPerMinute > 0 ? itemsPerMinute : null,
          last_batch_speed: batchSpeed > 0 ? batchSpeed : null,
          last_batch_items: itemsProcessed,
          last_batch_duration_ms: elapsed,
          last_heartbeat_at: new Date().toISOString(),
          current_batch: (typeof effectiveCurrentBatch === 'number' ? effectiveCurrentBatch : (job.current_batch || 0)) + 1,
        };

        // Handle rate limiting with exponential backoff
        let scheduledRetryMs: number | null = null;
        if (result.rateLimited && result.retryAfterSeconds) {
          // Count consecutive empty (zero-progress) batches to escalate backoff.
          // If the PREVIOUS batch also processed 0 items, we're in a 429 loop.
          const previousBatchWasEmpty = (job.last_batch_items === 0 || job.last_batch_items === null);
          const currentBatchEmpty = itemsProcessed === 0;
          // Estimate consecutive empty count from pattern: if both prev and current are empty, escalate
          const consecutiveEmpty = (previousBatchWasEmpty && currentBatchEmpty) ? 
            Math.min(Math.floor((job.current_batch || 0) - (job.processed_count || 0) / Math.max(job.batch_size || 1, 1)), 5) : 
            (currentBatchEmpty ? 1 : 0);
          
          const retryMs = getRetryMs(job.entity_type, result.retryAfterSeconds, consecutiveEmpty);
          scheduledRetryMs = retryMs;
          updateData.next_attempt_at = new Date(Date.now() + retryMs).toISOString();
          console.log(`[WORKER] Rate limited, backing off ${Math.ceil(retryMs / 1000)}s (entity=${job.entity_type}, consecutiveEmpty~${consecutiveEmpty})`);
        }

        // Merge error details (filter transient messages)
        const TRANSIENT_PATTERNS = ['bucket', 'rate limit', '429', 'timeout', 'pausing'];
        const existingErrors = (job.error_details || []).filter((e: any) => 
          e?.externalId !== '__worker__' && 
          !TRANSIENT_PATTERNS.some(p => (e?.message || '').toLowerCase().includes(p))
        );
        const newErrors = (result.errorDetails || []).filter((e: any) =>
          !TRANSIENT_PATTERNS.some(p => (e?.message || '').toLowerCase().includes(p))
        );
        updateData.error_details = [...existingErrors, ...newErrors].slice(-100);

        // Persist lookup cache for orders (saves ~2-3s per batch)
        if (job.entity_type === 'orders' && result.newLookupCache) {
          updateData.lookup_cache = result.newLookupCache;
          updateData.lookup_cache_built_at = result.newLookupCache.builtAt || new Date().toISOString();
          updateData.last_bucket_used = result.lastBucketUsed || 0;
        }

        // Persist duplicate cache for orders (eliminates redundant pre-flight API calls)
        if (job.entity_type === 'orders' && result.newDuplicateCache) {
          updateData.duplicate_cache = result.newDuplicateCache;
        }

        // Check if job is complete:
        // - Normal mode: complete when no pending items remain
        // - Test mode: complete after processing up to 3 items (one batch with batchSize=3)
        const hasMore = job.is_test_mode 
          ? !testModeLimitReached && (actualPending || 0) > 0
          : (actualPending || 0) > 0;
        
        if (!hasMore) {
          const reason = job.is_test_mode 
            ? `test mode limit reached (${testModeItemsUploaded} items)` 
            : 'pending=0';
          console.log(`[WORKER] Job ${jobId} complete (${reason})`);
          updateData.status = 'completed';
          updateData.completed_at = new Date().toISOString();
          // Clear cache on completion to free storage
          updateData.lookup_cache = null;
          updateData.lookup_cache_built_at = null;
          updateData.duplicate_cache = null;
        }

        // Release orders mutex before saving (next invocation will re-acquire)
        if (workerLockId) {
          updateData.worker_lock_id = null;
          updateData.worker_locked_until = null;
        }

        await supabase.from('upload_jobs').update(updateData).eq('id', jobId);

        // Schedule next batch or start next entity
        if (hasMore) {
          // IMPORTANT: if we are rate-limited, schedule AFTER next_attempt_at (with a small safety buffer)
          // so we don't call too early and accidentally create a 429 loop.
          const delayMs = scheduledRetryMs != null
            ? scheduledRetryMs + 250
            : WORKER_SCHEDULE_DELAY_MS;

          runInBackground((async () => {
            await sleep(delayMs);
            const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
            await fetch(functionUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
              body: JSON.stringify({ jobId, action: 'process' }),
            });
          })());
        } else {
          if (job.is_test_mode) {
            // In test mode: continue with the next *test* job (3 stk each).
            // Never start a real (non-test) job automatically.
            const { data: pendingTests, error: nextErr } = await supabase
              .from('upload_jobs')
              .select('*')
              .eq('project_id', job.project_id)
              .eq('is_test_mode', true)
              .in('status', ['pending', 'paused']);

            if (nextErr) throw nextErr;

            const idx = (t: string) => {
              const i = (TEST_ENTITY_SEQUENCE as readonly string[]).indexOf(t);
              return i >= 0 ? i : 999;
            };

            const next = (pendingTests || [])
              .slice()
              .sort((a: any, b: any) => idx(String(a.entity_type)) - idx(String(b.entity_type)))
              .at(0);

            if (next) {
              await supabase
                .from('upload_jobs')
                .update({ status: 'running', started_at: next.started_at || nowIso(), last_heartbeat_at: nowIso(), next_attempt_at: null })
                .eq('id', next.id);

              runInBackground(
                fetch(`${supabaseUrl}/functions/v1/upload-worker`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
                  body: JSON.stringify({ jobId: next.id, action: 'process' }),
                })
              );
            } else {
              console.log(`[WORKER] Test run complete for project ${job.project_id}`);
            }
          } else {
            // Check trigger_mode: if 'manual', do NOT cascade to next entity
            const jobTriggerMode = job.trigger_mode || 'full';
            if (jobTriggerMode === 'manual') {
              console.log(`[WORKER] Job ${jobId} completed (manual mode) – NOT cascading to next entity`);
            } else {
              // Start next pending job (full mode)
              // Always pick the earliest incomplete entity in our dependency chain.
              const earliest = await getEarliestIncompleteEntity(job.project_id);

              if (earliest) {
                await ensureEntityJobRunning(job.project_id, earliest);
              } else {
                // All done
                console.log(`[WORKER] All jobs complete for project ${job.project_id}`);
              }
            }
          }
        }

        return new Response(JSON.stringify({
          success: true,
          processed: result.processed,
          errors: result.errors,
          hasMore,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      case 'pause': {
        const filter = jobId ? { id: jobId } : { project_id: projectId };
        await supabase
          .from('upload_jobs')
          .update({ status: 'paused', next_attempt_at: null })
          .match(filter)
          .eq('status', 'running');

        return new Response(JSON.stringify({ success: true, message: 'Paused' }), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      case 'resume': {
        const filter = jobId ? { id: jobId } : { project_id: projectId };
        const { data: pausedJobs } = await supabase
          .from('upload_jobs')
          .update({ status: 'running', last_heartbeat_at: new Date().toISOString() })
          .match(filter)
          .eq('status', 'paused')
          .select();

        if (pausedJobs && pausedJobs.length > 0) {
          for (const pj of pausedJobs) {
            runInBackground(
              fetch(`${supabaseUrl}/functions/v1/upload-worker`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
                body: JSON.stringify({ jobId: pj.id, action: 'process' }),
              })
            );
          }
        }

        return new Response(JSON.stringify({ success: true, message: 'Resumed' }), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      case 'cancel': {
        // ========== SET HARD STOP ==========
        // When user cancels, set uploads_paused=true so no background tasks can continue
        if (projectId) {
          await supabase
            .from('projects')
            .update({ uploads_paused: true, updated_at: new Date().toISOString() })
            .eq('id', projectId);
          console.log(`[WORKER] Set uploads_paused=true for project ${projectId} on cancel`);
        }
        // ===================================

        const filter = jobId ? { id: jobId } : { project_id: projectId };
        await supabase
          .from('upload_jobs')
          .update({ status: 'cancelled', completed_at: new Date().toISOString(), next_attempt_at: null })
          .match(filter)
          .in('status', ['pending', 'running', 'paused']);

        return new Response(JSON.stringify({ success: true, message: 'Cancelled' }), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      case 'force-restart': {
        if (!projectId) throw new Error('projectId required');

        // Get all non-completed jobs
        const { data: jobs } = await supabase
          .from('upload_jobs')
          .select('*')
          .eq('project_id', projectId)
          .in('status', ['running', 'paused', 'pending']);

        if (!jobs || jobs.length === 0) {
          return new Response(JSON.stringify({ success: true, message: 'No jobs to restart' }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }

        // Cancel all but the oldest running job per entity type
        const byEntity: Record<string, any[]> = {};
        for (const job of jobs) {
          if (!byEntity[job.entity_type]) byEntity[job.entity_type] = [];
          byEntity[job.entity_type].push(job);
        }

        for (const [entityType, entityJobs] of Object.entries(byEntity)) {
          entityJobs.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
          
          // Keep oldest, cancel rest
          for (let i = 1; i < entityJobs.length; i++) {
            await supabase
              .from('upload_jobs')
              .update({ status: 'cancelled', completed_at: new Date().toISOString() })
              .eq('id', entityJobs[i].id);
          }
          
          // Restart the oldest
          const keepJob = entityJobs[0];
          await supabase
            .from('upload_jobs')
            .update({ 
              status: 'running',
              next_attempt_at: null,
              error_details: [],
              last_heartbeat_at: new Date().toISOString()
            })
            .eq('id', keepJob.id);

          runInBackground(
            fetch(`${supabaseUrl}/functions/v1/upload-worker`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
              body: JSON.stringify({ jobId: keepJob.id, action: 'process' }),
            })
          );
          
          console.log(`[WORKER] Force-restarted ${entityType} job ${keepJob.id}`);
        }

        return new Response(JSON.stringify({ success: true, message: 'Force-restarted' }), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[WORKER] Error:', message);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
