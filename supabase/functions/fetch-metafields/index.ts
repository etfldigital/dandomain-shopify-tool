import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface MetafieldDefinition {
  namespace: string;
  key: string;
  name: string;
  type: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId } = await req.json();
    
    if (!projectId) {
      return new Response(
        JSON.stringify({ error: 'projectId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get project with Shopify credentials
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('shopify_store_domain, shopify_access_token_encrypted')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return new Response(
        JSON.stringify({ error: 'Project not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { shopify_store_domain, shopify_access_token_encrypted } = project;

    if (!shopify_store_domain || !shopify_access_token_encrypted) {
      return new Response(
        JSON.stringify({ error: 'Shopify not connected' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Use GraphQL to fetch metafield definitions for products
    const graphqlUrl = `https://${shopify_store_domain}/admin/api/2025-01/graphql.json`;
    
    const query = `
      query {
        metafieldDefinitions(ownerType: PRODUCT, first: 50) {
          edges {
            node {
              namespace
              key
              name
              type {
                name
              }
            }
          }
        }
      }
    `;

    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': shopify_access_token_encrypted,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Shopify GraphQL error:', errorText);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch metafields from Shopify', details: errorText }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = await response.json();
    
    if (result.errors) {
      console.error('GraphQL errors:', result.errors);
      return new Response(
        JSON.stringify({ error: 'GraphQL query failed', details: result.errors }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const metafields: MetafieldDefinition[] = result.data?.metafieldDefinitions?.edges?.map(
      (edge: any) => ({
        namespace: edge.node.namespace,
        key: edge.node.key,
        name: edge.node.name,
        type: edge.node.type?.name || 'single_line_text_field',
      })
    ) || [];

    console.log(`Found ${metafields.length} metafield definitions for project ${projectId}`);

    return new Response(
      JSON.stringify({ metafields }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error fetching metafields:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
