import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Shopify rate limiting: 2 requests per second for REST API
const RATE_LIMIT_DELAY_MS = 550;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface CreateRedirectsRequest {
  projectId: string;
  redirectIds?: string[];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { projectId, redirectIds } = (await req.json()) as CreateRedirectsRequest;

    if (!projectId) {
      return new Response(
        JSON.stringify({ error: 'Missing projectId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Creating redirects for project ${projectId}`);

    // Get project with Shopify credentials
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      console.error('Project not found:', projectError);
      return new Response(
        JSON.stringify({ error: 'Project not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!project.shopify_store_domain || !project.shopify_access_token_encrypted) {
      return new Response(
        JSON.stringify({ error: 'Shopify not connected' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const shopifyDomain = project.shopify_store_domain;
    const shopifyToken = project.shopify_access_token_encrypted;

    // Get redirects to create - build query carefully
    let query = supabase
      .from('project_redirects')
      .select('*')
      .eq('project_id', projectId)
      .eq('status', 'pending');

    // Only add .in() filter if we have specific IDs
    if (redirectIds && Array.isArray(redirectIds) && redirectIds.length > 0) {
      query = query.in('id', redirectIds);
    }

    // Apply order and limit last
    const { data: redirects, error: redirectsError } = await query
      .order('created_at', { ascending: true })
      .limit(100);

    if (redirectsError) {
      console.error('Error fetching redirects:', JSON.stringify(redirectsError));
      return new Response(
        JSON.stringify({ error: 'Failed to fetch redirects', details: redirectsError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!redirects || redirects.length === 0) {
      return new Response(
        JSON.stringify({ success: true, created: 0, failed: 0, message: 'No pending redirects' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing ${redirects.length} redirects`);

    let created = 0;
    let failed = 0;

    for (const redirect of redirects) {
      try {
        // Create redirect in Shopify
        const response = await fetch(
          `https://${shopifyDomain}/admin/api/2024-01/redirects.json`,
          {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': shopifyToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              redirect: {
                path: redirect.old_path,
                target: redirect.new_path,
              },
            }),
          }
        );

        const responseText = await response.text();
        let responseData;
        try {
          responseData = JSON.parse(responseText);
        } catch {
          responseData = { raw: responseText };
        }

        if (response.ok && responseData.redirect) {
          // Success
          await supabase
            .from('project_redirects')
            .update({
              status: 'created',
              shopify_redirect_id: String(responseData.redirect.id),
              error_message: null,
            })
            .eq('id', redirect.id);

          created++;
          console.log(`Created redirect: ${redirect.old_path} -> ${redirect.new_path}`);
        } else if (response.status === 422 && responseText.includes('already exists')) {
          // Redirect already exists - mark as created
          await supabase
            .from('project_redirects')
            .update({
              status: 'created',
              error_message: 'Redirect eksisterede allerede',
            })
            .eq('id', redirect.id);

          created++;
          console.log(`Redirect already exists: ${redirect.old_path}`);
        } else {
          // Failed
          const errorMessage = responseData.errors 
            ? (typeof responseData.errors === 'string' ? responseData.errors : JSON.stringify(responseData.errors))
            : `HTTP ${response.status}`;

          await supabase
            .from('project_redirects')
            .update({
              status: 'failed',
              error_message: errorMessage.substring(0, 500),
            })
            .eq('id', redirect.id);

          failed++;
          console.error(`Failed to create redirect: ${redirect.old_path}`, errorMessage);
        }

        // Rate limiting
        await sleep(RATE_LIMIT_DELAY_MS);

      } catch (err) {
        console.error(`Error processing redirect ${redirect.id}:`, err);
        
        await supabase
          .from('project_redirects')
          .update({
            status: 'failed',
            error_message: err instanceof Error ? err.message : 'Unknown error',
          })
          .eq('id', redirect.id);

        failed++;
      }
    }

    console.log(`Completed: ${created} created, ${failed} failed`);

    return new Response(
      JSON.stringify({
        success: true,
        created,
        failed,
        hasMore: redirects.length === 100,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in create-redirects:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
