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

  try {
    const now = Date.now();
    const stallCutoff = new Date(now - STALL_THRESHOLD_MS).toISOString();

    // Find running jobs with stale heartbeat
    const { data: stalledJobs, error: queryError } = await supabase
      .from('upload_jobs')
      .select('*')
      .eq('status', 'running')
      .lt('last_heartbeat_at', stallCutoff);

    if (queryError) {
      throw queryError;
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
        })
        .eq('id', job.id);

      // Re-trigger the worker to process this job
      const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
      try {
        await fetch(functionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ jobId: job.id, action: 'process' }),
        });

        console.log(`[WATCHDOG] Successfully re-triggered job ${job.id}`);
        restartedJobs.push({
          id: job.id,
          entity_type: job.entity_type,
          stalled_for_minutes: stalledForMinutes,
        });
      } catch (triggerError) {
        console.error(`[WATCHDOG] Failed to re-trigger job ${job.id}:`, triggerError);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Restarted ${restartedJobs.length} stalled job(s)`,
      restarted_jobs: restartedJobs,
      checked_at: new Date().toISOString(),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[WATCHDOG] Error:', errorMessage);
    
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage,
    }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
