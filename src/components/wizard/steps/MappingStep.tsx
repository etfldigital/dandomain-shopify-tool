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
import { Loader2, Save, ArrowRight, Folder, Tag, Package, ShoppingCart, Users, FileText, Eye } from 'lucide-react';
import { Project, CanonicalCategory } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { ProductMappingTab } from './ProductMappingTab';
import { ReviewPreviewTab } from './ReviewPreviewTab';

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
  const [entityCounts, setEntityCounts] = useState({
    products: 0,
    categories: 0,
    customers: 0,
    orders: 0,
    pages: 0,
  });

  useEffect(() => {
    loadData();
  }, [project.id]);

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

    // Load entity counts
    const [productsCount, customersCount, ordersCount, pagesCount] = await Promise.all([
      supabase.from('canonical_products').select('*', { count: 'exact', head: true }).eq('project_id', project.id),
      supabase.from('canonical_customers').select('*', { count: 'exact', head: true }).eq('project_id', project.id),
      supabase.from('canonical_orders').select('*', { count: 'exact', head: true }).eq('project_id', project.id),
      supabase.from('canonical_pages').select('*', { count: 'exact', head: true }).eq('project_id', project.id),
    ]);

    setEntityCounts({
      products: productsCount.count || 0,
      categories: categoryData?.length || 0,
      customers: customersCount.count || 0,
      orders: ordersCount.count || 0,
      pages: pagesCount.count || 0,
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

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-semibold mb-2">Data Mapping</h2>
        <p className="text-muted-foreground">
          Tilpas hvordan DanDomain data omdannes til Shopify format
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="products" className="gap-2">
            <Package className="w-4 h-4" />
            <span className="hidden sm:inline">Produkter</span>
            <Badge variant="secondary" className="ml-1">{entityCounts.products}</Badge>
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
          <TabsTrigger value="pages" className="gap-2">
            <FileText className="w-4 h-4" />
            <span className="hidden sm:inline">Sider</span>
            <Badge variant="secondary" className="ml-1">{entityCounts.pages}</Badge>
          </TabsTrigger>
          <TabsTrigger value="preview" className="gap-2">
            <Eye className="w-4 h-4" />
            <span className="hidden sm:inline">Preview</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="mt-6">
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
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Kunder</CardTitle>
              <CardDescription>
                Kunder mappes automatisk til Shopify - ingen yderligere konfiguration nødvendig
              </CardDescription>
            </CardHeader>
            <CardContent>
              {entityCounts.customers === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>Ingen kunder fundet</p>
                  <p className="text-sm">Upload en kunder CSV-fil i Upload-trinnet</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <Card>
                      <CardContent className="pt-4">
                        <div className="text-2xl font-bold">{entityCounts.customers}</div>
                        <div className="text-sm text-muted-foreground">Kunder i alt</div>
                      </CardContent>
                    </Card>
                  </div>

                  <Card className="bg-muted/30">
                    <CardContent className="pt-4">
                      <h4 className="text-sm font-medium mb-3">Automatisk felt-mapping</h4>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">CUST_EMAIL</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Email</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">CUST_NAME</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Navn</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">CUST_PHONE</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Telefon</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">CUST_ADDRESS</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Adresse</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">CUST_CITY</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>By</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">CUST_ZIP</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Postnummer</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orders" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Ordrer</CardTitle>
              <CardDescription>
                Ordrer mappes automatisk til Shopify - kræver at kunder er uploadet først
              </CardDescription>
            </CardHeader>
            <CardContent>
              {entityCounts.orders === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <ShoppingCart className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>Ingen ordrer fundet</p>
                  <p className="text-sm">Upload en ordrer CSV-fil i Upload-trinnet</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <Card>
                      <CardContent className="pt-4">
                        <div className="text-2xl font-bold">{entityCounts.orders}</div>
                        <div className="text-sm text-muted-foreground">Ordrer i alt</div>
                      </CardContent>
                    </Card>
                  </div>

                  <Card className="bg-muted/30">
                    <CardContent className="pt-4">
                      <h4 className="text-sm font-medium mb-3">Automatisk felt-mapping</h4>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">ORDER_ID</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Ordre nummer</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">ORDER_DATE</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Oprettelsesdato</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">ORDER_TOTAL</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Total</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">CUST_EMAIL</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Kunde (via email)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">ORDER_STATUS</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Financial status</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30">
                    <CardContent className="pt-4">
                      <div className="flex items-start gap-2">
                        <ShoppingCart className="w-5 h-5 text-amber-600 mt-0.5" />
                        <div>
                          <p className="font-medium text-amber-800 dark:text-amber-200">Vigtigt: Ordre-upload afhængigheder</p>
                          <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                            Ordrer uploades sidst da de kræver at kunder allerede findes i Shopify. 
                            Ordrer linkes til kunder via email-adresse.
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pages" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Sider</CardTitle>
              <CardDescription>
                CMS-sider mappes automatisk til Shopify Pages
              </CardDescription>
            </CardHeader>
            <CardContent>
              {entityCounts.pages === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>Ingen sider fundet</p>
                  <p className="text-sm">Upload en sider CSV-fil i Upload-trinnet</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <Card>
                      <CardContent className="pt-4">
                        <div className="text-2xl font-bold">{entityCounts.pages}</div>
                        <div className="text-sm text-muted-foreground">Sider i alt</div>
                      </CardContent>
                    </Card>
                  </div>

                  <Card className="bg-muted/30">
                    <CardContent className="pt-4">
                      <h4 className="text-sm font-medium mb-3">Automatisk felt-mapping</h4>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">PAGE_TITLE</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Titel</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">PAGE_CONTENT</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Body HTML</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">PAGE_HANDLE</Badge>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span>Handle (URL)</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="preview" className="mt-6">
          <ReviewPreviewTab projectId={project.id} shopifyDomain={project.shopify_store_domain} />
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
