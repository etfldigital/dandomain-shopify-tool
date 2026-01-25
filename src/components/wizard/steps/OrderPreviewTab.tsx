import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Loader2, ShoppingCart, Search, ChevronLeft, ChevronRight, Package, CreditCard, Truck, MapPin, Calendar, User } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { da } from 'date-fns/locale';

interface OrderPreviewTabProps {
  projectId: string;
}

interface LineItem {
  product_external_id: string;
  sku: string;
  title: string;
  quantity: number;
  price: number;
}

interface Address {
  address1: string;
  address2?: string | null;
  city: string;
  zip: string;
  country: string;
  phone?: string | null;
}

interface OrderData {
  customer_external_id: string;
  customer_email?: string;
  customer_first_name?: string;
  customer_last_name?: string;
  customer_phone?: string;
  customer_address?: string;
  customer_zip?: string;
  customer_city?: string;
  customer_country?: string;
  order_date: string;
  currency: string;
  subtotal_price: number;
  total_price: number;
  total_tax: number;
  shipping_price: number;
  discount_total: number;
  line_items: LineItem[];
  billing_address: Address;
  shipping_address: Address;
  financial_status: string;
  fulfillment_status: string;
}

interface CanonicalOrder {
  id: string;
  external_id: string;
  shopify_id: string | null;
  status: string;
  data: OrderData;
}

export function OrderPreviewTab({ projectId }: OrderPreviewTabProps) {
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<CanonicalOrder[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<CanonicalOrder | null>(null);
  const pageSize = 20;

  useEffect(() => {
    loadOrders();
  }, [projectId, currentPage, searchQuery]);

  const loadOrders = async () => {
    setLoading(true);

    // Get total count
    let countQuery = supabase
      .from('canonical_orders')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId);

    if (searchQuery) {
      countQuery = countQuery.or(`external_id.ilike.%${searchQuery}%,data->>customer_email.ilike.%${searchQuery}%`);
    }

    const { count } = await countQuery;
    setTotalCount(count || 0);

    // Get orders for current page
    let dataQuery = supabase
      .from('canonical_orders')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .range(currentPage * pageSize, (currentPage + 1) * pageSize - 1);

    if (searchQuery) {
      dataQuery = dataQuery.or(`external_id.ilike.%${searchQuery}%,data->>customer_email.ilike.%${searchQuery}%`);
    }

    const { data } = await dataQuery;

    if (data) {
      setOrders(data.map(o => ({
        ...o,
        data: o.data as unknown as OrderData,
      })));
    }

    setLoading(false);
  };

  const totalPages = Math.ceil(totalCount / pageSize);

  const formatPrice = (price: number, currency: string = 'DKK') => {
    return new Intl.NumberFormat('da-DK', {
      style: 'currency',
      currency,
    }).format(price);
  };

  const formatDate = (dateStr: string) => {
    try {
      return format(new Date(dateStr), 'd. MMM yyyy', { locale: da });
    } catch {
      return dateStr;
    }
  };

  const getFinancialStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case 'paid':
        return <Badge className="bg-primary">Betalt</Badge>;
      case 'pending':
        return <Badge variant="secondary">Afventer</Badge>;
      case 'refunded':
        return <Badge variant="destructive">Refunderet</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getFulfillmentStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case 'fulfilled':
        return <Badge className="bg-accent">Afsendt</Badge>;
      case 'partial':
        return <Badge variant="secondary">Delvist afsendt</Badge>;
      case 'unfulfilled':
        return <Badge variant="outline">Ikke afsendt</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (loading && orders.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <ShoppingCart className="w-5 h-5" />
            Ordredata Preview
          </CardTitle>
          <CardDescription>
            Se hvordan dine ordrer vil se ud i Shopify efter import
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <Card className="bg-muted/30">
              <CardContent className="pt-4">
                <div className="text-2xl font-bold">{totalCount}</div>
                <div className="text-sm text-muted-foreground">Ordrer i alt</div>
              </CardContent>
            </Card>
          </div>

          {/* Search */}
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Søg efter ordre-ID eller kundemail..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(0);
                }}
                className="pl-9"
              />
            </div>
          </div>

          {/* Orders Table */}
          {orders.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <ShoppingCart className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Ingen ordrer fundet</p>
              <p className="text-sm">Upload en ORDERS.xml fil i Upload-trinnet</p>
            </div>
          ) : (
            <>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ordre #</TableHead>
                      <TableHead>Dato</TableHead>
                      <TableHead>Kunde</TableHead>
                      <TableHead>Produkter</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-20"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((order) => (
                      <TableRow key={order.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedOrder(order)}>
                        <TableCell>
                          <span className="font-mono font-medium">#{order.external_id}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-muted-foreground">{formatDate(order.data.order_date)}</span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <User className="w-4 h-4 text-muted-foreground" />
                            <span>
                              {order.data.customer_first_name || ''} {order.data.customer_last_name || order.data.customer_email || '-'}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-muted-foreground">{order.data.line_items?.length || 0} varer</span>
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatPrice(order.data.total_price, order.data.currency)}
                        </TableCell>
                        <TableCell>
                          {getFinancialStatusBadge(order.data.financial_status)}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" onClick={() => setSelectedOrder(order)}>
                            Vis
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between mt-4">
                <div className="text-sm text-muted-foreground">
                  Viser {currentPage * pageSize + 1}-{Math.min((currentPage + 1) * pageSize, totalCount)} af {totalCount}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                    disabled={currentPage === 0}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-sm">
                    Side {currentPage + 1} af {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={currentPage >= totalPages - 1}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Order Detail Dialog */}
      <Dialog open={!!selectedOrder} onOpenChange={() => setSelectedOrder(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShoppingCart className="w-5 h-5" />
              Shopify Ordre Preview
            </DialogTitle>
          </DialogHeader>

          {selectedOrder && (
            <div className="space-y-6">
              {/* Order Header */}
              <div className="flex items-start justify-between p-4 bg-muted/30 rounded-lg">
                <div>
                  <h3 className="text-lg font-semibold">Ordre #{selectedOrder.external_id}</h3>
                  <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                    <Calendar className="w-4 h-4" />
                    {formatDate(selectedOrder.data.order_date)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {getFinancialStatusBadge(selectedOrder.data.financial_status)}
                  {getFulfillmentStatusBadge(selectedOrder.data.fulfillment_status)}
                </div>
              </div>

              {/* Line Items */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Package className="w-4 h-4" />
                    Ordrelinjer
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Produkt</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead className="text-right">Antal</TableHead>
                        <TableHead className="text-right">Pris</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedOrder.data.line_items?.map((item, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-medium">{item.title}</TableCell>
                          <TableCell className="font-mono text-sm text-muted-foreground">{item.sku}</TableCell>
                          <TableCell className="text-right">{item.quantity}</TableCell>
                          <TableCell className="text-right">{formatPrice(item.price, selectedOrder.data.currency)}</TableCell>
                          <TableCell className="text-right font-medium">
                            {formatPrice(item.price * item.quantity, selectedOrder.data.currency)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* Payment Summary */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <CreditCard className="w-4 h-4" />
                    Betalingsoversigt
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Subtotal</span>
                      <span>{formatPrice(selectedOrder.data.subtotal_price, selectedOrder.data.currency)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Moms</span>
                      <span>{formatPrice(selectedOrder.data.total_tax, selectedOrder.data.currency)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Fragt</span>
                      <span>{formatPrice(selectedOrder.data.shipping_price, selectedOrder.data.currency)}</span>
                    </div>
                    {selectedOrder.data.discount_total > 0 && (
                      <div className="flex justify-between text-sm text-primary">
                        <span>Rabat</span>
                        <span>-{formatPrice(selectedOrder.data.discount_total, selectedOrder.data.currency)}</span>
                      </div>
                    )}
                    <Separator />
                    <div className="flex justify-between font-semibold">
                      <span>Total</span>
                      <span>{formatPrice(selectedOrder.data.total_price, selectedOrder.data.currency)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Customer & Shipping */}
              <div className="grid md:grid-cols-2 gap-6">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <User className="w-4 h-4" />
                      Kunde
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="font-medium">
                      {selectedOrder.data.customer_first_name} {selectedOrder.data.customer_last_name}
                    </p>
                    {selectedOrder.data.customer_email && (
                      <p className="text-muted-foreground">{selectedOrder.data.customer_email}</p>
                    )}
                    {selectedOrder.data.customer_phone && (
                      <p className="text-muted-foreground">{selectedOrder.data.customer_phone}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Kunde-ID: {selectedOrder.data.customer_external_id}
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Truck className="w-4 h-4" />
                      Leveringsadresse
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {selectedOrder.data.shipping_address ? (
                      <div className="flex items-start gap-3 text-sm">
                        <MapPin className="w-4 h-4 text-muted-foreground mt-1" />
                        <div>
                          <p className="font-medium">{selectedOrder.data.shipping_address.address1}</p>
                          {selectedOrder.data.shipping_address.address2 && (
                            <p className="text-muted-foreground">{selectedOrder.data.shipping_address.address2}</p>
                          )}
                          <p className="text-muted-foreground">
                            {selectedOrder.data.shipping_address.zip} {selectedOrder.data.shipping_address.city}
                          </p>
                          <p className="text-muted-foreground">{selectedOrder.data.shipping_address.country}</p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-sm">Ingen leveringsadresse</p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
