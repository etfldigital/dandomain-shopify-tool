import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface InspectUrlRequest {
  url: string;
}

interface InspectUrlResponse {
  success: boolean;
  pageType: 'product' | 'collection' | 'page' | 'unknown';
  title?: string;
  productInfo?: {
    name: string;
    sku?: string;
    price?: string;
  };
  collectionInfo?: {
    name: string;
    productCount?: number;
  };
  error?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url } = (await req.json()) as InspectUrlRequest;

    if (!url) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing URL' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Ensure URL has protocol
    let fullUrl = url.trim();
    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
      fullUrl = 'https://' + fullUrl;
    }

    console.log(`Inspecting URL: ${fullUrl}`);

    // Fetch the page
    const response = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MigrationBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          pageType: 'unknown',
          error: `HTTP ${response.status}: ${response.statusText}` 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const html = await response.text();
    
    // Analyze the HTML to determine page type
    const result = analyzeHtml(html, fullUrl);

    console.log(`Page type detected: ${result.pageType}, title: ${result.title}`);

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error inspecting URL:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        pageType: 'unknown',
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function analyzeHtml(html: string, url: string): InspectUrlResponse {
  // Extract page title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].trim() : undefined;

  // Look for common DanDomain/e-commerce product page indicators
  const productIndicators = [
    // Product schema
    /"@type"\s*:\s*"Product"/i,
    // Add to cart buttons/forms
    /class="[^"]*add[_-]?to[_-]?cart[^"]*"/i,
    /class="[^"]*addtocart[^"]*"/i,
    /id="[^"]*add[_-]?to[_-]?cart[^"]*"/i,
    // Product-specific elements
    /class="[^"]*product[_-]?detail[^"]*"/i,
    /class="[^"]*product[_-]?page[^"]*"/i,
    /class="[^"]*product[_-]?info[^"]*"/i,
    // Variant selectors
    /class="[^"]*variant[_-]?selector[^"]*"/i,
    /class="[^"]*size[_-]?selector[^"]*"/i,
    // Price elements with specific product context
    /class="[^"]*product[_-]?price[^"]*"/i,
    // Buy button
    /class="[^"]*buy[_-]?button[^"]*"/i,
    // DanDomain specific
    /data-productid/i,
    /class="[^"]*produkt[_-]?detalje[^"]*"/i,
    // Stock/quantity
    /class="[^"]*stock[_-]?quantity[^"]*"/i,
    /class="[^"]*in[_-]?stock[^"]*"/i,
  ];

  const collectionIndicators = [
    // Collection/category schema
    /"@type"\s*:\s*"CollectionPage"/i,
    /"@type"\s*:\s*"ItemList"/i,
    // Product grids/lists
    /class="[^"]*product[_-]?grid[^"]*"/i,
    /class="[^"]*product[_-]?list[^"]*"/i,
    /class="[^"]*products[_-]?grid[^"]*"/i,
    /class="[^"]*category[_-]?products[^"]*"/i,
    // Category/collection page elements
    /class="[^"]*category[_-]?page[^"]*"/i,
    /class="[^"]*collection[_-]?page[^"]*"/i,
    // Filters
    /class="[^"]*product[_-]?filter[^"]*"/i,
    /class="[^"]*filter[_-]?sidebar[^"]*"/i,
    // Pagination (common in category pages)
    /class="[^"]*pagination[^"]*"/i,
    // DanDomain specific category indicators
    /class="[^"]*kategori[^"]*"/i,
    /class="[^"]*vareliste[^"]*"/i,
  ];

  // Count matches
  let productScore = 0;
  let collectionScore = 0;

  for (const indicator of productIndicators) {
    if (indicator.test(html)) {
      productScore++;
    }
  }

  for (const indicator of collectionIndicators) {
    if (indicator.test(html)) {
      collectionScore++;
    }
  }

  // URL path analysis
  const urlLower = url.toLowerCase();
  if (urlLower.includes('/product') || urlLower.includes('/produkt') || urlLower.includes('/vare')) {
    productScore += 2;
  }
  if (urlLower.includes('/shop/') || urlLower.includes('/kategori') || urlLower.includes('/category') || urlLower.includes('/collection')) {
    collectionScore += 2;
  }

  // Extract product info if it's a product page
  let productInfo: InspectUrlResponse['productInfo'] | undefined;
  if (productScore > collectionScore && productScore >= 2) {
    // Try to extract product name from various sources
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const productName = h1Match ? h1Match[1].trim() : pageTitle;
    
    // Try to extract price
    const priceMatch = html.match(/class="[^"]*price[^"]*"[^>]*>([^<]+)/i);
    const price = priceMatch ? priceMatch[1].trim() : undefined;
    
    // Try to extract SKU
    const skuMatch = html.match(/(?:sku|varenr|article)[^>]*>([^<]+)/i);
    const sku = skuMatch ? skuMatch[1].trim() : undefined;

    if (productName) {
      productInfo = {
        name: productName,
        sku,
        price,
      };
    }
  }

  // Extract collection info
  let collectionInfo: InspectUrlResponse['collectionInfo'] | undefined;
  if (collectionScore > productScore && collectionScore >= 2) {
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const collectionName = h1Match ? h1Match[1].trim() : pageTitle;
    
    // Try to count products in the grid
    const productLinks = html.match(/class="[^"]*product[^"]*"/g);
    const productCount = productLinks ? Math.floor(productLinks.length / 2) : undefined;

    if (collectionName) {
      collectionInfo = {
        name: collectionName,
        productCount,
      };
    }
  }

  // Determine page type
  let pageType: InspectUrlResponse['pageType'] = 'unknown';
  if (productScore > collectionScore && productScore >= 2) {
    pageType = 'product';
  } else if (collectionScore > productScore && collectionScore >= 2) {
    pageType = 'collection';
  } else if (productScore > 0 || collectionScore > 0) {
    // Low confidence - pick the higher score
    pageType = productScore >= collectionScore ? 'product' : 'collection';
  } else {
    // Check if it's a content page
    const hasContentIndicators = 
      /<article/i.test(html) || 
      /class="[^"]*page[_-]?content[^"]*"/i.test(html) ||
      /class="[^"]*cms[_-]?content[^"]*"/i.test(html);
    
    if (hasContentIndicators) {
      pageType = 'page';
    }
  }

  return {
    success: true,
    pageType,
    title: pageTitle,
    productInfo,
    collectionInfo,
  };
}
