import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Stall threshold: 2 minutes without heartbeat
const STALL_THRESHOLD_MS = 2 * 60 * 1000;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const runInBackground = (task: Promise<unknown>) => {
    const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil;
    if (typeof waitUntil === 'function') {
      waitUntil(task);
      return;
    }
    task.catch((e) => console.error('[WATCHDOG] Background task failed:', e));
  };

  try {
    const now = Date.now();
    const stallCutoff = new Date(now - STALL_THRESHOLD_MS).toISOString();
    const nowIso = new Date(now).toISOString();

    // Retry helper for transient network errors
    const fetchWithRetry = async (retries = 3, delay = 500) => {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const { data, error } = await supabase
            .from('upload_jobs')
            .select('*')
            .eq('status', 'running')
            // Consider a job "stalled" either when:
            // 1) heartbeat is stale (classic stall)
            // 2) next_attempt_at is due (rate-limit backoff finished but no retrigger happened)
            .or(
              `last_heartbeat_at.lt.${stallCutoff},and(next_attempt_at.not.is.null,next_attempt_at.lte.${nowIso})`
            );
          
          if (error) throw error;
          return data;
        } catch (err) {
          const isTransient = err instanceof Error && 
            (err.message.includes('connection reset') || err.message.includes('SendRequest'));
          
          if (isTransient && attempt < retries) {
            console.log(`[WATCHDOG] Transient error on attempt ${attempt}, retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            delay *= 2; // Exponential backoff
          } else {
            throw err;
          }
        }
      }
      return null;
    };

    // Find running jobs with stale heartbeat
    let stalledJobs;
    try {
      stalledJobs = await fetchWithRetry();
    } catch (fetchError) {
      // Transient network errors are expected occasionally - don't fail the watchdog
      // The next scheduled run will try again
      const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      console.warn('[WATCHDOG] Could not fetch stalled jobs (will retry next run):', msg);
      return new Response(JSON.stringify({
        success: true,
        message: 'Skipped due to transient network error, will retry next run',
        warning: msg,
        checked_at: new Date().toISOString(),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (!stalledJobs || stalledJobs.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No stalled jobs found',
        checked_at: new Date().toISOString(),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const restartedJobs: Array<{ id: string; entity_type: string; stalled_for_minutes: number }> = [];

    for (const job of stalledJobs) {
      const lastHeartbeat = new Date(job.last_heartbeat_at).getTime();
      const stalledForMs = now - lastHeartbeat;
      const stalledForMinutes = Math.round(stalledForMs / 60000 * 10) / 10;

      console.log(`[WATCHDOG] Job ${job.id} (${job.entity_type}) stalled for ${stalledForMinutes} minutes. Restarting...`);

      // Update heartbeat to prevent immediate re-trigger
      await supabase
        .from('upload_jobs')
        .update({ 
          last_heartbeat_at: new Date().toISOString(),
          // If we are resuming from a scheduled retry, clear it so UI doesn't keep showing waiting.
          next_attempt_at: null,
        })
        .eq('id', job.id);

      // Re-trigger the worker to process this job.
      // IMPORTANT: fire-and-forget, otherwise the watchdog itself can timeout when a batch is slow.
      const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
      runInBackground(
        fetch(functionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ jobId: job.id, action: 'process' }),
        })
          .then(() => console.log(`[WATCHDOG] Re-triggered job ${job.id}`))
          .catch((triggerError) => console.error(`[WATCHDOG] Failed to re-trigger job ${job.id}:`, triggerError))
      );

      restartedJobs.push({
        id: job.id,
        entity_type: job.entity_type,
        stalled_for_minutes: stalledForMinutes,
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Restarted ${restartedJobs.length} stalled job(s)`,
      restarted_jobs: restartedJobs,
      checked_at: new Date().toISOString(),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'object' && error !== null) {
      errorMessage = JSON.stringify(error);
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    console.error('[WATCHDOG] Error:', errorMessage, error);
    
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage,
    }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
