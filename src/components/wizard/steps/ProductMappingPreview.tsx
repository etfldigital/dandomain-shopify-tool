import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, ArrowRight, Package, AlertTriangle, Check, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { ProductData } from '@/types/database';

interface ProductMappingPreviewProps {
  projectId: string;
  mappingRules: MappingRules;
  onRulesChange: (rules: MappingRules) => void;
}

export interface MappingRules {
  stripVendorFromTitle: boolean;
  vendorSeparator: string;
  excludeUntitled: boolean;
  excludeZeroPrice: boolean;
  excludeNoImages: boolean;
}

interface ProductPreview {
  id: string;
  external_id: string;
  original: ProductData;
  transformed: {
    title: string;
    vendor: string;
    price: string;
    sku: string;
    images: number;
  };
  issues: string[];
  willBeExcluded: boolean;
}

export function ProductMappingPreview({ projectId, mappingRules, onRulesChange }: ProductMappingPreviewProps) {
  const [products, setProducts] = useState<ProductPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    total: 0,
    valid: 0,
    excluded: 0,
    untitled: 0,
    zeroPrice: 0,
    noImages: 0,
  });

  useEffect(() => {
    loadSampleProducts();
  }, [projectId]);

  useEffect(() => {
    // Recalculate previews when rules change
    if (products.length > 0) {
      const transformed = products.map(p => transformProduct(p.original, p.id, p.external_id, mappingRules));
      setProducts(transformed);
      calculateStats(transformed);
    }
  }, [mappingRules]);

  const loadSampleProducts = async () => {
    setLoading(true);
    
    // Get total count
    const { count: totalCount } = await supabase
      .from('canonical_products')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId);

    // Get sample of 5 products with data
    const { data } = await supabase
      .from('canonical_products')
      .select('id, external_id, data')
      .eq('project_id', projectId)
      .limit(10);

    if (data) {
      // Filter to get a good mix of products
      const validProducts = data.filter(p => {
        const d = p.data as unknown as ProductData;
        return d.title !== 'Untitled';
      }).slice(0, 3);
      
      const invalidProducts = data.filter(p => {
        const d = p.data as unknown as ProductData;
        return d.title === 'Untitled';
      }).slice(0, 2);
      
      const allSamples = [...validProducts, ...invalidProducts];
      
      const transformed = allSamples.map(p => 
        transformProduct(p.data as unknown as ProductData, p.id, p.external_id, mappingRules)
      );
      
      setProducts(transformed);
      
      // Count issues across all products
      const { count: untitledCount } = await supabase
        .from('canonical_products')
        .select('*', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('data->>title', 'Untitled');
      
      setStats({
        total: totalCount || 0,
        valid: (totalCount || 0) - (untitledCount || 0),
        excluded: untitledCount || 0,
        untitled: untitledCount || 0,
        zeroPrice: 0,
        noImages: 0,
      });
    }
    
    setLoading(false);
  };

  const transformProduct = (
    data: ProductData, 
    id: string, 
    external_id: string,
    rules: MappingRules
  ): ProductPreview => {
    const issues: string[] = [];
    let willBeExcluded = false;

    // Check for issues
    if (data.title === 'Untitled' || !data.title) {
      issues.push('Mangler titel');
      if (rules.excludeUntitled) willBeExcluded = true;
    }
    
    if (data.price === 0) {
      issues.push('Pris er 0');
      if (rules.excludeZeroPrice) willBeExcluded = true;
    }
    
    if (!data.images || data.images.length === 0) {
      issues.push('Ingen billeder');
      if (rules.excludeNoImages) willBeExcluded = true;
    }

    // Transform title (strip vendor if enabled)
    let transformedTitle = data.title || 'Untitled';
    let transformedVendor = data.vendor || '';
    
    if (rules.stripVendorFromTitle && data.vendor && transformedTitle.includes(data.vendor)) {
      // Try to strip vendor from title using separator
      const separator = rules.vendorSeparator || ' - ';
      if (transformedTitle.startsWith(data.vendor + separator)) {
        transformedTitle = transformedTitle.substring(data.vendor.length + separator.length).trim();
      } else if (transformedTitle.includes(separator)) {
        // Vendor might be at a different position
        const parts = transformedTitle.split(separator);
        if (parts[0].trim() === data.vendor) {
          transformedTitle = parts.slice(1).join(separator).trim();
        }
      }
    }

    return {
      id,
      external_id,
      original: data,
      transformed: {
        title: transformedTitle,
        vendor: transformedVendor,
        price: `${data.price?.toFixed(2) || '0.00'} DKK`,
        sku: data.sku,
        images: data.images?.length || 0,
      },
      issues,
      willBeExcluded,
    };
  };

  const calculateStats = (previews: ProductPreview[]) => {
    // This would normally count across all products, but for preview we just show sample stats
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold">{stats.total}</div>
            <div className="text-sm text-muted-foreground">Produkter i alt</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold text-green-600">{stats.valid}</div>
            <div className="text-sm text-muted-foreground">Klar til upload</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold text-amber-600">{stats.untitled}</div>
            <div className="text-sm text-muted-foreground">"Untitled" produkter</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold text-red-600">{stats.excluded}</div>
            <div className="text-sm text-muted-foreground">Vil blive ekskluderet</div>
          </CardContent>
        </Card>
      </div>

      {/* Mapping Rules */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Transformationsregler</CardTitle>
          <CardDescription>
            Konfigurer hvordan produktdata transformeres til Shopify
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Fjern brand fra titel</Label>
              <p className="text-sm text-muted-foreground">
                "Mads Nørgaard - T-shirt" → "T-shirt" (brand i Vendor felt)
              </p>
            </div>
            <Switch
              checked={mappingRules.stripVendorFromTitle}
              onCheckedChange={(checked) => onRulesChange({ ...mappingRules, stripVendorFromTitle: checked })}
            />
          </div>
          
          {mappingRules.stripVendorFromTitle && (
            <div className="pl-4 border-l-2 border-muted">
              <Label>Separator mellem brand og titel</Label>
              <Input
                value={mappingRules.vendorSeparator}
                onChange={(e) => onRulesChange({ ...mappingRules, vendorSeparator: e.target.value })}
                placeholder=" - "
                className="w-24 mt-1"
              />
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Ekskluder "Untitled" produkter</Label>
              <p className="text-sm text-muted-foreground">
                Produkter uden navn vil ikke blive oprettet
              </p>
            </div>
            <Switch
              checked={mappingRules.excludeUntitled}
              onCheckedChange={(checked) => onRulesChange({ ...mappingRules, excludeUntitled: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Ekskluder produkter med pris 0</Label>
              <p className="text-sm text-muted-foreground">
                Produkter uden pris vil ikke blive oprettet
              </p>
            </div>
            <Switch
              checked={mappingRules.excludeZeroPrice}
              onCheckedChange={(checked) => onRulesChange({ ...mappingRules, excludeZeroPrice: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Preview Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Package className="w-5 h-5" />
            Preview (3 eksempler)
          </CardTitle>
          <CardDescription>
            Sådan vil produkterne se ud i Shopify efter transformation
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>DanDomain</TableHead>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Shopify</TableHead>
                  <TableHead className="w-32">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map(product => (
                  <TableRow 
                    key={product.id}
                    className={product.willBeExcluded ? 'opacity-50 bg-destructive/5' : ''}
                  >
                    <TableCell>
                      <div className="space-y-1">
                        <div className="font-medium text-sm">{product.original.title}</div>
                        <div className="text-xs text-muted-foreground">
                          SKU: {product.original.sku}
                        </div>
                        {product.original.vendor && (
                          <div className="text-xs text-muted-foreground">
                            Vendor: {product.original.vendor}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <ArrowRight className="w-4 h-4 text-muted-foreground" />
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="font-medium text-sm">{product.transformed.title}</div>
                        <div className="text-xs text-muted-foreground">
                          Vendor: {product.transformed.vendor || '(tom)'}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {product.transformed.price} • {product.transformed.images} billeder
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {product.willBeExcluded ? (
                        <Badge variant="destructive" className="gap-1">
                          <X className="w-3 h-3" />
                          Ekskluderet
                        </Badge>
                      ) : product.issues.length > 0 ? (
                        <Badge variant="secondary" className="gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          {product.issues.length} advarsel
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-green-600 border-green-600">
                          <Check className="w-3 h-3" />
                          OK
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          
          {/* Issues Summary */}
          {products.some(p => p.issues.length > 0) && (
            <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5" />
                <div className="text-sm">
                  <div className="font-medium text-amber-800 dark:text-amber-200">Fundne problemer:</div>
                  <ul className="list-disc list-inside text-amber-700 dark:text-amber-300 mt-1">
                    {Array.from(new Set(products.flatMap(p => p.issues))).map(issue => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
