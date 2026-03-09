import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
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

    // ========== HARD STOP: Set uploads_paused=true ==========
    await supabase
      .from('projects')
      .update({ uploads_paused: true, updated_at: new Date().toISOString() })
      .eq('id', projectId);
    console.log(`[RESET] Set uploads_paused=true for project ${projectId}`);

    // Cancel active upload jobs
    try {
      const { data: activeJobs } = await supabase
        .from('upload_jobs')
        .select('id')
        .eq('project_id', projectId)
        .eq('entity_type', entityType)
        .in('status', ['pending', 'running', 'paused']);

      if (activeJobs && activeJobs.length > 0) {
        const ids = activeJobs.map(j => j.id);
        console.log(`[RESET] Cancelling ${ids.length} active upload job(s)`);
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
      console.warn('[RESET] Failed cancelling active jobs:', e);
    }

    // Determine status filter
    let statusFilter: string[] = [];
    let requiresSkippedFilter = false;

    if (resetScope === 'all') {
      statusFilter = ['pending', 'mapped', 'uploaded', 'failed'];
    } else if (resetScope === 'failed') {
      statusFilter = ['failed'];
    } else if (resetScope === 'uploaded') {
      statusFilter = ['uploaded'];
    } else if (resetScope === 'skipped') {
      statusFilter = ['uploaded'];
      requiresSkippedFilter = true;
    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid resetScope. Must be: all, failed, uploaded, or skipped' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Determine table name and update data
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

    // ========== BATCHED RESET ==========
    // Instead of one massive UPDATE, fetch IDs first then update in batches of 500
    const BATCH_SIZE = 500;
    let totalAffected = 0;

    // If specific recordIds provided, use those directly
    if (recordIds && Array.isArray(recordIds) && recordIds.length > 0) {
      // Update in batches
      for (let i = 0; i < recordIds.length; i += BATCH_SIZE) {
        const batch = recordIds.slice(i, i + BATCH_SIZE);
        const { count } = await supabase
          .from(tableName)
          .update(updateData, { count: 'exact' })
          .eq('project_id', projectId)
          .in('id', batch);
        totalAffected += count || 0;
      }
    } else if (externalIds && Array.isArray(externalIds) && externalIds.length > 0) {
      for (let i = 0; i < externalIds.length; i += BATCH_SIZE) {
        const batch = externalIds.slice(i, i + BATCH_SIZE);
        const { count } = await supabase
          .from(tableName)
          .update(updateData, { count: 'exact' })
          .eq('project_id', projectId)
          .in('status', statusFilter)
          .in('external_id', batch);
        totalAffected += count || 0;
      }
    } else {
      // No specific IDs — fetch matching IDs first, then update in batches
      let allIds: string[] = [];
      let offset = 0;
      const FETCH_SIZE = 1000;

      while (true) {
        let query = supabase
          .from(tableName)
          .select('id')
          .eq('project_id', projectId)
          .in('status', statusFilter)
          .range(offset, offset + FETCH_SIZE - 1);

        if (requiresSkippedFilter) {
          query = query.like('error_message', 'Sprunget over%');
        }

        const { data: rows, error: fetchErr } = await query;
        if (fetchErr) {
          console.error('[RESET] Error fetching IDs:', fetchErr);
          break;
        }
        if (!rows || rows.length === 0) break;

        allIds = allIds.concat(rows.map(r => r.id));
        offset += FETCH_SIZE;
        if (rows.length < FETCH_SIZE) break;
      }

      console.log(`[RESET] Found ${allIds.length} records to reset`);

      // Update in batches
      for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
        const batch = allIds.slice(i, i + BATCH_SIZE);
        const { count, error: updateErr } = await supabase
          .from(tableName)
          .update(updateData, { count: 'exact' })
          .in('id', batch);

        if (updateErr) {
          console.error(`[RESET] Batch update error at offset ${i}:`, updateErr);
        }
        totalAffected += count || 0;
      }
    }

    console.log(`[RESET] Reset ${totalAffected} ${entityType} to pending for project ${projectId}`);

    // Clear cached counters on latest upload job
    try {
      const { data: latestJob } = await supabase
        .from('upload_jobs')
        .select('id, status')
        .eq('project_id', projectId)
        .eq('entity_type', entityType)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestJob) {
        await supabase
          .from('upload_jobs')
          .update({
            skipped_count: 0,
            processed_count: 0,
            error_count: 0,
            error_details: null,
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
          })
          .eq('id', latestJob.id);
        console.log(`[RESET] Cleared counters on latest ${entityType} upload job (${latestJob.id})`);
      }
    } catch (e) {
      console.warn('[RESET] Error clearing job counters:', e);
    }

    return new Response(
      JSON.stringify({
        success: true,
        resetCount: totalAffected,
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
