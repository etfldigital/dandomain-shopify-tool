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

    // Build the filter based on resetScope
    let statusFilter: string[] = [];
    if (resetScope === 'all') {
      statusFilter = ['pending', 'mapped', 'uploaded', 'failed'];
    } else if (resetScope === 'failed') {
      statusFilter = ['failed'];
    } else if (resetScope === 'uploaded') {
      statusFilter = ['uploaded'];
    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid resetScope. Must be: all, failed, or uploaded' }),
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
