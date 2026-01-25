import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Loader2, Users, Search, ChevronLeft, ChevronRight, MapPin, Phone, Mail, Building, User } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface CustomerPreviewTabProps {
  projectId: string;
}

interface CustomerData {
  external_id: string;
  email: string;
  first_name: string;
  last_name: string;
  company?: string | null;
  phone?: string | null;
  country?: string | null;
  vat_number?: string | null;
  accepts_marketing?: boolean;
  addresses?: Array<{
    address1: string;
    address2?: string | null;
    city: string;
    zip: string;
    country: string;
    phone?: string | null;
  }>;
  created_at?: string;
}

interface CanonicalCustomer {
  id: string;
  external_id: string;
  shopify_id: string | null;
  status: string;
  data: CustomerData;
}

export function CustomerPreviewTab({ projectId }: CustomerPreviewTabProps) {
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<CanonicalCustomer[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<CanonicalCustomer | null>(null);
  const pageSize = 20;

  useEffect(() => {
    loadCustomers();
  }, [projectId, currentPage, searchQuery]);

  const loadCustomers = async () => {
    setLoading(true);

    // Get total count
    let countQuery = supabase
      .from('canonical_customers')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId);

    if (searchQuery) {
      countQuery = countQuery.or(`data->>email.ilike.%${searchQuery}%,data->>first_name.ilike.%${searchQuery}%,data->>last_name.ilike.%${searchQuery}%`);
    }

    const { count } = await countQuery;
    setTotalCount(count || 0);

    // Get customers for current page
    let dataQuery = supabase
      .from('canonical_customers')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .range(currentPage * pageSize, (currentPage + 1) * pageSize - 1);

    if (searchQuery) {
      dataQuery = dataQuery.or(`data->>email.ilike.%${searchQuery}%,data->>first_name.ilike.%${searchQuery}%,data->>last_name.ilike.%${searchQuery}%`);
    }

    const { data } = await dataQuery;

    if (data) {
      setCustomers(data.map(c => ({
        ...c,
        data: c.data as unknown as CustomerData,
      })));
    }

    setLoading(false);
  };

  const totalPages = Math.ceil(totalCount / pageSize);

  const formatAddress = (address: CustomerData['addresses'][0] | undefined) => {
    if (!address) return '-';
    const parts = [
      address.address1,
      address.address2,
      `${address.zip} ${address.city}`,
      address.country,
    ].filter(Boolean);
    return parts.join(', ');
  };

  if (loading && customers.length === 0) {
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
            <Users className="w-5 h-5" />
            Kundedata Preview
          </CardTitle>
          <CardDescription>
            Se hvordan dine kunder vil se ud i Shopify efter import
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <Card className="bg-muted/30">
              <CardContent className="pt-4">
                <div className="text-2xl font-bold">{totalCount}</div>
                <div className="text-sm text-muted-foreground">Kunder i alt</div>
              </CardContent>
            </Card>
          </div>

          {/* Search */}
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Søg efter navn eller email..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(0);
                }}
                className="pl-9"
              />
            </div>
          </div>

          {/* Customer Table */}
          {customers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Ingen kunder fundet</p>
              <p className="text-sm">Upload en ORDERS.xml fil i Upload-trinnet for at udtrække kunder</p>
            </div>
          ) : (
            <>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Navn</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Telefon</TableHead>
                      <TableHead>By</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-20"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customers.map((customer) => (
                      <TableRow key={customer.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedCustomer(customer)}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <User className="w-4 h-4 text-muted-foreground" />
                            <span className="font-medium">
                              {customer.data.first_name} {customer.data.last_name}
                            </span>
                            {customer.data.company && (
                              <Badge variant="outline" className="text-xs">{customer.data.company}</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-muted-foreground">{customer.data.email || '-'}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-muted-foreground">{customer.data.phone || '-'}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-muted-foreground">
                            {customer.data.addresses?.[0]?.city || '-'}
                          </span>
                        </TableCell>
                        <TableCell>
                          {customer.shopify_id ? (
                            <Badge variant="default" className="bg-primary">Uploadet</Badge>
                          ) : (
                            <Badge variant="secondary">Afventer</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" onClick={() => setSelectedCustomer(customer)}>
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

      {/* Customer Detail Dialog */}
      <Dialog open={!!selectedCustomer} onOpenChange={() => setSelectedCustomer(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="w-5 h-5" />
              Shopify Kunde Preview
            </DialogTitle>
          </DialogHeader>

          {selectedCustomer && (
            <div className="space-y-6">
              {/* Customer Header */}
              <div className="flex items-start gap-4 p-4 bg-muted/30 rounded-lg">
                <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center">
                  <User className="w-6 h-6 text-primary" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold">
                    {selectedCustomer.data.first_name} {selectedCustomer.data.last_name}
                  </h3>
                  {selectedCustomer.data.company && (
                    <p className="text-muted-foreground flex items-center gap-1">
                      <Building className="w-4 h-4" />
                      {selectedCustomer.data.company}
                    </p>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-sm">
                    {selectedCustomer.shopify_id ? (
                      <Badge variant="default" className="bg-primary">Uploadet til Shopify</Badge>
                    ) : (
                      <Badge variant="secondary">Afventer upload</Badge>
                    )}
                    <span className="text-muted-foreground">ID: {selectedCustomer.external_id}</span>
                  </div>
                </div>
              </div>

              {/* Contact Info */}
              <div className="grid md:grid-cols-2 gap-6">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">Kontaktoplysninger</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center gap-3">
                      <Mail className="w-4 h-4 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">Email</p>
                        <p className="font-medium">{selectedCustomer.data.email || '-'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Phone className="w-4 h-4 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">Telefon</p>
                        <p className="font-medium">{selectedCustomer.data.phone || '-'}</p>
                      </div>
                    </div>
                    {selectedCustomer.data.vat_number && (
                      <div className="flex items-center gap-3">
                        <Building className="w-4 h-4 text-muted-foreground" />
                        <div>
                          <p className="text-xs text-muted-foreground">CVR-nummer</p>
                          <p className="font-medium">{selectedCustomer.data.vat_number}</p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">Adresse</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {selectedCustomer.data.addresses?.[0] ? (
                      <div className="flex items-start gap-3">
                        <MapPin className="w-4 h-4 text-muted-foreground mt-1" />
                        <div>
                          <p className="font-medium">{selectedCustomer.data.addresses[0].address1}</p>
                          {selectedCustomer.data.addresses[0].address2 && (
                            <p className="text-muted-foreground">{selectedCustomer.data.addresses[0].address2}</p>
                          )}
                          <p className="text-muted-foreground">
                            {selectedCustomer.data.addresses[0].zip} {selectedCustomer.data.addresses[0].city}
                          </p>
                          <p className="text-muted-foreground">{selectedCustomer.data.addresses[0].country}</p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-muted-foreground">Ingen adresse registreret</p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Raw Data Preview */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Alle felter (som sendes til Shopify)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">first_name</p>
                      <p className="font-mono">{selectedCustomer.data.first_name || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">last_name</p>
                      <p className="font-mono">{selectedCustomer.data.last_name || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">email</p>
                      <p className="font-mono">{selectedCustomer.data.email || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">phone</p>
                      <p className="font-mono">{selectedCustomer.data.phone || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">company</p>
                      <p className="font-mono">{selectedCustomer.data.company || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">country</p>
                      <p className="font-mono">{selectedCustomer.data.country || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">accepts_marketing</p>
                      <p className="font-mono">{selectedCustomer.data.accepts_marketing ? 'true' : 'false'}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
