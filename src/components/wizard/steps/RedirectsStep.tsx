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
import * as XLSX from 'xlsx';
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
  FileUp,
  FileSpreadsheet
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

interface UploadedEntity {
  id: string;
  source_path: string | null;
  shopify_handle: string;
  entity_type: RedirectEntityType;
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
  const [unmatchedCount, setUnmatchedCount] = useState(0);
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

  // Fetch all uploaded entities to build a lookup map for matching old URLs
  const fetchUploadedEntities = async (): Promise<UploadedEntity[]> => {
    const entities: UploadedEntity[] = [];

    // Products - get source_path and generate handle from title
    const { data: products } = await supabase
      .from('canonical_products')
      .select('id, data, shopify_id')
      .eq('project_id', project.id)
      .eq('status', 'uploaded');

    for (const product of products || []) {
      const data = product.data as Record<string, unknown>;
      const sourcePath = data?.source_path as string | null;
      const title = data?.title as string;
      if (sourcePath && product.shopify_id) {
        entities.push({
          id: product.id,
          source_path: sourcePath,
          shopify_handle: `/products/${generateShopifyHandle(title)}`,
          entity_type: 'product',
        });
      }
    }

    // Categories
    const { data: categories } = await supabase
      .from('canonical_categories')
      .select('id, slug, shopify_collection_id, name')
      .eq('project_id', project.id)
      .eq('status', 'uploaded');

    for (const category of categories || []) {
      if (category.slug && category.shopify_collection_id) {
        entities.push({
          id: category.id,
          source_path: `/shop/${category.slug}/`,
          shopify_handle: `/collections/${generateShopifyHandle(category.name)}`,
          entity_type: 'category',
        });
        // Also add without trailing slash
        entities.push({
          id: category.id,
          source_path: `/shop/${category.slug}`,
          shopify_handle: `/collections/${generateShopifyHandle(category.name)}`,
          entity_type: 'category',
        });
      }
    }

    // Pages
    const { data: pages } = await supabase
      .from('canonical_pages')
      .select('id, data, shopify_id')
      .eq('project_id', project.id)
      .eq('status', 'uploaded');

    for (const page of pages || []) {
      const data = page.data as Record<string, unknown>;
      const slug = data?.slug as string;
      const title = data?.title as string;
      if (slug && page.shopify_id) {
        entities.push({
          id: page.id,
          source_path: `/${slug}`,
          shopify_handle: `/pages/${slug}`,
          entity_type: 'page',
        });
      }
    }

    return entities;
  };

  // Normalize URL path for matching
  const normalizePath = (path: string): string => {
    let normalized = path.trim().toLowerCase();
    // Remove domain if present
    try {
      const url = new URL(normalized);
      normalized = url.pathname;
    } catch {
      // Not a full URL, continue
    }
    // Ensure leading slash
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    // Remove trailing slash (except for root)
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  };

  // Handle Excel file upload with auto-matching
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUnmatchedCount(0);
    
    try {
      // Read Excel file
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

      if (rows.length < 1) {
        throw new Error('Excel-filen er tom');
      }

      // Fetch all uploaded entities for matching
      const uploadedEntities = await fetchUploadedEntities();
      
      // Build lookup maps for faster matching
      const pathToEntity = new Map<string, UploadedEntity>();
      for (const entity of uploadedEntities) {
        if (entity.source_path) {
          pathToEntity.set(normalizePath(entity.source_path), entity);
        }
      }

      const redirectsToInsert: Array<{
        project_id: string;
        entity_type: string;
        entity_id: string;
        old_path: string;
        new_path: string;
      }> = [];

      let unmatched = 0;

      // Parse rows - Column A is optional title, Column B is old URL
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        // Skip empty rows
        if (!row || row.length === 0) continue;
        
        // Column B (index 1) contains the old URL
        const oldUrlRaw = row[1]?.toString()?.trim();
        if (!oldUrlRaw) continue;

        const normalizedOldPath = normalizePath(oldUrlRaw);
        
        // Try to find matching entity
        const matchedEntity = pathToEntity.get(normalizedOldPath);
        
        if (matchedEntity) {
          redirectsToInsert.push({
            project_id: project.id,
            entity_type: matchedEntity.entity_type,
            entity_id: matchedEntity.id,
            old_path: normalizedOldPath,
            new_path: matchedEntity.shopify_handle,
          });
        } else {
          // No match found - still add but mark as needing manual review
          unmatched++;
          redirectsToInsert.push({
            project_id: project.id,
            entity_type: 'product', // Default
            entity_id: `excel-import-${i}`,
            old_path: normalizedOldPath,
            new_path: '', // Empty - needs manual input
          });
        }
      }

      if (redirectsToInsert.length === 0) {
        throw new Error('Ingen URLs fundet i kolonne B');
      }

      // Filter out unmatched (empty new_path) for now - only insert matched
      const matchedRedirects = redirectsToInsert.filter(r => r.new_path !== '');

      if (matchedRedirects.length > 0) {
        // Insert in batches
        const batchSize = 100;
        for (let i = 0; i < matchedRedirects.length; i += batchSize) {
          const batch = matchedRedirects.slice(i, i + batchSize);
          const { error } = await supabase
            .from('project_redirects')
            .insert(batch);
          
          if (error) throw error;
        }
      }

      setUnmatchedCount(unmatched);

      toast({
        title: 'Excel importeret',
        description: unmatched > 0 
          ? `${matchedRedirects.length} redirects matchet automatisk. ${unmatched} URLs kunne ikke matches.`
          : `${matchedRedirects.length} redirects matchet automatisk til Shopify URLs.`,
        variant: unmatched > 0 ? 'default' : 'default',
      });

      await loadRedirects();
    } catch (err) {
      console.error('Error importing Excel:', err);
      toast({
        title: 'Fejl ved import',
        description: err instanceof Error ? err.message : 'Kunne ikke importere Excel-fil',
        variant: 'destructive',
      });
    } finally {
      setIsUploading(false);
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
            
            {/* Excel Upload Button */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept=".xlsx,.xls"
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
                <FileSpreadsheet className="w-4 h-4 mr-2" />
              )}
              Upload Excel
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
          
          {/* Excel format explanation */}
          <div className="bg-muted/50 rounded-lg p-4 mt-4">
            <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4" />
              Excel-format
            </h4>
            <p className="text-xs text-muted-foreground">
              Upload en Excel-fil med gamle URLs i <strong>kolonne B</strong>. Kolonne A kan indeholde sidetitel (valgfrit).
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Programmet matcher automatisk gamle URLs til de nye Shopify-sider baseret på produkter, kollektioner og sider der allerede er uploadet.
            </p>
          </div>

          {unmatchedCount > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mt-3">
              <p className="text-sm text-amber-700 dark:text-amber-400">
                <AlertCircle className="w-4 h-4 inline mr-2" />
                {unmatchedCount} URLs kunne ikke matches automatisk og blev sprunget over.
              </p>
            </div>
          )}

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
