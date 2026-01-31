import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface CreateMetafieldRequest {
  projectId: string;
  name: string;
  namespace: string;
  key: string;
  type: string;
  ownerType: 'PRODUCT' | 'VARIANT' | 'CUSTOMER' | 'ORDER';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, name, namespace, key, type, ownerType = 'PRODUCT' }: CreateMetafieldRequest = await req.json();
    
    if (!projectId || !name || !namespace || !key || !type) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: projectId, name, namespace, key, type' }),
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
      console.error('Project not found:', projectError);
      return new Response(
        JSON.stringify({ error: 'Project not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { shopify_store_domain, shopify_access_token_encrypted } = project;

    if (!shopify_store_domain || !shopify_access_token_encrypted) {
      return new Response(
        JSON.stringify({ error: 'Shopify not connected to this project' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // GraphQL mutation to create metafield definition
    const graphqlUrl = `https://${shopify_store_domain}/admin/api/2024-01/graphql.json`;
    
    const mutation = `
      mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            id
            namespace
            key
            name
            type {
              name
            }
            ownerType
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const variables = {
      definition: {
        name,
        namespace,
        key,
        type,
        ownerType,
      },
    };

    console.log('Creating metafield definition:', { name, namespace, key, type, ownerType });

    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': shopify_access_token_encrypted,
      },
      body: JSON.stringify({ query: mutation, variables }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Shopify GraphQL error:', errorText);
      return new Response(
        JSON.stringify({ error: 'Failed to create metafield in Shopify', details: errorText }),
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

    const { createdDefinition, userErrors } = result.data?.metafieldDefinitionCreate || {};

    if (userErrors && userErrors.length > 0) {
      // Check if it's a duplicate error (metafield already exists)
      const isDuplicate = userErrors.some((e: any) => 
        e.code === 'TAKEN' || e.message?.includes('already exists')
      );
      
      if (isDuplicate) {
        console.log('Metafield already exists, returning success');
        return new Response(
          JSON.stringify({ 
            success: true, 
            alreadyExists: true,
            metafield: { namespace, key, name, type } 
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.error('User errors:', userErrors);
      return new Response(
        JSON.stringify({ error: 'Failed to create metafield', details: userErrors }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Successfully created metafield definition:', createdDefinition);

    return new Response(
      JSON.stringify({ 
        success: true, 
        metafield: createdDefinition 
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error creating metafield definition:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
