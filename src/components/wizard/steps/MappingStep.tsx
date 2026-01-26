import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, Save, ArrowRight, Folder, Tag, Package, ShoppingCart, Users } from 'lucide-react';
import { Project, CanonicalCategory } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { ProductMappingTab } from './ProductMappingTab';
import { CustomerPreviewTab } from './CustomerPreviewTab';
import { OrderPreviewTab } from './OrderPreviewTab';
import { useProductForecast } from '@/hooks/useProductForecast';

interface MappingStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

export function MappingStep({ project, onUpdateProject, onNext }: MappingStepProps) {
  const [categories, setCategories] = useState<CanonicalCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState('products');
  const { forecast, isLoading: forecastLoading, error: forecastError, refresh: refreshForecast } = useProductForecast(project.id);
  const [stats, setStats] = useState({
    totalLines: 0,
    uniqueProducts: 0,
    totalVariants: 0,
    avgVariants: 0,
    ungroupedCount: 0, // Records not yet processed by prepare-upload
  });
  const [entityCounts, setEntityCounts] = useState({
    categories: 0,
    customers: 0,
    orders: 0,
  });

  useEffect(() => {
    loadData();
  }, [project.id]);

  useEffect(() => {
    if (!forecast) return;
    // Forecast is computed via preview-only prepare-upload and cached,
    // so these numbers are stable and match what will be created in Shopify.
    setStats({
      totalLines: forecast.totalLines,
      uniqueProducts: forecast.shopifyProducts,
      totalVariants: forecast.totalVariants,
      avgVariants: forecast.avgVariants,
      ungroupedCount: 0,
    });
  }, [forecast]);

  const loadData = async () => {
    setLoading(true);
    
    // Load categories
    const { data: categoryData } = await supabase
      .from('canonical_categories')
      .select('*')
      .eq('project_id', project.id)
      .order('name');

    if (categoryData) {
      setCategories(categoryData as CanonicalCategory[]);
    }

    // Load entity counts - use count queries to avoid 1000 row limit
    const [customersCount, ordersCount] = await Promise.all([
      supabase.from('canonical_customers').select('*', { count: 'exact', head: true }).eq('project_id', project.id),
      supabase.from('canonical_orders').select('*', { count: 'exact', head: true }).eq('project_id', project.id),
    ]);

    setEntityCounts({
      categories: categoryData?.length || 0,
      customers: customersCount.count || 0,
      orders: ordersCount.count || 0,
    });

    setLoading(false);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === categories.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(categories.map(c => c.id)));
    }
  };

  const updateCategory = async (id: string, updates: Partial<CanonicalCategory>) => {
    const { error } = await supabase
      .from('canonical_categories')
      .update(updates)
      .eq('id', id);

    if (!error) {
      setCategories(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
    }
  };

  const handleExcludeSelected = async () => {
    setSaving(true);
    for (const id of selectedIds) {
      await updateCategory(id, { exclude: true });
    }
    setSelectedIds(new Set());
    setSaving(false);
  };

  const handleSaveAndContinue = async () => {
    setSaving(true);
    await onUpdateProject({ status: 'mapped' });
    setSaving(false);
    onNext();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (forecastLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-semibold mb-2">Data Mapping</h2>
        <p className="text-muted-foreground">
          Tilpas hvordan DanDomain data omdannes til Shopify format
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="products" className="gap-2">
            <Package className="w-4 h-4" />
            <span className="hidden sm:inline">Produkter</span>
            <Badge variant="secondary" className="ml-1">{stats.uniqueProducts}</Badge>
          </TabsTrigger>
          <TabsTrigger value="categories" className="gap-2">
            <Folder className="w-4 h-4" />
            <span className="hidden sm:inline">Kategorier</span>
            <Badge variant="secondary" className="ml-1">{entityCounts.categories}</Badge>
          </TabsTrigger>
          <TabsTrigger value="customers" className="gap-2">
            <Users className="w-4 h-4" />
            <span className="hidden sm:inline">Kunder</span>
            <Badge variant="secondary" className="ml-1">{entityCounts.customers}</Badge>
          </TabsTrigger>
          <TabsTrigger value="orders" className="gap-2">
            <ShoppingCart className="w-4 h-4" />
            <span className="hidden sm:inline">Ordrer</span>
            <Badge variant="secondary" className="ml-1">{entityCounts.orders}</Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="mt-6 space-y-6">
          {forecastError && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4">
              <p className="text-sm text-destructive">
                Kunne ikke beregne forecast: {forecastError}
              </p>
            </div>
          )}
          
          {/* Product Statistics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">Linjer i filen</p>
              <p className="text-2xl font-semibold">{stats.totalLines.toLocaleString('da-DK')}</p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">Shopify produkter</p>
              <p className="text-2xl font-semibold">{stats.uniqueProducts.toLocaleString('da-DK')}</p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">Varianter i alt</p>
              <p className="text-2xl font-semibold">{stats.totalVariants.toLocaleString('da-DK')}</p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">Gns. varianter pr. produkt</p>
              <p className="text-2xl font-semibold">{stats.avgVariants.toFixed(1)}</p>
            </Card>
          </div>

          <div className="flex justify-center">
            <Button onClick={() => refreshForecast(true)}>
              Opdater forecast
            </Button>
          </div>
          <ProductMappingTab projectId={project.id} />
        </TabsContent>

        <TabsContent value="categories" className="mt-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">Kategorier</CardTitle>
                  <CardDescription>
                    Hver kategori bliver til et Shopify tag og en Smart Collection
                  </CardDescription>
                </div>
                {selectedIds.size > 0 && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleExcludeSelected}
                      disabled={saving}
                    >
                      Ekskluder valgte ({selectedIds.size})
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {categories.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Folder className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>Ingen kategorier fundet</p>
                  <p className="text-sm">Kategorier udtrækkes automatisk fra produkternes PROD_CAT_ID</p>
                </div>
              ) : (
                <div className="border rounded-lg overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">
                          <Checkbox
                            checked={selectedIds.size === categories.length}
                            onCheckedChange={toggleSelectAll}
                          />
                        </TableHead>
                        <TableHead className="w-20">ID</TableHead>
                        <TableHead>DanDomain Kategori</TableHead>
                        <TableHead>Shopify Tag</TableHead>
                        <TableHead className="w-24">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {categories.map(category => (
                        <TableRow 
                          key={category.id}
                          className={category.exclude ? 'opacity-50' : ''}
                        >
                          <TableCell>
                            <Checkbox
                              checked={selectedIds.has(category.id)}
                              onCheckedChange={() => toggleSelect(category.id)}
                            />
                          </TableCell>
                          <TableCell>
                            <span className="font-mono text-xs text-muted-foreground">
                              {category.external_id}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Folder className="w-4 h-4 text-muted-foreground" />
                              <span className="font-medium">{category.name}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <ArrowRight className="w-4 h-4 text-muted-foreground" />
                              <Input
                                value={category.shopify_tag || ''}
                                onChange={(e) => updateCategory(category.id, { shopify_tag: e.target.value })}
                                className="h-8 w-48"
                                disabled={category.exclude}
                              />
                              <Tag className="w-4 h-4 text-primary" />
                            </div>
                          </TableCell>
                          <TableCell>
                            {category.exclude ? (
                              <Badge variant="secondary">Ekskluderet</Badge>
                            ) : (
                              <Badge variant="outline">Aktiv</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="customers" className="mt-6">
          <CustomerPreviewTab projectId={project.id} />
        </TabsContent>

        <TabsContent value="orders" className="mt-6">
          <OrderPreviewTab projectId={project.id} />
        </TabsContent>
      </Tabs>

      <div className="flex justify-end gap-3 pt-4">
        <Button onClick={handleSaveAndContinue} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Gemmer...
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              Gem og fortsæt
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
