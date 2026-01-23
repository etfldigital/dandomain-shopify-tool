import { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { 
  Loader2, 
  Package, 
  Users, 
  ShoppingCart, 
  Folder,
  FileText,
  CheckCircle2,
  ExternalLink,
  Search,
  Eye,
  Image as ImageIcon,
  Tag,
  DollarSign,
  Hash,
  MapPin,
  Mail,
  Phone,
  Calendar,
  Truck,
  CreditCard,
} from 'lucide-react';
import { Project, EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface ReviewStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

interface EntityStats {
  total: number;
  pending: number;
  uploaded: number;
  failed: number;
}

interface ProductPreview {
  id: string;
  external_id: string;
  shopify_id: string | null;
  title: string;
  vendor: string;
  sku: string;
  price: string;
  stock: number;
  images: string[];
  variants: { sku: string; option: string; price: string }[];
  status: string;
}

interface CustomerPreview {
  id: string;
  external_id: string;
  shopify_id: string | null;
  name: string;
  email: string;
  phone: string;
  address: {
    address1: string;
    city: string;
    zip: string;
    country: string;
  } | null;
  status: string;
}

interface OrderPreview {
  id: string;
  external_id: string;
  shopify_id: string | null;
  orderNumber: string;
  customerEmail: string;
  totalPrice: string;
  lineItemsCount: number;
  financialStatus: string;
  fulfillmentStatus: string;
  createdAt: string;
  status: string;
}

interface CategoryPreview {
  id: string;
  external_id: string;
  shopify_id: string | null;
  name: string;
  slug: string | null;
  parentId: string | null;
  status: string;
}

/**
 * REVIEW STEP - READ-ONLY PREVIEW
 * 
 * This step is intentionally read-only. It shows exactly how entities 
 * WILL appear (or already appear) in Shopify.
 * 
 * NO corrective logic, NO merge decisions, NO data modifications.
 * If something looks wrong, the fix belongs in earlier steps.
 */
export function ReviewStep({ project, onUpdateProject, onNext }: ReviewStepProps) {
  const [activeTab, setActiveTab] = useState<EntityType>('products');
  const [loading, setLoading] = useState<EntityType | null>(null);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Entity data
  const [products, setProducts] = useState<ProductPreview[]>([]);
  const [customers, setCustomers] = useState<CustomerPreview[]>([]);
  const [orders, setOrders] = useState<OrderPreview[]>([]);
  const [categories, setCategories] = useState<CategoryPreview[]>([]);
  
  // Stats
  const [stats, setStats] = useState<Record<EntityType, EntityStats>>({
    products: { total: 0, pending: 0, uploaded: 0, failed: 0 },
    customers: { total: 0, pending: 0, uploaded: 0, failed: 0 },
    orders: { total: 0, pending: 0, uploaded: 0, failed: 0 },
    categories: { total: 0, pending: 0, uploaded: 0, failed: 0 },
    pages: { total: 0, pending: 0, uploaded: 0, failed: 0 },
  });

  // Detail dialog
  const [selectedProduct, setSelectedProduct] = useState<ProductPreview | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerPreview | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<OrderPreview | null>(null);

  // Load stats on mount
  useEffect(() => {
    loadAllStats();
  }, [project.id]);

  // Load entity data when tab changes
  useEffect(() => {
    loadEntityData(activeTab);
  }, [activeTab, project.id]);

  const loadAllStats = async () => {
    const entityTypes: EntityType[] = ['products', 'customers', 'orders', 'categories', 'pages'];
    const newStats: Record<EntityType, EntityStats> = { ...stats };

    await Promise.all(entityTypes.map(async (entityType) => {
      const tableName = entityType === 'categories' 
        ? 'canonical_categories' 
        : `canonical_${entityType}` as const;

      const [totalRes, pendingRes, uploadedRes, failedRes] = await Promise.all([
        supabase.from(tableName).select('*', { count: 'exact', head: true }).eq('project_id', project.id),
        supabase.from(tableName).select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'pending'),
        supabase.from(tableName).select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'uploaded'),
        supabase.from(tableName).select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'failed'),
      ]);

      newStats[entityType] = {
        total: totalRes.count || 0,
        pending: pendingRes.count || 0,
        uploaded: uploadedRes.count || 0,
        failed: failedRes.count || 0,
      };
    }));

    setStats(newStats);
  };

  const loadEntityData = async (entityType: EntityType) => {
    setLoading(entityType);
    
    try {
      if (entityType === 'products') {
        // Fetch uploaded products grouped by shopify_id
        const { data, error } = await supabase
          .from('canonical_products')
          .select('id, external_id, shopify_id, data, status')
          .eq('project_id', project.id)
          .order('updated_at', { ascending: false })
          .limit(500);

        if (error) throw error;

        // Group by shopify_id to show as single products with variants
        const productMap = new Map<string, ProductPreview>();
        
        for (const item of data || []) {
          const d = (item.data || {}) as Record<string, any>;
          const shopifyId = item.shopify_id || item.id;
          
          if (productMap.has(shopifyId)) {
            // Add as variant
            const existing = productMap.get(shopifyId)!;
            const variantSize = extractSizeFromData(d);
            if (variantSize) {
              existing.variants.push({
                sku: d.sku || '',
                option: variantSize,
                price: d.price || '0',
              });
            }
          } else {
            // New product
            const variantSize = extractSizeFromData(d);
            productMap.set(shopifyId, {
              id: item.id,
              external_id: item.external_id,
              shopify_id: item.shopify_id,
              title: d.title || 'Untitled',
              vendor: d.vendor || '',
              sku: d.sku || '',
              price: d.price || '0',
              stock: d.stock_quantity || 0,
              images: d.images || [],
              variants: variantSize ? [{ sku: d.sku || '', option: variantSize, price: d.price || '0' }] : [],
              status: item.status,
            });
          }
        }

        setProducts(Array.from(productMap.values()));
      }
      else if (entityType === 'customers') {
        const { data, error } = await supabase
          .from('canonical_customers')
          .select('id, external_id, shopify_id, data, status')
          .eq('project_id', project.id)
          .order('updated_at', { ascending: false })
          .limit(500);

        if (error) throw error;

        setCustomers((data || []).map(item => {
          const d = (item.data || {}) as Record<string, any>;
          return {
            id: item.id,
            external_id: item.external_id,
            shopify_id: item.shopify_id,
            name: `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Ukendt',
            email: d.email || '',
            phone: d.phone || '',
            address: d.address ? {
              address1: d.address.address1 || d.address.street || '',
              city: d.address.city || '',
              zip: d.address.zip || d.address.postal_code || '',
              country: d.address.country || 'DK',
            } : null,
            status: item.status,
          };
        }));
      }
      else if (entityType === 'orders') {
        const { data, error } = await supabase
          .from('canonical_orders')
          .select('id, external_id, shopify_id, data, status')
          .eq('project_id', project.id)
          .order('updated_at', { ascending: false })
          .limit(500);

        if (error) throw error;

        setOrders((data || []).map(item => {
          const d = (item.data || {}) as Record<string, any>;
          return {
            id: item.id,
            external_id: item.external_id,
            shopify_id: item.shopify_id,
            orderNumber: d.order_number || item.external_id,
            customerEmail: d.customer_email || d.email || '',
            totalPrice: d.total_price || '0',
            lineItemsCount: (d.line_items || []).length,
            financialStatus: d.financial_status || 'pending',
            fulfillmentStatus: d.fulfillment_status || 'unfulfilled',
            createdAt: d.created_at || '',
            status: item.status,
          };
        }));
      }
      else if (entityType === 'categories') {
        const { data, error } = await supabase
          .from('canonical_categories')
          .select('id, external_id, name, slug, parent_external_id, shopify_collection_id, status')
          .eq('project_id', project.id)
          .order('name', { ascending: true })
          .limit(500);

        if (error) throw error;

        setCategories((data || []).map(item => ({
          id: item.id,
          external_id: item.external_id,
          shopify_id: item.shopify_collection_id,
          name: item.name,
          slug: item.slug,
          parentId: item.parent_external_id,
          status: item.status,
        })));
      }
    } catch (error) {
      console.error(`Error loading ${entityType}:`, error);
      toast.error(`Fejl ved indlæsning af ${entityType}`);
    } finally {
      setLoading(null);
    }
  };

  // Filter data based on search query
  const filteredProducts = useMemo(() => {
    if (!searchQuery) return products;
    const q = searchQuery.toLowerCase();
    return products.filter(p => 
      p.title.toLowerCase().includes(q) ||
      p.sku.toLowerCase().includes(q) ||
      p.vendor.toLowerCase().includes(q) ||
      p.shopify_id?.includes(q)
    );
  }, [products, searchQuery]);

  const filteredCustomers = useMemo(() => {
    if (!searchQuery) return customers;
    const q = searchQuery.toLowerCase();
    return customers.filter(c => 
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      c.shopify_id?.includes(q)
    );
  }, [customers, searchQuery]);

  const filteredOrders = useMemo(() => {
    if (!searchQuery) return orders;
    const q = searchQuery.toLowerCase();
    return orders.filter(o => 
      o.orderNumber.toLowerCase().includes(q) ||
      o.customerEmail.toLowerCase().includes(q) ||
      o.shopify_id?.includes(q)
    );
  }, [orders, searchQuery]);

  const filteredCategories = useMemo(() => {
    if (!searchQuery) return categories;
    const q = searchQuery.toLowerCase();
    return categories.filter(c => 
      c.name.toLowerCase().includes(q) ||
      c.slug?.toLowerCase().includes(q)
    );
  }, [categories, searchQuery]);

  const handleContinue = async () => {
    setSaving(true);
    await onUpdateProject({ status: 'completed' });
    setSaving(false);
    onNext();
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'uploaded':
        return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">I Shopify</Badge>;
      case 'pending':
        return <Badge variant="secondary">Afventer</Badge>;
      case 'failed':
        return <Badge variant="destructive">Fejlet</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const entityIcons: Record<EntityType, React.ReactNode> = {
    products: <Package className="w-4 h-4" />,
    customers: <Users className="w-4 h-4" />,
    orders: <ShoppingCart className="w-4 h-4" />,
    categories: <Folder className="w-4 h-4" />,
    pages: <FileText className="w-4 h-4" />,
  };

  const shopifyDomain = project.shopify_store_domain?.replace('.myshopify.com', '');

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="text-center mb-8">
        <h2 className="text-2xl font-semibold mb-2">Review</h2>
        <p className="text-muted-foreground">
          Gennemgå dine data før afslutning. Dette er en read-only preview.
        </p>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {(['products', 'customers', 'orders', 'categories', 'pages'] as EntityType[]).map(entityType => (
          <Card 
            key={entityType} 
            className={`cursor-pointer transition-colors ${activeTab === entityType ? 'border-primary ring-1 ring-primary' : 'hover:border-muted-foreground/30'}`}
            onClick={() => setActiveTab(entityType)}
          >
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-2">
                {entityIcons[entityType]}
                <span className="text-sm font-medium capitalize">{entityType}</span>
              </div>
              <div className="text-2xl font-bold">{stats[entityType].total}</div>
              <div className="flex gap-2 mt-1 text-xs">
                <span className="text-green-600">{stats[entityType].uploaded} ✓</span>
                {stats[entityType].pending > 0 && (
                  <span className="text-muted-foreground">{stats[entityType].pending} afventer</span>
                )}
                {stats[entityType].failed > 0 && (
                  <span className="text-destructive">{stats[entityType].failed} fejl</span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Content */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                {entityIcons[activeTab]}
                <span className="capitalize">{activeTab}</span>
                {loading === activeTab && <Loader2 className="w-4 h-4 animate-spin" />}
              </CardTitle>
              <CardDescription>
                Preview af data som de vises i Shopify
              </CardDescription>
            </div>
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Søg..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[500px]">
            {/* Products Table */}
            {activeTab === 'products' && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12"></TableHead>
                    <TableHead>Produkt</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Varianter</TableHead>
                    <TableHead className="text-right">Pris</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredProducts.map(product => (
                    <TableRow key={product.id}>
                      <TableCell>
                        {product.images.length > 0 ? (
                          <img 
                            src={product.images[0]} 
                            alt="" 
                            className="w-10 h-10 object-cover rounded"
                            onError={(e) => { e.currentTarget.style.display = 'none'; }}
                          />
                        ) : (
                          <div className="w-10 h-10 bg-muted rounded flex items-center justify-center">
                            <ImageIcon className="w-4 h-4 text-muted-foreground" />
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{product.title}</div>
                        {product.vendor && (
                          <div className="text-xs text-muted-foreground">{product.vendor}</div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{product.sku}</TableCell>
                      <TableCell>
                        {product.variants.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {product.variants.slice(0, 5).map((v, i) => (
                              <Badge key={i} variant="outline" className="text-xs">
                                {v.option}
                              </Badge>
                            ))}
                            {product.variants.length > 5 && (
                              <Badge variant="secondary" className="text-xs">
                                +{product.variants.length - 5}
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">{product.price} kr</TableCell>
                      <TableCell>{getStatusBadge(product.status)}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button 
                            variant="ghost" 
                            size="sm"
                            onClick={() => setSelectedProduct(product)}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                          {product.shopify_id && shopifyDomain && (
                            <a
                              href={`https://admin.shopify.com/store/${shopifyDomain}/products/${product.shopify_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Button variant="ghost" size="sm">
                                <ExternalLink className="w-4 h-4" />
                              </Button>
                            </a>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredProducts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        {searchQuery ? 'Ingen produkter matcher søgningen' : 'Ingen produkter fundet'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}

            {/* Customers Table */}
            {activeTab === 'customers' && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kunde</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Telefon</TableHead>
                    <TableHead>Adresse</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCustomers.map(customer => (
                    <TableRow key={customer.id}>
                      <TableCell className="font-medium">{customer.name}</TableCell>
                      <TableCell className="text-sm">{customer.email}</TableCell>
                      <TableCell className="text-sm font-mono">{customer.phone || '-'}</TableCell>
                      <TableCell className="text-sm">
                        {customer.address ? (
                          <span>{customer.address.city}, {customer.address.country}</span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>{getStatusBadge(customer.status)}</TableCell>
                      <TableCell>
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => setSelectedCustomer(customer)}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredCustomers.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        {searchQuery ? 'Ingen kunder matcher søgningen' : 'Ingen kunder fundet'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}

            {/* Orders Table */}
            {activeTab === 'orders' && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ordre</TableHead>
                    <TableHead>Kunde</TableHead>
                    <TableHead>Varer</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Betaling</TableHead>
                    <TableHead>Levering</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredOrders.map(order => (
                    <TableRow key={order.id}>
                      <TableCell className="font-mono font-medium">#{order.orderNumber}</TableCell>
                      <TableCell className="text-sm">{order.customerEmail || '-'}</TableCell>
                      <TableCell>{order.lineItemsCount} varer</TableCell>
                      <TableCell className="text-right font-mono">{order.totalPrice} kr</TableCell>
                      <TableCell>
                        <Badge variant={order.financialStatus === 'paid' ? 'default' : 'secondary'} className="text-xs">
                          {order.financialStatus}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={order.fulfillmentStatus === 'fulfilled' ? 'default' : 'outline'} className="text-xs">
                          {order.fulfillmentStatus || 'unfulfilled'}
                        </Badge>
                      </TableCell>
                      <TableCell>{getStatusBadge(order.status)}</TableCell>
                    </TableRow>
                  ))}
                  {filteredOrders.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        {searchQuery ? 'Ingen ordrer matcher søgningen' : 'Ingen ordrer fundet'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}

            {/* Categories Table */}
            {activeTab === 'categories' && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Navn</TableHead>
                    <TableHead>Handle</TableHead>
                    <TableHead>Shopify ID</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCategories.map(category => (
                    <TableRow key={category.id}>
                      <TableCell className="font-medium">{category.name}</TableCell>
                      <TableCell className="font-mono text-sm text-muted-foreground">
                        {category.slug || '-'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {category.shopify_id || '-'}
                      </TableCell>
                      <TableCell>{getStatusBadge(category.status)}</TableCell>
                    </TableRow>
                  ))}
                  {filteredCategories.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                        {searchQuery ? 'Ingen kategorier matcher søgningen' : 'Ingen kategorier fundet'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}

            {/* Pages placeholder */}
            {activeTab === 'pages' && (
              <div className="text-center py-12 text-muted-foreground">
                <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>Sider preview kommer snart</p>
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Continue Button */}
      <div className="flex justify-between gap-3 pt-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="w-4 h-4 text-green-500" />
          Upload gennemført - review dine data før afslutning
        </div>
        <Button onClick={handleContinue} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Gemmer...
            </>
          ) : (
            'Afslut og gå til rapport'
          )}
        </Button>
      </div>

      {/* Product Detail Dialog */}
      <Dialog open={selectedProduct !== null} onOpenChange={() => setSelectedProduct(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="w-5 h-5" />
              {selectedProduct?.title}
            </DialogTitle>
            <DialogDescription>
              Shopify produkt preview
            </DialogDescription>
          </DialogHeader>
          
          {selectedProduct && (
            <div className="space-y-4">
              {/* Images */}
              {selectedProduct.images.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {selectedProduct.images.slice(0, 5).map((img, i) => (
                    <img 
                      key={i}
                      src={img} 
                      alt="" 
                      className="w-20 h-20 object-cover rounded border"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  ))}
                </div>
              )}

              {/* Details */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <Tag className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Vendor:</span>
                  <span className="font-medium">{selectedProduct.vendor || '-'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Hash className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground">SKU:</span>
                  <span className="font-mono">{selectedProduct.sku}</span>
                </div>
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Pris:</span>
                  <span className="font-mono">{selectedProduct.price} kr</span>
                </div>
                <div className="flex items-center gap-2">
                  <Package className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Lager:</span>
                  <span>{selectedProduct.stock} stk</span>
                </div>
              </div>

              {/* Variants */}
              {selectedProduct.variants.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">Varianter ({selectedProduct.variants.length})</h4>
                  <div className="flex flex-wrap gap-2">
                    {selectedProduct.variants.map((v, i) => (
                      <Badge key={i} variant="outline">
                        {v.option} - {v.price} kr
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Shopify Link */}
              {selectedProduct.shopify_id && shopifyDomain && (
                <a
                  href={`https://admin.shopify.com/store/${shopifyDomain}/products/${selectedProduct.shopify_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-primary hover:underline"
                >
                  <ExternalLink className="w-4 h-4" />
                  Åbn i Shopify Admin
                </a>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Customer Detail Dialog */}
      <Dialog open={selectedCustomer !== null} onOpenChange={() => setSelectedCustomer(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              {selectedCustomer?.name}
            </DialogTitle>
            <DialogDescription>
              Shopify kunde preview
            </DialogDescription>
          </DialogHeader>
          
          {selectedCustomer && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-muted-foreground" />
                <span>{selectedCustomer.email}</span>
              </div>
              {selectedCustomer.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4 text-muted-foreground" />
                  <span>{selectedCustomer.phone}</span>
                </div>
              )}
              {selectedCustomer.address && (
                <div className="flex items-start gap-2">
                  <MapPin className="w-4 h-4 text-muted-foreground mt-0.5" />
                  <div>
                    <div>{selectedCustomer.address.address1}</div>
                    <div>{selectedCustomer.address.zip} {selectedCustomer.address.city}</div>
                    <div>{selectedCustomer.address.country}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Helper function to extract size from product data
function extractSizeFromData(data: any): string | null {
  if (data.variant_option && data.variant_option !== 'Default Title') {
    return data.variant_option;
  }
  
  const sku = data.sku || '';
  if (!sku) return null;
  
  const parts = sku.split('-');
  const lastPart = parts[parts.length - 1]?.toUpperCase();
  
  // Check if it's a valid size
  const sizePatterns = /^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|\d{2}|\d{2}-\d{2}|ONE-?SIZE)$/i;
  if (lastPart && sizePatterns.test(lastPart)) {
    return lastPart;
  }
  
  return null;
}
