const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { storeDomain, accessToken } = await req.json();

    if (!storeDomain || !accessToken) {
      return new Response(
        JSON.stringify({ success: false, error: 'Butik domæne og access token er påkrævet.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Basic format validation
    if (!accessToken.startsWith('shpat_')) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Ugyldig access token. Shopify Admin API access tokens starter med "shpat_". Du har muligvis indsat en forkert nøgle.' 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Sanitize domain
    const cleanDomain = storeDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

    if (!cleanDomain.includes('.myshopify.com')) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Domænet skal være et Shopify-domæne (f.eks. min-butik.myshopify.com).' 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Test the connection by fetching shop info
    const response = await fetch(`https://${cleanDomain}/admin/api/2025-01/shop.json`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      let detail = '';
      
      if (contentType?.includes('application/json')) {
        const data = await response.json();
        detail = JSON.stringify(data.errors || data);
      } else {
        detail = await response.text();
      }

      if (response.status === 401 || response.status === 403) {
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: 'Ugyldig access token. Kontrollér at din token er korrekt og har de nødvendige rettigheder.' 
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.error('Shopify API error:', response.status, detail);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: `Shopify svarede med fejl ${response.status}. Kontrollér domæne og access token.` 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    const shopName = data.shop?.name || cleanDomain;

    return new Response(
      JSON.stringify({ success: true, shopName }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error testing connection:', error);

    // DNS/network errors
    if (String(error).includes('dns error') || String(error).includes('failed to lookup')) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Kunne ikke finde domænet. Kontrollér at du har indtastet det korrekte .myshopify.com domæne.' 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: 'Der opstod en uventet fejl. Prøv igen.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
