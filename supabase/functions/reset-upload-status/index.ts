import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, entityType, resetScope, recordIds, externalIds } = await req.json();

    if (!projectId || !entityType || !resetScope) {
      return new Response(
        JSON.stringify({ error: 'Missing required parameters: projectId, entityType, resetScope' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // IMPORTANT: Stop any active upload job for this entity before resetting records.
    // Otherwise a background worker/watchdog may keep running and immediately re-upload items
    // the user just reset to pending.
    try {
      const { data: activeJobs, error: activeJobsError } = await supabase
        .from('upload_jobs')
        .select('id, status')
        .eq('project_id', projectId)
        .eq('entity_type', entityType)
        .in('status', ['pending', 'running', 'paused']);

      if (activeJobsError) {
        console.warn('[RESET] Could not fetch active upload jobs to cancel:', activeJobsError);
      } else if (activeJobs && activeJobs.length > 0) {
        const ids = activeJobs.map(j => j.id);
        console.log(`[RESET] Cancelling ${ids.length} active upload job(s) for ${entityType} before resetting records`);
        await supabase
          .from('upload_jobs')
          .update({
            status: 'cancelled',
            completed_at: new Date().toISOString(),
            next_attempt_at: null,
            last_heartbeat_at: null,
            updated_at: new Date().toISOString(),
          })
          .in('id', ids);
      }
    } catch (e) {
      console.warn('[RESET] Failed while cancelling active jobs (continuing reset anyway):', e);
    }

    // Build the filter based on resetScope
    // 'skipped' is a special scope that targets uploaded items with a "Sprunget over" error_message
    let statusFilter: string[] = [];
    let requiresSkippedFilter = false;
    
    if (resetScope === 'all') {
      statusFilter = ['pending', 'mapped', 'uploaded', 'failed'];
    } else if (resetScope === 'failed') {
      statusFilter = ['failed'];
    } else if (resetScope === 'uploaded') {
      statusFilter = ['uploaded'];
    } else if (resetScope === 'skipped') {
      // Skipped items have status 'uploaded' but with a skip error message
      statusFilter = ['uploaded'];
      requiresSkippedFilter = true;
    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid resetScope. Must be: all, failed, uploaded, or skipped' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Determine the table and update query based on entity type
    let tableName: string;
    let updateData: Record<string, any> = {
      status: 'pending',
      error_message: null,
      updated_at: new Date().toISOString(),
    };

    switch (entityType) {
      case 'products':
        tableName = 'canonical_products';
        updateData.shopify_id = null;
        break;
      case 'customers':
        tableName = 'canonical_customers';
        updateData.shopify_id = null;
        break;
      case 'orders':
        tableName = 'canonical_orders';
        updateData.shopify_id = null;
        break;
      case 'categories':
        tableName = 'canonical_categories';
        updateData.shopify_collection_id = null;
        break;
      case 'pages':
        tableName = 'canonical_pages';
        updateData.shopify_id = null;
        break;
      default:
        return new Response(
          JSON.stringify({ error: 'Invalid entityType' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

    // Build the update query with count
    let updateQuery = supabase
      .from(tableName)
      .update(updateData, { count: 'exact' })
      .eq('project_id', projectId)
      .in('status', statusFilter);

    // If targeting skipped items specifically, filter by error message pattern
    if (requiresSkippedFilter) {
      updateQuery = updateQuery.like('error_message', 'Sprunget over%');
      console.log(`Filtering for skipped items (error_message LIKE 'Sprunget over%')`);
    }

    // If specific recordIds are provided, filter by them (preferred because they are short UUIDs)
    if (recordIds && Array.isArray(recordIds) && recordIds.length > 0) {
      console.log(`Filtering by ${recordIds.length} specific record IDs`);
      updateQuery = updateQuery.in('id', recordIds);
    } else if (externalIds && Array.isArray(externalIds) && externalIds.length > 0) {
      // Backwards compatibility: externalIds can be extremely long (e.g. CSV rows) and may hit URL limits.
      console.log(`Filtering by ${externalIds.length} specific external IDs`);
      updateQuery = updateQuery.in('external_id', externalIds);
    }

    // Perform the update and get count
    const { count: affectedCount, error: updateError } = await updateQuery;

    if (updateError) {
      console.error('Update error:', updateError);
      return new Response(
        JSON.stringify({ error: updateError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Reset ${affectedCount} ${entityType} to pending for project ${projectId}`);

    // IMPORTANT: Clear cached counters on the latest upload job so UI starts fresh at 0.
    // This applies to ALL entity types and ALL reset scopes to ensure consistent behavior.
    try {
      const { data: latestJob, error: latestJobError } = await supabase
        .from('upload_jobs')
        .select('id, status, skipped_count, processed_count, error_count')
        .eq('project_id', projectId)
        .eq('entity_type', entityType)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestJobError) {
        console.warn('[RESET] Could not fetch latest upload job:', latestJobError);
      } else if (latestJob) {
        const { error: jobUpdateError } = await supabase
          .from('upload_jobs')
          .update(
            {
              skipped_count: 0,
              processed_count: 0,
              error_count: 0,
              error_details: null,
              // IMPORTANT: Do NOT leave a job in 'pending' after a reset.
              // A pending job can be picked up by background scheduling and look like it "auto-starts".
              // If the latest job was pending, mark it cancelled and clear scheduling timestamps.
              ...(latestJob.status === 'pending'
                ? {
                    status: 'cancelled',
                    current_batch: 0,
                    next_attempt_at: null,
                    last_heartbeat_at: null,
                    started_at: null,
                    completed_at: new Date().toISOString(),
                  }
                : {}),
              updated_at: new Date().toISOString(),
            },
            { count: 'exact' }
          )
          .eq('id', latestJob.id);

        if (jobUpdateError) {
          console.warn('[RESET] Could not reset latest upload job counters:', jobUpdateError);
        } else {
          console.log(`[RESET] Cleared all counters on latest ${entityType} upload job (${latestJob.id})`);
        }
      }
    } catch (e) {
      console.warn('[RESET] Unexpected error while clearing job counters:', e);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        resetCount: affectedCount || 0,
        entityType,
        resetScope,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
