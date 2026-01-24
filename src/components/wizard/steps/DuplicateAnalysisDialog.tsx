import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertTriangle,
  Search,
  Download,
  Loader2,
  Package,
  GitMerge,
  Trash2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Filter,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface DuplicateAnalysisDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  skippedCount: number;
}

interface SplitProduct {
  title: string;
  vendor: string | null;
  separateShopifyProducts: number;
  totalSourceRows: number;
  extraDuplicates: number;
  allSkus: string[];
  shopifyIds: string[];
  patternType: 'size_suffix' | 'base_only' | 'numeric_suffix' | 'mixed' | 'unknown';
  suggestedFix: string;
}

interface PatternGroup {
  pattern: string;
  description: string;
  icon: typeof AlertTriangle;
  products: SplitProduct[];
  totalDuplicates: number;
  suggestedAction: string;
}

export function DuplicateAnalysisDialog({
  open,
  onOpenChange,
  projectId,
  skippedCount,
}: DuplicateAnalysisDialogProps) {
  const [loading, setLoading] = useState(true);
  const [splitProducts, setSplitProducts] = useState<SplitProduct[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPattern, setSelectedPattern] = useState<string | null>(null);
  const [stats, setStats] = useState({
    affectedTitles: 0,
    totalExtraDuplicates: 0,
    totalAffectedRows: 0,
  });

  useEffect(() => {
    if (open) {
      loadAnalysis();
    }
  }, [open, projectId]);

  const loadAnalysis = async () => {
    setLoading(true);
    try {
      await loadAnalysisDirect();
    } catch (err) {
      console.error('Error loading analysis:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadAnalysisDirect = async () => {
    // Direct query to get split products
    const { data } = await supabase
      .from('canonical_products')
      .select('external_id, data, shopify_id')
      .eq('project_id', projectId)
      .not('shopify_id', 'is', null);

    if (!data) return;

    // Group by title
    const titleGroups: Record<string, { 
      skus: string[]; 
      shopifyIds: Set<string>;
      vendor: string | null;
    }> = {};

    data.forEach((row) => {
      const productData = row.data as Record<string, unknown>;
      const title = (productData?.title as string) || 'Unknown';
      const sku = (productData?.sku as string) || row.external_id;
      const vendor = (productData?.vendor as string) || null;
      
      if (!titleGroups[title]) {
        titleGroups[title] = { skus: [], shopifyIds: new Set(), vendor };
      }
      titleGroups[title].skus.push(sku);
      if (row.shopify_id) {
        titleGroups[title].shopifyIds.add(row.shopify_id);
      }
    });

    // Find titles with multiple shopify_ids (splits)
    const splits: SplitProduct[] = [];
    Object.entries(titleGroups).forEach(([title, group]) => {
      if (group.shopifyIds.size > 1) {
        const patternInfo = analyzeSkuPattern(group.skus);
        splits.push({
          title,
          vendor: group.vendor,
          separateShopifyProducts: group.shopifyIds.size,
          totalSourceRows: group.skus.length,
          extraDuplicates: group.shopifyIds.size - 1,
          allSkus: group.skus.sort(),
          shopifyIds: Array.from(group.shopifyIds),
          patternType: patternInfo.type,
          suggestedFix: patternInfo.fix,
        });
      }
    });

    // Sort by most duplicates first
    splits.sort((a, b) => b.extraDuplicates - a.extraDuplicates);
    setSplitProducts(splits);
    calculateStats(splits);
  };

  const analyzeSkuPattern = (skus: string[]): { type: SplitProduct['patternType']; fix: string } => {
    const sizePattern = /-(?:XXS|XS|S|M|L|XL|XXL|XXXL|ONE-SIZE|\d{2}(?:-\d{2})?)$/i;
    const hasBaseSku = skus.some(s => !sizePattern.test(s));
    const hasSizeSuffix = skus.some(s => sizePattern.test(s));
    
    // Check for space in SKU (often causes grouping issues)
    const hasSpaceInSku = skus.some(s => s.includes(' '));
    
    // Check for inconsistent base SKUs
    const baseParts = skus.map(s => s.replace(sizePattern, ''));
    const uniqueBases = new Set(baseParts);
    
    if (hasSpaceInSku) {
      return {
        type: 'mixed',
        fix: 'SKU indeholder mellemrum som forhindrer korrekt gruppering. Ret SKU-format i kildedata.',
      };
    }
    
    if (uniqueBases.size > 1) {
      return {
        type: 'mixed',
        fix: 'Forskellige base-SKUer med samme titel. Tjek om produkterne virkelig er varianter.',
      };
    }
    
    if (hasBaseSku && hasSizeSuffix) {
      return {
        type: 'size_suffix',
        fix: 'Base-SKU og størrelses-varianter uploadet separat. Merge i Shopify eller genkør upload.',
      };
    }
    
    if (!hasBaseSku && hasSizeSuffix) {
      return {
        type: 'size_suffix',
        fix: 'Alle er størrelses-varianter men blev oprettet separat. Merge via Shopify.',
      };
    }
    
    return {
      type: 'unknown',
      fix: 'Ukendt mønster. Manuel gennemgang anbefales.',
    };
  };

  const calculateStats = (products: SplitProduct[]) => {
    setStats({
      affectedTitles: products.length,
      totalExtraDuplicates: products.reduce((sum, p) => sum + p.extraDuplicates, 0),
      totalAffectedRows: products.reduce((sum, p) => sum + p.totalSourceRows, 0),
    });
  };

  // Group products by pattern type for the summary
  const patternGroups = useMemo((): PatternGroup[] => {
    const groups: Record<string, SplitProduct[]> = {
      size_suffix: [],
      mixed: [],
      base_only: [],
      numeric_suffix: [],
      unknown: [],
    };

    splitProducts.forEach((p) => {
      groups[p.patternType]?.push(p);
    });

    const result: PatternGroup[] = [];

    if (groups.size_suffix.length > 0) {
      result.push({
        pattern: 'size_suffix',
        description: 'Størrelses-varianter ikke grupperet',
        icon: GitMerge,
        products: groups.size_suffix,
        totalDuplicates: groups.size_suffix.reduce((s, p) => s + p.extraDuplicates, 0),
        suggestedAction: 'Disse produkter har størrelses-suffikser (f.eks. -S, -M, -L) men blev oprettet som separate produkter. Brug merge-funktionen til at samle dem.',
      });
    }

    if (groups.mixed.length > 0) {
      result.push({
        pattern: 'mixed',
        description: 'SKU-format problemer',
        icon: AlertTriangle,
        products: groups.mixed,
        totalDuplicates: groups.mixed.reduce((s, p) => s + p.extraDuplicates, 0),
        suggestedAction: 'SKUer med mellemrum eller inkonsistent format. Ret kildedata og gen-importer.',
      });
    }

    if (groups.unknown.length > 0) {
      result.push({
        pattern: 'unknown',
        description: 'Kræver manuel gennemgang',
        icon: Search,
        products: groups.unknown,
        totalDuplicates: groups.unknown.reduce((s, p) => s + p.extraDuplicates, 0),
        suggestedAction: 'Ukendt mønster - gennemgå manuelt.',
      });
    }

    return result;
  }, [splitProducts]);

  const filteredProducts = useMemo(() => {
    let products = splitProducts;
    
    if (selectedPattern) {
      products = products.filter(p => p.patternType === selectedPattern);
    }
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      products = products.filter(p => 
        p.title.toLowerCase().includes(query) ||
        p.allSkus.some(s => s.toLowerCase().includes(query)) ||
        (p.vendor?.toLowerCase() || '').includes(query)
      );
    }
    
    return products;
  }, [splitProducts, searchQuery, selectedPattern]);

  const downloadCSV = () => {
    const headers = ['Titel', 'Vendor', 'Antal Shopify-produkter', 'Ekstra duplikater', 'SKUer', 'Problem', 'Løsning'];
    const rows = splitProducts.map(p => [
      `"${p.title.replace(/"/g, '""')}"`,
      `"${(p.vendor || '').replace(/"/g, '""')}"`,
      p.separateShopifyProducts,
      p.extraDuplicates,
      `"${p.allSkus.join(', ')}"`,
      `"${p.patternType}"`,
      `"${p.suggestedFix.replace(/"/g, '""')}"`,
    ]);

    const csv = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `duplikat-analyse-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Analyse af {skippedCount} oversprungne produkter
          </DialogTitle>
          <DialogDescription>
            Disse produkter blev ikke uploadet korrekt fordi varianterne blev oprettet som separate produkter
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col gap-4">
            {/* Summary Stats */}
            <div className="grid grid-cols-3 gap-4">
              <Card>
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Påvirkede produkter
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-2 px-4">
                  <div className="text-2xl font-bold">{stats.affectedTitles}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Ekstra duplikater i Shopify
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-2 px-4">
                  <div className="text-2xl font-bold text-amber-600">{stats.totalExtraDuplicates}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Kilde-rækker påvirket
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-2 px-4">
                  <div className="text-2xl font-bold">{stats.totalAffectedRows}</div>
                </CardContent>
              </Card>
            </div>

            {/* Pattern Groups Summary */}
            <Card>
              <CardHeader className="py-3 px-4">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Filter className="h-4 w-4" />
                  Fejltyper (klik for at filtrere)
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2 px-4">
                <div className="flex flex-wrap gap-2">
                  <Badge
                    variant={selectedPattern === null ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => setSelectedPattern(null)}
                  >
                    Alle ({splitProducts.length})
                  </Badge>
                  {patternGroups.map((group) => (
                    <Badge
                      key={group.pattern}
                      variant={selectedPattern === group.pattern ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => setSelectedPattern(
                        selectedPattern === group.pattern ? null : group.pattern
                      )}
                    >
                      <group.icon className="h-3 w-3 mr-1" />
                      {group.description} ({group.products.length})
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Selected Pattern Info */}
            {selectedPattern && (
              <Card className="border-amber-500/30 bg-amber-500/10">
                <CardContent className="py-3 px-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5" />
                    <div>
                      <p className="font-medium text-foreground">
                        {patternGroups.find(g => g.pattern === selectedPattern)?.description}
                      </p>
                      <p className="text-sm text-muted-foreground mt-1">
                        {patternGroups.find(g => g.pattern === selectedPattern)?.suggestedAction}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Search and Actions */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Søg efter titel, SKU eller vendor..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Button variant="outline" onClick={downloadCSV}>
                <Download className="h-4 w-4 mr-2" />
                Download CSV
              </Button>
            </div>

            {/* Product List */}
            <ScrollArea className="flex-1 border rounded-lg">
              <div className="p-4 space-y-2">
                {filteredProducts.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    Ingen produkter matcher søgningen
                  </div>
                ) : (
                  <Accordion type="multiple" className="space-y-2">
                    {filteredProducts.slice(0, 50).map((product, idx) => (
                      <AccordionItem
                        key={`${product.title}-${idx}`}
                        value={`${idx}`}
                        className="border rounded-lg px-4"
                      >
                        <AccordionTrigger className="hover:no-underline py-3">
                          <div className="flex items-center gap-3 flex-1 text-left">
                            <Package className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate">{product.title}</div>
                              <div className="text-xs text-muted-foreground">
                                {product.vendor} • {product.totalSourceRows} kilde-rækker
                              </div>
                            </div>
                            <Badge variant="destructive" className="flex-shrink-0">
                              {product.separateShopifyProducts} produkter i Shopify
                            </Badge>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent className="pb-4">
                          <div className="space-y-3">
                            {/* Problem Description */}
                            <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/30">
                              <div className="flex items-start gap-2">
                                <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5" />
                                <div className="text-sm">
                                  <p className="font-medium text-foreground">Problem</p>
                                  <p className="text-muted-foreground">{product.suggestedFix}</p>
                                </div>
                              </div>
                            </div>

                            {/* SKUs Table */}
                            <div>
                              <p className="text-sm font-medium mb-2">SKUer ({product.allSkus.length})</p>
                              <div className="border rounded-lg overflow-hidden">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>SKU</TableHead>
                                      <TableHead>Type</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {product.allSkus.map((sku) => {
                                      const isBase = !/-(?:XXS|XS|S|M|L|XL|XXL|XXXL|ONE-SIZE|\d{2}(?:-\d{2})?)$/i.test(sku);
                                      return (
                                        <TableRow key={sku}>
                                          <TableCell className="font-mono text-sm">{sku}</TableCell>
                                          <TableCell>
                                            <Badge variant={isBase ? 'secondary' : 'outline'}>
                                              {isBase ? 'Base' : 'Variant'}
                                            </Badge>
                                          </TableCell>
                                        </TableRow>
                                      );
                                    })}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>

                            {/* Shopify IDs */}
                            <div>
                              <p className="text-sm font-medium mb-2">
                                Shopify produkt-IDer ({product.shopifyIds.length})
                              </p>
                              <div className="flex flex-wrap gap-2">
                                {product.shopifyIds.map((id, i) => (
                                  <Badge key={id} variant="outline" className="font-mono text-xs">
                                    {i === 0 && <CheckCircle2 className="h-3 w-3 mr-1 text-primary" />}
                                    {i > 0 && <XCircle className="h-3 w-3 mr-1 text-destructive" />}
                                    {id}
                                  </Badge>
                                ))}
                              </div>
                              <p className="text-xs text-muted-foreground mt-1">
                                <CheckCircle2 className="h-3 w-3 inline mr-1 text-primary" />
                                Behold dette produkt,
                                <XCircle className="h-3 w-3 inline mx-1 text-destructive" />
                                disse skal merges eller slettes
                              </p>
                            </div>
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                )}
                {filteredProducts.length > 50 && (
                  <p className="text-center text-sm text-muted-foreground py-4">
                    Viser 50 af {filteredProducts.length} produkter. Download CSV for fuld liste.
                  </p>
                )}
              </div>
            </ScrollArea>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
