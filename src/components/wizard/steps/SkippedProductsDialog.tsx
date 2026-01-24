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
  SkipForward,
  AlertTriangle,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface SkippedProduct {
  id: string;
  external_id: string;
  error_message: string;
  data: Record<string, unknown>;
}

interface SkippedProductsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  skippedCount: number;
}

export function SkippedProductsDialog({
  open,
  onOpenChange,
  projectId,
  skippedCount,
}: SkippedProductsDialogProps) {
  const [products, setProducts] = useState<SkippedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (open && projectId) {
      fetchSkippedProducts();
    }
  }, [open, projectId]);

  const fetchSkippedProducts = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('canonical_products')
        .select('id, external_id, error_message, data')
        .eq('project_id', projectId)
        .eq('status', 'uploaded')
        .like('error_message', 'Sprunget over%')
        .order('external_id', { ascending: true })
        .limit(500);

      if (error) throw error;
      setProducts((data || []) as SkippedProduct[]);
    } catch (error) {
      console.error('Failed to fetch skipped products:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Group products by skip reason
  const groupedByReason = products.reduce((acc, product) => {
    const reason = product.error_message || 'Ukendt årsag';
    if (!acc[reason]) {
      acc[reason] = [];
    }
    acc[reason].push(product);
    return acc;
  }, {} as Record<string, SkippedProduct[]>);

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

  // Get a user-friendly reason label
  const getReasonLabel = (reason: string) => {
    if (reason.includes('Eksisterer allerede')) {
      return 'Eksisterer allerede i Shopify';
    }
    if (reason.includes('Variant grupperet')) {
      return 'Variant slået sammen med andet produkt';
    }
    if (reason.includes('Sprunget over:')) {
      return reason.replace('Sprunget over: ', '');
    }
    return reason;
  };

  // Download CSV
  const handleDownloadCSV = () => {
    if (products.length === 0) return;

    // Build CSV with relevant columns
    const headers = ['External ID', 'Titel', 'SKU', 'Årsag'];
    const rows = products.map(p => [
      p.external_id || '',
      (p.data?.title as string) || '',
      (p.data?.sku as string) || '',
      getReasonLabel(p.error_message),
    ]);

    const csvContent = [
      headers.join(';'),
      ...rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';')),
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `skipped-products-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SkipForward className="w-5 h-5 text-amber-500" />
            Oversprungne produkter
          </DialogTitle>
          <DialogDescription>
            {skippedCount.toLocaleString('da-DK')} produkter blev sprunget over under upload
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : products.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Package className="w-12 h-12 mb-4 opacity-50" />
            <p>Ingen oversprungne produkter fundet</p>
          </div>
        ) : (
          <>
            {/* Summary by reason */}
            <div className="space-y-2 mb-4">
              <p className="text-sm font-medium text-muted-foreground">Oversigt:</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(groupedByReason).map(([reason, items]) => (
                  <Badge 
                    key={reason} 
                    variant="secondary" 
                    className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                  >
                    {getReasonLabel(reason)}: {items.length}
                  </Badge>
                ))}
              </div>
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
            <ScrollArea className="flex-1 min-h-0 max-h-[400px] border rounded-md">
              <div className="divide-y">
                {filteredProducts.map((product) => (
                  <div
                    key={product.id}
                    className="p-3 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">
                          {(product.data?.title as string) || product.external_id}
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
                        className="text-xs shrink-0 text-amber-600 border-amber-300"
                      >
                        <AlertTriangle className="w-3 h-3 mr-1" />
                        {getReasonLabel(product.error_message)}
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
                Viser de første 500 af {skippedCount.toLocaleString('da-DK')} produkter
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
