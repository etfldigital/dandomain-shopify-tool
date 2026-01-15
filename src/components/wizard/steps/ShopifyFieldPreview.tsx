import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowRight, FileText, ChevronLeft, ChevronRight, Shuffle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface ShopifyFieldPreviewProps {
  projectId: string;
}

interface ProductPreviewData {
  original: {
    title: string;
    body_html: string;
    sku: string;
    price: number;
    cost_price: number | null;
    stock_quantity: number;
    vendor: string | null;
    category_ids: string[];
  };
  transformed: {
    title: string;
    vendor: string;
  };
  categoryNames: string[];
}

interface ProductRef {
  id: string;
  external_id: string;
}

export function ShopifyFieldPreview({ projectId }: ShopifyFieldPreviewProps) {
  const [product, setProduct] = useState<ProductPreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [productIds, setProductIds] = useState<ProductRef[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    loadProductList();
  }, [projectId]);

  useEffect(() => {
    if (productIds.length > 0) {
      loadProduct(productIds[currentIndex].id);
    }
  }, [currentIndex, productIds]);

  const loadProductList = async () => {
    // Get total count
    const { count } = await supabase
      .from('canonical_products')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .neq('data->>title', 'Untitled');
    
    setTotalCount(count || 0);

    // Get first batch of product IDs
    const { data: products } = await supabase
      .from('canonical_products')
      .select('id, external_id')
      .eq('project_id', projectId)
      .neq('data->>title', 'Untitled')
      .limit(100);

    if (products && products.length > 0) {
      setProductIds(products);
      setCurrentIndex(0);
    } else {
      setLoading(false);
    }
  };

  const loadProduct = async (productId: string) => {
    setLoading(true);
    
    const { data: products } = await supabase
      .from('canonical_products')
      .select('*')
      .eq('id', productId)
      .limit(1);

    if (products && products.length > 0) {
      const p = products[0];
      const data = p.data as any;
      
      // Get category names
      const categoryIds = data.category_external_ids || [];
      let categoryNames: string[] = [];
      
      if (categoryIds.length > 0) {
        const { data: categories } = await supabase
          .from('canonical_categories')
          .select('name, shopify_tag')
          .eq('project_id', projectId)
          .in('external_id', categoryIds);
        
        if (categories) {
          categoryNames = categories.map(c => c.shopify_tag || c.name);
        }
      }

      // Transform title (strip vendor)
      let transformedTitle = data.title || '';
      const vendor = data.vendor || '';
      
      if (vendor && transformedTitle.includes(vendor)) {
        const separators = [' - ', ' – ', ' — ', ': ', ' | '];
        for (const sep of separators) {
          if (transformedTitle.startsWith(vendor + sep)) {
            transformedTitle = transformedTitle.substring(vendor.length + sep.length).trim();
            break;
          }
        }
      }

      setProduct({
        original: {
          title: data.title || '',
          body_html: data.body_html || '',
          sku: data.sku || '',
          price: data.price || 0,
          cost_price: data.cost_price || null,
          stock_quantity: data.stock_quantity || 0,
          vendor: data.vendor,
          category_ids: categoryIds,
        },
        transformed: {
          title: transformedTitle,
          vendor: vendor,
        },
        categoryNames,
      });
    }
    
    setLoading(false);
  };

  const handlePrevious = () => {
    setCurrentIndex(prev => Math.max(0, prev - 1));
  };

  const handleNext = () => {
    setCurrentIndex(prev => Math.min(productIds.length - 1, prev + 1));
  };

  const handleRandom = () => {
    const randomIndex = Math.floor(Math.random() * productIds.length);
    setCurrentIndex(randomIndex);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!product) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
        <p>Ingen produkter fundet til preview</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
        <span className="font-medium">CSV Data</span>
        <ArrowRight className="w-4 h-4" />
        <span className="font-medium">Shopify Felter</span>
      </div>

      {/* Main Content - Left Side */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          {/* Title Field */}
          <Card>
            <CardContent className="pt-4">
              <label className="text-sm font-medium text-foreground mb-2 block">Titel</label>
              <div className="relative">
                <Input 
                  value={product.transformed.title} 
                  readOnly 
                  className="bg-background"
                />
                {product.original.title !== product.transformed.title && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    <span className="text-amber-600">Original:</span> {product.original.title}
                    <br />
                    <span className="text-green-600">→ Vendor fjernet fra titel</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Description Field */}
          <Card>
            <CardContent className="pt-4">
              <label className="text-sm font-medium text-foreground mb-2 block">Beskrivelse</label>
              <div className="min-h-[100px] p-3 border rounded-md bg-background text-sm">
                {product.original.body_html ? (
                  <div dangerouslySetInnerHTML={{ __html: product.original.body_html.substring(0, 300) + (product.original.body_html.length > 300 ? '...' : '') }} />
                ) : (
                  <span className="text-muted-foreground italic">Ingen beskrivelse (PROD_DESCRIPTION)</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Fra: DESC_LONG
              </p>
            </CardContent>
          </Card>

          {/* Price Field */}
          <Card>
            <CardContent className="pt-4">
              <label className="text-sm font-medium text-foreground mb-2 block">Pris</label>
              <div className="flex items-center gap-2">
                <Input 
                  value={product.original.price.toFixed(2)} 
                  readOnly 
                  className="w-32 bg-background"
                />
                <span className="text-muted-foreground">kr.</span>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Fra: UNIT_PRICE
              </p>
            </CardContent>
          </Card>

          {/* Cost Price Field */}
          <Card>
            <CardContent className="pt-4">
              <label className="text-sm font-medium text-foreground mb-2 block">Kostpris</label>
              <div className="flex items-center gap-2">
                <Input 
                  value={product.original.cost_price?.toFixed(2) || '0.00'} 
                  readOnly 
                  className="w-32 bg-background"
                />
                <span className="text-muted-foreground">kr.</span>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Fra: PROD_COST_PRICE
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Right Side - Product Organization */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Produktorganisering</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Vendor */}
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Forhandler</label>
                <Input 
                  value={product.transformed.vendor || '(tom)'} 
                  readOnly 
                  className="bg-background h-9"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Fra: MANUFAC_ID
                </p>
              </div>

              <Separator />

              {/* Collections/Categories */}
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Kollektioner</label>
                {product.categoryNames.length > 0 ? (
                  <div className="flex flex-wrap gap-1 p-2 border rounded-md bg-background min-h-[38px]">
                    {product.categoryNames.map((name, i) => (
                      <Badge key={i} variant="secondary" className="text-xs">
                        {name}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <Input 
                    value="(ingen kategorier)" 
                    readOnly 
                    className="bg-background h-9 text-muted-foreground"
                  />
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Fra: PROD_CAT_ID → Smart Collections
                </p>
              </div>

              <Separator />

              {/* Tags */}
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Tags</label>
                {product.categoryNames.length > 0 ? (
                  <div className="flex flex-wrap gap-1 p-2 border rounded-md bg-background min-h-[38px]">
                    {product.categoryNames.map((name, i) => (
                      <Badge key={i} variant="outline" className="text-xs">
                        {name} <span className="ml-1 opacity-50">×</span>
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <Input 
                    value="(ingen tags)" 
                    readOnly 
                    className="bg-background h-9 text-muted-foreground"
                  />
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Genereret fra: Kategorinavne
                </p>
              </div>
            </CardContent>
          </Card>

          {/* SKU Info */}
          <Card>
            <CardContent className="pt-4">
              <label className="text-xs text-muted-foreground mb-1 block">SKU (Variant)</label>
              <Input 
                value={product.original.sku} 
                readOnly 
                className="bg-background h-9 font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Fra: PROD_NUM
              </p>
            </CardContent>
          </Card>

          {/* Stock Quantity */}
          <Card>
            <CardContent className="pt-4">
              <label className="text-xs text-muted-foreground mb-1 block">Lagerbeholdning</label>
              <Input 
                value={(product.original.stock_quantity ?? 0).toString()} 
                readOnly 
                className="bg-background h-9 font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Fra: STOCK_COUNT
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Field Mapping Legend */}
      <Card className="bg-muted/30">
        <CardContent className="pt-4">
          <h4 className="text-sm font-medium mb-3">Felt-mapping oversigt</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono">PROD_NAME</Badge>
              <ArrowRight className="w-3 h-3 text-muted-foreground" />
              <span>Titel</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono">DESC_LONG</Badge>
              <ArrowRight className="w-3 h-3 text-muted-foreground" />
              <span>Beskrivelse</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono">UNIT_PRICE</Badge>
              <ArrowRight className="w-3 h-3 text-muted-foreground" />
              <span>Pris</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono">PROD_COST_PRICE</Badge>
              <ArrowRight className="w-3 h-3 text-muted-foreground" />
              <span>Kostpris</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono">MANUFAC_ID</Badge>
              <ArrowRight className="w-3 h-3 text-muted-foreground" />
              <span>Forhandler</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono">PROD_CAT_ID</Badge>
              <ArrowRight className="w-3 h-3 text-muted-foreground" />
              <span>Tags + Collections</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono">PROD_NUM</Badge>
              <ArrowRight className="w-3 h-3 text-muted-foreground" />
              <span>SKU</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono">STOCK_COUNT</Badge>
              <ArrowRight className="w-3 h-3 text-muted-foreground" />
              <span>Lagerbeholdning</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Product Navigation */}
      <div className="flex items-center justify-center gap-4 pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={handlePrevious}
          disabled={currentIndex === 0 || loading}
        >
          <ChevronLeft className="w-4 h-4 mr-1" />
          Forrige
        </Button>
        
        <div className="text-sm text-muted-foreground">
          Produkt {currentIndex + 1} af {totalCount > 100 ? `${productIds.length}+` : totalCount}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleNext}
          disabled={currentIndex >= productIds.length - 1 || loading}
        >
          Næste
          <ChevronRight className="w-4 h-4 ml-1" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleRandom}
          disabled={loading || productIds.length <= 1}
        >
          <Shuffle className="w-4 h-4 mr-1" />
          Tilfældig
        </Button>
      </div>
    </div>
  );
}
