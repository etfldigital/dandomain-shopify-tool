import { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
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
  RefreshCw,
  AlertTriangle,
  Layers,
  BarChart3,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface ReviewPreviewTabProps {
  projectId: string;
  shopifyDomain?: string | null;
}

interface EntityStats {
  total: number;
  pending: number;
  mapped: number;
  uploaded: number;
  failed: number;
  primaryProducts?: number;
  totalVariants?: number;
}

// Product data from database (with _mergedVariants)
interface ProductData {
  title: string;
  vendor: string;
  sku: string;
  price: string;
  compare_at_price?: string;
  stock_quantity: number;
  images: string[];
  body_html?: string;
  tags?: string;
  barcode?: string;
  weight?: number;
  meta_title?: string;
  meta_description?: string;
  categories?: string[];
  // Variant grouping metadata
  _isPrimary?: boolean;
  _variantCount?: number;
  _mergedVariants?: MergedVariant[];
  variant_option?: string;
  // Metafields
  field_1?: string; // Materiale
  field_2?: string; // Farve
  field_3?: string; // Pasform
  field_9?: string; // Vaskeanvisning
}

interface MergedVariant {
  id: string;
  external_id: string;
  sku: string;
  price: string;
  compare_at_price?: string;
  stock_quantity: number;
  barcode?: string;
  option1: string;
  images?: string[];
}

interface ProductPreview {
  id: string;
  external_id: string;
  shopify_id: string | null;
  data: ProductData;
  status: string;
  variantCount: number;
  variants: MergedVariant[];
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
  shopify_tag: string | null;
  status: string;
}

/**
 * REVIEW PREVIEW TAB - SHOPIFY-IDENTICAL PREVIEW
 * 
 * This component shows how products will appear in Shopify AFTER upload.
 * It reads _mergedVariants directly from the database (set by prepare-upload)
 * to ensure the preview exactly matches what will be uploaded.
 * 
 * KEY CHANGE: No manual grouping - we trust the prepare-upload output.
 */
export function ReviewPreviewTab({ projectId, shopifyDomain }: ReviewPreviewTabProps) {
  const [activeEntityTab, setActiveEntityTab] = useState<EntityType>('products');
  const [loading, setLoading] = useState<EntityType | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Entity data
  const [products, setProducts] = useState<ProductPreview[]>([]);
  const [customers, setCustomers] = useState<CustomerPreview[]>([]);
  const [orders, setOrders] = useState<OrderPreview[]>([]);
  const [categories, setCategories] = useState<CategoryPreview[]>([]);
  
  // Stats
  const [stats, setStats] = useState<Record<EntityType, EntityStats>>({
    products: { total: 0, pending: 0, mapped: 0, uploaded: 0, failed: 0 },
    customers: { total: 0, pending: 0, mapped: 0, uploaded: 0, failed: 0 },
    orders: { total: 0, pending: 0, mapped: 0, uploaded: 0, failed: 0 },
    categories: { total: 0, pending: 0, mapped: 0, uploaded: 0, failed: 0 },
    pages: { total: 0, pending: 0, mapped: 0, uploaded: 0, failed: 0 },
  });

  // Detail dialogs
  const [selectedProduct, setSelectedProduct] = useState<ProductPreview | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerPreview | null>(null);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  // Load stats on mount
  useEffect(() => {
    loadAllStats();
    loadEntityData('products');
  }, [projectId]);

  const loadAllStats = async () => {
    const entityTypes: EntityType[] = ['products', 'customers', 'orders', 'categories', 'pages'];
    const newStats: Record<EntityType, EntityStats> = { ...stats };

    await Promise.all(entityTypes.map(async (entityType) => {
      const tableName = entityType === 'categories' 
        ? 'canonical_categories' 
        : `canonical_${entityType}` as const;

      const [totalRes, pendingRes, mappedRes, uploadedRes, failedRes] = await Promise.all([
        supabase.from(tableName).select('*', { count: 'exact', head: true }).eq('project_id', projectId),
        supabase.from(tableName).select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'pending'),
        supabase.from(tableName).select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'mapped'),
        supabase.from(tableName).select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'uploaded'),
        supabase.from(tableName).select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'failed'),
      ]);

      // For products, also count primary products (unique Shopify products to be created)
      let primaryCount = 0;
      if (entityType === 'products') {
        const { count } = await supabase.from('canonical_products')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', projectId)
          .eq('data->>_isPrimary', 'true');
        primaryCount = count || 0;
      }

      newStats[entityType] = {
        total: totalRes.count || 0,
        pending: pendingRes.count || 0,
        mapped: mappedRes.count || 0,
        uploaded: uploadedRes.count || 0,
        failed: failedRes.count || 0,
        ...(entityType === 'products' && { primaryProducts: primaryCount }),
      };
    }));

    setStats(newStats);
  };

  const loadEntityData = async (entityType: EntityType) => {
    setLoading(entityType);
    setActiveEntityTab(entityType);
    setSearchQuery('');
    
    try {
      if (entityType === 'products') {
        // CRITICAL: Only fetch PRIMARY products (where _isPrimary = true)
        // These are the actual Shopify products that will be created
        // Their _mergedVariants array contains all the variant data
        const { data, error } = await supabase
          .from('canonical_products')
          .select('id, external_id, shopify_id, data, status')
          .eq('project_id', projectId)
          .or('data->>_isPrimary.eq.true,and(status.eq.pending,data->>_isPrimary.is.null)')
          .order('updated_at', { ascending: false })
          .limit(500);

        if (error) throw error;

        const mappedProducts: ProductPreview[] = (data || []).map(item => {
          const d = (item.data || {}) as unknown as ProductData;
          const mergedVariants = d._mergedVariants || [];
          const variantCount = d._variantCount || 1;
          
          // Build variants array from _mergedVariants or create single variant
          let variants: MergedVariant[] = [];
          if (mergedVariants.length > 0) {
            variants = mergedVariants;
          } else {
            // Single variant product - create from main data
            variants = [{
              id: item.id,
              external_id: item.external_id,
              sku: d.sku || '',
              price: d.price || '0',
              compare_at_price: d.compare_at_price,
              stock_quantity: d.stock_quantity || 0,
              barcode: d.barcode,
              option1: d.variant_option || 'ONE-SIZE',
            }];
          }

          return {
            id: item.id,
            external_id: item.external_id,
            shopify_id: item.shopify_id,
            data: d,
            status: item.status,
            variantCount,
            variants,
          };
        });

        setProducts(mappedProducts);
        
        // Calculate total variants for stats display
        const totalVariants = mappedProducts.reduce((sum, p) => sum + p.variants.length, 0);
        setStats(prev => ({
          ...prev,
          products: { ...prev.products, totalVariants },
        }));
      }
      else if (entityType === 'customers') {
        const { data, error } = await supabase
          .from('canonical_customers')
          .select('id, external_id, shopify_id, data, status')
          .eq('project_id', projectId)
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
          .eq('project_id', projectId)
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
          .select('id, external_id, name, slug, parent_external_id, shopify_collection_id, shopify_tag, status')
          .eq('project_id', projectId)
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
          shopify_tag: item.shopify_tag,
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
      p.data.title?.toLowerCase().includes(q) ||
      p.data.sku?.toLowerCase().includes(q) ||
      p.data.vendor?.toLowerCase().includes(q) ||
      p.external_id?.includes(q) ||
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

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'uploaded':
        return <Badge className="bg-accent text-accent-foreground">I Shopify</Badge>;
      case 'mapped':
        return <Badge variant="secondary">Mappet</Badge>;
      case 'pending':
        return <Badge variant="outline">Afventer</Badge>;
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

  const shopifyAdmin = shopifyDomain?.replace('.myshopify.com', '');

  // Calculate summary stats for products
  const productSummary = useMemo(() => {
    const totalRecords = stats.products.total;
    const uniqueProducts = products.length;
    const totalVariants = products.reduce((sum, p) => sum + p.variants.length, 0);
    const avgVariants = uniqueProducts > 0 ? (totalVariants / uniqueProducts).toFixed(2) : '0';
    
    return { totalRecords, uniqueProducts, totalVariants, avgVariants };
  }, [stats.products.total, products]);

  return (
    <div className="space-y-4">
      {/* Migration Summary Panel - Products */}
      {activeEntityTab === 'products' && products.length > 0 && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">Migrerings-overblik</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold">{stats.products.total.toLocaleString('da-DK')}</div>
                <div className="text-xs text-muted-foreground">Linjer i database</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-primary">{products.length.toLocaleString('da-DK')}</div>
                <div className="text-xs text-muted-foreground">Unikke produkter</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">{productSummary.totalVariants.toLocaleString('da-DK')}</div>
                <div className="text-xs text-muted-foreground">Varianter i alt</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">{productSummary.avgVariants}</div>
                <div className="text-xs text-muted-foreground">Gns. varianter/produkt</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {(['products', 'customers', 'orders', 'categories', 'pages'] as EntityType[]).map(entityType => (
          <Card 
            key={entityType} 
            className={`cursor-pointer transition-colors ${activeEntityTab === entityType ? 'border-primary ring-1 ring-primary' : 'hover:border-muted-foreground/30'}`}
            onClick={() => loadEntityData(entityType)}
          >
            <CardContent className="pt-3 pb-2">
              <div className="flex items-center gap-2 mb-1">
                {entityIcons[entityType]}
                <span className="text-xs font-medium capitalize">{entityType}</span>
              </div>
              <div className="text-xl font-bold">{stats[entityType].total}</div>
              <div className="flex gap-2 mt-0.5 text-xs">
                <span className="text-primary">{stats[entityType].uploaded} ✓</span>
                {stats[entityType].pending > 0 && (
                  <span className="text-muted-foreground">{stats[entityType].pending} afv.</span>
                )}
                {stats[entityType].mapped > 0 && (
                  <span className="text-secondary-foreground">{stats[entityType].mapped} klar</span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Content Card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                {entityIcons[activeEntityTab]}
                <span className="capitalize">{activeEntityTab}</span>
                {loading === activeEntityTab && <Loader2 className="w-4 h-4 animate-spin" />}
              </CardTitle>
              <CardDescription className="text-xs">
                {activeEntityTab === 'products' 
                  ? `${products.length} unikke produkter (af ${stats.products.total} records) - sådan vil de se ud i Shopify`
                  : 'Sådan vil data se ud i Shopify'}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => { loadAllStats(); loadEntityData(activeEntityTab); }}
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
              <div className="relative w-48">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Søg..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 h-8 text-sm"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]">
            {/* Products Table */}
            {activeEntityTab === 'products' && (
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
                        {product.data.images && product.data.images.length > 0 ? (
                          <img 
                            src={product.data.images[0]} 
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
                        <div className="font-medium text-sm">{product.data.title || 'Untitled'}</div>
                        {product.data.vendor && (
                          <div className="text-xs text-muted-foreground">{product.data.vendor}</div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{product.data.sku || '-'}</TableCell>
                      <TableCell>
                        {product.variants.length > 1 ? (
                          <div className="flex flex-wrap gap-1">
                            {product.variants.slice(0, 4).map((v, i) => (
                              <Badge key={i} variant="outline" className="text-xs">
                                {v.option1}
                              </Badge>
                            ))}
                            {product.variants.length > 4 && (
                              <Badge variant="secondary" className="text-xs">
                                +{product.variants.length - 4}
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <Badge variant="outline" className="text-xs">
                            {product.variants[0]?.option1 || 'ONE-SIZE'}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {product.data.price || product.variants[0]?.price || '0'} kr
                      </TableCell>
                      <TableCell>{getStatusBadge(product.status)}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button 
                            variant="ghost" 
                            size="sm"
                            onClick={() => {
                              setSelectedProduct(product);
                              setSelectedImageIndex(0);
                            }}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                          {product.shopify_id && shopifyAdmin && (
                            <a
                              href={`https://admin.shopify.com/store/${shopifyAdmin}/products/${product.shopify_id}`}
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
            {activeEntityTab === 'customers' && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kunde</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Telefon</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCustomers.map(customer => (
                    <TableRow key={customer.id}>
                      <TableCell className="font-medium text-sm">{customer.name}</TableCell>
                      <TableCell className="text-sm">{customer.email}</TableCell>
                      <TableCell className="text-sm font-mono">{customer.phone || '-'}</TableCell>
                      <TableCell className="text-sm">
                        {customer.address?.city || '-'}
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
            {activeEntityTab === 'orders' && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ordre</TableHead>
                    <TableHead>Kunde</TableHead>
                    <TableHead>Varer</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Betaling</TableHead>
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
                      <TableCell>{getStatusBadge(order.status)}</TableCell>
                    </TableRow>
                  ))}
                  {filteredOrders.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        {searchQuery ? 'Ingen ordrer matcher søgningen' : 'Ingen ordrer fundet'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}

            {/* Categories Table */}
            {activeEntityTab === 'categories' && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Navn</TableHead>
                    <TableHead>Handle</TableHead>
                    <TableHead>Shopify Tag</TableHead>
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
                        {category.shopify_tag || '-'}
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
            {activeEntityTab === 'pages' && (
              <div className="text-center py-12 text-muted-foreground">
                <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>Sider preview kommer snart</p>
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Shopify-Identical Product Detail Dialog */}
      <Dialog open={selectedProduct !== null} onOpenChange={() => setSelectedProduct(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <Package className="w-5 h-5" />
              {selectedProduct?.data.title || 'Produktdetaljer'}
            </DialogTitle>
          </DialogHeader>
          
          {selectedProduct && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Left Column: Images */}
              <div className="space-y-4">
                {/* Main Image */}
                <div className="aspect-square bg-muted rounded-lg overflow-hidden relative">
                  {selectedProduct.data.images && selectedProduct.data.images.length > 0 ? (
                    <>
                      <img 
                        src={selectedProduct.data.images[selectedImageIndex]} 
                        alt={selectedProduct.data.title}
                        className="w-full h-full object-contain"
                        onError={(e) => { 
                          e.currentTarget.src = '/placeholder.svg';
                        }}
                      />
                      {selectedProduct.data.images.length > 1 && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="absolute left-2 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background"
                            onClick={() => setSelectedImageIndex(i => i > 0 ? i - 1 : selectedProduct.data.images.length - 1)}
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="absolute right-2 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background/95"
                            onClick={() => setSelectedImageIndex(i => i < selectedProduct.data.images.length - 1 ? i + 1 : 0)}
                          >
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        </>
                      )}
                    </>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <ImageIcon className="w-16 h-16 text-muted-foreground/50" />
                    </div>
                  )}
                </div>
                
                {/* Thumbnail Gallery */}
                {selectedProduct.data.images && selectedProduct.data.images.length > 1 && (
                  <div className="flex gap-2 overflow-x-auto pb-2">
                    {selectedProduct.data.images.map((img, i) => (
                      <button
                        key={i}
                        onClick={() => setSelectedImageIndex(i)}
                        className={`flex-shrink-0 w-16 h-16 rounded border-2 overflow-hidden ${
                          i === selectedImageIndex ? 'border-primary' : 'border-transparent'
                        }`}
                      >
                        <img 
                          src={img} 
                          alt="" 
                          className="w-full h-full object-cover"
                          onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Right Column: Product Details */}
              <div className="space-y-6">
                {/* Title & Vendor */}
                <div>
                  <h2 className="text-xl font-bold">{selectedProduct.data.title}</h2>
                  {selectedProduct.data.vendor && (
                    <p className="text-muted-foreground">{selectedProduct.data.vendor}</p>
                  )}
                </div>

                {/* Price */}
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold">
                    {selectedProduct.data.price || selectedProduct.variants[0]?.price || '0'} kr
                  </span>
                  {selectedProduct.data.compare_at_price && (
                    <span className="text-lg text-muted-foreground line-through">
                      {selectedProduct.data.compare_at_price} kr
                    </span>
                  )}
                </div>

                <Separator />

                {/* Variant Options Section */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium">Størrelse</span>
                    </div>
                    <Badge variant="secondary">
                      {selectedProduct.variants.length} variant{selectedProduct.variants.length !== 1 ? 'er' : ''}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedProduct.variants.map((v, i) => (
                      <Badge 
                        key={i} 
                        variant="outline" 
                        className="px-3 py-1.5 text-sm"
                      >
                        {v.option1}
                      </Badge>
                    ))}
                  </div>
                </div>

                <Separator />

                {/* Variant Details Table */}
                <div>
                  <h4 className="font-medium mb-3 flex items-center gap-2">
                    <Hash className="w-4 h-4 text-muted-foreground" />
                    Variant detaljer
                  </h4>
                  <div className="border rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted">
                          <TableHead className="text-xs">Størrelse</TableHead>
                          <TableHead className="text-xs">SKU</TableHead>
                          <TableHead className="text-xs text-right">Pris</TableHead>
                          <TableHead className="text-xs text-right">Lager</TableHead>
                          <TableHead className="text-xs">Barcode</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedProduct.variants.map((v, i) => (
                          <TableRow key={i}>
                            <TableCell className="font-medium">{v.option1}</TableCell>
                            <TableCell className="font-mono text-xs">{v.sku || '-'}</TableCell>
                            <TableCell className="text-right font-mono">{v.price} kr</TableCell>
                            <TableCell className="text-right">{v.stock_quantity || 0}</TableCell>
                            <TableCell className="font-mono text-xs">{v.barcode || '-'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                {/* Tags */}
                {selectedProduct.data.tags && (
                  <div>
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <Tag className="w-4 h-4 text-muted-foreground" />
                      Tags
                    </h4>
                    <div className="flex flex-wrap gap-1">
                      {selectedProduct.data.tags.split(',').map((tag, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">
                          {tag.trim()}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Metafields */}
                {(selectedProduct.data.field_1 || selectedProduct.data.field_2 || 
                  selectedProduct.data.field_3 || selectedProduct.data.field_9) && (
                  <div>
                    <h4 className="font-medium mb-2">Metafelter</h4>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      {selectedProduct.data.field_1 && (
                        <div>
                          <span className="text-muted-foreground">Materiale:</span>
                          <span className="ml-2">{selectedProduct.data.field_1}</span>
                        </div>
                      )}
                      {selectedProduct.data.field_2 && (
                        <div>
                          <span className="text-muted-foreground">Farve:</span>
                          <span className="ml-2">{selectedProduct.data.field_2}</span>
                        </div>
                      )}
                      {selectedProduct.data.field_3 && (
                        <div>
                          <span className="text-muted-foreground">Pasform:</span>
                          <span className="ml-2">{selectedProduct.data.field_3}</span>
                        </div>
                      )}
                      {selectedProduct.data.field_9 && (
                        <div>
                          <span className="text-muted-foreground">Vaskeanvisning:</span>
                          <span className="ml-2">{selectedProduct.data.field_9}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* SEO */}
                {(selectedProduct.data.meta_title || selectedProduct.data.meta_description) && (
                  <div>
                    <h4 className="font-medium mb-2">SEO</h4>
                    <div className="space-y-2 text-sm">
                      {selectedProduct.data.meta_title && (
                        <div>
                          <span className="text-muted-foreground">Titel:</span>
                          <p className="text-foreground">{selectedProduct.data.meta_title}</p>
                        </div>
                      )}
                      {selectedProduct.data.meta_description && (
                        <div>
                          <span className="text-muted-foreground">Beskrivelse:</span>
                          <p className="text-foreground">{selectedProduct.data.meta_description}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Description */}
                {selectedProduct.data.body_html && (
                  <div>
                    <h4 className="font-medium mb-2">Beskrivelse</h4>
                    <div 
                      className="text-sm text-muted-foreground prose prose-sm max-w-none"
                      dangerouslySetInnerHTML={{ __html: selectedProduct.data.body_html }}
                    />
                  </div>
                )}

                {/* Shopify Link */}
                {selectedProduct.shopify_id && shopifyAdmin && (
                  <a
                    href={`https://admin.shopify.com/store/${shopifyAdmin}/products/${selectedProduct.shopify_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-primary hover:underline"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Åbn i Shopify Admin
                  </a>
                )}

                {/* Variant Count Validation */}
                {selectedProduct.variantCount !== selectedProduct.variants.length && selectedProduct.variantCount > 1 && (
                  <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm">
                    <AlertTriangle className="w-4 h-4 text-destructive mt-0.5" />
                    <div>
                      <span className="font-medium text-destructive">Variant mismatch!</span>
                      <p className="text-muted-foreground">
                        Forventet {selectedProduct.variantCount} varianter, men fandt {selectedProduct.variants.length}.
                        Check prepare-upload loggen.
                      </p>
                    </div>
                  </div>
                )}
              </div>
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
