import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const WORKER_SCHEDULE_DELAY_MS = 500;
const WORKER_RETRY_DELAY_MS = 5000;
// IMPORTANT: Keep this comfortably below the platform's hard request timeout.
// If we let the fetch hang too long, the worker itself can be terminated mid-response,
// which shows up as "Failed to send a request" in the UI.
const SHOPIFY_UPLOAD_TIMEOUT_MS = 45_000;

const runInBackground = (task: Promise<unknown>) => {
  const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof waitUntil === 'function') {
    waitUntil(task);
    return;
  }
  task.catch((e) => console.error('[WORKER] Background task failed:', e));
};

const isGatewayOrTimeoutError = (message: string) => {
  const m = message.toLowerCase();
  return (
    m.includes('status 502') ||
    m.includes('502') ||
    m.includes('bad gateway') ||
    m.includes('status 504') ||
    m.includes('504') ||
    m.includes('gateway') ||
    m.includes('cloudflare') ||
    m.includes('connection closed') ||
    m.includes('failed to fetch') ||
    m.includes('timeout') ||
    m.includes('aborted')
  );
};

const countTrailingWorkerErrors = (details: Array<{ externalId?: string; message?: string }> | null | undefined) => {
  if (!details || details.length === 0) return 0;
  let streak = 0;
  for (let i = details.length - 1; i >= 0; i--) {
    if (details[i]?.externalId === '__worker__') streak++;
    else break;
  }
  return streak;
};

const countRateLimitErrors = (details: Array<{ externalId?: string; message?: string }> | null | undefined) => {
  if (!details || details.length === 0) return 0;
  // Count rate limit errors in last 10 entries
  const recent = details.slice(-10);
  return recent.filter(d => 
    d?.message?.includes('429') || 
    d?.message?.includes('rate limit') ||
    d?.message?.includes('Rate limit')
  ).length;
};

const isRateLimitError = (message: string) => {
  const m = message.toLowerCase();
  return m.includes('429') || m.includes('rate limit') || m.includes('too many requests') || m.includes('bucket nearly full');
};

const computeRetryDelayMs = (workerErrorStreak: number, message: string, rateLimitCount: number, retryAfterSecondsHint?: number) => {
  // If shopify-upload gave us a specific retry hint, use it (with small buffer)
  if (typeof retryAfterSecondsHint === 'number' && retryAfterSecondsHint > 0) {
    // Add 1s buffer but cap at 10s max for rate limits
    return Math.min((retryAfterSecondsHint + 1) * 1000, 10_000);
  }
  
  // Rate limit errors: short waits - Shopify bucket refills at 2 req/sec (20 requests = 10s)
  if (isRateLimitError(message)) {
    // Start at 3s, increase by 2s per consecutive error, max 10s
    const rateLimitDelay = Math.min(3_000 + (rateLimitCount * 2_000), 10_000);
    return rateLimitDelay;
  }
  // Gateway/timeouts benefit from moderate cool-down
  const base = isGatewayOrTimeoutError(message) ? 5_000 : WORKER_RETRY_DELAY_MS;
  const delay = base * Math.pow(1.5, Math.min(workerErrorStreak, 4));
  return Math.min(delay, 30_000); // max 30s instead of 2 minutes
};

// Batch sizes tuned for Shopify's rate limits (40 bucket, 2 req/sec leak)
// More aggressive defaults - we'll auto-scale down on errors
const DEFAULT_BATCH_SIZE: Record<string, number> = {
  customers: 30,
  orders: 10,      // Orders are complex but we auto-scale on timeout
  products: 15,    // Products with images/metafields - scale down if needed
  pages: 30,
  categories: 30,
};

const MIN_BATCH_SIZE: Record<string, number> = {
  customers: 5,
  orders: 1,
  products: 1,
  pages: 5,
  categories: 5,
};

const MAX_BATCH_SIZE: Record<string, number> = {
  customers: 50,
  orders: 15,
  products: 25,
  pages: 50,
  categories: 50,
};

const batchSizeForEntity = (entityType: string) => {
  return DEFAULT_BATCH_SIZE[entityType] || 25;
};

interface WorkerRequest {
  jobId?: string;
  projectId?: string;
  action: 'start' | 'process' | 'pause' | 'resume' | 'cancel' | 'status' | 'force-restart';
  entityTypes?: string[];
  isTestMode?: boolean;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { jobId, projectId, action, entityTypes, isTestMode }: WorkerRequest = await req.json();

    switch (action) {
      case 'start': {
        if (!projectId) {
          throw new Error('projectId required for start action');
        }

        // Cancel any existing running/pending jobs for this project
        await supabase
          .from('upload_jobs')
          .update({ status: 'cancelled', completed_at: new Date().toISOString() })
          .eq('project_id', projectId)
          .in('status', ['pending', 'running', 'paused']);

        // Get counts for each entity type
        const entitiesToProcess = entityTypes || ['pages', 'categories', 'products', 'customers', 'orders'];
        const jobs = [];

        for (const entityType of entitiesToProcess) {
          const tableName = `canonical_${entityType}`;
          
          // Get pending count (only items that haven't been attempted)
          let pendingQuery = supabase
            .from(tableName)
            .select('*', { count: 'exact', head: true })
            .eq('project_id', projectId)
            .eq('status', 'pending');
          
          // Categories need exclude filter
          if (entityType === 'categories') {
            pendingQuery = pendingQuery.eq('exclude', false);
          }
          
          const { count: pendingCount } = await pendingQuery;
          
          // Get already uploaded count for progress display
          const { count: uploadedCount } = await supabase
            .from(tableName)
            .select('*', { count: 'exact', head: true })
            .eq('project_id', projectId)
            .eq('status', 'uploaded');

          // Get failed count - these are considered "processed" and won't be retried automatically
          const { count: failedCount } = await supabase
            .from(tableName)
            .select('*', { count: 'exact', head: true })
            .eq('project_id', projectId)
            .eq('status', 'failed');

          // Total = all items that have been processed (uploaded + failed) + pending
          const totalCount = (pendingCount || 0) + (uploadedCount || 0) + (failedCount || 0);
          // Already processed = uploaded + failed
          const alreadyProcessedCount = (uploadedCount || 0) + (failedCount || 0);
          
          console.log(`[WORKER] Entity ${entityType}: pending=${pendingCount}, uploaded=${uploadedCount}, failed=${failedCount}, total=${totalCount}`);
          
          // Only create job if there are actually pending items to process
          if (pendingCount && pendingCount > 0) {
            const { data: job, error } = await supabase
              .from('upload_jobs')
              .insert({
                project_id: projectId,
                entity_type: entityType,
                status: 'pending',
                total_count: isTestMode ? Math.min(pendingCount, 3) : totalCount,
                processed_count: isTestMode ? 0 : alreadyProcessedCount,
                batch_size: isTestMode ? 3 : batchSizeForEntity(entityType),
                is_test_mode: isTestMode || false,
              })
              .select()
              .single();

            if (error) throw error;
            jobs.push(job);
          }
        }

        // SEQUENTIAL PROCESSING: Start only the FIRST job
        // Order: pages → categories → products → customers → orders
        // This ensures:
        // 1. Customers are fully uploaded before orders start
        // 2. Each entity type gets the full rate limit budget
        // 3. No conflicts or race conditions between entity types
        const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
        
        if (jobs.length > 0) {
          const firstJob = jobs[0];
          
          // Mark first job as running
          await supabase
            .from('upload_jobs')
            .update({ 
              status: 'running', 
              started_at: new Date().toISOString(),
              last_heartbeat_at: new Date().toISOString()
            })
            .eq('id', firstJob.id);

          // Trigger processing for first job only.
          // CRITICAL: fire-and-forget, otherwise the "start" request blocks until the batch finishes,
          // which can timeout and surface as "Failed to send a request" in the UI.
          runInBackground(
            fetch(functionUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({ jobId: firstJob.id, action: 'process' }),
            })
              .then(() => {
                console.log(
                  `[WORKER] Started sequential job ${firstJob.id} (${firstJob.entity_type}), ${jobs.length - 1} more jobs waiting`
                );
              })
              .catch((e) => {
                console.error(`[WORKER] Failed to trigger ${firstJob.entity_type} processing:`, e);
              })
          );
        }

        // Update project status
        await supabase
          .from('projects')
          .update({ status: 'migrating' })
          .eq('id', projectId);

        return new Response(JSON.stringify({
          success: true,
          message: `Started ${jobs.length} upload jobs`,
          jobs,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      case 'process': {
        if (!jobId) {
          throw new Error('jobId required for process action');
        }

        // Get the job
        const { data: job, error: jobError } = await supabase
          .from('upload_jobs')
          .select('*')
          .eq('id', jobId)
          .single();

        if (jobError || !job) {
          throw new Error('Job not found');
        }

        // Robustness: ensure only ONE active job per (project_id, entity_type).
        // If multiple running/paused jobs exist (e.g. due to retries/restarts), cancel the older ones to
        // avoid duplicate workers fighting each other and spamming rate limits.
        {
          const { data: newestJobs } = await supabase
            .from('upload_jobs')
            .select('id, created_at')
            .eq('project_id', job.project_id)
            .eq('entity_type', job.entity_type)
            .in('status', ['running', 'paused'])
            .order('created_at', { ascending: false })
            .limit(1);

          const newestJobId = newestJobs?.[0]?.id;
          if (newestJobId && newestJobId !== job.id) {
            console.log(`[WORKER] Cancelling superseded job ${job.id} (newest is ${newestJobId})`);
            await supabase
              .from('upload_jobs')
              .update({
                status: 'cancelled',
                completed_at: new Date().toISOString(),
                next_attempt_at: null,
              })
              .eq('id', job.id);

            return new Response(
              JSON.stringify({
                success: true,
                message: 'Job superseded by a newer active job; cancelled to prevent duplicate processing',
              }),
              { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
            );
          }
        }

        console.log(`[WORKER] Processing job ${job.id} (${job.entity_type}) batch=${job.current_batch} processed=${job.processed_count}/${job.total_count}`);

        // Check if job should continue
        if (job.status === 'cancelled' || job.status === 'paused') {
          return new Response(JSON.stringify({
            success: true,
            message: `Job is ${job.status}`,
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // If a retry has been scheduled in the future, don't hit shopify-upload yet.
        // This prevents noisy retry loops and makes the system resilient even if multiple triggers happen.
        if (job.next_attempt_at) {
          const nowMs = Date.now();
          const nextMs = new Date(job.next_attempt_at).getTime();
          if (Number.isFinite(nextMs) && nextMs - nowMs > 500) {
            const waitMs = Math.max(0, nextMs - nowMs);
            const waitSeconds = Math.ceil(waitMs / 1000);

            // Keep heartbeat fresh so UI shows "venter" instead of "stalled".
            await supabase
              .from('upload_jobs')
              .update({ last_heartbeat_at: new Date().toISOString() })
              .eq('id', jobId);

            // Self-schedule the retry (best-effort). The watchdog is a secondary safety net.
            runInBackground(
              (async () => {
                await sleep(waitMs);
                const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
                await fetch(functionUrl, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${supabaseServiceKey}`,
                  },
                  body: JSON.stringify({ jobId, action: 'process' }),
                });
              })()
            );

            return new Response(JSON.stringify({
              success: true,
              waiting: true,
              nextAttemptAt: job.next_attempt_at,
              waitSeconds,
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        }

        // Get project for Shopify credentials
        const { data: project, error: projectError } = await supabase
          .from('projects')
          .select('*')
          .eq('id', job.project_id)
          .single();

        if (projectError || !project) {
          throw new Error('Project not found');
        }

        // Process one batch
        const effectiveBatchSize = job.is_test_mode
          ? job.batch_size
          : Math.min(job.batch_size, batchSizeForEntity(job.entity_type));

        // Update heartbeat at the start so the UI doesn't look "stuck" while a batch is in-flight.
        await supabase
          .from('upload_jobs')
          .update({
            last_heartbeat_at: new Date().toISOString(),
            batch_size: effectiveBatchSize,
            // Clear any scheduled retry once we start processing again
            next_attempt_at: null,
          })
          .eq('id', jobId);

        const startTime = Date.now();
        let result: Record<string, any>;
        
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), SHOPIFY_UPLOAD_TIMEOUT_MS);

          const response = await fetch(`${supabaseUrl}/functions/v1/shopify-upload`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              projectId: job.project_id,
              entityType: job.entity_type,
              // IMPORTANT: use effectiveBatchSize (job.batch_size may be outdated in-memory)
              batchSize: effectiveBatchSize,
            }),
            signal: controller.signal,
          });

          clearTimeout(timeout);

          const responseText = await response.text();

          // Try to parse as JSON, handle empty/HTML error pages
          if (!responseText || !responseText.trim()) {
            throw new Error(`shopify-upload returned empty response (status ${response.status})`);
          }

          try {
            result = JSON.parse(responseText);
          } catch (parseError) {
            console.error('Failed to parse shopify-upload response:', responseText.substring(0, 200));
            throw new Error(`shopify-upload returned invalid JSON (status ${response.status}): ${responseText.substring(0, 100)}`);
          }

          if (!response.ok) {
            throw new Error(result.error || `shopify-upload failed with status ${response.status}`);
          }
        } catch (fetchError) {
          const message = fetchError instanceof Error ? fetchError.message : 'Unknown fetch error';
          console.error('shopify-upload call failed:', fetchError);

           // Treat rate-limit/timeouts/aborts as transient operational states.
           // They should not spam error counters as "failures" in the UI.
           const isTransient = isRateLimitError(message) || isGatewayOrTimeoutError(message);

          // Keep only non-worker errors in the persisted report.
          // Worker operational states (rate-limit, timeouts, bucket full) are communicated via next_attempt_at
          // and should not spam the error report.
          const existingErrors = (job.error_details || []).filter((e: any) => e?.externalId !== '__worker__');
          const workerErrorStreak = countTrailingWorkerErrors(existingErrors) + 1;
          const rateLimitCount = countRateLimitErrors(existingErrors);
          // Use shorter delays for rate limits - no explicit hint available in catch block
          const retryDelayMs = computeRetryDelayMs(workerErrorStreak, message, rateLimitCount, undefined);
          const nextAttemptAtIso = new Date(Date.now() + retryDelayMs).toISOString();

          // If orders OR products are timing out / gatewaying, reduce batch size
          // But respect minimum batch sizes
          const minBatch = MIN_BATCH_SIZE[job.entity_type] || 1;
          const shouldReduceBatchSize =
            (job.entity_type === 'orders' || job.entity_type === 'products') &&
            !job.is_test_mode &&
            isGatewayOrTimeoutError(message) &&
            effectiveBatchSize > minBatch;

          const reducedBatchSize = shouldReduceBatchSize
            ? Math.max(minBatch, Math.floor(effectiveBatchSize / 2))
            : effectiveBatchSize;

          const displayMessage =
            `${message}` +
            (shouldReduceBatchSize ? ` (reducerer batch til ${reducedBatchSize})` : '') +
            ` (retry om ${Math.round(retryDelayMs / 1000)}s)`;

          // Only persist worker errors if they are NOT transient.
          // Transient states should not pollute the error report.
          const mergedErrors = isTransient
            ? existingErrors
            : [...existingErrors, { externalId: '__worker__', message: displayMessage }].slice(-30);

          // Update job with error and retry in the background
          await supabase
            .from('upload_jobs')
            .update({
              last_heartbeat_at: new Date().toISOString(),
              error_count: job.error_count + (isTransient ? 0 : 1),
              error_details: mergedErrors,
              next_attempt_at: nextAttemptAtIso,
              ...(shouldReduceBatchSize ? { batch_size: reducedBatchSize } : {}),
            })
            .eq('id', jobId);

          // Self-schedule retries (best-effort). The watchdog remains a secondary safety net.
          const scheduleRetry = async () => {
            await sleep(retryDelayMs);
            const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
            await fetch(functionUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({ jobId, action: 'process' }),
            });
            console.log(`[WORKER] Retrying job ${jobId} after error (self-scheduled, delay=${Math.round(retryDelayMs / 1000)}s)`);
          };

          const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil;
          if (typeof waitUntil === 'function') {
            waitUntil(scheduleRetry());
          } else {
            scheduleRetry().catch((e) => console.error('[WORKER] Failed to retry after error:', e));
          }

          return new Response(JSON.stringify({
            success: false,
            error: message,
            retrying: true,
            nextAttemptAt: nextAttemptAtIso,
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const elapsed = Date.now() - startTime;

        const rateLimited = Boolean((result as any)?.rateLimited);
        const retryAfterSecondsRaw = (result as any)?.retryAfterSeconds;
        const retryAfterSeconds = rateLimited && typeof retryAfterSecondsRaw === 'number'
          ? Math.max(1, Math.round(retryAfterSecondsRaw))
          : rateLimited && typeof retryAfterSecondsRaw === 'string'
            ? Math.max(1, Math.round(Number(retryAfterSecondsRaw)))
            : 0;

        // Count ALL attempted items (success + skipped + failed).
        // This is critical for correct progress + realistic speed when many items fail validation.
        const itemsAttempted = (result.processed || 0) + (result.skipped || 0) + (result.errors || 0);
        const itemsSucceeded = (result.processed || 0) + (result.skipped || 0);

        // ACTUAL batch speed - this is the real throughput for THIS batch only
        const batchItemsPerMinute = elapsed > 0 && itemsAttempted > 0
          ? (itemsAttempted / (elapsed / 60000))
          : 0;

        console.log(
          `[WORKER] Batch result: succeeded=${itemsSucceeded} (processed=${result.processed}, skipped=${result.skipped}), failed=${result.errors}, elapsed=${elapsed}ms, batchSpeed=${batchItemsPerMinute.toFixed(1)}/min`
        );

        // Rolling average for ETA calculations (smoothed)
        let itemsPerMinute: number | null = null;
        
        if (batchItemsPerMinute > 0) {
          if (job.items_per_minute && job.items_per_minute > 0) {
            itemsPerMinute = job.items_per_minute * 0.7 + batchItemsPerMinute * 0.3;
          } else {
            itemsPerMinute = batchItemsPerMinute;
          }
        } else if (job.items_per_minute) {
          itemsPerMinute = job.items_per_minute;
        }

        console.log(`[WORKER] Speed: last_batch=${batchItemsPerMinute.toFixed(1)}/min, rolling_avg=${itemsPerMinute?.toFixed(1) || 'null'}/min`);

        // Merge error details - filter out transient operational messages
        // These are bucket/rate-limit states, NOT real item failures
        const TRANSIENT_MESSAGES = [
          'Bucket nearly full',
          'pausing',
          'rate limit',
          'too many requests',
          'For mange forespørgsler',
          '429',
        ];
        const isTransientError = (msg: string) => 
          TRANSIENT_MESSAGES.some(t => msg.toLowerCase().includes(t.toLowerCase()));
        
        const existingErrors = (job.error_details || []).filter((e: any) => 
          e?.externalId !== '__worker__' && !isTransientError(e?.message || '')
        );
        const newErrors = (result.errorDetails || []).filter((e: any) =>
          !isTransientError(e?.message || '')
        );

        const allErrors = [...existingErrors, ...newErrors].slice(-100); // Keep last 100

        // Calculate next attempt time if rate limited - use the hint from shopify-upload
        const nextAttemptAt = rateLimited && retryAfterSeconds > 0
          ? new Date(Date.now() + Math.min(retryAfterSeconds * 1000, 10_000)).toISOString()
          : null;

        // ADAPTIVE BATCH SCALING: Scale UP after successful batches, DOWN on errors
        // This ensures maximum throughput while respecting Shopify limits
        let newBatchSize = effectiveBatchSize;
        const maxBatch = MAX_BATCH_SIZE[job.entity_type] || 50;
        const minBatch = MIN_BATCH_SIZE[job.entity_type] || 1;
        
        if (!rateLimited && result.errors === 0 && itemsAttempted > 0) {
          // Success! Consider scaling up if below max
          // Only scale up every 3 successful batches to avoid oscillation
          const successStreak = (job.current_batch % 3 === 0);
          if (successStreak && effectiveBatchSize < maxBatch) {
            newBatchSize = Math.min(maxBatch, Math.ceil(effectiveBatchSize * 1.25));
            console.log(`[WORKER] Scaling UP batch size: ${effectiveBatchSize} → ${newBatchSize}`);
          }
        }

        // Update job progress with ACTUAL batch speed
        const updateData: Record<string, any> = {
          processed_count: job.processed_count + itemsAttempted,
          error_count: job.error_count + (result.errors || 0),
          skipped_count: job.skipped_count + (result.skipped || 0),
          items_per_minute: itemsPerMinute,
          // NEW: Store actual batch metrics for accurate UI display
          last_batch_speed: batchItemsPerMinute,
          last_batch_items: itemsAttempted,
          last_batch_duration_ms: elapsed,
          next_attempt_at: nextAttemptAt,
          error_details: allErrors,
          last_heartbeat_at: new Date().toISOString(),
          current_batch: job.current_batch + 1,
          // Update batch size if changed
          ...(newBatchSize !== effectiveBatchSize ? { batch_size: newBatchSize } : {}),
        };

        // Check if this entity is complete
        // CRITICAL: Job completion is determined SOLELY by whether there are pending items left in the database
        // This ensures the progress bar reaches 100% before moving to next entity
        const hasMore = result.hasMore && !job.is_test_mode;
        const newProcessedCount = job.processed_count + itemsAttempted;
        
        // ALWAYS check actual pending count from database - this is the source of truth
        const tableName = `canonical_${job.entity_type}`;
        let pendingQuery = supabase
          .from(tableName)
          .select('*', { count: 'exact', head: true })
          .eq('project_id', job.project_id)
          .eq('status', 'pending');
        
        // Categories need exclude filter
        if (job.entity_type === 'categories') {
          pendingQuery = pendingQuery.eq('exclude', false);
        }
        
        const { count: actualPending } = await pendingQuery;
        
        // Get actual uploaded + failed count for accurate progress
        const { count: actualUploaded } = await supabase
          .from(tableName)
          .select('*', { count: 'exact', head: true })
          .eq('project_id', job.project_id)
          .eq('status', 'uploaded');
          
        const { count: actualFailed } = await supabase
          .from(tableName)
          .select('*', { count: 'exact', head: true })
          .eq('project_id', job.project_id)
          .eq('status', 'failed');
        
        const actualTotal = (actualPending || 0) + (actualUploaded || 0) + (actualFailed || 0);
        const actualProcessed = (actualUploaded || 0) + (actualFailed || 0);
        
        console.log(`[WORKER] job ${jobId} batchAttempted=${itemsAttempted} elapsedMs=${elapsed} hasMore=${hasMore} pending=${actualPending} uploaded=${actualUploaded} failed=${actualFailed}`);
        
        // Sync processed_count and total_count with actual database state
        updateData.processed_count = actualProcessed + (job.skipped_count || 0);
        updateData.total_count = actualTotal + (job.skipped_count || 0);
        
        // Job is ONLY complete when there are no more pending items (0 pending = 100% progress bar)
        if (actualPending === 0 || (!hasMore && job.is_test_mode)) {
          console.log(`[WORKER] Job ${jobId} completed: pending=0 (or test mode)`);
          updateData.status = 'completed';
          updateData.completed_at = new Date().toISOString();
        } else if (!hasMore && (actualPending || 0) > 0) {
          // shopify-upload says no more, but database shows pending items remain
          // This is a transient state - schedule another batch to pick up remaining items
          console.log(`[WORKER] Mismatch: hasMore=false but ${actualPending || 0} pending items remain. Scheduling retry.`);
        }

        await supabase
          .from('upload_jobs')
          .update(updateData)
          .eq('id', jobId);

        // If more work, schedule next batch
        if (hasMore) {
          const scheduleNext = async () => {
            // Delay to avoid hammering the API. If rate limited, wait longer.
            const delayMs = rateLimited && retryAfterSeconds > 0
              ? retryAfterSeconds * 1000
              : WORKER_SCHEDULE_DELAY_MS;
            await sleep(delayMs);
            const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
            await fetch(functionUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({ jobId, action: 'process' }),
            });
            console.log(`[WORKER] Scheduled next batch for job ${jobId}`);
          };

          const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil;
          if (typeof waitUntil === 'function') {
            waitUntil(scheduleNext());
          } else {
            scheduleNext().catch((e) => console.error('[WORKER] Failed to schedule next batch:', e));
          }
        } else {
          // This entity is done - check for next pending job to start (SEQUENTIAL PROCESSING)
          const { data: nextPendingJob } = await supabase
            .from('upload_jobs')
            .select('*')
            .eq('project_id', job.project_id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (nextPendingJob) {
            // Start the next job in sequence
            console.log(`[WORKER] Job ${job.entity_type} completed, starting next: ${nextPendingJob.entity_type}`);
            
            await supabase
              .from('upload_jobs')
              .update({ 
                status: 'running', 
                started_at: new Date().toISOString(),
                last_heartbeat_at: new Date().toISOString()
              })
              .eq('id', nextPendingJob.id);

            const startNext = async () => {
              await sleep(WORKER_SCHEDULE_DELAY_MS);
              const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
              await fetch(functionUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${supabaseServiceKey}`,
                },
                body: JSON.stringify({ jobId: nextPendingJob.id, action: 'process' }),
              });
              console.log(`[WORKER] Started next sequential job ${nextPendingJob.id} (${nextPendingJob.entity_type})`);
            };

            const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil;
            if (typeof waitUntil === 'function') {
              waitUntil(startNext());
            } else {
              startNext().catch((e) => console.error('[WORKER] Failed to start next job:', e));
            }
          } else {
            // No more pending jobs - check if ALL jobs are completed
            const { count: runningOrPending } = await supabase
              .from('upload_jobs')
              .select('*', { count: 'exact', head: true })
              .eq('project_id', job.project_id)
              .in('status', ['running', 'pending', 'paused']);

            if (!runningOrPending || runningOrPending === 0) {
              // All jobs completed - update project status
              console.log(`[WORKER] All jobs completed for project ${job.project_id}`);
              await supabase
                .from('projects')
                .update({ status: 'completed' })
                .eq('id', job.project_id);
            }
          }
        }

        return new Response(JSON.stringify({
          success: true,
          attempted: itemsAttempted,
          succeeded: itemsSucceeded,
          errors: result.errors || 0,
          hasMore,
          jobStatus: updateData.status || 'running',
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      case 'pause': {
        if (!jobId && !projectId) {
          throw new Error('jobId or projectId required for pause action');
        }

        const query = supabase
          .from('upload_jobs')
          .update({ status: 'paused' })
          .eq('status', 'running');

        if (jobId) {
          await query.eq('id', jobId);
        } else if (projectId) {
          await query.eq('project_id', projectId);
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Upload paused',
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      case 'resume': {
        if (!jobId && !projectId) {
          throw new Error('jobId or projectId required for resume action');
        }

        // Find ALL paused jobs to resume (not just the first one!)
        let query = supabase
          .from('upload_jobs')
          .select('*')
          .eq('status', 'paused');

        if (jobId) {
          query = query.eq('id', jobId);
        } else if (projectId) {
          query = query.eq('project_id', projectId);
        }

        const { data: pausedJobs } = await query;
        const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;

        if (pausedJobs && pausedJobs.length > 0) {
          console.log(`[WORKER] Resuming ${pausedJobs.length} paused jobs`);
          
          // Resume ALL paused jobs, not just the first one
          for (const jobToResume of pausedJobs) {
            await supabase
              .from('upload_jobs')
              .update({ 
                status: 'running',
                last_heartbeat_at: new Date().toISOString()
              })
              .eq('id', jobToResume.id);

            // Trigger processing for each job
            try {
              runInBackground(
                fetch(functionUrl, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${supabaseServiceKey}`,
                  },
                  body: JSON.stringify({ jobId: jobToResume.id, action: 'process' }),
                })
                  .then(() => console.log(`[WORKER] Resumed job ${jobToResume.id} (${jobToResume.entity_type})`))
                  .catch((e) => console.error(`[WORKER] Failed to trigger resume for job ${jobToResume.id}:`, e))
              );
            } catch (e) {
              console.error(`[WORKER] Failed to trigger resume for job ${jobToResume.id}:`, e);
            }
          }
        }

        return new Response(JSON.stringify({
          success: true,
          message: `Resumed ${pausedJobs?.length || 0} jobs`,
          resumedJobs: pausedJobs?.length || 0,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      case 'cancel': {
        if (!jobId && !projectId) {
          throw new Error('jobId or projectId required for cancel action');
        }

        const query = supabase
          .from('upload_jobs')
          .update({ 
            status: 'cancelled',
            completed_at: new Date().toISOString()
          })
          .in('status', ['pending', 'running', 'paused']);

        if (jobId) {
          await query.eq('id', jobId);
        } else if (projectId) {
          await query.eq('project_id', projectId);
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Upload cancelled',
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      case 'force-restart': {
        // Force restart a stuck job regardless of current status
        if (!jobId && !projectId) {
          throw new Error('jobId or projectId required for force-restart action');
        }

        // Find the job(s) to restart
        let query = supabase
          .from('upload_jobs')
          .select('*')
          .in('status', ['running', 'paused']);

        if (jobId) {
          query = query.eq('id', jobId);
        } else if (projectId) {
          query = query.eq('project_id', projectId);
        }

        const { data: jobsToRestart } = await query;
        const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
        const restartedIds: string[] = [];

        if (jobsToRestart && jobsToRestart.length > 0) {
          // If multiple jobs exist for the same entity_type, only restart the newest one.
          // Cancel the rest to prevent duplicate workers and rate-limit thrashing.
          const newestByEntity = new Map<string, any>();
          for (const j of jobsToRestart) {
            const key = String(j.entity_type);
            const existing = newestByEntity.get(key);
            if (!existing) {
              newestByEntity.set(key, j);
              continue;
            }
            const a = new Date(j.created_at).getTime();
            const b = new Date(existing.created_at).getTime();
            if (Number.isFinite(a) && Number.isFinite(b) ? a > b : j.created_at > existing.created_at) {
              newestByEntity.set(key, j);
            }
          }

          const jobsToActuallyRestart = Array.from(newestByEntity.values());
          const keepIds = new Set(jobsToActuallyRestart.map((j) => j.id));
          const cancelIds = jobsToRestart.filter((j) => !keepIds.has(j.id)).map((j) => j.id);

          if (cancelIds.length > 0) {
            console.log(`[WORKER] Cancelling ${cancelIds.length} superseded job(s) during force-restart`);
            await supabase
              .from('upload_jobs')
              .update({
                status: 'cancelled',
                completed_at: new Date().toISOString(),
                next_attempt_at: null,
              })
              .in('id', cancelIds);
          }

          for (const jobToRestart of jobsToActuallyRestart) {
            console.log(`[WORKER] Force restarting job ${jobToRestart.id} (${jobToRestart.entity_type})`);
            
            // Clear error details to reset rate limit counters
            await supabase
              .from('upload_jobs')
              .update({ 
                status: 'running',
                last_heartbeat_at: new Date().toISOString(),
                next_attempt_at: null,
                error_details: [], // Clear error history to reset backoff
              })
              .eq('id', jobToRestart.id);

            // Trigger processing
            runInBackground(
              fetch(functionUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${supabaseServiceKey}`,
                },
                body: JSON.stringify({ jobId: jobToRestart.id, action: 'process' }),
              })
                .then(() => console.log(`[WORKER] Force restarted job ${jobToRestart.id}`))
                .catch((e) => console.error(`[WORKER] Failed to force restart job ${jobToRestart.id}:`, e))
            );

            restartedIds.push(jobToRestart.id);
          }
        }

        return new Response(JSON.stringify({
          success: true,
          message: `Force restarted ${restartedIds.length} job(s)`,
          restartedJobs: restartedIds,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Upload worker error:', errorMessage);
    
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage,
    }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
