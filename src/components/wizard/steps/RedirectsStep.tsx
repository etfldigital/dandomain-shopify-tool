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
import { Label } from '@/components/ui/label';
import { ShopifyDestinationSearch } from './ShopifyDestinationSearch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
  FileSpreadsheet,
  AlertTriangle,
  Eye,
  Package,
  FolderOpen,
  FileText,
  Sparkles,
  Wand2,
  Globe,
  Info,
  CheckCircle,
  HelpCircle,
  XCircle
} from 'lucide-react';

// ============================================
// TYPES
// ============================================

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
  old_type: 'product' | 'category' | 'unknown';
  status: RedirectStatus;
  error_message: string | null;
  selected: boolean;
  confidence_score: number;
  matched_by?: string;
  match_reason?: string;
  ai_suggestions?: Array<{
    entity_id: string;
    new_path: string;
    title: string;
    score: number;
  }>;
}

type RedirectStatus = 'auto_approved' | 'needs_review' | 'no_match' | 'pending' | 'created' | 'failed';
type TabType = 'auto_approved' | 'needs_review' | 'no_match' | 'all';

interface SitemapUrl {
  loc: string;
  type: 'product' | 'category' | 'unknown';
}

interface ShopifyUrl {
  loc: string;
  type: 'product' | 'collection' | 'page';
  handle: string;
}

interface UrlInspectionResult {
  success: boolean;
  pageType: 'product' | 'collection' | 'page' | 'unknown';
  title?: string;
  productInfo?: { name: string; sku?: string; price?: string };
  collectionInfo?: { name: string; productCount?: number };
  error?: string;
}

// ============================================
// CONSTANTS
// ============================================

const AUTO_APPROVE_THRESHOLD = 90;
const REVIEW_THRESHOLD = 50;

// ============================================
// HELPER FUNCTIONS
// ============================================

// Normalize path for comparison
function normalizePath(path: string): string {
  let normalized = path.trim().toLowerCase();
  normalized = normalized.replace(/^https?:\/\/[^\/]+/, '');
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

// Extract slug from path
function extractSlugFromPath(path: string): string {
  const cleanPath = path
    .replace(/^\/shop\//, '')
    .replace(/^\/products\//, '')
    .replace(/^\/collections\//, '')
    .replace(/^\/pages\//, '')
    .replace(/\/$/, '')
    .replace(/\.html$/, '');
  const segments = cleanPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

// Normalize for text comparison
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'oe')
    .replace(/[å]/g, 'aa')
    .replace(/[^a-z0-9]/g, '');
}

// Extract product name from DanDomain slug (removes ID suffix)
function extractProductNameFromSlug(slug: string): string {
  const withoutExtension = slug.replace(/\.html$/, '');
  return withoutExtension.replace(/-\d+[pc]?\d*$/, '').replace(/-[A-Z0-9]+p$/, '');
}

// Classify URL type from path
function classifyUrlType(path: string): 'product' | 'category' | 'unknown' {
  const lower = path.toLowerCase();
  if (/-\d+p\.html$/i.test(lower)) return 'product';
  if (/-\d+c\d*\.html$/i.test(lower) || /-\d+s\d*\.html$/i.test(lower)) return 'category';
  if (lower.includes('/products/')) return 'product';
  if (lower.includes('/collections/')) return 'category';
  return 'unknown';
}

// Generate Shopify handle
function generateShopifyHandle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'oe')
    .replace(/[å]/g, 'aa')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 255);
}

// Determine redirect status based on confidence
function getRedirectStatus(confidence: number): RedirectStatus {
  if (confidence >= AUTO_APPROVE_THRESHOLD) return 'auto_approved';
  if (confidence >= REVIEW_THRESHOLD) return 'needs_review';
  return 'no_match';
}

// Get status display info
function getStatusInfo(status: RedirectStatus): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: React.ReactNode } {
  switch (status) {
    case 'auto_approved':
      return { label: 'Automatisk godkendt', variant: 'default', icon: <CheckCircle className="w-3 h-3" /> };
    case 'needs_review':
      return { label: 'Kræver gennemsyn', variant: 'secondary', icon: <HelpCircle className="w-3 h-3" /> };
    case 'no_match':
      return { label: 'Ingen match', variant: 'destructive', icon: <XCircle className="w-3 h-3" /> };
    case 'created':
      return { label: 'Oprettet', variant: 'default', icon: <Check className="w-3 h-3" /> };
    case 'failed':
      return { label: 'Fejlet', variant: 'destructive', icon: <X className="w-3 h-3" /> };
    default:
      return { label: 'Afventer', variant: 'outline', icon: null };
  }
}

// ============================================
// MAIN COMPONENT
// ============================================

export function RedirectsStep({ project, onNext }: RedirectsStepProps) {
  const { toast } = useToast();
  
  // Data state
  const [redirects, setRedirects] = useState<RedirectRow[]>([]);
  const [shopifyUrls, setShopifyUrls] = useState<ShopifyUrl[]>([]);
  const [dandomanUrls, setDandomainUrls] = useState<SitemapUrl[]>([]);
  
  // Loading states
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isFetchingSitemaps, setIsFetchingSitemaps] = useState(false);
  const [isAiMatching, setIsAiMatching] = useState(false);
  
  // UI state
  const [activeTab, setActiveTab] = useState<TabType>('auto_approved');
  const [searchQuery, setSearchQuery] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  
  // Sitemap inputs
  const [productSitemapUrl, setProductSitemapUrl] = useState('');
  const [categorySitemapUrl, setCategorySitemapUrl] = useState('');
  
  // URL inspection
  const [inspectionDialogOpen, setInspectionDialogOpen] = useState(false);
  const [inspectionUrl, setInspectionUrl] = useState('');
  const [inspectionResult, setInspectionResult] = useState<UrlInspectionResult | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  
  // File upload
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ============================================
  // DATA LOADING
  // ============================================

  useEffect(() => {
    loadRedirects();
    loadShopifyUrls();
  }, [project.id]);

  const loadRedirects = async () => {
    setIsLoading(true);
    try {
      const allRedirects: ProjectRedirect[] = [];
      const pageSize = 1000;
      let from = 0;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from('project_redirects')
          .select('*')
          .eq('project_id', project.id)
          .order('confidence_score', { ascending: false })
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
        allRedirects.map(r => {
          const confidence = (r as unknown as { confidence_score?: number }).confidence_score ?? 0;
          const dbStatus = r.status as string;
          
          // Map database status to our UI status
          let uiStatus: RedirectStatus;
          if (dbStatus === 'created') uiStatus = 'created';
          else if (dbStatus === 'failed') uiStatus = 'failed';
          else uiStatus = getRedirectStatus(confidence);
          
          return {
            id: r.id,
            entity_type: r.entity_type as RedirectEntityType,
            entity_id: r.entity_id,
            old_path: r.old_path,
            new_path: r.new_path,
            old_type: classifyUrlType(r.old_path),
            status: uiStatus,
            error_message: r.error_message,
            selected: uiStatus === 'auto_approved',
            confidence_score: confidence,
            matched_by: (r as unknown as { matched_by?: string }).matched_by,
            ai_suggestions: (r as unknown as { ai_suggestions?: RedirectRow['ai_suggestions'] }).ai_suggestions ?? [],
          };
        })
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

  const loadShopifyUrls = async () => {
    try {
      // Fetch from database (uploaded entities)
      const entities: ShopifyUrl[] = [];
      
      const { data: products } = await supabase
        .from('canonical_products')
        .select('data, shopify_id')
        .eq('project_id', project.id)
        .eq('status', 'uploaded');

      for (const p of products || []) {
        const data = p.data as Record<string, unknown>;
        const title = (data?.title as string) || '';
        const handle = (data?.shopify_handle as string) || generateShopifyHandle(title);
        if (p.shopify_id) {
          entities.push({ loc: `/products/${handle}`, type: 'product', handle });
        }
      }

      const { data: categories } = await supabase
        .from('canonical_categories')
        .select('name, shopify_tag, shopify_collection_id')
        .eq('project_id', project.id)
        .eq('status', 'uploaded');

      for (const c of categories || []) {
        const handle = c.shopify_tag || generateShopifyHandle(c.name);
        if (c.shopify_collection_id) {
          entities.push({ loc: `/collections/${handle}`, type: 'collection', handle });
        }
      }

      const { data: pages } = await supabase
        .from('canonical_pages')
        .select('data, shopify_id')
        .eq('project_id', project.id)
        .eq('status', 'uploaded');

      for (const pg of pages || []) {
        const data = pg.data as Record<string, unknown>;
        const slug = (data?.slug as string) || '';
        const handle = (data?.shopify_handle as string) || slug;
        if (pg.shopify_id && handle) {
          entities.push({ loc: `/pages/${handle}`, type: 'page', handle });
        }
      }

      setShopifyUrls(entities);
    } catch (err) {
      console.error('Error loading Shopify URLs:', err);
    }
  };

  // ============================================
  // SITEMAP FETCHING
  // ============================================

  const fetchSitemaps = async () => {
    if (!productSitemapUrl && !categorySitemapUrl) {
      toast({
        title: 'Mangler URL',
        description: 'Angiv mindst én sitemap URL',
        variant: 'destructive',
      });
      return;
    }

    setIsFetchingSitemaps(true);
    try {
      const { data, error } = await supabase.functions.invoke('parse-sitemap', {
        body: {
          projectId: project.id,
          productSitemapUrl: productSitemapUrl || undefined,
          categorySitemapUrl: categorySitemapUrl || undefined,
        },
      });

      if (error) throw error;
      if (data.error) throw new Error(data.error);

      setDandomainUrls(data.urls || []);
      
      toast({
        title: 'Sitemaps hentet',
        description: `Fandt ${data.stats.products} produkter, ${data.stats.categories} kategorier, ${data.stats.unknown} ukendte`,
      });
    } catch (err) {
      console.error('Error fetching sitemaps:', err);
      toast({
        title: 'Fejl ved hentning',
        description: err instanceof Error ? err.message : 'Kunne ikke hente sitemaps',
        variant: 'destructive',
      });
    } finally {
      setIsFetchingSitemaps(false);
    }
  };

  // ============================================
  // REDIRECT GENERATION
  // ============================================

  const generateRedirects = async () => {
    // Use either sitemap URLs or uploaded entities from database
    const urlsToMatch = dandomanUrls.length > 0 
      ? dandomanUrls.map(u => u.loc)
      : [];

    if (urlsToMatch.length === 0) {
      // Generate from database (canonical entities with source_path)
      await generateFromDatabase();
      return;
    }

    setIsGenerating(true);
    setProgress({ current: 0, total: urlsToMatch.length });

    try {
      // Call match-redirects edge function in batches
      const BATCH_SIZE = 100;
      let totalMatched = 0;
      let totalUnmatched = 0;

      for (let i = 0; i < urlsToMatch.length; i += BATCH_SIZE) {
        const batch = urlsToMatch.slice(i, i + BATCH_SIZE);
        
        const { data, error } = await supabase.functions.invoke('match-redirects', {
          body: {
            projectId: project.id,
            oldPaths: batch,
          },
        });

        if (error) throw error;

        totalMatched += data.matched || 0;
        totalUnmatched += data.unmatched || 0;
        setProgress({ current: Math.min(i + BATCH_SIZE, urlsToMatch.length), total: urlsToMatch.length });
      }

      toast({
        title: 'Redirects genereret',
        description: `${totalMatched} matchet, ${totalUnmatched} kræver manuel gennemgang`,
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
      setProgress({ current: 0, total: 0 });
    }
  };

  const generateFromDatabase = async () => {
    setIsGenerating(true);
    try {
      // Clear existing redirects (not created ones)
      await supabase
        .from('project_redirects')
        .delete()
        .eq('project_id', project.id)
        .neq('status', 'created');

      const redirectsToInsert: Array<{
        project_id: string;
        entity_type: string;
        entity_id: string;
        old_path: string;
        new_path: string;
        confidence_score: number;
        matched_by: string;
      }> = [];

      // Products - fetch ALL with pagination, only PRIMARY products
      const pageSize = 1000;
      let from = 0;
      let hasMore = true;

      while (hasMore) {
        const { data: products, error } = await supabase
          .from('canonical_products')
          .select('id, external_id, data, shopify_id')
          .eq('project_id', project.id)
          .eq('status', 'uploaded')
          .range(from, from + pageSize - 1);

        if (error) throw error;

        for (const product of products || []) {
          const data = product.data as Record<string, unknown>;
          const isPrimary = data?._isPrimary as boolean;
          
          // Only include primary products (the actual Shopify products)
          if (!isPrimary) continue;
          
          const sourcePath = data?.source_path as string | null;
          const title = data?.title as string;
          const storedHandle = data?.shopify_handle as string | null;
          const handle = storedHandle || generateShopifyHandle(title);
          
          if (sourcePath && product.shopify_id) {
            redirectsToInsert.push({
              project_id: project.id,
              entity_type: 'product',
              entity_id: product.id,
              old_path: sourcePath,
              new_path: `/products/${handle}`,
              confidence_score: 100,
              matched_by: 'exact',
            });
          }
        }

        from += pageSize;
        hasMore = (products?.length || 0) === pageSize;
      }

      // Categories - with pagination
      from = 0;
      hasMore = true;
      while (hasMore) {
        const { data: categories, error } = await supabase
          .from('canonical_categories')
          .select('id, external_id, slug, shopify_collection_id, name, shopify_tag')
          .eq('project_id', project.id)
          .eq('status', 'uploaded')
          .range(from, from + pageSize - 1);

        if (error) throw error;

        for (const category of categories || []) {
          if (category.slug && category.shopify_collection_id) {
            const handle = category.shopify_tag || generateShopifyHandle(category.name);
            redirectsToInsert.push({
              project_id: project.id,
              entity_type: 'category',
              entity_id: category.id,
              old_path: `/shop/${category.slug}/`,
              new_path: `/collections/${handle}`,
              confidence_score: 100,
              matched_by: 'exact',
            });
          }
        }

        from += pageSize;
        hasMore = (categories?.length || 0) === pageSize;
      }

      // Pages - with pagination
      from = 0;
      hasMore = true;
      while (hasMore) {
        const { data: pages, error } = await supabase
          .from('canonical_pages')
          .select('id, external_id, data, shopify_id')
          .eq('project_id', project.id)
          .eq('status', 'uploaded')
          .range(from, from + pageSize - 1);

        if (error) throw error;

        for (const page of pages || []) {
          const data = page.data as Record<string, unknown>;
          const slug = data?.slug as string;
          const storedHandle = data?.shopify_handle as string | null;
          const handle = storedHandle || slug;
          
          if (handle && page.shopify_id) {
            redirectsToInsert.push({
              project_id: project.id,
              entity_type: 'page',
              entity_id: page.id,
              old_path: `/${slug || handle}`,
              new_path: `/pages/${handle}`,
              confidence_score: 100,
              matched_by: 'exact',
            });
          }
        }

        from += pageSize;
        hasMore = (pages?.length || 0) === pageSize;
      }

      // Insert in batches
      const batchSize = 100;
      setProgress({ current: 0, total: redirectsToInsert.length });
      
      for (let i = 0; i < redirectsToInsert.length; i += batchSize) {
        const batch = redirectsToInsert.slice(i, i + batchSize);
        const { error } = await supabase.from('project_redirects').insert(batch);
        if (error) console.error('Insert error:', error);
        setProgress({ current: Math.min(i + batchSize, redirectsToInsert.length), total: redirectsToInsert.length });
      }

      toast({
        title: 'Redirects genereret',
        description: `${redirectsToInsert.length} redirects klar (${redirectsToInsert.filter(r => r.entity_type === 'product').length} produkter, ${redirectsToInsert.filter(r => r.entity_type === 'category').length} kategorier)`,
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
      setProgress({ current: 0, total: 0 });
    }
  };

  // ============================================
  // AI MATCHING
  // ============================================

  const runAiMatching = async () => {
    const unmatchedRedirects = redirects.filter(r => 
      r.status !== 'auto_approved' && r.status !== 'created'
    );
    
    if (unmatchedRedirects.length === 0) {
      toast({
        title: 'Ingen at matche',
        description: 'Alle redirects er allerede matchet',
      });
      return;
    }

    setIsAiMatching(true);
    setProgress({ current: 0, total: unmatchedRedirects.length });

    try {
      const BATCH_SIZE = 50;
      let totalMatched = 0;

      for (let i = 0; i < unmatchedRedirects.length; i += BATCH_SIZE) {
        const batch = unmatchedRedirects.slice(i, i + BATCH_SIZE);
        const paths = batch.map(r => r.old_path);

        const { data, error } = await supabase.functions.invoke('match-redirects', {
          body: {
            projectId: project.id,
            oldPaths: paths,
          },
        });

        if (error) throw error;

        totalMatched += data.matched || 0;
        setProgress({ current: Math.min(i + BATCH_SIZE, unmatchedRedirects.length), total: unmatchedRedirects.length });
      }

      toast({
        title: 'AI-matching fuldført',
        description: `${totalMatched} nye matches fundet`,
      });

      await loadRedirects();
    } catch (err) {
      console.error('Error in AI matching:', err);
      toast({
        title: 'Fejl ved AI-matching',
        description: err instanceof Error ? err.message : 'Kunne ikke køre AI-matching',
        variant: 'destructive',
      });
    } finally {
      setIsAiMatching(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  // ============================================
  // SHOPIFY CREATION
  // ============================================

  const createRedirectsInShopify = async () => {
    const selectedRedirects = redirects.filter(r => 
      r.selected && (r.status === 'auto_approved' || r.status === 'needs_review')
    );
    
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
      const { data, error } = await supabase.functions.invoke('create-redirects', {
        body: {
          projectId: project.id,
          redirectIds: selectedRedirects.map(r => r.id),
        },
      });

      if (error) throw error;

      toast({
        title: 'Redirects oprettet',
        description: `${data.created} oprettet, ${data.failed} fejlede`,
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

  // ============================================
  // FILE HANDLING
  // ============================================

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

      const urls: SitemapUrl[] = [];
      for (const row of rows) {
        const arr = row as unknown[];
        if (!arr?.[0]) continue;
        const url = String(arr[0]).trim();
        if (!url) continue;
        
        urls.push({
          loc: normalizePath(url),
          type: classifyUrlType(url),
        });
      }

      if (urls.length === 0) {
        throw new Error('Ingen URLs fundet i kolonne A');
      }

      setDandomainUrls(urls);
      toast({
        title: 'Fil importeret',
        description: `${urls.length} URLs indlæst`,
      });
    } catch (err) {
      console.error('Error importing file:', err);
      toast({
        title: 'Fejl ved import',
        description: err instanceof Error ? err.message : 'Kunne ikke importere fil',
        variant: 'destructive',
      });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const downloadAsCSV = () => {
    const filtered = activeTab === 'all' ? redirects : redirects.filter(r => r.status === activeTab);
    const csv = [
      ['old_path', 'new_path', 'type', 'confidence', 'status'].join(','),
      ...filtered.map(r => 
        [r.old_path, r.new_path, r.old_type, r.confidence_score, r.status].map(v => `"${v}"`).join(',')
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `redirects-${project.name}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAsExcel = () => {
    const filtered = activeTab === 'all' ? redirects : redirects.filter(r => r.status === activeTab);
    const data = filtered.map(r => ({
      'Gammel URL': r.old_path,
      'Ny URL': r.new_path,
      'Type': r.old_type === 'product' ? 'Produkt' : r.old_type === 'category' ? 'Kategori' : 'Ukendt',
      'Confidence': r.confidence_score,
      'Status': getStatusInfo(r.status).label,
      'Match metode': r.matched_by || '',
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Redirects');
    XLSX.writeFile(wb, `redirects-${project.name}.xlsx`);
  };

  // ============================================
  // UI ACTIONS
  // ============================================

  const toggleSelection = (id: string) => {
    setRedirects(prev => prev.map(r => r.id === id ? { ...r, selected: !r.selected } : r));
  };

  const toggleAllInTab = () => {
    const tabRedirects = filteredRedirects.filter(r => r.status !== 'created' && r.status !== 'failed');
    const allSelected = tabRedirects.every(r => r.selected);
    const ids = new Set(tabRedirects.map(r => r.id));
    setRedirects(prev => prev.map(r => ids.has(r.id) ? { ...r, selected: !allSelected } : r));
  };

  const updateNewPath = async (id: string, newPath: string, isManualSelection = false) => {
    const newConfidence = isManualSelection ? 100 : undefined;
    
    setRedirects(prev => prev.map(r => r.id === id ? { 
      ...r, 
      new_path: newPath,
      confidence_score: newConfidence ?? r.confidence_score,
      status: newConfidence ? 'auto_approved' : r.status,
    } : r));

    try {
      const updateData: Record<string, unknown> = { new_path: newPath };
      if (newConfidence) {
        updateData.confidence_score = newConfidence;
        updateData.matched_by = 'manual';
      }
      
      await supabase.from('project_redirects').update(updateData).eq('id', id);
    } catch (err) {
      console.error('Error updating path:', err);
    }
  };

  const resetRedirects = async () => {
    try {
      await supabase.from('project_redirects').delete().eq('project_id', project.id);
      setRedirects([]);
      setDandomainUrls([]);
      toast({ title: 'Nulstillet', description: 'Alle redirects er blevet slettet' });
    } catch (err) {
      console.error('Error resetting:', err);
      toast({ title: 'Fejl', description: 'Kunne ikke nulstille', variant: 'destructive' });
    }
  };

  const inspectUrl = async (oldPath: string) => {
    const base = project.dandomain_shop_url?.replace(/\/$/, '') || '';
    const fullUrl = base ? `https://${base.replace(/^https?:\/\//, '')}${oldPath}` : oldPath;
    
    setInspectionUrl(fullUrl);
    setInspectionDialogOpen(true);
    setIsInspecting(true);
    setInspectionResult(null);

    try {
      const { data, error } = await supabase.functions.invoke('inspect-url', {
        body: { url: fullUrl },
      });
      if (error) throw error;
      setInspectionResult(data);
    } catch (err) {
      setInspectionResult({
        success: false,
        pageType: 'unknown',
        error: err instanceof Error ? err.message : 'Kunne ikke inspicere URL',
      });
    } finally {
      setIsInspecting(false);
    }
  };

  // ============================================
  // COMPUTED VALUES
  // ============================================

  const filteredRedirects = useMemo(() => {
    let filtered = redirects;
    
    if (activeTab !== 'all') {
      filtered = filtered.filter(r => r.status === activeTab);
    }
    
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(r => 
        r.old_path.toLowerCase().includes(q) || 
        r.new_path.toLowerCase().includes(q)
      );
    }
    
    return filtered;
  }, [redirects, activeTab, searchQuery]);

  const stats = useMemo(() => ({
    total: redirects.length,
    autoApproved: redirects.filter(r => r.status === 'auto_approved').length,
    needsReview: redirects.filter(r => r.status === 'needs_review').length,
    noMatch: redirects.filter(r => r.status === 'no_match').length,
    created: redirects.filter(r => r.status === 'created').length,
    failed: redirects.filter(r => r.status === 'failed').length,
    selected: redirects.filter(r => r.selected && r.status !== 'created').length,
    dandomain: {
      products: dandomanUrls.filter(u => u.type === 'product').length,
      categories: dandomanUrls.filter(u => u.type === 'category').length,
      unknown: dandomanUrls.filter(u => u.type === 'unknown').length,
    },
    shopify: {
      products: shopifyUrls.filter(u => u.type === 'product').length,
      collections: shopifyUrls.filter(u => u.type === 'collection').length,
      pages: shopifyUrls.filter(u => u.type === 'page').length,
    },
  }), [redirects, dandomanUrls, shopifyUrls]);

  // ============================================
  // RENDER
  // ============================================

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Intro / Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="w-5 h-5" />
            URL Redirects
          </CardTitle>
          <CardDescription>
            Opret 301 redirects fra din gamle DanDomain-shop til din nye Shopify-butik
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted/50 rounded-lg p-4 space-y-3">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 mt-0.5 text-primary shrink-0" />
              <div className="text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Hvad er redirects?</p>
                <p>Redirects sikrer at gamle links til din DanDomain-shop automatisk videresender besøgende til de tilsvarende sider i Shopify. Dette bevarer din SEO-værdi og forhindrer at kunder lander på fejlsider.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 text-warning shrink-0" />
              <div className="text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Confidence score (0-100%)</p>
                <p>
                  <strong>90-100%:</strong> Automatisk godkendt - sikre matches baseret på eksakte stier eller titler.<br/>
                  <strong>50-89%:</strong> Kræver gennemsyn - sandsynlige matches der bør verificeres manuelt.<br/>
                  <strong>Under 50%:</strong> Ingen match - kræver manuel valg af destination.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Data Sources */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Datakilder</CardTitle>
          <CardDescription>
            Angiv kilder til gamle DanDomain URLs. Shopify-destinationer hentes automatisk fra uploadede data.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Sitemap inputs */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="product-sitemap">Produkt-sitemap URL</Label>
              <Input
                id="product-sitemap"
                placeholder="https://din-shop.dk/shop/GoogleSitemapProducts.asp?LangId=26"
                value={productSitemapUrl}
                onChange={(e) => setProductSitemapUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="category-sitemap">Kategori-sitemap URL</Label>
              <Input
                id="category-sitemap"
                placeholder="https://din-shop.dk/shop/GoogleSitemapCategories.asp?LangId=26"
                value={categorySitemapUrl}
                onChange={(e) => setCategorySitemapUrl(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={fetchSitemaps}
              disabled={isFetchingSitemaps || (!productSitemapUrl && !categorySitemapUrl)}
              variant="outline"
            >
              {isFetchingSitemaps ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Globe className="w-4 h-4 mr-2" />}
              Hent sitemaps
            </Button>

            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept=".xlsx,.xls,.csv"
              className="hidden"
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              variant="outline"
            >
              <FileSpreadsheet className="w-4 h-4 mr-2" />
              Upload Excel/CSV
            </Button>
          </div>

          {/* URL counts */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
            <div className="text-center p-3 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold">{dandomanUrls.length}</div>
              <div className="text-xs text-muted-foreground">DanDomain URLs</div>
              {dandomanUrls.length > 0 && (
                <div className="text-[10px] text-muted-foreground mt-1">
                  {stats.dandomain.products} prod. / {stats.dandomain.categories} kat.
                </div>
              )}
            </div>
            <div className="text-center p-3 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold">{stats.shopify.products}</div>
              <div className="text-xs text-muted-foreground">Shopify produkter</div>
            </div>
            <div className="text-center p-3 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold">{stats.shopify.collections}</div>
              <div className="text-xs text-muted-foreground">Shopify kollektioner</div>
            </div>
            <div className="text-center p-3 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold">{stats.shopify.pages}</div>
              <div className="text-xs text-muted-foreground">Shopify sider</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Generate / Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Handlinger</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={generateRedirects}
              disabled={isGenerating}
            >
              {isGenerating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              {dandomanUrls.length > 0 ? `Match ${dandomanUrls.length} URLs` : 'Generer fra uploadede data'}
            </Button>

            <Button
              onClick={runAiMatching}
              disabled={isAiMatching || stats.needsReview + stats.noMatch === 0}
              variant="secondary"
              className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 text-primary-foreground"
            >
              {isAiMatching ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wand2 className="w-4 h-4 mr-2" />}
              AI Match ({stats.needsReview + stats.noMatch})
            </Button>

            <Button
              onClick={createRedirectsInShopify}
              disabled={isCreating || stats.selected === 0}
            >
              {isCreating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
              Opret i Shopify ({stats.selected})
            </Button>

            <Button onClick={downloadAsCSV} variant="outline" disabled={redirects.length === 0}>
              <Download className="w-4 h-4 mr-2" />
              Eksportér CSV
            </Button>

            <Button onClick={downloadAsExcel} variant="outline" disabled={redirects.length === 0}>
              <FileSpreadsheet className="w-4 h-4 mr-2" />
              Eksportér Excel
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

          {(isGenerating || isAiMatching || isCreating) && progress.total > 0 && (
            <div className="mt-4">
              <Progress value={(progress.current / progress.total) * 100} />
              <p className="text-sm text-muted-foreground mt-1">
                {progress.current} af {progress.total}...
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Redirect Table */}
      {redirects.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Check className="w-5 h-5 text-primary" />
              Redirect-tabel ({stats.total})
            </CardTitle>
            <CardDescription>
              Gennemgå matches og godkend før de oprettes i Shopify
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabType)}>
              <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                <TabsList>
                  <TabsTrigger value="auto_approved" className="gap-1">
                    <CheckCircle className="w-3 h-3" />
                    Godkendt ({stats.autoApproved})
                  </TabsTrigger>
                  <TabsTrigger value="needs_review" className="gap-1">
                    <HelpCircle className="w-3 h-3" />
                    Gennemsyn ({stats.needsReview})
                  </TabsTrigger>
                  <TabsTrigger value="no_match" className="gap-1">
                    <XCircle className="w-3 h-3" />
                    Ingen match ({stats.noMatch})
                  </TabsTrigger>
                  <TabsTrigger value="all">Alle</TabsTrigger>
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
                            checked={filteredRedirects.filter(r => r.status !== 'created' && r.status !== 'failed').every(r => r.selected)}
                            onCheckedChange={toggleAllInTab}
                          />
                        </TableHead>
                        <TableHead>Gammel URL</TableHead>
                        <TableHead className="w-14">Type</TableHead>
                        <TableHead className="w-10"></TableHead>
                        <TableHead>Ny URL</TableHead>
                        <TableHead className="w-20">Score</TableHead>
                        <TableHead className="w-32">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRedirects.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                            {searchQuery ? 'Ingen resultater' : 'Ingen redirects i denne kategori'}
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredRedirects.slice(0, 100).map((redirect) => {
                          const statusInfo = getStatusInfo(redirect.status);
                          return (
                            <TableRow key={redirect.id}>
                              <TableCell>
                                <Checkbox
                                  checked={redirect.selected}
                                  onCheckedChange={() => toggleSelection(redirect.id)}
                                  disabled={redirect.status === 'created' || redirect.status === 'failed'}
                                />
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                <div className="flex items-center gap-1">
                                  <span className="truncate max-w-[200px]" title={redirect.old_path}>
                                    {redirect.old_path}
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 shrink-0"
                                    onClick={() => inspectUrl(redirect.old_path)}
                                    title="Inspicér URL"
                                  >
                                    <Eye className="w-3 h-3" />
                                  </Button>
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className="text-[10px]">
                                  {redirect.old_type === 'product' && <Package className="w-3 h-3 mr-1" />}
                                  {redirect.old_type === 'category' && <FolderOpen className="w-3 h-3 mr-1" />}
                                  {redirect.old_type === 'unknown' && <HelpCircle className="w-3 h-3 mr-1" />}
                                  {redirect.old_type === 'product' ? 'Prod' : redirect.old_type === 'category' ? 'Kat' : '?'}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <ArrowRight className="w-4 h-4 text-muted-foreground" />
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  <Input
                                    value={redirect.new_path}
                                    onChange={(e) => updateNewPath(redirect.id, e.target.value)}
                                    className="font-mono text-xs h-8 flex-1"
                                    disabled={redirect.status === 'created'}
                                  />
                                  <ShopifyDestinationSearch
                                    projectId={project.id}
                                    currentValue={redirect.new_path}
                                    onSelect={(path) => updateNewPath(redirect.id, path, true)}
                                    disabled={redirect.status === 'created'}
                                    shopifyDomain={project.shopify_store_domain || undefined}
                                  />
                                  {project.shopify_store_domain && redirect.new_path && (
                                    <a
                                      href={`https://${project.shopify_store_domain.replace(/^https?:\/\//, '')}${redirect.new_path}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="h-8 w-8 flex items-center justify-center shrink-0 text-muted-foreground hover:text-primary"
                                      title="Åbn i Shopify"
                                    >
                                      <ExternalLink className="w-4 h-4" />
                                    </a>
                                  )}
                                </div>
                                {/* AI suggestions for unmatched */}
                                {(redirect.status === 'needs_review' || redirect.status === 'no_match') && 
                                 redirect.ai_suggestions && redirect.ai_suggestions.length > 0 && (
                                  <div className="mt-2 space-y-1">
                                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                                      <Sparkles className="w-3 h-3" /> AI forslag:
                                    </span>
                                    {redirect.ai_suggestions.slice(0, 2).map((s, idx) => (
                                      <button
                                        key={idx}
                                        onClick={() => updateNewPath(redirect.id, s.new_path, true)}
                                        className="block w-full text-left px-2 py-1 text-xs rounded bg-muted/50 hover:bg-muted transition-colors"
                                      >
                                        <span className="font-medium">{s.title}</span>
                                        <span className="text-muted-foreground ml-1">({s.score}%)</span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge 
                                  variant={redirect.confidence_score >= 90 ? "default" : redirect.confidence_score >= 70 ? "secondary" : "outline"}
                                  className={redirect.confidence_score < 50 ? "text-destructive border-destructive/50" : ""}
                                >
                                  {redirect.confidence_score}%
                                </Badge>
                                {redirect.matched_by && (
                                  <div className="text-[10px] text-muted-foreground mt-0.5">
                                    {redirect.matched_by === 'exact' && 'Eksakt'}
                                    {redirect.matched_by === 'sku' && 'SKU'}
                                    {redirect.matched_by === 'title' && 'Titel'}
                                    {redirect.matched_by === 'ai' && '✨ AI'}
                                    {redirect.matched_by === 'manual' && 'Manuel'}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge variant={statusInfo.variant} className="gap-1">
                                  {statusInfo.icon}
                                  {statusInfo.label}
                                </Badge>
                                {redirect.error_message && (
                                  <div className="text-xs text-destructive mt-1 truncate max-w-[120px]" title={redirect.error_message}>
                                    {redirect.error_message}
                                  </div>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                  {filteredRedirects.length > 100 && (
                    <div className="p-3 text-center text-sm text-muted-foreground bg-muted/30">
                      Viser 100 af {filteredRedirects.length}. Eksportér for fuld liste.
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {redirects.length === 0 && dandomanUrls.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <AlertCircle className="w-10 h-10 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">Ingen redirects endnu</h3>
            <p className="text-muted-foreground mb-4">
              Hent DanDomain sitemaps eller upload en Excel-fil med gamle URLs, eller generér redirects fra uploadede data.
            </p>
            <Button onClick={generateRedirects} disabled={isGenerating}>
              {isGenerating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              Generer fra uploadede data
            </Button>
          </CardContent>
        </Card>
      )}

      {/* URL Inspection Dialog */}
      <Dialog open={inspectionDialogOpen} onOpenChange={setInspectionDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="w-5 h-5" />
              URL Inspektion
            </DialogTitle>
            <DialogDescription className="font-mono text-xs break-all">
              {inspectionUrl}
            </DialogDescription>
          </DialogHeader>
          
          {isInspecting ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : inspectionResult ? (
            <div className="space-y-4">
              {!inspectionResult.success ? (
                <div className="p-4 bg-destructive/10 rounded-lg text-destructive">
                  <AlertCircle className="w-5 h-5 inline mr-2" />
                  {inspectionResult.error || 'Kunne ikke inspicere URL'}
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 p-4 bg-muted rounded-lg">
                    {inspectionResult.pageType === 'product' && <Package className="w-8 h-8 text-primary" />}
                    {inspectionResult.pageType === 'collection' && <FolderOpen className="w-8 h-8 text-primary" />}
                    {inspectionResult.pageType === 'page' && <FileText className="w-8 h-8 text-muted-foreground" />}
                    {inspectionResult.pageType === 'unknown' && <AlertCircle className="w-8 h-8 text-muted-foreground" />}
                    <div>
                      <Badge variant={inspectionResult.pageType === 'product' ? 'default' : inspectionResult.pageType === 'collection' ? 'secondary' : 'outline'}>
                        {inspectionResult.pageType === 'product' && 'Produktside'}
                        {inspectionResult.pageType === 'collection' && 'Kollektionsside'}
                        {inspectionResult.pageType === 'page' && 'Indholdsside'}
                        {inspectionResult.pageType === 'unknown' && 'Ukendt type'}
                      </Badge>
                      {inspectionResult.title && (
                        <p className="text-sm font-medium mt-1">{inspectionResult.title}</p>
                      )}
                    </div>
                  </div>
                  
                  {inspectionResult.productInfo && (
                    <div className="space-y-2 text-sm">
                      <h4 className="font-medium">Produktinfo</h4>
                      <dl className="grid grid-cols-2 gap-2">
                        <dt className="text-muted-foreground">Navn:</dt>
                        <dd className="font-medium">{inspectionResult.productInfo.name}</dd>
                        {inspectionResult.productInfo.sku && (
                          <>
                            <dt className="text-muted-foreground">SKU:</dt>
                            <dd className="font-mono text-xs">{inspectionResult.productInfo.sku}</dd>
                          </>
                        )}
                        {inspectionResult.productInfo.price && (
                          <>
                            <dt className="text-muted-foreground">Pris:</dt>
                            <dd>{inspectionResult.productInfo.price}</dd>
                          </>
                        )}
                      </dl>
                    </div>
                  )}
                  
                  {inspectionResult.collectionInfo && (
                    <div className="space-y-2 text-sm">
                      <h4 className="font-medium">Kollektionsinfo</h4>
                      <dl className="grid grid-cols-2 gap-2">
                        <dt className="text-muted-foreground">Navn:</dt>
                        <dd className="font-medium">{inspectionResult.collectionInfo.name}</dd>
                        {inspectionResult.collectionInfo.productCount && (
                          <>
                            <dt className="text-muted-foreground">Produkter:</dt>
                            <dd>{inspectionResult.collectionInfo.productCount}</dd>
                          </>
                        )}
                      </dl>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

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
