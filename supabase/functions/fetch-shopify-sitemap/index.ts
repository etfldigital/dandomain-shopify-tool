import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface FetchShopifySitemapRequest {
  projectId: string;
}

interface ShopifyUrl {
  loc: string;
  type: 'product' | 'collection' | 'page';
  handle: string;
}

// Extract handle from Shopify URL
function extractHandle(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

// Parse XML sitemap
async function parseSitemap(url: string): Promise<string[]> {
  console.log(`Fetching sitemap: ${url}`);
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DanDomainMigrator/1.0)',
      'Accept': 'application/xml, text/xml, */*',
    },
  });
  
  if (!response.ok) {
    console.error(`Failed to fetch ${url}: ${response.status}`);
    return [];
  }
  
  const xml = await response.text();
  const urls: string[] = [];
  
  // Check if this is a sitemap index
  if (xml.includes('<sitemapindex')) {
    const sitemapMatches = xml.matchAll(/<sitemap[^>]*>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/gi);
    for (const match of sitemapMatches) {
      const childUrl = match[1].trim();
      try {
        const childUrls = await parseSitemap(childUrl);
        urls.push(...childUrls);
      } catch (err) {
        console.error(`Error parsing child sitemap ${childUrl}:`, err);
      }
    }
  } else {
    // Regular sitemap
    const urlMatches = xml.matchAll(/<url[^>]*>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/gi);
    for (const match of urlMatches) {
      urls.push(match[1].trim());
    }
  }
  
  return urls;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { projectId } = (await req.json()) as FetchShopifySitemapRequest;

    if (!projectId) {
      return new Response(
        JSON.stringify({ error: 'Missing projectId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get project to fetch Shopify domain
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('shopify_store_domain')
      .eq('id', projectId)
      .single();

    if (projectError || !project?.shopify_store_domain) {
      return new Response(
        JSON.stringify({ error: 'Shopify not connected' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let domain = project.shopify_store_domain;
    if (!domain.startsWith('http')) {
      domain = 'https://' + domain;
    }
    domain = domain.replace(/\/$/, '');

    console.log(`Fetching Shopify sitemap for ${domain}`);

    // Fetch main sitemap
    const mainSitemapUrl = `${domain}/sitemap.xml`;
    const allUrls = await parseSitemap(mainSitemapUrl);

    console.log(`Found ${allUrls.length} total URLs in Shopify sitemap`);

    // Classify and extract handles
    const shopifyUrls: ShopifyUrl[] = [];
    
    for (const url of allUrls) {
      try {
        const parsed = new URL(url);
        const path = parsed.pathname;
        
        if (path.startsWith('/products/')) {
          shopifyUrls.push({
            loc: path,
            type: 'product',
            handle: extractHandle(path),
          });
        } else if (path.startsWith('/collections/')) {
          shopifyUrls.push({
            loc: path,
            type: 'collection',
            handle: extractHandle(path),
          });
        } else if (path.startsWith('/pages/')) {
          shopifyUrls.push({
            loc: path,
            type: 'page',
            handle: extractHandle(path),
          });
        }
      } catch {
        // Skip invalid URLs
      }
    }

    console.log(`Classified: ${shopifyUrls.filter(u => u.type === 'product').length} products, ${shopifyUrls.filter(u => u.type === 'collection').length} collections, ${shopifyUrls.filter(u => u.type === 'page').length} pages`);

    return new Response(
      JSON.stringify({
        success: true,
        urls: shopifyUrls,
        stats: {
          total: shopifyUrls.length,
          products: shopifyUrls.filter(u => u.type === 'product').length,
          collections: shopifyUrls.filter(u => u.type === 'collection').length,
          pages: shopifyUrls.filter(u => u.type === 'page').length,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in fetch-shopify-sitemap:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
