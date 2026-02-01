import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  products: 10,
  customers: 20,
  orders: 5,
};

// Enforce strict upload order for dependent entities.
// (Collections == categories in our schema)
const ENTITY_SEQUENCE = ['categories', 'products', 'customers', 'orders'] as const;
type SequencedEntity = (typeof ENTITY_SEQUENCE)[number];

interface WorkerRequest {
  jobId?: string;
  projectId?: string;
  action: 'start' | 'process' | 'pause' | 'resume' | 'cancel' | 'force-restart';
  entityTypes?: string[];
  isTestMode?: boolean;
  skipPrepare?: boolean; // If true, skip prepare-upload (already done by UI)
}

serve(async (req) => {
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

      // Products: only primary records are real Shopify products.
      if (entityType === 'products') {
        query = query.or('data->>_isPrimary.eq.true,data->>_isPrimary.is.null');
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

      if (entityType === 'products') {
        scan = scan.or('data->>_isPrimary.eq.true,data->>_isPrimary.is.null');
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

    const { jobId, projectId, action, entityTypes, isTestMode, skipPrepare }: WorkerRequest = await req.json();

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

        for (const entityType of entitiesToProcess) {
          // Use robust counting to avoid accidentally skipping an entity (which breaks sequencing)
          projectIdForCounts = projectId;

          const pendingCount = await countCanonicalStatus(entityType, 'pending');
          const uploadedCount = await countCanonicalStatus(entityType, 'uploaded');
          const failedCount = await countCanonicalStatus(entityType, 'failed');

          const totalCount = pendingCount + uploadedCount + failedCount;
          const alreadyProcessedCount = uploadedCount + failedCount;
          
          console.log(`[WORKER] ${entityType}: pending=${pendingCount}, uploaded=${uploadedCount}, failed=${failedCount}, total=${totalCount}`);
          console.log(`[WORKER] ${entityType}: pending=${pendingCount}, uploaded=${uploadedCount}, failed=${failedCount}, total=${totalCount}`);
          
           if (pendingCount && pendingCount > 0) {
            const batchSize = isTestMode ? 3 : (DEFAULT_BATCH_SIZE[entityType] || 10);
            
             // IMPORTANT: For products, the UI may already have run prepare-upload.
             // In that case, skip the worker-side prepare step by starting at current_batch=1.
             const initialBatch = entityType === 'products' && skipPrepare ? 1 : 0;

             const { data: job, error } = await supabase
              .from('upload_jobs')
              .insert({
                project_id: projectId,
                entity_type: entityType,
                status: 'pending',
                total_count: isTestMode ? Math.min(pendingCount, 3) : totalCount,
                processed_count: isTestMode ? 0 : alreadyProcessedCount,
                batch_size: batchSize,
                is_test_mode: isTestMode || false,
                 current_batch: initialBatch,
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

        // ================= SEQUENCING GATE =================
        // Never allow a later entity to run while an earlier one still has pending work.
        if (isSequencedEntity(job.entity_type)) {
          const earliest = await getEarliestIncompleteEntity(job.project_id);
          if (earliest && seqIndex(job.entity_type) > seqIndex(earliest)) {
            console.log(`[WORKER] Sequencing gate: blocking ${job.entity_type} until ${earliest} is complete`);

            // Put this job back to pending so it won't keep running.
            await supabase
              .from('upload_jobs')
              .update({ status: 'pending', last_heartbeat_at: nowIso(), next_attempt_at: null })
              .eq('id', jobId);

            // Ensure the correct (earliest incomplete) entity is running.
            await ensureEntityJobRunning(job.project_id, earliest);

            return new Response(JSON.stringify({
              success: true,
              blocked: true,
              message: `Blocked ${job.entity_type} until ${earliest} is complete`,
              required_entity: earliest,
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
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

        const getRetryMs = (entityType: string, retryAfterSeconds?: number | null) => {
          // Use Shopify's suggested retry time, or default minimum
          const raw = Math.max(0, (retryAfterSeconds || 0) * 1000);
          const min = 2000; // 2s minimum - Shopify bucket refills at 2 req/s
          const jitter = Math.floor(Math.random() * 500);
          return Math.min(Math.max(raw, min) + jitter, 30_000);
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

        // Clear next_attempt_at and update heartbeat
        await supabase
          .from('upload_jobs')
          .update({ last_heartbeat_at: new Date().toISOString(), next_attempt_at: null })
          .eq('id', jobId);

        // One-time product preparation (grouping/variant extraction) before first product batch.
        // CRITICAL: We must not re-run prepare-upload on every watchdog retrigger.
        // We use current_batch as a durable marker:
        // - current_batch === 0  => not prepared yet
        // - current_batch >= 1   => prepared (or UI chose to skip prepare)
        let effectiveCurrentBatch = typeof job.current_batch === 'number' ? job.current_batch : 0;

        if (job.entity_type === 'products' && effectiveCurrentBatch === 0) {
          console.log('[WORKER] Running product prepare step before upload...');

          const prepRes = await fetch(`${supabaseUrl}/functions/v1/prepare-upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
            body: JSON.stringify({
              projectId: job.project_id,
              entityType: 'products',
              previewOnly: false,
            }),
          });

          const prepText = await prepRes.text();
          if (!prepText || !prepText.trim()) {
            throw new Error(`prepare-upload returned empty response (status ${prepRes.status})`);
          }
          let prepJson: any;
          try {
            prepJson = JSON.parse(prepText);
          } catch {
            throw new Error(`prepare-upload invalid JSON: ${prepText.substring(0, 120)}`);
          }
          if (!prepRes.ok || prepJson?.success === false) {
            throw new Error(prepJson?.error || `prepare-upload failed (status ${prepRes.status})`);
          }

          console.log(
            `[WORKER] prepare-upload committed: groups=${prepJson?.stats?.groupsCreated ?? '?'}, variants=${prepJson?.stats?.variantsTotal ?? '?'}, rejected=${prepJson?.stats?.recordsRejected ?? '?'}`
          );

          // Mark job as prepared immediately so a watchdog retrigger does NOT re-run prepare.
          // Use a conditional update to reduce chances of concurrent invocations flipping it back/forth.
          await supabase
            .from('upload_jobs')
            .update({ current_batch: 1, last_heartbeat_at: new Date().toISOString() })
            .eq('id', jobId)
            .eq('current_batch', 0);

          effectiveCurrentBatch = 1;
        } else if (job.entity_type === 'products' && effectiveCurrentBatch >= 1) {
          console.log('[WORKER] Skipping prepare-upload (already prepared)');
        }

        // Call shopify-upload
        const startTime = Date.now();
        let result: any;

        try {
          const response = await fetch(`${supabaseUrl}/functions/v1/shopify-upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
            body: JSON.stringify({
              projectId: job.project_id,
              entityType: job.entity_type,
              batchSize: job.batch_size,
            }),
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
        let itemsPerMinute = batchSpeed;
        if (job.items_per_minute && job.items_per_minute > 0 && batchSpeed > 0) {
          itemsPerMinute = job.items_per_minute * 0.7 + batchSpeed * 0.3;
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
        
        console.log(`[WORKER] Counts for ${job.entity_type}: pending=${actualPending}, uploaded=${actualUploaded}, failed=${actualFailed}`);

        const actualTotal = actualPending + actualUploaded + actualFailed;
        const actualProcessed = actualUploaded + actualFailed;

        // Prepare update
        const updateData: Record<string, any> = {
          processed_count: actualProcessed,
          total_count: actualTotal,
          error_count: actualFailed || 0,
          skipped_count: job.skipped_count + (result.skipped || 0),
          items_per_minute: itemsPerMinute > 0 ? itemsPerMinute : null,
          last_batch_speed: batchSpeed > 0 ? batchSpeed : null,
          last_batch_items: itemsProcessed,
          last_batch_duration_ms: elapsed,
          last_heartbeat_at: new Date().toISOString(),
          current_batch: (typeof effectiveCurrentBatch === 'number' ? effectiveCurrentBatch : (job.current_batch || 0)) + 1,
        };

        // Handle rate limiting
        let scheduledRetryMs: number | null = null;
        if (result.rateLimited && result.retryAfterSeconds) {
          const retryMs = getRetryMs(job.entity_type, result.retryAfterSeconds);
          scheduledRetryMs = retryMs;
          updateData.next_attempt_at = new Date(Date.now() + retryMs).toISOString();
          console.log(`[WORKER] Rate limited, backing off ${Math.ceil(retryMs / 1000)}s (entity=${job.entity_type})`);
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

        // Check if job is complete
        const hasMore = (actualPending || 0) > 0 && !job.is_test_mode;
        
        if (!hasMore) {
          console.log(`[WORKER] Job ${jobId} complete (pending=0)`);
          updateData.status = 'completed';
          updateData.completed_at = new Date().toISOString();
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
          // Start next pending job
          // Always pick the earliest incomplete entity in our dependency chain.
          const earliest = await getEarliestIncompleteEntity(job.project_id);

          if (earliest) {
            await ensureEntityJobRunning(job.project_id, earliest);
          } else {
            // All done
            console.log(`[WORKER] All jobs complete for project ${job.project_id}`);
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
