import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { 
  Loader2, 
  RefreshCw, 
  Package, 
  Layers, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle,
  Search,
  ChevronDown,
  ChevronRight,
  Eye
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface UploadPreviewTabProps {
  projectId: string;
}

interface ValidatedVariant {
  recordId: string;
  externalId: string;
  sku: string;
  size: string;
  price: string;
  compareAtPrice: string | null;
  stockQuantity: number;
  weight: number;
  barcode: string | null;
}

interface ProductGroup {
  key: string;
  title: string;
  vendor: string;
  bodyHtml: string;
  tags: string[];
  images: string[];
  variants: ValidatedVariant[];
  recordIds: string[];
  externalIds: string[];
  warnings: string[];
}

interface RejectedRecord {
  recordId: string;
  externalId: string;
  reason: string;
}

interface PrepareResult {
  success: boolean;
  groups: ProductGroup[];
  rejected: RejectedRecord[];
  stats: {
    totalRecords: number;
    groupsCreated: number;
    variantsTotal: number;
    recordsRejected: number;
  };
}

export function UploadPreviewTab({ projectId }: UploadPreviewTabProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PrepareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selectedGroup, setSelectedGroup] = useState<ProductGroup | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const generatePreview = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const { data, error: fnError } = await supabase.functions.invoke('prepare-upload', {
        body: {
          projectId,
          entityType: 'products',
          previewOnly: true,
        },
      });

      if (fnError) throw fnError;
      setResult(data as PrepareResult);
    } catch (err) {
      console.error('Preview error:', err);
      setError(err instanceof Error ? err.message : 'Kunne ikke generere preview');
    } finally {
      setLoading(false);
    }
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const filteredGroups = result?.groups.filter(group => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      group.title.toLowerCase().includes(term) ||
      group.vendor.toLowerCase().includes(term) ||
      group.key.includes(term) ||
      group.variants.some(v => v.sku.toLowerCase().includes(term))
    );
  }) || [];

  const filteredRejected = result?.rejected.filter(rej => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      rej.externalId.toLowerCase().includes(term) ||
      rej.reason.toLowerCase().includes(term)
    );
  }) || [];

  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Eye className="w-5 h-5" />
            Upload Preview
          </CardTitle>
          <CardDescription>
            Se hvordan dine produkter vil blive grupperet og valideret før upload til Shopify
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-12">
            <Layers className="w-16 h-16 mx-auto mb-4 text-muted-foreground opacity-50" />
            <p className="text-muted-foreground mb-6">
              Klik på knappen for at generere et preview af hvordan produkter 
              vil blive grupperet med varianter og valideret før upload.
            </p>
            <Button onClick={generatePreview} disabled={loading} size="lg">
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Analyserer produkter...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Generér Preview
                </>
              )}
            </Button>
            {error && (
              <p className="text-destructive mt-4 text-sm">{error}</p>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Package className="w-5 h-5 text-muted-foreground" />
              <div>
                <div className="text-2xl font-bold">{result.stats.totalRecords}</div>
                <div className="text-sm text-muted-foreground">Produktrækker</div>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary" />
              <div>
                <div className="text-2xl font-bold">{result.stats.groupsCreated}</div>
                <div className="text-sm text-muted-foreground">Shopify-produkter</div>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              <div>
                <div className="text-2xl font-bold">{result.stats.variantsTotal}</div>
                <div className="text-sm text-muted-foreground">Varianter i alt</div>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className={result.stats.recordsRejected > 0 ? 'border-amber-300 dark:border-amber-700' : ''}>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              {result.stats.recordsRejected > 0 ? (
                <AlertTriangle className="w-5 h-5 text-amber-500" />
              ) : (
                <CheckCircle2 className="w-5 h-5 text-green-600" />
              )}
              <div>
                <div className="text-2xl font-bold">{result.stats.recordsRejected}</div>
                <div className="text-sm text-muted-foreground">Afviste</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Refresh button */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={generatePreview} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          <span className="ml-2">Opdater preview</span>
        </Button>
      </div>

      {/* Tab toggle for Groups vs Rejected */}
      <div className="flex gap-2 border-b">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            !showRejected 
              ? 'border-primary text-primary' 
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setShowRejected(false)}
        >
          Produktgrupper ({result.groups.length})
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            showRejected 
              ? 'border-primary text-primary' 
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setShowRejected(true)}
        >
          Afviste ({result.rejected.length})
          {result.stats.recordsRejected > 0 && (
            <Badge variant="secondary" className="ml-2 bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
              {result.stats.recordsRejected}
            </Badge>
          )}
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder={showRejected ? "Søg i afviste..." : "Søg i produktgrupper..."}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Groups List */}
      {!showRejected && (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {filteredGroups.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {searchTerm ? 'Ingen grupper matcher søgningen' : 'Ingen produktgrupper fundet'}
                </div>
              ) : (
                filteredGroups.map(group => (
                  <div key={group.key} className="p-4">
                    <div 
                      className="flex items-center gap-3 cursor-pointer"
                      onClick={() => toggleGroup(group.key)}
                    >
                      {expandedGroups.has(group.key) ? (
                        <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      )}
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {group.warnings.length > 0 ? (
                            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                          ) : (
                            <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                          )}
                          <span className="font-medium truncate">{group.title}</span>
                          <Badge variant="secondary" className="ml-2">
                            {group.variants.length} {group.variants.length === 1 ? 'variant' : 'varianter'}
                          </Badge>
                        </div>
                        <div className="text-sm text-muted-foreground mt-0.5">
                          {group.vendor || 'Ingen vendor'}
                        </div>
                      </div>
                      
                      <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedGroup(group);
                        }}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                    </div>
                    
                    {/* Expanded variant list */}
                    {expandedGroups.has(group.key) && (
                      <div className="mt-4 ml-8 space-y-2">
                        {/* Warnings */}
                        {group.warnings.length > 0 && (
                          <div className="bg-amber-50 dark:bg-amber-950/30 rounded-lg p-3 mb-3">
                            <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 text-sm font-medium mb-1">
                              <AlertTriangle className="w-4 h-4" />
                              Advarsler
                            </div>
                            <ul className="text-xs text-amber-600 dark:text-amber-500 space-y-1">
                              {group.warnings.map((warning, i) => (
                                <li key={i}>• {warning}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        
                        {/* Variant table */}
                        <div className="border rounded-lg overflow-hidden">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-20">Størrelse</TableHead>
                                <TableHead>SKU</TableHead>
                                <TableHead className="w-24 text-right">Pris</TableHead>
                                <TableHead className="w-20 text-right">Lager</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {group.variants.map((variant, idx) => (
                                <TableRow key={idx}>
                                  <TableCell>
                                    <Badge variant="outline">
                                      {variant.size || 'Standard'}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="font-mono text-xs">
                                    {variant.sku}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {variant.price} kr
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {variant.stockQuantity}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Rejected List */}
      {showRejected && (
        <Card>
          <CardContent className="p-0">
            {filteredRejected.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                {searchTerm ? 'Ingen afviste matcher søgningen' : 'Ingen afviste produkter'}
              </div>
            ) : (
              <div className="divide-y">
                {filteredRejected.map((rej, idx) => (
                  <div key={idx} className="p-4 flex items-start gap-3">
                    <XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-mono text-sm">{rej.externalId}</div>
                      <div className="text-sm text-muted-foreground mt-1">{rej.reason}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Group Detail Dialog */}
      <Dialog open={!!selectedGroup} onOpenChange={() => setSelectedGroup(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          {selectedGroup && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Package className="w-5 h-5" />
                  {selectedGroup.title}
                </DialogTitle>
              </DialogHeader>
              
              <div className="space-y-6">
                {/* Product info */}
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Vendor:</span>
                    <span className="ml-2 font-medium">{selectedGroup.vendor || 'Ikke angivet'}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Antal varianter:</span>
                    <span className="ml-2 font-medium">{selectedGroup.variants.length}</span>
                  </div>
                </div>

                {/* Tags */}
                {selectedGroup.tags.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2">Tags</h4>
                    <div className="flex flex-wrap gap-2">
                      {selectedGroup.tags.map((tag, i) => (
                        <Badge key={i} variant="secondary">{tag}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Images */}
                {selectedGroup.images.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2">Billeder ({selectedGroup.images.length})</h4>
                    <div className="flex gap-2 overflow-x-auto pb-2">
                      {selectedGroup.images.slice(0, 5).map((img, i) => (
                        <img 
                          key={i} 
                          src={img} 
                          alt={`Produkt billede ${i + 1}`}
                          className="w-20 h-20 object-cover rounded-lg border"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ))}
                      {selectedGroup.images.length > 5 && (
                        <div className="w-20 h-20 rounded-lg border flex items-center justify-center bg-muted text-sm text-muted-foreground">
                          +{selectedGroup.images.length - 5}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Warnings */}
                {selectedGroup.warnings.length > 0 && (
                  <div className="bg-amber-50 dark:bg-amber-950/30 rounded-lg p-4">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-medium mb-2">
                      <AlertTriangle className="w-4 h-4" />
                      Advarsler ({selectedGroup.warnings.length})
                    </div>
                    <ul className="text-sm text-amber-600 dark:text-amber-500 space-y-1">
                      {selectedGroup.warnings.map((warning, i) => (
                        <li key={i}>• {warning}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Variants table */}
                <div>
                  <h4 className="text-sm font-medium mb-2">Varianter (sorteret)</h4>
                  <div className="border rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-20">Størrelse</TableHead>
                          <TableHead>SKU</TableHead>
                          <TableHead className="text-right">Pris</TableHead>
                          <TableHead className="text-right">Udsalgspris</TableHead>
                          <TableHead className="text-right">Lager</TableHead>
                          <TableHead className="text-right">Vægt</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedGroup.variants.map((variant, idx) => (
                          <TableRow key={idx}>
                            <TableCell>
                              <Badge variant="outline">
                                {variant.size || 'Standard'}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {variant.sku}
                            </TableCell>
                            <TableCell className="text-right">
                              {variant.price} kr
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {variant.compareAtPrice ? `${variant.compareAtPrice} kr` : '-'}
                            </TableCell>
                            <TableCell className="text-right">
                              {variant.stockQuantity}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {variant.weight ? `${variant.weight} kg` : '-'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                {/* External IDs for debugging */}
                <div className="text-xs text-muted-foreground">
                  <details>
                    <summary className="cursor-pointer hover:text-foreground">
                      Tekniske detaljer ({selectedGroup.externalIds.length} originale rækker)
                    </summary>
                    <div className="mt-2 font-mono bg-muted p-2 rounded max-h-24 overflow-y-auto">
                      {selectedGroup.externalIds.join(', ')}
                    </div>
                  </details>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
