import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, ArrowRight, Package, AlertTriangle, Check, X, Plus, Trash2, ChevronLeft, ChevronRight, Shuffle, ImageIcon, FileText, Wand2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { ProductData } from '@/types/database';
import { toast } from 'sonner';

interface ProductMappingTabProps {
  projectId: string;
}

interface MappingRules {
  stripVendorFromTitle: boolean;
  vendorSeparator: string;
  excludeUntitled: boolean;
  excludeZeroPrice: boolean;
  excludeNoImages: boolean;
}

interface FieldMapping {
  id: string;
  sourceField: string;
  targetField: string;
}

// Common Shopify product fields that can be mapped
const SHOPIFY_PRODUCT_FIELDS = [
  { value: 'title', label: 'Titel' },
  { value: 'body_html', label: 'Beskrivelse (HTML)' },
  { value: 'vendor', label: 'Leverandør' },
  { value: 'product_type', label: 'Produkttype' },
  { value: 'tags', label: 'Tags' },
  { value: 'variants[0].sku', label: 'SKU' },
  { value: 'variants[0].barcode', label: 'Stregkode' },
  { value: 'variants[0].price', label: 'Pris' },
  { value: 'variants[0].compare_at_price', label: 'Sammenlign ved pris' },
  { value: 'variants[0].weight', label: 'Vægt' },
  { value: 'variants[0].inventory_quantity', label: 'Lagerbeholdning' },
  { value: 'metafields.custom.field', label: 'Brugerdefineret metafelt' },
];

// Known source fields from DanDomain XML exports
const KNOWN_SOURCE_FIELDS = [
  // GENERAL section
  'PROD_NUM',
  'PROD_NAME',
  'PROD_WEIGHT',
  'PROD_PHOTO_URL',
  'PROD_COST_PRICE',
  // PRICES section
  'UNIT_PRICE',
  'SPECIAL_OFFER_PRICE',
  // ADVANCED section
  'PROD_BARCODE_NUMBER',
  'INTERNAL_ID',
  'PROD_HIDDEN',
  // STOCK section
  'STOCK_COUNT',
  // DESCRIPTION section
  'DESC_SHORT',
  'DESC_LONG',
  'META_DESCRIPTION',
  // MANUFACTURERS
  'MANUFAC_ID',
  // INFO section
  'PROD_CREATED',
  'PROD_SALES_COUNT',
];

// Auto-map suggestions: DanDomain field -> Shopify field
const AUTO_MAP_SUGGESTIONS: { source: string; target: string }[] = [
  { source: 'PROD_NUM', target: 'variants[0].sku' },
  { source: 'PROD_BARCODE_NUMBER', target: 'variants[0].barcode' },
  { source: 'UNIT_PRICE', target: 'variants[0].price' },
  { source: 'SPECIAL_OFFER_PRICE', target: 'variants[0].compare_at_price' },
  { source: 'PROD_WEIGHT', target: 'variants[0].weight' },
  { source: 'STOCK_COUNT', target: 'variants[0].inventory_quantity' },
  { source: 'MANUFAC_ID', target: 'vendor' },
  { source: 'DESC_LONG', target: 'body_html' },
];

interface ProductRef {
  id: string;
  external_id: string;
}

interface ProductPreviewData {
  original: {
    title: string;
    body_html: string;
    sku: string;
    price: number;
    cost_price: number | null;
    stock_quantity: number;
    weight: number | null;
    images: string[];
    vendor: string | null;
    category_ids: string[];
    rawData: Record<string, any>; // Store raw data for field mapping
  };
  transformed: {
    title: string;
    vendor: string;
    sku: string;
    price: number;
    compare_at_price: number | null;
    weight: number | null;
    stock_quantity: number;
    body_html: string;
  };
  categoryNames: string[];
  mappedFields: { field: string; value: any; source: string }[];
}

const defaultMappingRules: MappingRules = {
  stripVendorFromTitle: true,
  vendorSeparator: ' - ',
  excludeUntitled: true,
  excludeZeroPrice: false,
  excludeNoImages: false,
};

export function ProductMappingTab({ projectId }: ProductMappingTabProps) {
  const [loading, setLoading] = useState(true);
  const [mappingRules, setMappingRules] = useState<MappingRules>(defaultMappingRules);
  const [fieldMappings, setFieldMappings] = useState<FieldMapping[]>([]);
  const [newMapping, setNewMapping] = useState({ sourceField: '', targetField: '' });
  
  // Preview state
  const [product, setProduct] = useState<ProductPreviewData | null>(null);
  const [productIds, setProductIds] = useState<ProductRef[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [untitledCount, setUntitledCount] = useState(0);

  useEffect(() => {
    loadData();
  }, [projectId]);

  useEffect(() => {
    if (productIds.length > 0) {
      loadProduct(productIds[currentIndex].id);
    }
  }, [currentIndex, productIds, mappingRules]);

  const loadData = async () => {
    setLoading(true);
    
    // Load product list
    const { count } = await supabase
      .from('canonical_products')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .neq('data->>title', 'Untitled');
    
    setTotalCount(count || 0);

    // Count untitled
    const { count: untitled } = await supabase
      .from('canonical_products')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('data->>title', 'Untitled');
    
    setUntitledCount(untitled || 0);

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
    }

    // Load existing field mappings
    await loadFieldMappings();
    
    setLoading(false);
  };

  const loadFieldMappings = async () => {
    try {
      const { data } = await supabase
        .from('mapping_profiles')
        .select('*')
        .eq('project_id', projectId)
        .eq('is_active', true)
        .maybeSingle();

      if (data?.mappings) {
        const mappings = (data.mappings as any[]).filter(m => m.type === 'field');
        setFieldMappings(mappings.map((m, i) => ({
          id: `mapping-${i}`,
          sourceField: m.sourceField,
          targetField: m.targetField,
        })));
      }
    } catch (error) {
      console.error('Error loading field mappings:', error);
    }
  };

  const loadProduct = async (productId: string) => {
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

      // Transform title based on rules
      let transformedTitle = data.title || '';
      const vendor = data.vendor || '';
      
      if (mappingRules.stripVendorFromTitle && vendor && transformedTitle.includes(vendor)) {
        const separator = mappingRules.vendorSeparator || ' - ';
        if (transformedTitle.startsWith(vendor + separator)) {
          transformedTitle = transformedTitle.substring(vendor.length + separator.length).trim();
        } else {
          const separators = [' - ', ' – ', ' — ', ': ', ' | '];
          for (const sep of separators) {
            if (transformedTitle.startsWith(vendor + sep)) {
              transformedTitle = transformedTitle.substring(vendor.length + sep.length).trim();
              break;
            }
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
          weight: data.weight || null,
          images: data.images || [],
          vendor: data.vendor,
          category_ids: categoryIds,
          rawData: data, // Store raw data for field mapping
        },
        transformed: {
          title: transformedTitle,
          vendor: vendor,
          sku: data.sku || '',
          price: data.price || 0,
          compare_at_price: null,
          weight: data.weight || null,
          stock_quantity: data.stock_quantity || 0,
          body_html: data.body_html || '',
        },
        categoryNames,
        mappedFields: [],
      });
    }
  };

  // Apply field mappings to preview when they change
  useEffect(() => {
    if (!product) return;

    const rawData = product.original.rawData;
    const mappedFields: { field: string; value: any; source: string }[] = [];
    
    // Start with original values
    const transformed = { ...product.transformed };

    for (const mapping of fieldMappings) {
      const sourceValue = rawData[mapping.sourceField];
      if (sourceValue !== undefined && sourceValue !== null && sourceValue !== '') {
        mappedFields.push({
          field: mapping.targetField,
          value: sourceValue,
          source: mapping.sourceField,
        });

        // Apply mapping to transformed data
        switch (mapping.targetField) {
          case 'variants[0].sku':
            transformed.sku = String(sourceValue);
            break;
          case 'variants[0].price':
            transformed.price = parseFloat(sourceValue) || 0;
            break;
          case 'variants[0].compare_at_price':
            transformed.compare_at_price = parseFloat(sourceValue) || null;
            break;
          case 'variants[0].weight':
            transformed.weight = parseFloat(sourceValue) || null;
            break;
          case 'variants[0].inventory_quantity':
            transformed.stock_quantity = parseInt(sourceValue) || 0;
            break;
          case 'body_html':
            transformed.body_html = String(sourceValue);
            break;
          case 'vendor':
            transformed.vendor = String(sourceValue);
            break;
          case 'title':
            transformed.title = String(sourceValue);
            break;
        }
      }
    }

    setProduct(prev => prev ? {
      ...prev,
      transformed,
      mappedFields,
    } : null);
  }, [fieldMappings]);

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

  const addFieldMapping = async () => {
    if (!newMapping.sourceField || !newMapping.targetField) {
      toast.error('Vælg både kilde- og målfelt');
      return;
    }

    const mapping: FieldMapping = {
      id: `mapping-${Date.now()}`,
      sourceField: newMapping.sourceField,
      targetField: newMapping.targetField,
    };

    const updatedMappings = [...fieldMappings, mapping];
    setFieldMappings(updatedMappings);
    setNewMapping({ sourceField: '', targetField: '' });
    
    await saveMappings(updatedMappings);
    toast.success('Felt-mapping tilføjet');
  };

  const removeFieldMapping = async (id: string) => {
    const updatedMappings = fieldMappings.filter(m => m.id !== id);
    setFieldMappings(updatedMappings);
    
    await saveMappings(updatedMappings);
    toast.success('Felt-mapping fjernet');
  };

  const autoMapFields = async () => {
    // Get existing mapped target fields to avoid duplicates
    const existingTargets = new Set(fieldMappings.map(m => m.targetField));
    
    // Create new mappings for fields that aren't already mapped
    const newMappings: FieldMapping[] = [];
    for (const suggestion of AUTO_MAP_SUGGESTIONS) {
      if (!existingTargets.has(suggestion.target)) {
        newMappings.push({
          id: `mapping-${Date.now()}-${suggestion.source}`,
          sourceField: suggestion.source,
          targetField: suggestion.target,
        });
        existingTargets.add(suggestion.target);
      }
    }

    if (newMappings.length === 0) {
      toast.info('Alle standard felt-mappings er allerede tilføjet');
      return;
    }

    const updatedMappings = [...fieldMappings, ...newMappings];
    setFieldMappings(updatedMappings);
    await saveMappings(updatedMappings);
    toast.success(`${newMappings.length} felt-mappings tilføjet automatisk`);
  };

  const saveMappings = async (mappings: FieldMapping[]) => {
    try {
      const { data: existing } = await supabase
        .from('mapping_profiles')
        .select('*')
        .eq('project_id', projectId)
        .eq('is_active', true)
        .maybeSingle();

      const mappingsData = mappings.map(m => ({
        type: 'field',
        sourceField: m.sourceField,
        targetField: m.targetField,
        entityType: 'products',
      }));

      if (existing) {
        const existingMappings = (existing.mappings as any[]) || [];
        const otherMappings = existingMappings.filter(m => m.type !== 'field');
        
        await supabase
          .from('mapping_profiles')
          .update({ 
            mappings: [...otherMappings, ...mappingsData],
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('mapping_profiles')
          .insert({
            project_id: projectId,
            name: 'Standard',
            mappings: mappingsData,
            is_active: true,
          });
      }
    } catch (error) {
      console.error('Error saving field mappings:', error);
      toast.error('Fejl ved gemning af felt-mappings');
    }
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
            <div className="text-2xl font-bold">{totalCount + untitledCount}</div>
            <div className="text-sm text-muted-foreground">Produkter i alt</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold text-green-600">{totalCount}</div>
            <div className="text-sm text-muted-foreground">Klar til upload</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold text-amber-600">{untitledCount}</div>
            <div className="text-sm text-muted-foreground">"Untitled" produkter</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold">{fieldMappings.length}</div>
            <div className="text-sm text-muted-foreground">Ekstra mappings</div>
          </CardContent>
        </Card>
      </div>

      {/* Transformation Rules */}
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
              onCheckedChange={(checked) => setMappingRules({ ...mappingRules, stripVendorFromTitle: checked })}
            />
          </div>
          
          {mappingRules.stripVendorFromTitle && (
            <div className="pl-4 border-l-2 border-muted">
              <Label>Separator mellem brand og titel</Label>
              <Input
                value={mappingRules.vendorSeparator}
                onChange={(e) => setMappingRules({ ...mappingRules, vendorSeparator: e.target.value })}
                placeholder=" - "
                className="w-24 mt-1"
              />
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Ekskluder "Untitled" produkter</Label>
              <p className="text-sm text-muted-foreground">
                {untitledCount} produkter uden navn vil ikke blive oprettet
              </p>
            </div>
            <Switch
              checked={mappingRules.excludeUntitled}
              onCheckedChange={(checked) => setMappingRules({ ...mappingRules, excludeUntitled: checked })}
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
              onCheckedChange={(checked) => setMappingRules({ ...mappingRules, excludeZeroPrice: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Extra Field Mappings */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-lg">Ekstra felt-mappings</CardTitle>
            <CardDescription>
              Map ekstra felter fra DanDomain XML til Shopify felter
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={autoMapFields}
            className="flex items-center gap-2"
          >
            <Wand2 className="w-4 h-4" />
            Auto-map
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Add new mapping */}
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <Label className="text-xs">Kilde felt (DanDomain)</Label>
              <Select
                value={newMapping.sourceField}
                onValueChange={(v) => setNewMapping(prev => ({ ...prev, sourceField: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Vælg kilde felt..." />
                </SelectTrigger>
                <SelectContent>
                  {KNOWN_SOURCE_FIELDS.map(field => (
                    <SelectItem key={field} value={field}>
                      {field}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ArrowRight className="w-5 h-5 text-muted-foreground mb-2" />
            <div className="flex-1">
              <Label className="text-xs">Mål felt (Shopify)</Label>
              <Select
                value={newMapping.targetField}
                onValueChange={(v) => setNewMapping(prev => ({ ...prev, targetField: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Vælg mål felt..." />
                </SelectTrigger>
                <SelectContent>
                  {SHOPIFY_PRODUCT_FIELDS.map(field => (
                    <SelectItem key={field.value} value={field.value}>
                      {field.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={addFieldMapping} size="icon">
              <Plus className="w-4 h-4" />
            </Button>
          </div>

          {/* Existing mappings */}
          {fieldMappings.length > 0 ? (
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kilde felt (DanDomain)</TableHead>
                    <TableHead></TableHead>
                    <TableHead>Mål felt (Shopify)</TableHead>
                    <TableHead className="w-16"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fieldMappings.map(mapping => (
                    <TableRow key={mapping.id}>
                      <TableCell className="font-mono text-sm">
                        {mapping.sourceField}
                      </TableCell>
                      <TableCell className="w-12">
                        <ArrowRight className="w-4 h-4 text-muted-foreground" />
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {SHOPIFY_PRODUCT_FIELDS.find(f => f.value === mapping.targetField)?.label || mapping.targetField}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeFieldMapping(mapping.id)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground text-sm">
              Ingen ekstra felt-mappings tilføjet endnu
            </div>
          )}

          {/* Suggestion */}
          {fieldMappings.length === 0 && (
            <Card className="bg-muted/50 border-dashed">
              <CardContent className="py-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5" />
                  <div>
                    <p className="font-medium text-sm">Forslag: Stregkode mapping</p>
                    <p className="text-sm text-muted-foreground">
                      Hvis dine produkter har stregkoder i PROD_BARCODE_NUMBER, kan du mappe dem til Shopify stregkode-feltet ovenfor.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* Product Preview */}
      {product && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium">Shopify Preview</h3>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handlePrevious}
                disabled={currentIndex === 0}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <span className="text-sm text-muted-foreground min-w-[80px] text-center">
                {currentIndex + 1} / {productIds.length}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleNext}
                disabled={currentIndex === productIds.length - 1}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRandom}
              >
                <Shuffle className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-medium">CSV Data</span>
            <ArrowRight className="w-4 h-4" />
            <span className="font-medium">Shopify Felter</span>
          </div>

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
                    {product.transformed.body_html ? (
                      <div dangerouslySetInnerHTML={{ __html: product.transformed.body_html.substring(0, 300) + (product.transformed.body_html.length > 300 ? '...' : '') }} />
                    ) : (
                      <span className="text-muted-foreground italic">Ingen beskrivelse</span>
                    )}
                  </div>
                  {product.mappedFields.some(m => m.field === 'body_html') && (
                    <div className="mt-2 text-xs text-green-600 flex items-center gap-1">
                      <Check className="w-3 h-3" />
                      Mappet fra {product.mappedFields.find(m => m.field === 'body_html')?.source}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Price Field */}
              <Card>
                <CardContent className="pt-4">
                  <label className="text-sm font-medium text-foreground mb-2 block">Pris</label>
                  <div className="flex items-center gap-4">
                    <div>
                      <Input 
                        value={product.transformed.price.toFixed(2)} 
                        readOnly 
                        className="w-32 bg-background"
                      />
                      {product.mappedFields.some(m => m.field === 'variants[0].price') && (
                        <div className="mt-1 text-xs text-green-600 flex items-center gap-1">
                          <Check className="w-3 h-3" />
                          Fra {product.mappedFields.find(m => m.field === 'variants[0].price')?.source}
                        </div>
                      )}
                    </div>
                    <span className="text-muted-foreground">kr.</span>
                    {product.transformed.compare_at_price && (
                      <div className="text-muted-foreground">
                        <span className="text-xs">Før: </span>
                        <span className="line-through">{product.transformed.compare_at_price.toFixed(2)} kr.</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

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
                  </div>

                  <Separator />

                  {/* Tags */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Tags</label>
                    {product.categoryNames.length > 0 ? (
                      <div className="flex flex-wrap gap-1 p-2 border rounded-md bg-background min-h-[38px]">
                        {product.categoryNames.map((name, i) => (
                          <Badge key={i} variant="outline" className="text-xs">
                            {name}
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
                  </div>
                </CardContent>
              </Card>

              {/* SKU Info */}
              <Card>
                <CardContent className="pt-4">
                  <label className="text-xs text-muted-foreground mb-1 block">SKU</label>
                  <Input 
                    value={product.transformed.sku} 
                    readOnly 
                    className="bg-background h-9 font-mono text-sm"
                  />
                  {product.mappedFields.some(m => m.field === 'variants[0].sku') && (
                    <div className="mt-1 text-xs text-green-600 flex items-center gap-1">
                      <Check className="w-3 h-3" />
                      Fra {product.mappedFields.find(m => m.field === 'variants[0].sku')?.source}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Stock */}
              <Card>
                <CardContent className="pt-4">
                  <label className="text-xs text-muted-foreground mb-1 block">Lagerbeholdning</label>
                  <Input 
                    value={product.transformed.stock_quantity.toString()} 
                    readOnly 
                    className="bg-background h-9 font-mono text-sm"
                  />
                  {product.mappedFields.some(m => m.field === 'variants[0].inventory_quantity') && (
                    <div className="mt-1 text-xs text-green-600 flex items-center gap-1">
                      <Check className="w-3 h-3" />
                      Fra {product.mappedFields.find(m => m.field === 'variants[0].inventory_quantity')?.source}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Image preview */}
              <Card>
                <CardContent className="pt-4">
                  <label className="text-xs text-muted-foreground mb-1 block">Billeder</label>
                  {product.original.images.length > 0 ? (
                    <Badge variant="secondary">{product.original.images.length} billede(r)</Badge>
                  ) : (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <ImageIcon className="w-4 h-4" />
                      <span className="text-sm">Intet billede</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Applied Field Mappings in Preview */}
          {fieldMappings.length > 0 && (
            <Card className="bg-primary/5 border-primary/20">
              <CardContent className="pt-4">
                <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                  <Check className="w-4 h-4 text-primary" />
                  Ekstra felt-mappings anvendt
                </h4>
                <div className="flex flex-wrap gap-2">
                  {fieldMappings.map(mapping => (
                    <Badge key={mapping.id} variant="outline" className="gap-1">
                      <span className="font-mono text-xs">{mapping.sourceField}</span>
                      <ArrowRight className="w-3 h-3" />
                      <span>{SHOPIFY_PRODUCT_FIELDS.find(f => f.value === mapping.targetField)?.label || mapping.targetField}</span>
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {!product && totalCount === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>Ingen produkter fundet til preview</p>
        </div>
      )}
    </div>
  );
}
