import { useState, useEffect, useMemo, useRef } from 'react';
import { Project, ProjectRedirect, RedirectEntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { 
  ArrowRight, 
  Check, 
  X, 
  Download, 
  Upload, 
  RefreshCw, 
  ExternalLink,
  AlertCircle,
  Loader2,
  Search,
  FileUp
} from 'lucide-react';

interface RedirectsStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

interface RedirectRow {
  id: string;
  entity_type: RedirectEntityType;
  entity_id: string;
  old_path: string;
  new_path: string;
  status: string;
  error_message: string | null;
  selected: boolean;
}

export function RedirectsStep({ project, onNext }: RedirectsStepProps) {
  const { toast } = useToast();
  const [redirects, setRedirects] = useState<RedirectRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [activeTab, setActiveTab] = useState<RedirectEntityType>('product');
  const [searchQuery, setSearchQuery] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load existing redirects
  useEffect(() => {
    loadRedirects();
  }, [project.id]);

  const loadRedirects = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('project_redirects')
        .select('*')
        .eq('project_id', project.id)
        .order('entity_type')
        .order('old_path');

      if (error) throw error;

      setRedirects(
        (data || []).map(r => ({
          id: r.id,
          entity_type: r.entity_type as RedirectEntityType,
          entity_id: r.entity_id,
          old_path: r.old_path,
          new_path: r.new_path,
          status: r.status,
          error_message: r.error_message,
          selected: r.status === 'pending',
        }))
      );
    } catch (err) {
      console.error('Error loading redirects:', err);
      toast({
        title: 'Fejl ved indlæsning',
        description: 'Kunne ikke hente redirects',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Generate redirects from canonical data
  const generateRedirects = async () => {
    setIsGenerating(true);
    try {
      // Clear existing pending redirects
      await supabase
        .from('project_redirects')
        .delete()
        .eq('project_id', project.id)
        .eq('status', 'pending');

      const redirectsToInsert: Array<{
        project_id: string;
        entity_type: string;
        entity_id: string;
        old_path: string;
        new_path: string;
      }> = [];

      // Products
      const { data: products } = await supabase
        .from('canonical_products')
        .select('id, external_id, data, shopify_id')
        .eq('project_id', project.id)
        .eq('status', 'uploaded');

      for (const product of products || []) {
        const data = product.data as Record<string, unknown>;
        const sourcePath = data?.source_path as string | null;
        const title = data?.title as string;
        
        if (sourcePath && product.shopify_id) {
          // Generate Shopify handle from title
          const handle = generateShopifyHandle(title);
          redirectsToInsert.push({
            project_id: project.id,
            entity_type: 'product',
            entity_id: product.id,
            old_path: sourcePath,
            new_path: `/products/${handle}`,
          });
        }
      }

      // Categories
      const { data: categories } = await supabase
        .from('canonical_categories')
        .select('id, external_id, slug, shopify_collection_id, name')
        .eq('project_id', project.id)
        .eq('status', 'uploaded');

      for (const category of categories || []) {
        if (category.slug && category.shopify_collection_id) {
          const handle = generateShopifyHandle(category.name);
          redirectsToInsert.push({
            project_id: project.id,
            entity_type: 'category',
            entity_id: category.id,
            old_path: `/shop/${category.slug}/`,
            new_path: `/collections/${handle}`,
          });
        }
      }

      // Pages
      const { data: pages } = await supabase
        .from('canonical_pages')
        .select('id, external_id, data, shopify_id')
        .eq('project_id', project.id)
        .eq('status', 'uploaded');

      for (const page of pages || []) {
        const data = page.data as Record<string, unknown>;
        const slug = data?.slug as string;
        
        if (slug && page.shopify_id) {
          redirectsToInsert.push({
            project_id: project.id,
            entity_type: 'page',
            entity_id: page.id,
            old_path: `/${slug}`,
            new_path: `/pages/${slug}`,
          });
        }
      }

      // Insert in batches
      const batchSize = 100;
      for (let i = 0; i < redirectsToInsert.length; i += batchSize) {
        const batch = redirectsToInsert.slice(i, i + batchSize);
        const { error } = await supabase
          .from('project_redirects')
          .insert(batch);
        
        if (error) throw error;
      }

      toast({
        title: 'Redirects genereret',
        description: `${redirectsToInsert.length} redirects klar til oprettelse`,
      });

      await loadRedirects();
    } catch (err) {
      console.error('Error generating redirects:', err);
      toast({
        title: 'Fejl',
        description: 'Kunne ikke generere redirects',
        variant: 'destructive',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  // Generate Shopify handle from title
  const generateShopifyHandle = (title: string): string => {
    return title
      .toLowerCase()
      .replace(/[æ]/g, 'ae')
      .replace(/[ø]/g, 'oe')
      .replace(/[å]/g, 'aa')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 255);
  };

  // Create redirects in Shopify
  const createRedirectsInShopify = async () => {
    const selectedRedirects = redirects.filter(r => r.selected && r.status === 'pending');
    if (selectedRedirects.length === 0) {
      toast({
        title: 'Ingen valgt',
        description: 'Vælg mindst én redirect at oprette',
        variant: 'destructive',
      });
      return;
    }

    setIsCreating(true);
    setProgress({ current: 0, total: selectedRedirects.length });

    try {
      const { error } = await supabase.functions.invoke('create-redirects', {
        body: {
          projectId: project.id,
          redirectIds: selectedRedirects.map(r => r.id),
        },
      });

      if (error) throw error;

      toast({
        title: 'Redirects oprettet',
        description: `Redirects er blevet oprettet i Shopify`,
      });

      await loadRedirects();
    } catch (err) {
      console.error('Error creating redirects:', err);
      toast({
        title: 'Fejl',
        description: 'Kunne ikke oprette redirects i Shopify',
        variant: 'destructive',
      });
    } finally {
      setIsCreating(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  // Handle CSV file upload
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const text = await file.text();
      const lines = text.split('\n').filter(line => line.trim());
      
      if (lines.length < 2) {
        throw new Error('CSV-filen skal indeholde mindst en header-linje og en data-linje');
      }

      // Parse header
      const header = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''));
      const oldPathIndex = header.findIndex(h => h === 'old_path' || h === 'from' || h === 'redirect from' || h === 'source');
      const newPathIndex = header.findIndex(h => h === 'new_path' || h === 'to' || h === 'redirect to' || h === 'target' || h === 'destination');

      if (oldPathIndex === -1 || newPathIndex === -1) {
        throw new Error('CSV-filen skal have kolonner for "old_path" (eller "from") og "new_path" (eller "to")');
      }

      const redirectsToInsert: Array<{
        project_id: string;
        entity_type: string;
        entity_id: string;
        old_path: string;
        new_path: string;
      }> = [];

      // Parse data rows
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        // Handle quoted CSV values
        const values = line.match(/("([^"]*)"|[^,]+)/g)?.map(v => v.replace(/^"|"$/g, '').trim()) || [];
        
        const oldPath = values[oldPathIndex]?.trim();
        const newPath = values[newPathIndex]?.trim();

        if (oldPath && newPath) {
          // Determine entity type from new_path
          let entityType: RedirectEntityType = 'product';
          if (newPath.includes('/collections/')) {
            entityType = 'category';
          } else if (newPath.includes('/pages/')) {
            entityType = 'page';
          }

          redirectsToInsert.push({
            project_id: project.id,
            entity_type: entityType,
            entity_id: `csv-import-${i}`,
            old_path: oldPath.startsWith('/') ? oldPath : `/${oldPath}`,
            new_path: newPath.startsWith('/') ? newPath : `/${newPath}`,
          });
        }
      }

      if (redirectsToInsert.length === 0) {
        throw new Error('Ingen gyldige redirects fundet i CSV-filen');
      }

      // Insert in batches
      const batchSize = 100;
      for (let i = 0; i < redirectsToInsert.length; i += batchSize) {
        const batch = redirectsToInsert.slice(i, i + batchSize);
        const { error } = await supabase
          .from('project_redirects')
          .insert(batch);
        
        if (error) throw error;
      }

      toast({
        title: 'CSV importeret',
        description: `${redirectsToInsert.length} redirects tilføjet fra CSV`,
      });

      await loadRedirects();
    } catch (err) {
      console.error('Error importing CSV:', err);
      toast({
        title: 'Fejl ved import',
        description: err instanceof Error ? err.message : 'Kunne ikke importere CSV-fil',
        variant: 'destructive',
      });
    } finally {
      setIsUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Download as CSV
  const downloadCSV = () => {
    const filteredRedirects = redirects.filter(r => r.entity_type === activeTab);
    const csv = [
      ['old_path', 'new_path', 'status'].join(','),
      ...filteredRedirects.map(r => 
        [r.old_path, r.new_path, r.status].map(v => `"${v}"`).join(',')
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `redirects-${activeTab}s-${project.name}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Toggle selection
  const toggleSelection = (id: string) => {
    setRedirects(prev => 
      prev.map(r => r.id === id ? { ...r, selected: !r.selected } : r)
    );
  };

  // Toggle all in current tab
  const toggleAllInTab = () => {
    const tabRedirects = redirects.filter(r => r.entity_type === activeTab && r.status === 'pending');
    const allSelected = tabRedirects.every(r => r.selected);
    
    setRedirects(prev =>
      prev.map(r => 
        r.entity_type === activeTab && r.status === 'pending'
          ? { ...r, selected: !allSelected }
          : r
      )
    );
  };

  // Filter redirects
  const filteredRedirects = useMemo(() => {
    return redirects
      .filter(r => r.entity_type === activeTab)
      .filter(r => 
        searchQuery === '' ||
        r.old_path.toLowerCase().includes(searchQuery.toLowerCase()) ||
        r.new_path.toLowerCase().includes(searchQuery.toLowerCase())
      );
  }, [redirects, activeTab, searchQuery]);

  // Stats
  const stats = useMemo(() => {
    const byType = {
      product: redirects.filter(r => r.entity_type === 'product'),
      category: redirects.filter(r => r.entity_type === 'category'),
      page: redirects.filter(r => r.entity_type === 'page'),
    };

    const total = redirects.length;
    const pending = redirects.filter(r => r.status === 'pending').length;
    const created = redirects.filter(r => r.status === 'created').length;
    const failed = redirects.filter(r => r.status === 'failed').length;

    return { byType, total, pending, created, failed };
  }, [redirects]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="secondary">Afventer</Badge>;
      case 'created':
        return <Badge variant="default" className="bg-primary">Oprettet</Badge>;
      case 'failed':
        return <Badge variant="destructive">Fejlet</Badge>;
      case 'skipped':
        return <Badge variant="outline">Sprunget over</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ExternalLink className="w-5 h-5" />
            URL Redirects
          </CardTitle>
          <CardDescription>
            Opret redirects fra gamle DanDomain URLs til nye Shopify URLs
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Stats */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <div className="text-2xl font-semibold">{stats.total}</div>
              <div className="text-xs text-muted-foreground">Total</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <div className="text-2xl font-semibold text-warning">{stats.pending}</div>
              <div className="text-xs text-muted-foreground">Afventer</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <div className="text-2xl font-semibold text-primary">{stats.created}</div>
              <div className="text-xs text-muted-foreground">Oprettet</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <div className="text-2xl font-semibold text-destructive">{stats.failed}</div>
              <div className="text-xs text-muted-foreground">Fejlet</div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={generateRedirects}
              disabled={isGenerating}
              variant="outline"
            >
              {isGenerating ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              Generer redirects
            </Button>
            
            {/* CSV Upload Button */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept=".csv"
              className="hidden"
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              variant="outline"
            >
              {isUploading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <FileUp className="w-4 h-4 mr-2" />
              )}
              Upload CSV
            </Button>
            
            <Button
              onClick={createRedirectsInShopify}
              disabled={isCreating || stats.pending === 0}
            >
              {isCreating ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-2" />
              )}
              Opret i Shopify ({redirects.filter(r => r.selected && r.status === 'pending').length})
            </Button>
            <Button
              onClick={downloadCSV}
              variant="outline"
              disabled={filteredRedirects.length === 0}
            >
              <Download className="w-4 h-4 mr-2" />
              Download CSV
            </Button>
          </div>
          
          {/* CSV format hint */}
          <p className="text-xs text-muted-foreground mt-3">
            CSV-format: Kolonner med "old_path" (eller "from") og "new_path" (eller "to")
          </p>

          {isCreating && progress.total > 0 && (
            <div className="mt-4">
              <Progress value={(progress.current / progress.total) * 100} />
              <p className="text-sm text-muted-foreground mt-1">
                {progress.current} af {progress.total} oprettet...
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Redirects table */}
      {redirects.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as RedirectEntityType)}>
              <div className="flex items-center justify-between mb-4">
                <TabsList>
                  <TabsTrigger value="product">
                    Produkter ({stats.byType.product.length})
                  </TabsTrigger>
                  <TabsTrigger value="category">
                    Kategorier ({stats.byType.category.length})
                  </TabsTrigger>
                  <TabsTrigger value="page">
                    Sider ({stats.byType.page.length})
                  </TabsTrigger>
                </TabsList>

                <div className="relative w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Søg i stier..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>

              <TabsContent value={activeTab} className="mt-0">
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            checked={
                              filteredRedirects
                                .filter(r => r.status === 'pending')
                                .every(r => r.selected)
                            }
                            onCheckedChange={toggleAllInTab}
                          />
                        </TableHead>
                        <TableHead>Gammel sti</TableHead>
                        <TableHead className="w-10"></TableHead>
                        <TableHead>Ny sti</TableHead>
                        <TableHead className="w-24">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRedirects.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                            {searchQuery ? 'Ingen resultater' : 'Ingen redirects - klik "Generer redirects"'}
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredRedirects.slice(0, 100).map((redirect) => (
                          <TableRow key={redirect.id}>
                            <TableCell>
                              <Checkbox
                                checked={redirect.selected}
                                onCheckedChange={() => toggleSelection(redirect.id)}
                                disabled={redirect.status !== 'pending'}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {redirect.old_path}
                            </TableCell>
                            <TableCell>
                              <ArrowRight className="w-4 h-4 text-muted-foreground" />
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {redirect.new_path}
                            </TableCell>
                            <TableCell>
                              {getStatusBadge(redirect.status)}
                              {redirect.error_message && (
                                <div className="text-xs text-destructive mt-1">
                                  {redirect.error_message}
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                  {filteredRedirects.length > 100 && (
                    <div className="p-3 text-center text-sm text-muted-foreground bg-muted/30">
                      Viser 100 af {filteredRedirects.length} redirects. Download CSV for fuld liste.
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {redirects.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <AlertCircle className="w-10 h-10 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">Ingen redirects genereret</h3>
            <p className="text-muted-foreground mb-4">
              Klik "Generer redirects" for at oprette redirects baseret på uploadede produkter, kategorier og sider.
            </p>
            <Button onClick={generateRedirects} disabled={isGenerating}>
              {isGenerating ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              Generer redirects
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Next button */}
      <div className="flex justify-end pt-4">
        <Button onClick={onNext} size="lg">
          Videre til rapport
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}
