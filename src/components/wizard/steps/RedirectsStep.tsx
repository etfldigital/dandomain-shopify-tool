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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
  FileSpreadsheet,
  ChevronDown,
  ChevronRight,
  AlertTriangle
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
  title?: string;
  external_id?: string;
}

interface UnmatchedUrl {
  originalUrl: string;
  normalizedPath: string;
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
  const [unmatchedUrls, setUnmatchedUrls] = useState<UnmatchedUrl[]>([]);
  const [unmatchedExpanded, setUnmatchedExpanded] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load existing redirects
  useEffect(() => {
    loadRedirects();
  }, [project.id]);

  const loadRedirects = async () => {
    setIsLoading(true);
    try {
      // Fetch ALL redirects using pagination to bypass 1000 row limit
      const allRedirects: ProjectRedirect[] = [];
      const pageSize = 1000;
      let from = 0;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from('project_redirects')
          .select('*')
          .eq('project_id', project.id)
          .order('entity_type')
          .order('old_path')
          .range(from, from + pageSize - 1);

        if (error) throw error;

        if (data && data.length > 0) {
          allRedirects.push(...(data as ProjectRedirect[]));
          from += pageSize;
          hasMore = data.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      setRedirects(
        allRedirects.map(r => ({
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

  // Reset/clear all redirects for this project
  const resetRedirects = async () => {
    try {
      const { error } = await supabase
        .from('project_redirects')
        .delete()
        .eq('project_id', project.id);

      if (error) throw error;

      setRedirects([]);
      setUnmatchedUrls([]);
      toast({
        title: 'Nulstillet',
        description: 'Alle redirects er blevet slettet',
      });
    } catch (err) {
      console.error('Error resetting redirects:', err);
      toast({
        title: 'Fejl',
        description: 'Kunne ikke nulstille redirects',
        variant: 'destructive',
      });
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

    // Products - include all uploaded products for flexible matching
    const { data: products } = await supabase
      .from('canonical_products')
      .select('id, external_id, data, shopify_id')
      .eq('project_id', project.id)
      .eq('status', 'uploaded');

    for (const product of products || []) {
      const data = product.data as Record<string, unknown>;
      const sourcePath = data?.source_path as string | null;
      const title = data?.title as string || '';
      const externalId = product.external_id;
      
      if (product.shopify_id) {
        entities.push({
          id: product.id,
          source_path: sourcePath,
          shopify_handle: `/products/${generateShopifyHandle(title)}`,
          entity_type: 'product',
          title: title,
          external_id: externalId,
        });
      }
    }

    // Categories - include all uploaded categories
    const { data: categories } = await supabase
      .from('canonical_categories')
      .select('id, external_id, slug, shopify_collection_id, name')
      .eq('project_id', project.id)
      .eq('status', 'uploaded');

    for (const category of categories || []) {
      if (category.shopify_collection_id) {
        entities.push({
          id: category.id,
          source_path: category.slug ? `/shop/${category.slug}/` : null,
          shopify_handle: `/collections/${generateShopifyHandle(category.name)}`,
          entity_type: 'category',
          title: category.name,
          external_id: category.external_id,
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
      const title = data?.title as string || '';
      if (page.shopify_id) {
        entities.push({
          id: page.id,
          source_path: slug ? `/${slug}` : null,
          shopify_handle: `/pages/${slug || generateShopifyHandle(title)}`,
          entity_type: 'page',
          title: title,
          external_id: page.external_id,
        });
      }
    }

    return entities;
  };

  // Strip root domain from URL
  const stripRootDomain = (url: string): string => {
    let normalized = url.trim();
    
    // Remove common protocols
    normalized = normalized.replace(/^https?:\/\//, '');
    
    // Remove www. prefix
    normalized = normalized.replace(/^www\./, '');
    
    // Find the first slash after the domain
    const slashIndex = normalized.indexOf('/');
    if (slashIndex > 0) {
      normalized = normalized.substring(slashIndex);
    } else if (slashIndex === -1) {
      // No path, just domain - return root
      normalized = '/';
    }
    
    return normalized;
  };

  // Normalize URL path for matching
  const normalizePath = (path: string): string => {
    // First strip the root domain
    let normalized = stripRootDomain(path).toLowerCase();
    
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

  // Extract slug from URL path for matching
  const extractSlugFromPath = (path: string): string => {
    // Remove common prefixes and get the last meaningful segment
    const cleanPath = path
      .replace(/^\/shop\//, '')
      .replace(/^\/products\//, '')
      .replace(/^\/collections\//, '')
      .replace(/^\/pages\//, '')
      .replace(/\/$/, '');
    
    // Get the last segment (the actual slug)
    const segments = cleanPath.split('/').filter(Boolean);
    return segments[segments.length - 1] || '';
  };

  // Normalize text for comparison (Danish chars, case, special chars)
  const normalizeForComparison = (text: string): string => {
    return text
      .toLowerCase()
      .replace(/[æ]/g, 'ae')
      .replace(/[ø]/g, 'oe')
      .replace(/[å]/g, 'aa')
      .replace(/[^a-z0-9]/g, '');
  };

  // Handle Excel file upload with auto-matching
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUnmatchedUrls([]);
    
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
      
      // Build multiple lookup maps for flexible matching
      const pathToEntity = new Map<string, UploadedEntity>();
      const slugToEntity = new Map<string, UploadedEntity>();
      const titleNormalizedToEntity = new Map<string, UploadedEntity>();
      
      for (const entity of uploadedEntities) {
        // Map by source_path if available
        if (entity.source_path) {
          pathToEntity.set(normalizePath(entity.source_path), entity);
        }
        
        // Map by normalized title for fuzzy matching
        if (entity.title) {
          const normalizedTitle = normalizeForComparison(entity.title);
          if (!titleNormalizedToEntity.has(normalizedTitle)) {
            titleNormalizedToEntity.set(normalizedTitle, entity);
          }
        }
        
        // Map by Shopify handle slug
        const handleSlug = entity.shopify_handle.split('/').pop() || '';
        if (handleSlug) {
          slugToEntity.set(handleSlug, entity);
        }
      }

      const redirectsToInsert: Array<{
        project_id: string;
        entity_type: string;
        entity_id: string;
        old_path: string;
        new_path: string;
      }> = [];

      const newUnmatchedUrls: UnmatchedUrl[] = [];

      // Parse rows - Column A contains old URL
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as unknown[];
        // Skip empty rows
        if (!row || row.length === 0) continue;
        
        // Column A (index 0) contains the old URL
        const oldUrlRaw = row[0]?.toString()?.trim();
        if (!oldUrlRaw) continue;

        const normalizedOldPath = normalizePath(oldUrlRaw);
        const oldSlug = extractSlugFromPath(normalizedOldPath);
        const normalizedOldSlug = normalizeForComparison(oldSlug);
        
        // Try multiple matching strategies
        let matchedEntity: UploadedEntity | undefined;
        
        // Strategy 1: Exact path match
        matchedEntity = pathToEntity.get(normalizedOldPath);
        
        // Strategy 2: Slug match (extract slug from URL and match)
        if (!matchedEntity && oldSlug) {
          matchedEntity = slugToEntity.get(oldSlug);
        }
        
        // Strategy 3: Normalized title match (fuzzy)
        if (!matchedEntity && normalizedOldSlug) {
          matchedEntity = titleNormalizedToEntity.get(normalizedOldSlug);
        }
        
        // Strategy 4: Partial title match - find entity where normalized title contains the slug
        if (!matchedEntity && normalizedOldSlug && normalizedOldSlug.length > 3) {
          for (const entity of uploadedEntities) {
            if (entity.title) {
              const normalizedEntityTitle = normalizeForComparison(entity.title);
              // Check if titles are similar enough
              if (normalizedEntityTitle === normalizedOldSlug || 
                  normalizedEntityTitle.includes(normalizedOldSlug) ||
                  normalizedOldSlug.includes(normalizedEntityTitle)) {
                matchedEntity = entity;
                break;
              }
            }
          }
        }
        
        if (matchedEntity) {
          redirectsToInsert.push({
            project_id: project.id,
            entity_type: matchedEntity.entity_type,
            entity_id: matchedEntity.id,
            old_path: normalizedOldPath,
            new_path: matchedEntity.shopify_handle,
          });
        } else {
          newUnmatchedUrls.push({
            originalUrl: oldUrlRaw,
            normalizedPath: normalizedOldPath,
          });
        }
      }

      if (redirectsToInsert.length === 0 && newUnmatchedUrls.length === 0) {
        throw new Error('Ingen URLs fundet i kolonne A');
      }

      if (redirectsToInsert.length > 0) {
        // Insert ALL in batches - no limit
        const batchSize = 100;
        for (let i = 0; i < redirectsToInsert.length; i += batchSize) {
          const batch = redirectsToInsert.slice(i, i + batchSize);
          const { error } = await supabase
            .from('project_redirects')
            .insert(batch);
          
          if (error) throw error;
        }
      }

      setUnmatchedUrls(newUnmatchedUrls);

      const totalFound = redirectsToInsert.length + newUnmatchedUrls.length;
      toast({
        title: 'Excel importeret',
        description: newUnmatchedUrls.length > 0 
          ? `${redirectsToInsert.length} af ${totalFound} URLs matchet automatisk. ${newUnmatchedUrls.length} URLs kunne ikke matches.`
          : `${redirectsToInsert.length} redirects matchet automatisk til Shopify URLs.`,
        variant: newUnmatchedUrls.length > 0 ? 'default' : 'default',
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

  // Download unmatched URLs as CSV
  const downloadUnmatchedCSV = () => {
    const csv = [
      ['original_url', 'normalized_path'].join(','),
      ...unmatchedUrls.map(u => 
        [u.originalUrl, u.normalizedPath].map(v => `"${v}"`).join(',')
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `unmatched-urls-${project.name}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
            
            <Button
              onClick={resetRedirects}
              variant="outline"
              disabled={redirects.length === 0}
              className="text-destructive hover:text-destructive"
            >
              <X className="w-4 h-4 mr-2" />
              Nulstil
            </Button>
          </div>
          
          {/* Excel format explanation */}
          <div className="bg-muted/50 rounded-lg p-4 mt-4">
            <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4" />
              Excel-format
            </h4>
            <p className="text-xs text-muted-foreground">
              Upload en Excel-fil med alle gamle URLs der skal redirectes i <strong>kolonne A</strong>.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Root-domænet (f.eks. https://maggiesgemakker.dk) fjernes automatisk fra URL'erne.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Programmet matcher automatisk gamle URLs til de nye Shopify-sider baseret på produkter, kollektioner og sider der allerede er uploadet.
            </p>
          </div>

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

      {/* Unmatched URLs section */}
      {unmatchedUrls.length > 0 && (
        <Card className="border-amber-500/30">
          <Collapsible open={unmatchedExpanded} onOpenChange={setUnmatchedExpanded}>
            <CardHeader className="pb-3">
              <CollapsibleTrigger className="flex items-center justify-between w-full">
                <CardTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-5 h-5" />
                  Umatchede URLs ({unmatchedUrls.length})
                </CardTitle>
                {unmatchedExpanded ? (
                  <ChevronDown className="w-5 h-5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-5 h-5 text-muted-foreground" />
                )}
              </CollapsibleTrigger>
              <CardDescription>
                Disse URLs kunne ikke matches automatisk til uploadede produkter, kategorier eller sider
              </CardDescription>
            </CardHeader>
            <CollapsibleContent>
              <CardContent className="pt-0">
                <div className="flex justify-end mb-3">
                  <Button
                    onClick={downloadUnmatchedCSV}
                    variant="outline"
                    size="sm"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Download umatchede URLs
                  </Button>
                </div>
                <ScrollArea className="h-[300px] border rounded-lg">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Original URL</TableHead>
                        <TableHead>Normaliseret sti</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {unmatchedUrls.slice(0, 100).map((url, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {url.originalUrl}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {url.normalizedPath}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {unmatchedUrls.length > 100 && (
                    <div className="p-3 text-center text-sm text-muted-foreground bg-muted/30">
                      Viser 100 af {unmatchedUrls.length} umatchede URLs. Download CSV for fuld liste.
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      )}

      {/* Redirects table */}
      {redirects.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Check className="w-5 h-5 text-primary" />
              Matchede redirects ({stats.total})
            </CardTitle>
            <CardDescription>
              Gennemgå og bekræft redirects før de oprettes i Shopify
            </CardDescription>
          </CardHeader>
          <CardContent>
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
      {redirects.length === 0 && unmatchedUrls.length === 0 && (
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
