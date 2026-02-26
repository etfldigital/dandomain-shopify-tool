import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Stall threshold: 30 seconds without heartbeat
const STALL_THRESHOLD_MS = 30 * 1000;

// Minimum interval between watchdog executions (database-enforced)
const MIN_EXECUTION_INTERVAL_MS = 8_000;

// Self-scheduling interval (watchdog IS the scheduler for orders)
const SELF_SCHEDULE_INTERVAL_MS = 8_000;

Deno.serve(async (req) => {
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
    // ============================================================================
    // ATOMIC THROTTLE GUARD: Only execute if 25+ seconds since last execution.
    // Uses atomic compare-and-swap to prevent race conditions where multiple
    // concurrent invocations all pass the check simultaneously.
    // ============================================================================
    const cutoffTime = new Date(Date.now() - MIN_EXECUTION_INTERVAL_MS).toISOString();
    const nowIso = new Date().toISOString();
    
    // Atomic CAS: update only if last_execution_at is old enough
    const { data: lockResult } = await supabase
      .from('watchdog_state')
      .update({ last_execution_at: nowIso })
      .eq('id', 'singleton')
      .lt('last_execution_at', cutoffTime)
      .select('id');

    if (!lockResult || lockResult.length === 0) {
      // Another invocation already claimed this window — exit without self-scheduling
      return new Response(JSON.stringify({
        success: true,
        message: 'Throttled: another watchdog instance is handling this window',
        throttled: true,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    // ============================================================================

    const now = Date.now();
    const currentIso = new Date().toISOString();
    const stallCutoff = new Date(now - STALL_THRESHOLD_MS).toISOString();

    // ============================================================================
    // 1. READY JOBS: trigger jobs where next_attempt_at <= now (DB-driven scheduling)
    //    These are jobs that completed a batch and are waiting for the watchdog
    //    to trigger the next batch. The worker_lock_id is still set (valid mutex).
    // ============================================================================
    const { data: readyJobs } = await supabase
      .from('upload_jobs')
      .select('id, entity_type, next_attempt_at')
      .eq('status', 'running')
      .not('next_attempt_at', 'is', null)
      .lte('next_attempt_at', currentIso);

    const triggeredJobs: string[] = [];
    for (const rj of (readyJobs || [])) {
      console.log(`[WATCHDOG] Triggering ready job ${rj.id} (${rj.entity_type}), next_attempt_at was ${rj.next_attempt_at}`);
      
      // Clear next_attempt_at so we don't double-trigger
      await supabase
        .from('upload_jobs')
        .update({ next_attempt_at: null, last_heartbeat_at: currentIso })
        .eq('id', rj.id);

      // Fire upload-worker
      const functionUrl = `${supabaseUrl}/functions/v1/upload-worker`;
      runInBackground(
        fetch(functionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ jobId: rj.id, action: 'process' }),
        })
          .then(() => console.log(`[WATCHDOG] Triggered ready job ${rj.id}`))
          .catch((e) => console.error(`[WATCHDOG] Failed to trigger ready job ${rj.id}:`, e))
      );
      triggeredJobs.push(rj.id);
    }

    // ============================================================================
    // 2. STALLED JOBS: find running jobs that are genuinely stuck
    // ============================================================================

    // Find running jobs that are ACTUALLY stalled:
    // Both conditions must be true:
    // 1. last_heartbeat_at is older than 30 seconds (genuinely stuck)
    // 2. worker_lock_id IS NULL (no active worker holds the mutex)
    // If a lock is held, the worker is still active — don't interfere.
    const { data: stalledJobs, error: fetchError } = await supabase
      .from('upload_jobs')
      .select('*')
      .eq('status', 'running')
      .lt('last_heartbeat_at', stallCutoff)
      .is('worker_lock_id', null)
      .is('next_attempt_at', null);  // Don't stall-check jobs waiting for next_attempt_at

    if (fetchError) {
      console.warn('[WATCHDOG] Could not fetch stalled jobs:', fetchError.message);
      selfSchedule(supabaseUrl, supabaseServiceKey, runInBackground);
      return new Response(JSON.stringify({
        success: true,
        message: 'Skipped due to query error, will retry',
        warning: fetchError.message,
        triggered: triggeredJobs,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Also find jobs where the mutex lock has EXPIRED (worker crashed while holding lock)
    const { data: expiredLockJobs } = await supabase
      .from('upload_jobs')
      .select('*')
      .eq('status', 'running')
      .lt('last_heartbeat_at', stallCutoff)
      .not('worker_lock_id', 'is', null)
      .lt('worker_locked_until', new Date().toISOString())
      .is('next_attempt_at', null);

    // Merge and deduplicate
    const allStalled = [...(stalledJobs || [])];
    const seenIds = new Set(allStalled.map(j => j.id));
    for (const j of (expiredLockJobs || [])) {
      if (!seenIds.has(j.id)) allStalled.push(j);
    }

    // ============================================================================
    // SELF-SCHEDULING: Check if there are ANY active jobs.
    // If yes, re-invoke this watchdog after a delay.
    // ============================================================================
    const { data: activeJobs } = await supabase
      .from('upload_jobs')
      .select('id')
      .in('status', ['running', 'pending', 'paused'])
      .limit(1);

    const hasActiveJobs = activeJobs && activeJobs.length > 0;

    if (hasActiveJobs) {
      selfSchedule(supabaseUrl, supabaseServiceKey, runInBackground);
    } else {
      console.log('[WATCHDOG] No active jobs, stopping self-scheduling loop');
    }
    // ============================================================================

    if ((!allStalled || allStalled.length === 0) && triggeredJobs.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No stalled or ready jobs found',
        checked_at: new Date().toISOString(),
        selfScheduled: hasActiveJobs,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (!allStalled || allStalled.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: `Triggered ${triggeredJobs.length} ready job(s), no stalled jobs`,
        triggered: triggeredJobs,
        checked_at: new Date().toISOString(),
        selfScheduled: hasActiveJobs,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const restartedJobs: Array<{ id: string; entity_type: string; stalled_for_minutes: number }> = [];

    for (const job of allStalled) {
      // ========== HARD STOP CHECK ==========
      const { data: projectCheck } = await supabase
        .from('projects')
        .select('uploads_paused')
        .eq('id', job.project_id)
        .single();

      if (projectCheck?.uploads_paused === true) {
        console.log(`[WATCHDOG] Skipping job ${job.id} - project has uploads_paused=true`);
        continue;
      }
      // =====================================

      const lastHeartbeat = new Date(job.last_heartbeat_at).getTime();
      const stalledForMs = now - lastHeartbeat;
      const stalledForMinutes = Math.round(stalledForMs / 60000 * 10) / 10;

      console.log(`[WATCHDOG] Job ${job.id} (${job.entity_type}) stalled for ${stalledForMinutes} minutes. Restarting...`);

      // Update heartbeat and clear expired lock
      const restartUpdate: Record<string, any> = {
        last_heartbeat_at: new Date().toISOString(),
        next_attempt_at: null,
        worker_lock_id: null,
        worker_locked_until: null,
      };
      await supabase
        .from('upload_jobs')
        .update(restartUpdate)
        .eq('id', job.id);

      // Re-trigger the worker (fire-and-forget)
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
      message: `Restarted ${restartedJobs.length} stalled job(s), triggered ${triggeredJobs.length} ready job(s)`,
      restarted_jobs: restartedJobs,
      triggered: triggeredJobs,
      checked_at: new Date().toISOString(),
      selfScheduled: hasActiveJobs,
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

/**
 * Self-schedule: After a delay, re-invoke this watchdog function.
 */
function selfSchedule(
  supabaseUrl: string,
  supabaseServiceKey: string,
  runInBackground: (task: Promise<unknown>) => void
) {
  runInBackground((async () => {
    await new Promise(r => setTimeout(r, SELF_SCHEDULE_INTERVAL_MS));
    try {
      await fetch(`${supabaseUrl}/functions/v1/job-watchdog`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({ source: 'self-schedule' }),
      });
      console.log('[WATCHDOG] Self-scheduled next run');
    } catch (e) {
      console.error('[WATCHDOG] Failed to self-schedule:', e);
    }
  })());
}
