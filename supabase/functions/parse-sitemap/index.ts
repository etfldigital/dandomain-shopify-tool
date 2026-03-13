import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface ParseSitemapRequest {
  projectId: string;
  productSitemapUrl?: string;
  categorySitemapUrl?: string;
  pageSitemapUrl?: string;
}

interface SitemapUrl {
  loc: string;
  type: 'product' | 'category' | 'page' | 'unknown';
}

// Classify URL based on heuristics
function classifyUrl(url: string, sourceType?: 'product' | 'category' | 'page'): 'product' | 'category' | 'page' | 'unknown' {
  if (sourceType) return sourceType;
  
  const path = url.toLowerCase();
  
  if (/-\d+p\.html$/i.test(path)) return 'product';
  if (/-\d+c\d*\.html$/i.test(path) || /-\d+s\d*\.html$/i.test(path)) return 'category';
  if (path.includes('/products/')) return 'product';
  if (path.includes('/collections/')) return 'category';
  if (path.includes('/pages/')) return 'page';
  
  return 'unknown';
}

// Extract path from full URL
function extractPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url.startsWith('/') ? url : '/' + url;
  }
}

// Parse XML sitemap and extract URLs
async function parseSitemap(url: string, sourceType?: 'product' | 'category' | 'page'): Promise<SitemapUrl[]> {
  console.log(`Fetching sitemap: ${url}`);
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DanDomainMigrator/1.0)',
      'Accept': 'application/xml, text/xml, */*',
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch sitemap: ${response.status} ${response.statusText}`);
  }
  
  const xml = await response.text();
  const urls: SitemapUrl[] = [];
  
  if (xml.includes('<sitemapindex')) {
    const sitemapMatches = xml.matchAll(/<sitemap[^>]*>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/gi);
    for (const match of sitemapMatches) {
      const childUrl = match[1].trim();
      try {
        const childUrls = await parseSitemap(childUrl, sourceType);
        urls.push(...childUrls);
      } catch (err) {
        console.error(`Error parsing child sitemap ${childUrl}:`, err);
      }
    }
  } else {
    const urlMatches = xml.matchAll(/<url[^>]*>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/gi);
    for (const match of urlMatches) {
      const loc = match[1].trim();
      urls.push({
        loc: extractPath(loc),
        type: classifyUrl(loc, sourceType),
      });
    }
  }
  
  return urls;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { projectId, productSitemapUrl, categorySitemapUrl, pageSitemapUrl } = (await req.json()) as ParseSitemapRequest;

    if (!projectId) {
      return new Response(
        JSON.stringify({ error: 'Missing projectId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!productSitemapUrl && !categorySitemapUrl && !pageSitemapUrl) {
      return new Response(
        JSON.stringify({ error: 'At least one sitemap URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Parsing sitemaps for project ${projectId}`);

    const allUrls: SitemapUrl[] = [];

    // Parse product sitemap
    if (productSitemapUrl) {
      try {
        const productUrls = await parseSitemap(productSitemapUrl, 'product');
        allUrls.push(...productUrls);
        console.log(`Found ${productUrls.length} product URLs`);
      } catch (err) {
        console.error('Error parsing product sitemap:', err);
        return new Response(
          JSON.stringify({ error: `Kunne ikke hente produkt-sitemap: ${err instanceof Error ? err.message : 'Ukendt fejl'}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Parse category sitemap
    if (categorySitemapUrl) {
      try {
        const categoryUrls = await parseSitemap(categorySitemapUrl, 'category');
        allUrls.push(...categoryUrls);
        console.log(`Found ${categoryUrls.length} category URLs`);
      } catch (err) {
        console.error('Error parsing category sitemap:', err);
        return new Response(
          JSON.stringify({ error: `Kunne ikke hente kategori-sitemap: ${err instanceof Error ? err.message : 'Ukendt fejl'}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Parse page sitemap
    if (pageSitemapUrl) {
      try {
        const pageUrls = await parseSitemap(pageSitemapUrl, 'page');
        allUrls.push(...pageUrls);
        console.log(`Found ${pageUrls.length} page URLs`);
      } catch (err) {
        console.error('Error parsing page sitemap:', err);
        return new Response(
          JSON.stringify({ error: `Kunne ikke hente side-sitemap: ${err instanceof Error ? err.message : 'Ukendt fejl'}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Remove duplicates based on path
    const uniqueUrls = Array.from(
      new Map(allUrls.map(u => [u.loc, u])).values()
    );

    console.log(`Total unique URLs: ${uniqueUrls.length}`);

    return new Response(
      JSON.stringify({
        success: true,
        urls: uniqueUrls,
        stats: {
          total: uniqueUrls.length,
          products: uniqueUrls.filter(u => u.type === 'product').length,
          categories: uniqueUrls.filter(u => u.type === 'category').length,
          pages: uniqueUrls.filter(u => u.type === 'page').length,
          unknown: uniqueUrls.filter(u => u.type === 'unknown').length,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in parse-sitemap:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
