import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

interface WorkerRequest {
  jobId?: string;
  projectId?: string;
  action: 'start' | 'process' | 'pause' | 'resume' | 'cancel' | 'force-restart';
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
        if (!projectId) throw new Error('projectId required');

        // Cancel existing jobs
        await supabase
          .from('upload_jobs')
          .update({ status: 'cancelled', completed_at: new Date().toISOString() })
          .eq('project_id', projectId)
          .in('status', ['pending', 'running', 'paused']);

        const entitiesToProcess = entityTypes || ['pages', 'categories', 'products', 'customers', 'orders'];
        const jobs = [];

        for (const entityType of entitiesToProcess) {
          const tableName = `canonical_${entityType}`;
          
          let pendingQuery = supabase
            .from(tableName)
            .select('*', { count: 'exact', head: true })
            .eq('project_id', projectId)
            .eq('status', 'pending');
          
          if (entityType === 'categories') {
            pendingQuery = pendingQuery.eq('exclude', false);
          }
          
          const { count: pendingCount } = await pendingQuery;
          
          const { count: uploadedCount } = await supabase
            .from(tableName)
            .select('*', { count: 'exact', head: true })
            .eq('project_id', projectId)
            .eq('status', 'uploaded');

          const { count: failedCount } = await supabase
            .from(tableName)
            .select('*', { count: 'exact', head: true })
            .eq('project_id', projectId)
            .eq('status', 'failed');

          const totalCount = (pendingCount || 0) + (uploadedCount || 0) + (failedCount || 0);
          const alreadyProcessedCount = (uploadedCount || 0) + (failedCount || 0);
          
          console.log(`[WORKER] ${entityType}: pending=${pendingCount}, uploaded=${uploadedCount}, failed=${failedCount}`);
          
          if (pendingCount && pendingCount > 0) {
            const batchSize = isTestMode ? 3 : (DEFAULT_BATCH_SIZE[entityType] || 10);
            
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

        console.log(`[WORKER] Processing ${job.entity_type} (${job.processed_count}/${job.total_count})`);

        if (job.status === 'cancelled' || job.status === 'paused') {
          return new Response(JSON.stringify({ success: true, message: `Job is ${job.status}` }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }

        // If scheduled retry is in future, wait
        if (job.next_attempt_at) {
          const waitMs = new Date(job.next_attempt_at).getTime() - Date.now();
          if (waitMs > 500) {
            await supabase
              .from('upload_jobs')
              .update({ last_heartbeat_at: new Date().toISOString() })
              .eq('id', jobId);

            runInBackground((async () => {
              await sleep(waitMs);
              const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
              await fetch(functionUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
                body: JSON.stringify({ jobId, action: 'process' }),
              });
            })());

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

        // One-time product preparation (grouping/variant extraction) before first product batch
        if (job.entity_type === 'products' && (job.current_batch || 0) === 0) {
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

        // Get actual database counts
        const tableName = `canonical_${job.entity_type}`;
        let pendingQuery = supabase
          .from(tableName)
          .select('*', { count: 'exact', head: true })
          .eq('project_id', job.project_id)
          .eq('status', 'pending');
        
        if (job.entity_type === 'categories') {
          pendingQuery = pendingQuery.eq('exclude', false);
        }
        
        const { count: actualPending } = await pendingQuery;
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
          current_batch: job.current_batch + 1,
        };

        // Handle rate limiting
        if (result.rateLimited && result.retryAfterSeconds) {
          const retryMs = Math.min(result.retryAfterSeconds * 1000, 10000);
          updateData.next_attempt_at = new Date(Date.now() + retryMs).toISOString();
          console.log(`[WORKER] Rate limited, waiting ${Math.ceil(retryMs/1000)}s`);
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
          const delayMs = result.rateLimited && result.retryAfterSeconds 
            ? Math.min(result.retryAfterSeconds * 1000, 10000)
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
          const { data: nextJobs } = await supabase
            .from('upload_jobs')
            .select('*')
            .eq('project_id', job.project_id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(1);

          if (nextJobs && nextJobs.length > 0) {
            const nextJob = nextJobs[0];
            
            await supabase
              .from('upload_jobs')
              .update({ 
                status: 'running', 
                started_at: new Date().toISOString(),
                last_heartbeat_at: new Date().toISOString()
              })
              .eq('id', nextJob.id);

            runInBackground((async () => {
              await sleep(WORKER_SCHEDULE_DELAY_MS);
              const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
              await fetch(functionUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
                body: JSON.stringify({ jobId: nextJob.id, action: 'process' }),
              });
              console.log(`[WORKER] Started next job: ${nextJob.entity_type}`);
            })());
          } else {
            // All done - update project status
            await supabase.from('projects').update({ status: 'ready' }).eq('id', job.project_id);
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
