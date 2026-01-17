import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const WORKER_SCHEDULE_DELAY_MS = 500;
const WORKER_RETRY_DELAY_MS = 5000;
const SHOPIFY_UPLOAD_TIMEOUT_MS = 240_000;

// Larger batches for better throughput - 25 items per batch = ~15-20s per batch at 80-100/min
// This reduces overhead from fetch/parse cycles while still updating UI frequently
const batchSizeForEntity = (entityType: string) => {
  switch (entityType) {
    case 'customers':
    case 'orders':
      return 25;
    case 'products':
      return 25;
    case 'pages':
    case 'categories':
      return 25;
    default:
      return 25;
  }
};

interface WorkerRequest {
  jobId?: string;
  projectId?: string;
  action: 'start' | 'process' | 'pause' | 'resume' | 'cancel' | 'status';
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

        // Start processing the first job immediately
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

          // Trigger processing (await so the request is actually sent before runtime shuts down)
          const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
          try {
            await fetch(functionUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({ jobId: firstJob.id, action: 'process' }),
            });
          } catch (e) {
            console.error('[WORKER] Failed to trigger initial processing:', e);
          }
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

        console.log(`[WORKER] Processing job ${job.id} (${job.entity_type}) batch=${job.current_batch} processed=${job.processed_count}/${job.total_count}`);

        // Check if job should continue
        if (job.status === 'cancelled' || job.status === 'paused') {
          return new Response(JSON.stringify({
            success: true,
            message: `Job is ${job.status}`,
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
              batchSize: job.batch_size,
            }),
            signal: controller.signal,
          });

          clearTimeout(timeout);

          const responseText = await response.text();
          
          // Try to parse as JSON, handle HTML error pages
          try {
            result = JSON.parse(responseText);
          } catch (parseError) {
            console.error('Failed to parse shopify-upload response:', responseText.substring(0, 200));
            throw new Error(`shopify-upload returned invalid JSON: ${responseText.substring(0, 100)}`);
          }
          
          if (!response.ok) {
            throw new Error(result.error || `shopify-upload failed with status ${response.status}`);
          }
        } catch (fetchError) {
          console.error('shopify-upload call failed:', fetchError);
          
          // Update job with error and retry after delay
          await supabase
            .from('upload_jobs')
            .update({
              last_heartbeat_at: new Date().toISOString(),
              error_count: job.error_count + 1,
            })
            .eq('id', jobId);
          
          // Retry after a short delay (do NOT use setTimeout; the runtime may shut down before it fires)
          await sleep(WORKER_RETRY_DELAY_MS);
          try {
            const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
            await fetch(functionUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({ jobId, action: 'process' }),
            });
            console.log(`[WORKER] Retrying job ${jobId} after error`);
          } catch (e) {
            console.error('[WORKER] Failed to retry after error:', e);
          }
          
          return new Response(JSON.stringify({
            success: false,
            error: fetchError instanceof Error ? fetchError.message : 'Unknown fetch error',
            retrying: true,
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const elapsed = Date.now() - startTime;
        const itemsProcessed = (result.processed || 0) + (result.skipped || 0);
        const batchItemsPerMinute = elapsed > 0 ? (itemsProcessed / (elapsed / 60000)) : 0;
        
        // Calculate rolling average speed (weighted: 70% previous, 30% current batch)
        // This gives a smoother, more accurate representation of speed
        let itemsPerMinute = batchItemsPerMinute;
        if (job.items_per_minute && job.items_per_minute > 0 && batchItemsPerMinute > 0) {
          itemsPerMinute = job.items_per_minute * 0.7 + batchItemsPerMinute * 0.3;
        } else if (batchItemsPerMinute === 0 && job.items_per_minute) {
          itemsPerMinute = job.items_per_minute; // Keep previous if batch had no items
        }

        // Merge error details
        const existingErrors = job.error_details || [];
        const newErrors = result.errorDetails || [];
        const allErrors = [...existingErrors, ...newErrors].slice(-100); // Keep last 100

        // Update job progress
        const updateData: Record<string, any> = {
          processed_count: job.processed_count + itemsProcessed,
          error_count: job.error_count + (result.errors || 0),
          skipped_count: job.skipped_count + (result.skipped || 0),
          items_per_minute: itemsPerMinute > 0 ? itemsPerMinute : job.items_per_minute,
          error_details: allErrors,
          last_heartbeat_at: new Date().toISOString(),
          current_batch: job.current_batch + 1,
        };

        // Check if this entity is complete
        const hasMore = result.hasMore && !job.is_test_mode;
        console.log(`[WORKER] job ${jobId} batchProcessed=${itemsProcessed} elapsedMs=${elapsed} hasMore=${hasMore}`);
        if (!hasMore) {
          updateData.status = 'completed';
          updateData.completed_at = new Date().toISOString();
        }

        await supabase
          .from('upload_jobs')
          .update(updateData)
          .eq('id', jobId);

        // If more work, schedule next batch
        if (hasMore) {
          // Small delay to avoid hammering the API
          await sleep(WORKER_SCHEDULE_DELAY_MS);
          try {
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
          } catch (e) {
            console.error('[WORKER] Failed to schedule next batch:', e);
          }
        } else {
          // Check for next entity to process
          const { data: nextJob } = await supabase
            .from('upload_jobs')
            .select('*')
            .eq('project_id', job.project_id)
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(1)
            .single();

          if (nextJob) {
            // Start next entity
            await supabase
              .from('upload_jobs')
              .update({ 
                status: 'running', 
                started_at: new Date().toISOString(),
                last_heartbeat_at: new Date().toISOString()
              })
              .eq('id', nextJob.id);

            await sleep(WORKER_SCHEDULE_DELAY_MS);
            try {
              const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
              await fetch(functionUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${supabaseServiceKey}`,
                },
                body: JSON.stringify({ jobId: nextJob.id, action: 'process' }),
              });
              console.log(`[WORKER] Started next entity job ${nextJob.id} (${nextJob.entity_type})`);
            } catch (e) {
              console.error('[WORKER] Failed to start next entity:', e);
            }
          } else {
            // All done - update project status
            await supabase
              .from('projects')
              .update({ status: 'completed' })
              .eq('id', job.project_id);
          }
        }

        return new Response(JSON.stringify({
          success: true,
          processed: itemsProcessed,
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

        // Find paused job(s) to resume
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

        if (pausedJobs && pausedJobs.length > 0) {
          const jobToResume = pausedJobs[0];
          
          await supabase
            .from('upload_jobs')
            .update({ 
              status: 'running',
              last_heartbeat_at: new Date().toISOString()
            })
            .eq('id', jobToResume.id);

          // Trigger processing (await so it doesn't get dropped on shutdown)
          const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
          try {
            await fetch(functionUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({ jobId: jobToResume.id, action: 'process' }),
            });
            console.log(`[WORKER] Resumed job ${jobToResume.id}`);
          } catch (e) {
            console.error('[WORKER] Failed to trigger resume processing:', e);
          }
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Upload resumed',
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

      case 'status': {
        if (!projectId) {
          throw new Error('projectId required for status action');
        }

        const { data: jobs } = await supabase
          .from('upload_jobs')
          .select('*')
          .eq('project_id', projectId)
          .order('created_at', { ascending: true });

        return new Response(JSON.stringify({
          success: true,
          jobs: jobs || [],
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
