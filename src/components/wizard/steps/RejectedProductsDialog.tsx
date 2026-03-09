import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Download, 
  Search, 
  Loader2, 
  Package, 
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface RejectedProduct {
  id: string;
  external_id: string;
  error_message: string;
  data: Record<string, unknown>;
}

interface RejectedProductsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  rejectedCount: number;
}

export function RejectedProductsDialog({
  open,
  onOpenChange,
  projectId,
  rejectedCount,
}: RejectedProductsDialogProps) {
  const [products, setProducts] = useState<RejectedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (open && projectId) {
      fetchRejectedProducts();
    }
  }, [open, projectId]);

  const fetchRejectedProducts = async () => {
    setIsLoading(true);
    try {
      // Rejected products have status='mapped' and error_message starting with 'Afvist:'
      const { data, error } = await supabase
        .from('canonical_products')
        .select('id, external_id, error_message, data')
        .eq('project_id', projectId)
        .eq('status', 'mapped')
        .like('error_message', 'Afvist:%')
        .order('external_id', { ascending: true })
        .limit(500);

      if (error) throw error;
      setProducts((data || []) as RejectedProduct[]);
    } catch (error) {
      
    } finally {
      setIsLoading(false);
    }
  };

  // Group products by rejection reason
  const groupedByReason = products.reduce((acc, product) => {
    const reason = product.error_message?.replace('Afvist: ', '') || 'Ukendt årsag';
    if (!acc[reason]) {
      acc[reason] = [];
    }
    acc[reason].push(product);
    return acc;
  }, {} as Record<string, RejectedProduct[]>);

  // Filter products by search query
  const filteredProducts = products.filter(p => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    const title = (p.data?.title as string) || '';
    const sku = (p.data?.sku as string) || '';
    const externalId = p.external_id || '';
    return (
      title.toLowerCase().includes(query) ||
      sku.toLowerCase().includes(query) ||
      externalId.toLowerCase().includes(query)
    );
  });

  // Download CSV
  const handleDownloadCSV = () => {
    if (products.length === 0) return;

    const headers = ['External ID', 'Titel', 'SKU', 'Årsag'];
    const rows = products.map(p => [
      p.external_id || '',
      (p.data?.title as string) || '',
      (p.data?.sku as string) || '',
      p.error_message?.replace('Afvist: ', '') || '',
    ]);

    const csvContent = [
      headers.join(';'),
      ...rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';')),
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `rejected-products-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XCircle className="w-5 h-5 text-destructive" />
            Afviste produkter
          </DialogTitle>
          <DialogDescription>
            {rejectedCount > 0 
              ? `${rejectedCount.toLocaleString('da-DK')} produkter kunne ikke grupperes og vil ikke blive uploadet`
              : 'Produkter der ikke kunne grupperes korrekt'
            }
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : products.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Package className="w-12 h-12 mb-4 opacity-50" />
            <p>Ingen afviste produkter</p>
            <p className="text-sm mt-2">Alle produkter er klar til upload</p>
          </div>
        ) : (
          <>
            {/* Summary by reason */}
            <div className="space-y-2 mb-4">
              <p className="text-sm font-medium text-muted-foreground">Årsager til afvisning:</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(groupedByReason).map(([reason, items]) => (
                  <Badge 
                    key={reason} 
                    variant="secondary" 
                    className="bg-destructive/10 text-destructive"
                  >
                    {reason}: {items.length}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Help text */}
            <div className="bg-muted/50 rounded-lg p-3 text-sm space-y-1">
              <p className="font-medium">Sådan løser du afvisninger:</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                <li><strong>Mangler titel</strong> – Tjek at produktet har en titel i kildefilen</li>
                <li><strong>Ingen gyldig størrelse</strong> – Tilføj størrelse til SKU (fx "PRODUKT-XL") eller variant_option felt</li>
                <li><strong>Duplikat størrelse</strong> – To produkter har samme titel OG størrelse</li>
              </ul>
            </div>

            {/* Search and actions */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Søg i titel, SKU eller external ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Button variant="outline" onClick={handleDownloadCSV}>
                <Download className="w-4 h-4 mr-2" />
                CSV
              </Button>
            </div>

            {/* Product list */}
            <ScrollArea className="flex-1 min-h-0 max-h-[300px] border rounded-md">
              <div className="divide-y">
                {filteredProducts.map((product) => (
                  <div
                    key={product.id}
                    className="p-3 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">
                          {(product.data?.title as string) || product.external_id || 'Uden titel'}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          {(product.data?.sku as string) && (
                            <span className="text-xs text-muted-foreground">
                              SKU: {product.data.sku as string}
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            ID: {product.external_id}
                          </span>
                        </div>
                      </div>
                      <Badge 
                        variant="outline" 
                        className="text-xs shrink-0 text-destructive border-destructive/30"
                      >
                        <AlertTriangle className="w-3 h-3 mr-1" />
                        {product.error_message?.replace('Afvist: ', '') || 'Ukendt'}
                      </Badge>
                    </div>
                  </div>
                ))}
                {filteredProducts.length === 0 && searchQuery && (
                  <div className="p-8 text-center text-muted-foreground">
                    Ingen produkter matcher søgningen
                  </div>
                )}
              </div>
            </ScrollArea>

            {products.length >= 500 && (
              <p className="text-xs text-muted-foreground text-center">
                Viser de første 500 produkter. Download CSV for komplet liste.
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
