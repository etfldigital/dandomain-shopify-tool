import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
import { Label } from '@/components/ui/label';
import { ShopifyDestinationSearch, type ShopifyEntity } from './ShopifyDestinationSearch';
import * as XLSX from 'xlsx';
import {
  matchUrls,
  buildShopifyDestinations,
  classifyOldUrl,
  type OldUrlType,
  type ShopifyUrlType,
  type ShopifyDestination,
  type MatchResult,
} from '@/lib/redirect-matcher';
import { 
  ArrowRight, Check, X, Download, Upload, RefreshCw, ExternalLink,
  AlertCircle, Loader2, Search, FileSpreadsheet, AlertTriangle,
  Package, FolderOpen, FileText, Globe, Info, CheckCircle, HelpCircle, XCircle,
  Clock, ImageOff, ThumbsUp
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
  old_type: OldUrlType;
  status: RedirectStatus;
  error_message: string | null;
  selected: boolean;
  confidence_score: number;
  matched_by?: string;
  suggestions: Array<{ destination: ShopifyDestination; score: number }>;
  /** Display info for the matched destination */
  matchedTitle?: string;
  matchedImageUrl?: string | null;
}

/**
 * Three UI statuses:
 * - pending_approval: suggestion from auto-matching or user selection, not yet approved
 * - approved: user has actively clicked "Approve"
 * - no_match: no suggestion found, requires manual selection
 * 
 * Plus backend statuses: created, failed
 */
type RedirectStatus = 'pending_approval' | 'approved' | 'no_match' | 'created' | 'failed';
type TabType = 'pending_approval' | 'approved' | 'no_match' | 'all';

interface SitemapUrl {
  loc: string;
  type: OldUrlType;
}

interface MatcherShopifyEntity {
  id: string;
  type: ShopifyUrlType;
  title: string;
  handle: string;
  path: string;
  imageUrl?: string | null;
}

// ============================================
// CONSTANTS
// ============================================

const REVIEW_THRESHOLD = 50;
const ITEMS_PER_PAGE = 100;

// ============================================
// HELPER FUNCTIONS
// ============================================

function getUrlOrigin(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).origin;
  } catch { return null; }
}

function buildOldUrl(project: Project, oldPath: string): string {
  if (!oldPath) return '';
  if (/^https?:\/\//i.test(oldPath)) return oldPath;
  const origin = getUrlOrigin(project.dandomain_base_url) || getUrlOrigin(project.dandomain_shop_url) || null;
  if (!origin) return oldPath;
  const path = oldPath.startsWith('/') ? oldPath : `/${oldPath}`;
  return `${origin}${path}`;
}

function normalizePath(path: string): string {
  let normalized = path.trim().toLowerCase();
  normalized = normalized.replace(/^https?:\/\/[^\/]+/, '');
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function generateShopifyHandle(title: string): string {
  return title.toLowerCase().trim()
    .replace(/[æ]/g, 'ae').replace(/[ø]/g, 'oe').replace(/[å]/g, 'aa')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').substring(0, 255);
}

function getRedirectStatus(confidence: number): RedirectStatus {
  if (confidence >= REVIEW_THRESHOLD) return 'pending_approval';
  return 'no_match';
}

function getStatusInfo(status: RedirectStatus): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'warning' | 'success'; icon: React.ReactNode } {
  switch (status) {
    case 'pending_approval': return { label: 'Afventer godkendelse', variant: 'warning', icon: <Clock className="w-3 h-3" /> };
    case 'approved': return { label: 'Godkendt', variant: 'success', icon: <CheckCircle className="w-3 h-3" /> };
    case 'no_match': return { label: 'Ingen match', variant: 'destructive', icon: <XCircle className="w-3 h-3" /> };
    case 'created': return { label: 'Oprettet i Shopify', variant: 'default', icon: <Check className="w-3 h-3" /> };
    case 'failed': return { label: 'Fejlet', variant: 'destructive', icon: <X className="w-3 h-3" /> };
    default: return { label: 'Ukendt', variant: 'outline', icon: null };
  }
}

function getScoreColor(score: number): string {
  if (score >= 80) return 'text-green-600 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-950 dark:border-green-800';
  if (score >= 50) return 'text-yellow-600 bg-yellow-50 border-yellow-200 dark:text-yellow-400 dark:bg-yellow-950 dark:border-yellow-800';
  if (score > 0) return 'text-red-600 bg-red-50 border-red-200 dark:text-red-400 dark:bg-red-950 dark:border-red-800';
  return 'text-muted-foreground bg-muted/50 border-border';
}

function getTypeLabel(type: OldUrlType): string {
  switch (type) {
    case 'product': return 'Produkt';
    case 'category': return 'Kollektion';
    case 'page': return 'Side';
    default: return 'Ukendt';
  }
}

function getTypeIcon(type: OldUrlType) {
  switch (type) {
    case 'product': return <Package className="w-3 h-3" />;
    case 'category': return <FolderOpen className="w-3 h-3" />;
    case 'page': return <FileText className="w-3 h-3" />;
    default: return <HelpCircle className="w-3 h-3" />;
  }
}

function isTypeMismatch(oldType: OldUrlType, newPath: string): boolean {
  if (!newPath || newPath === '/') return false;
  if (oldType === 'product' && !newPath.startsWith('/products/')) return true;
  if (oldType === 'category' && !newPath.startsWith('/collections/')) return true;
  if (oldType === 'page' && !newPath.startsWith('/pages/')) return true;
  return false;
}

// ============================================
// MAIN COMPONENT
// ============================================

export function RedirectsStep({ project, onNext }: RedirectsStepProps) {
  const { toast } = useToast();
  const persistKey = useMemo(() => `redirectsStep:inputs:${project.id}`, [project.id]);

  // Data state
  const [redirects, setRedirects] = useState<RedirectRow[]>([]);
  const [shopifyEntities, setShopifyEntities] = useState<MatcherShopifyEntity[]>([]);
  const [dandomanUrls, setDandomainUrls] = useState<SitemapUrl[]>([]);

  // Loading states
  const [isLoading, setIsLoading] = useState(true);
  const [isMatching, setIsMatching] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isFetchingSitemaps, setIsFetchingSitemaps] = useState(false);

  // UI state
  const [activeTab, setActiveTab] = useState<TabType>('pending_approval');
  const [searchQuery, setSearchQuery] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [currentPage, setCurrentPage] = useState(1);

  // Sitemap inputs
  const [productSitemapUrl, setProductSitemapUrl] = useState('');
  const [categorySitemapUrl, setCategorySitemapUrl] = useState('');
  const [pageSitemapUrl, setPageSitemapUrl] = useState('');

  // File upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoMatchAfterFetchRef = useRef(false);

  // ============================================
  // DATA LOADING
  // ============================================

  useEffect(() => {
    loadRedirects();
    loadShopifyEntities();
  }, [project.id]);

  useEffect(() => {
    if (productSitemapUrl) return;
    const origin = getUrlOrigin(project.dandomain_base_url) || getUrlOrigin(project.dandomain_shop_url);
    if (!origin) return;
    setProductSitemapUrl(`${origin}/shop/GoogleSitemapProducts.asp?LangId=26`);
  }, [project.id]);

  // Persist inputs
  useEffect(() => {
    try {
      const raw = localStorage.getItem(persistKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed.productSitemapUrl === 'string') setProductSitemapUrl(parsed.productSitemapUrl);
      if (typeof parsed.categorySitemapUrl === 'string') setCategorySitemapUrl(parsed.categorySitemapUrl);
      if (typeof parsed.pageSitemapUrl === 'string') setPageSitemapUrl(parsed.pageSitemapUrl);
      if (Array.isArray(parsed.dandomainUrls)) setDandomainUrls(parsed.dandomainUrls);
    } catch { /* ignore */ }
  }, [persistKey]);

  useEffect(() => {
    try {
      localStorage.setItem(persistKey, JSON.stringify({
        productSitemapUrl, categorySitemapUrl, pageSitemapUrl, dandomainUrls: dandomanUrls,
      }));
    } catch { /* ignore */ }
  }, [persistKey, productSitemapUrl, categorySitemapUrl, pageSitemapUrl, dandomanUrls]);

  // Auto-match after sitemap fetch
  useEffect(() => {
    if (autoMatchAfterFetchRef.current && dandomanUrls.length > 0 && !isFetchingSitemaps) {
      autoMatchAfterFetchRef.current = false;
      runClientSideMatching();
    }
  }, [dandomanUrls, isFetchingSitemaps]);

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

      setRedirects(allRedirects.map(r => {
        const confidence = (r as unknown as { confidence_score?: number }).confidence_score ?? 0;
        const dbStatus = r.status as string;
        let uiStatus: RedirectStatus;
        if (dbStatus === 'created') uiStatus = 'created';
        else if (dbStatus === 'failed') uiStatus = 'failed';
        else if (dbStatus === 'approved') uiStatus = 'approved';
        else uiStatus = getRedirectStatus(confidence);

        // Extract suggestion info
        const suggestions = (r as unknown as { ai_suggestions?: Array<{ entity_id: string; new_path: string; title: string; score: number }> }).ai_suggestions || [];

        return {
          id: r.id,
          entity_type: r.entity_type as RedirectEntityType,
          entity_id: r.entity_id,
          old_path: r.old_path,
          new_path: r.new_path,
          old_type: classifyOldUrl(r.old_path),
          status: uiStatus,
          error_message: r.error_message,
          selected: false,
          confidence_score: confidence,
          matched_by: (r as unknown as { matched_by?: string }).matched_by,
          suggestions: [],
          matchedTitle: suggestions[0]?.title || undefined,
        };
      }));
    } catch (err) {
      console.error('Error loading redirects:', err);
      toast({ title: 'Fejl ved indlæsning', description: 'Kunne ikke hente redirects', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  const loadShopifyEntities = async () => {
    try {
      const entities: MatcherShopifyEntity[] = [];

      const { data: products } = await supabase
        .from('canonical_products')
        .select('id, data, shopify_id')
        .eq('project_id', project.id)
        .eq('status', 'uploaded');

      for (const p of products || []) {
        const data = p.data as Record<string, unknown>;
        const title = (data?.title as string) || '';
        const handle = (data?.shopify_handle as string) || generateShopifyHandle(title);
        const images = (data?.images as string[]) || [];
        if (p.shopify_id && title) {
          entities.push({ id: p.id, type: 'product', title, handle, path: `/products/${handle}`, imageUrl: images[0] || null });
        }
      }

      const { data: categories } = await supabase
        .from('canonical_categories')
        .select('id, name, shopify_tag, shopify_collection_id, shopify_handle')
        .eq('project_id', project.id)
        .eq('status', 'uploaded');

      for (const c of categories || []) {
        const storedHandle = (c as Record<string, unknown>).shopify_handle as string | null;
        const handle = storedHandle || generateShopifyHandle(c.shopify_tag || c.name);
        if (c.shopify_collection_id && c.name) {
          entities.push({ id: c.id, type: 'collection', title: c.name, handle, path: `/collections/${handle}`, imageUrl: null });
        }
      }

      const { data: pages } = await supabase
        .from('canonical_pages')
        .select('id, data, shopify_id')
        .eq('project_id', project.id)
        .eq('status', 'uploaded');

      for (const pg of pages || []) {
        const data = pg.data as Record<string, unknown>;
        const title = (data?.title as string) || '';
        const slug = (data?.slug as string) || '';
        const handle = (data?.shopify_handle as string) || slug || generateShopifyHandle(title);
        if (pg.shopify_id && handle) {
          entities.push({ id: pg.id, type: 'page', title, handle, path: `/pages/${handle}`, imageUrl: null });
        }
      }

      setShopifyEntities(entities);
    } catch (err) {
      console.error('Error loading Shopify entities:', err);
    }
  };

  // ============================================
  // SITEMAP FETCHING
  // ============================================

  const fetchSitemaps = async () => {
    if (!productSitemapUrl && !categorySitemapUrl && !pageSitemapUrl) {
      toast({ title: 'Mangler URL', description: 'Angiv mindst én sitemap URL', variant: 'destructive' });
      return;
    }

    setIsFetchingSitemaps(true);
    try {
      const { data, error } = await supabase.functions.invoke('parse-sitemap', {
        body: {
          projectId: project.id,
          productSitemapUrl: productSitemapUrl || undefined,
          categorySitemapUrl: categorySitemapUrl || undefined,
          pageSitemapUrl: pageSitemapUrl || undefined,
        },
      });
      if (error) throw error;
      if (data.error) throw new Error(data.error);

      setDandomainUrls(data.urls || []);
      await supabase.from('project_redirects').delete().eq('project_id', project.id).neq('status', 'created');
      setRedirects([]);

      toast({
        title: 'Sitemaps hentet',
        description: `Fandt ${data.stats.products} produkter, ${data.stats.categories} kategorier, ${data.stats.pages || 0} sider`,
      });
    } catch (err) {
      console.error('Error fetching sitemaps:', err);
      toast({ title: 'Fejl ved hentning', description: err instanceof Error ? err.message : 'Kunne ikke hente sitemaps', variant: 'destructive' });
    } finally {
      setIsFetchingSitemaps(false);
    }
  };

  // ============================================
  // CLIENT-SIDE MATCHING — all results are "pending_approval"
  // ============================================

  const runClientSideMatching = useCallback(async () => {
    if (dandomanUrls.length === 0) {
      toast({ title: 'Mangler DanDomain-URLs', description: 'Hent sitemap eller upload fil først.', variant: 'destructive' });
      return;
    }
    if (shopifyEntities.length === 0) {
      toast({ title: 'Mangler Shopify-data', description: 'Der er ingen uploadede produkter/kategorier/sider at matche mod.', variant: 'destructive' });
      return;
    }

    setIsMatching(true);
    setProgress({ current: 0, total: dandomanUrls.length });

    try {
      await supabase.from('project_redirects').delete().eq('project_id', project.id).neq('status', 'created');

      const destinations = buildShopifyDestinations(shopifyEntities);

      // Build a lookup for entity info (title, image)
      const entityLookup = new Map<string, MatcherShopifyEntity>();
      for (const e of shopifyEntities) {
        entityLookup.set(e.id, e);
      }

      const CHUNK_SIZE = 200;
      const allResults: MatchResult[] = [];

      for (let i = 0; i < dandomanUrls.length; i += CHUNK_SIZE) {
        const chunk = dandomanUrls.slice(i, i + CHUNK_SIZE);
        await new Promise(resolve => setTimeout(resolve, 0));
        const chunkResults = matchUrls(chunk, destinations);
        allResults.push(...chunkResults);
        setProgress({ current: Math.min(i + CHUNK_SIZE, dandomanUrls.length), total: dandomanUrls.length });
      }

      const newRedirects: RedirectRow[] = [];
      const dbInserts: Array<Record<string, unknown>> = [];

      for (const result of allResults) {
        const id = crypto.randomUUID();
        const confidence = result.score;
        // ALL matches start as pending_approval — never auto-approved
        const status: RedirectStatus = confidence >= REVIEW_THRESHOLD ? 'pending_approval' : 'no_match';
        const entityType: RedirectEntityType = result.oldType === 'category' ? 'category' : result.oldType === 'page' ? 'page' : 'product';
        
        const matchedEntity = result.matchedDestination ? entityLookup.get(result.matchedDestination.id) : null;

        const row: RedirectRow = {
          id,
          entity_type: entityType,
          entity_id: result.matchedDestination?.id || '',
          old_path: result.oldUrl,
          new_path: result.matchedDestination?.path || '',
          old_type: result.oldType,
          status,
          error_message: null,
          selected: false,
          confidence_score: confidence,
          matched_by: result.matchMethod,
          suggestions: result.suggestions,
          matchedTitle: matchedEntity?.title || result.matchedDestination?.title,
          matchedImageUrl: matchedEntity?.imageUrl || null,
        };

        newRedirects.push(row);

        dbInserts.push({
          id,
          project_id: project.id,
          entity_type: entityType,
          entity_id: result.matchedDestination?.id || 'unmatched',
          old_path: result.oldUrl,
          new_path: result.matchedDestination?.path || '/',
          status: 'pending',
          confidence_score: confidence,
          matched_by: result.matchMethod,
          ai_suggestions: result.suggestions.map(s => ({
            entity_id: s.destination.id,
            new_path: s.destination.path,
            title: s.destination.title,
            score: s.score,
          })),
        });
      }

      const BATCH_SIZE = 500;
      for (let i = 0; i < dbInserts.length; i += BATCH_SIZE) {
        const batch = dbInserts.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from('project_redirects').insert(batch as any);
        if (error) console.error('Error inserting batch:', error);
      }

      setRedirects(newRedirects);

      const matched = newRedirects.filter(r => r.status === 'pending_approval').length;
      const unmatched = newRedirects.filter(r => r.status === 'no_match').length;
      
      toast({
        title: 'Matching fuldført',
        description: `${matched} forslag afventer godkendelse, ${unmatched} uden match`,
      });
    } catch (err) {
      console.error('Error in client-side matching:', err);
      toast({ title: 'Fejl', description: err instanceof Error ? err.message : 'Matching fejlede', variant: 'destructive' });
    } finally {
      setIsMatching(false);
      setProgress({ current: 0, total: 0 });
    }
  }, [dandomanUrls, shopifyEntities, project.id, toast]);

  // ============================================
  // SHOPIFY CREATION — only approved redirects
  // ============================================

  const createRedirectsInShopify = async () => {
    const approvedRedirects = redirects.filter(r => r.status === 'approved');
    if (approvedRedirects.length === 0) {
      toast({ title: 'Ingen godkendte', description: 'Godkend mindst én redirect før oprettelse i Shopify', variant: 'destructive' });
      return;
    }

    const mismatches = approvedRedirects.filter(r => isTypeMismatch(r.old_type, r.new_path));
    if (mismatches.length > 0) {
      toast({
        title: 'Type-fejl forhindret!',
        description: `${mismatches.length} redirects har forkert type-match. Ret dem først.`,
        variant: 'destructive',
      });
      return;
    }

    setIsCreating(true);
    setProgress({ current: 0, total: approvedRedirects.length });

    try {
      const { data, error } = await supabase.functions.invoke('create-redirects', {
        body: { projectId: project.id, redirectIds: approvedRedirects.map(r => r.id) },
      });
      if (error) throw error;
      toast({ title: 'Redirects oprettet', description: `${data.created} oprettet, ${data.failed} fejlede` });
      await loadRedirects();
    } catch (err) {
      console.error('Error creating redirects:', err);
      toast({ title: 'Fejl', description: 'Kunne ikke oprette redirects i Shopify', variant: 'destructive' });
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
        urls.push({ loc: normalizePath(url), type: classifyOldUrl(url) });
      }
      if (urls.length === 0) throw new Error('Ingen URLs fundet i kolonne A');

      setDandomainUrls(urls);
      await supabase.from('project_redirects').delete().eq('project_id', project.id).neq('status', 'created');
      setRedirects([]);
      toast({ title: 'Fil importeret', description: `${urls.length} URLs indlæst` });
    } catch (err) {
      console.error('Error importing file:', err);
      toast({ title: 'Fejl ved import', description: err instanceof Error ? err.message : 'Kunne ikke importere fil', variant: 'destructive' });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const downloadApprovedCSV = () => {
    const approved = redirects.filter(r => r.status === 'approved');
    if (approved.length === 0) {
      toast({ title: 'Ingen godkendte', description: 'Der er ingen godkendte redirects at eksportere', variant: 'destructive' });
      return;
    }

    // Show warning if pending/no_match remain
    const pending = redirects.filter(r => r.status === 'pending_approval').length;
    const noMatch = redirects.filter(r => r.status === 'no_match').length;
    if (pending > 0 || noMatch > 0) {
      toast({
        title: 'Advarsel',
        description: `Der er stadig ${pending} afventende og ${noMatch} uden match. Kun godkendte eksporteres.`,
      });
    }

    const csv = [
      ['old_url', 'new_url', 'status', 'score'].join(','),
      ...approved.map(r => [r.old_path, r.new_path, 'approved', r.confidence_score].map(v => `"${v}"`).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `redirects-approved-${project.name}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAllExcel = () => {
    const data = redirects.map(r => ({
      'Gammel URL': r.old_path,
      'Ny URL': r.new_path,
      'Type': getTypeLabel(r.old_type),
      'Score': r.confidence_score,
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

  /** Approve a single redirect */
  const approveRedirect = async (id: string) => {
    const redirect = redirects.find(r => r.id === id);
    if (!redirect || !redirect.new_path || redirect.new_path === '/') {
      toast({ title: 'Ingen destination', description: 'Vælg en destination først', variant: 'destructive' });
      return;
    }
    if (isTypeMismatch(redirect.old_type, redirect.new_path)) {
      toast({
        title: 'Type-mismatch!',
        description: `${getTypeLabel(redirect.old_type)} kan kun redirectes til ${redirect.old_type === 'product' ? '/products/' : redirect.old_type === 'category' ? '/collections/' : '/pages/'}`,
        variant: 'destructive',
      });
      return;
    }

    setRedirects(prev => prev.map(r => r.id === id ? { ...r, status: 'approved' as RedirectStatus } : r));
    try {
      await supabase.from('project_redirects').update({ status: 'approved' }).eq('id', id);
    } catch (err) {
      console.error('Error approving redirect:', err);
    }
  };

  /** Unapprove (revert to pending) */
  const unapproveRedirect = async (id: string) => {
    setRedirects(prev => prev.map(r => r.id === id ? { ...r, status: 'pending_approval' as RedirectStatus } : r));
    try {
      await supabase.from('project_redirects').update({ status: 'pending' }).eq('id', id);
    } catch (err) {
      console.error('Error unapproving redirect:', err);
    }
  };

  /** Bulk approve all selected in current tab */
  const bulkApproveSelected = async () => {
    const toApprove = filteredRedirects.filter(r => r.selected && r.status === 'pending_approval' && r.new_path && r.new_path !== '/' && !isTypeMismatch(r.old_type, r.new_path));
    if (toApprove.length === 0) {
      toast({ title: 'Ingen valgt', description: 'Vælg mindst én redirect at godkende', variant: 'destructive' });
      return;
    }

    const ids = new Set(toApprove.map(r => r.id));
    setRedirects(prev => prev.map(r => ids.has(r.id) ? { ...r, status: 'approved' as RedirectStatus } : r));

    // Batch update in DB
    const idArray = Array.from(ids);
    for (let i = 0; i < idArray.length; i += 100) {
      const batch = idArray.slice(i, i + 100);
      await supabase.from('project_redirects').update({ status: 'approved' }).in('id', batch);
    }

    toast({ title: 'Godkendt', description: `${toApprove.length} redirects godkendt` });
  };

  const toggleSelection = (id: string) => {
    setRedirects(prev => prev.map(r => r.id === id ? { ...r, selected: !r.selected } : r));
  };

  const toggleAllInTab = () => {
    const tabRedirects = filteredRedirects.filter(r => r.status !== 'created' && r.status !== 'failed');
    const allSelected = tabRedirects.every(r => r.selected);
    const ids = new Set(tabRedirects.map(r => r.id));
    setRedirects(prev => prev.map(r => ids.has(r.id) ? { ...r, selected: !allSelected } : r));
  };

  /** User selected a product/collection from the search — sets destination but does NOT auto-approve */
  const updateNewPath = async (id: string, newPath: string, entity?: ShopifyEntity) => {
    const redirect = redirects.find(r => r.id === id);
    if (redirect && isTypeMismatch(redirect.old_type, newPath)) {
      toast({
        title: 'Type-match forhindret!',
        description: `En ${getTypeLabel(redirect.old_type).toLowerCase()}-URL kan kun redirectes til ${
          redirect.old_type === 'product' ? '/products/' : redirect.old_type === 'category' ? '/collections/' : '/pages/'
        }`,
        variant: 'destructive',
      });
      return;
    }

    // Set destination but keep status as pending_approval — user must still click "Approve"
    setRedirects(prev => prev.map(r => r.id === id ? {
      ...r,
      new_path: newPath,
      confidence_score: 100,
      status: (r.status === 'no_match' || r.status === 'pending_approval') ? 'pending_approval' as RedirectStatus : r.status,
      matched_by: 'manual',
      matchedTitle: entity?.title || r.matchedTitle,
      matchedImageUrl: entity?.imageUrl || r.matchedImageUrl,
    } : r));

    try {
      await supabase.from('project_redirects').update({
        new_path: newPath, confidence_score: 100, matched_by: 'manual',
      }).eq('id', id);
    } catch (err) {
      console.error('Error updating path:', err);
    }
  };

  const handleReset = async () => {
    try {
      await supabase.from('project_redirects').delete().eq('project_id', project.id);
      setRedirects([]);
      setProductSitemapUrl('');
      setCategorySitemapUrl('');
      setPageSitemapUrl('');
      setDandomainUrls([]);
      try { localStorage.removeItem(persistKey); } catch { /* ignore */ }
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast({ title: 'Nulstillet', description: 'Alle redirects og input er blevet slettet' });
    } catch (err) {
      console.error('Error resetting:', err);
      toast({ title: 'Fejl', description: 'Kunne ikke nulstille', variant: 'destructive' });
    }
  };

  // ============================================
  // COMPUTED VALUES
  // ============================================

  const filteredRedirects = useMemo(() => {
    let filtered = redirects;
    if (activeTab !== 'all') filtered = filtered.filter(r => r.status === activeTab);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(r => r.old_path.toLowerCase().includes(q) || r.new_path.toLowerCase().includes(q) || (r.matchedTitle || '').toLowerCase().includes(q));
    }
    return filtered;
  }, [redirects, activeTab, searchQuery]);

  const stats = useMemo(() => ({
    total: redirects.length > 0 ? redirects.length : dandomanUrls.length,
    pendingApproval: redirects.filter(r => r.status === 'pending_approval').length,
    approved: redirects.filter(r => r.status === 'approved').length,
    noMatch: redirects.filter(r => r.status === 'no_match').length,
    created: redirects.filter(r => r.status === 'created').length,
    failed: redirects.filter(r => r.status === 'failed').length,
    selectedInTab: filteredRedirects.filter(r => r.selected && r.status !== 'created' && r.status !== 'failed').length,
    typeMismatches: redirects.filter(r => isTypeMismatch(r.old_type, r.new_path)).length,
    dandomain: {
      products: dandomanUrls.filter(u => u.type === 'product').length,
      categories: dandomanUrls.filter(u => u.type === 'category').length,
      pages: dandomanUrls.filter(u => u.type === 'page').length,
      unknown: dandomanUrls.filter(u => u.type === 'unknown').length,
    },
    shopify: {
      products: shopifyEntities.filter(u => u.type === 'product').length,
      collections: shopifyEntities.filter(u => u.type === 'collection').length,
      pages: shopifyEntities.filter(u => u.type === 'page').length,
    },
  }), [redirects, dandomanUrls, shopifyEntities, filteredRedirects]);

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
      {/* Intro */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="w-5 h-5" />
            URL Redirect Mapping
          </CardTitle>
          <CardDescription>
            Match gamle DanDomain-URLs til nye Shopify-URLs med semantisk matching
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted/50 rounded-lg p-4 space-y-3">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 mt-0.5 text-primary shrink-0" />
              <div className="text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Semantisk matching</p>
                <p>Matching baseres på indholdets betydning — brandnavn, produkttype, navne — ikke bogstavlighed.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 text-destructive shrink-0" />
              <div className="text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Streng type-sikkerhed</p>
                <p>
                  Produkter redirectes <strong>KUN</strong> til <code>/products/</code>. Kategorier <strong>KUN</strong> til <code>/collections/</code>.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Clock className="w-4 h-4 mt-0.5 text-yellow-600 dark:text-yellow-400 shrink-0" />
              <div className="text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Ingen auto-godkendelse</p>
                <p>
                  Alle matches er <strong>forslag</strong>. Du skal aktivt klikke "Godkend" på hver redirect — selv ved 100% score.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Package className="w-4 h-4 mt-0.5 text-primary shrink-0" />
              <div className="text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Vælg produkt — ikke URL</p>
                <p>
                  Du vælger et <strong>produkt eller kollektion</strong> fra listen — URL'en sættes automatisk. Der er ingen fri tekst-indtastning.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Type mismatch warning */}
      {stats.typeMismatches > 0 && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <div className="flex items-center gap-3 text-destructive">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <div>
                <p className="font-semibold">{stats.typeMismatches} redirect(s) har type-mismatch!</p>
                <p className="text-sm opacity-80">Der er produkt-URLs der peger på kollektioner (eller omvendt). Disse SKAL rettes.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Data Sources */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Datakilder</CardTitle>
          <CardDescription>
            Angiv kilder til gamle DanDomain URLs. Shopify-destinationer hentes automatisk fra uploadede data.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="product-sitemap">Produkt-sitemap URL</Label>
              <Input id="product-sitemap" placeholder="https://din-shop.dk/shop/GoogleSitemapProducts.asp?LangId=26" value={productSitemapUrl} onChange={(e) => setProductSitemapUrl(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="category-sitemap">Kategori-sitemap URL</Label>
              <Input id="category-sitemap" placeholder="https://din-shop.dk/shop/GoogleSitemapCategories.asp?LangId=26" value={categorySitemapUrl} onChange={(e) => setCategorySitemapUrl(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="page-sitemap">Side-sitemap URL</Label>
              <Input id="page-sitemap" placeholder="https://din-shop.dk/sitemap-pages.xml" value={pageSitemapUrl} onChange={(e) => setPageSitemapUrl(e.target.value)} />
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button onClick={fetchSitemaps} disabled={isFetchingSitemaps || (!productSitemapUrl && !categorySitemapUrl && !pageSitemapUrl)} variant="outline">
              {isFetchingSitemaps ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Globe className="w-4 h-4 mr-2" />}
              Hent sitemaps
            </Button>
            <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".xlsx,.xls,.csv" className="hidden" />
            <Button onClick={() => fileInputRef.current?.click()} variant="outline">
              <FileSpreadsheet className="w-4 h-4 mr-2" />
              Upload Excel/CSV
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="paste-urls">Eller indsæt URLs manuelt (én per linje)</Label>
            <textarea
              id="paste-urls"
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 font-mono"
              placeholder={`https://din-shop.dk/shop/produkt-123p.html\nhttps://din-shop.dk/shop/kategori-45c1.html`}
              onBlur={(e) => {
                const text = e.target.value.trim();
                if (!text) return;
                const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
                if (lines.length === 0) return;
                const urls: SitemapUrl[] = lines.map(line => ({ loc: normalizePath(line), type: classifyOldUrl(line) }));
                setDandomainUrls(prev => {
                  const existing = new Set(prev.map(u => u.loc));
                  return [...prev, ...urls.filter(u => !existing.has(u.loc))];
                });
                e.target.value = '';
                toast({ title: 'URLs tilføjet', description: `${lines.length} URLs indsat` });
              }}
            />
          </div>

          {/* URL counts */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
            <div className="text-center p-3 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold">{stats.dandomain.products}</div>
              <div className="text-xs text-muted-foreground flex items-center justify-center gap-1"><Package className="w-3 h-3" /> DanDomain produkter</div>
            </div>
            <div className="text-center p-3 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold">{stats.dandomain.categories}</div>
              <div className="text-xs text-muted-foreground flex items-center justify-center gap-1"><FolderOpen className="w-3 h-3" /> DanDomain kategorier</div>
            </div>
            <div className="text-center p-3 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold">{stats.shopify.products}</div>
              <div className="text-xs text-muted-foreground flex items-center justify-center gap-1"><Package className="w-3 h-3" /> Shopify produkter</div>
            </div>
            <div className="text-center p-3 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold">{stats.shopify.collections}</div>
              <div className="text-xs text-muted-foreground flex items-center justify-center gap-1"><FolderOpen className="w-3 h-3" /> Shopify kollektioner</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Handlinger</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={async () => {
                if (dandomanUrls.length === 0 && (productSitemapUrl || categorySitemapUrl || pageSitemapUrl)) {
                  autoMatchAfterFetchRef.current = true;
                  await fetchSitemaps();
                } else {
                  await runClientSideMatching();
                }
              }}
              disabled={isMatching || isFetchingSitemaps || (dandomanUrls.length === 0 && !productSitemapUrl && !categorySitemapUrl && !pageSitemapUrl)}
            >
              {(isMatching || isFetchingSitemaps) ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              {dandomanUrls.length > 0 ? `Generer forslag for ${dandomanUrls.length} URLs` : 'Hent og match URLs'}
            </Button>

            <Button onClick={createRedirectsInShopify} disabled={isCreating || stats.approved === 0} variant="default">
              {isCreating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
              Opret godkendte i Shopify ({stats.approved})
            </Button>

            <Button onClick={handleReset} variant="outline" className="text-destructive hover:text-destructive">
              <X className="w-4 h-4 mr-2" />
              Nulstil
            </Button>
          </div>

          {/* Bulk actions */}
          {redirects.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t">
              <Button variant="outline" size="sm"
                onClick={bulkApproveSelected}
                disabled={stats.selectedInTab === 0}
              >
                <ThumbsUp className="w-3 h-3 mr-1" />
                Godkend valgte ({stats.selectedInTab})
              </Button>
              <Button variant="outline" size="sm"
                onClick={async () => {
                  const noMatchIds = redirects.filter(r => r.status === 'no_match').map(r => r.id);
                  if (noMatchIds.length === 0) return;
                  for (let i = 0; i < noMatchIds.length; i += 100) {
                    await supabase.from('project_redirects').delete().in('id', noMatchIds.slice(i, i + 100));
                  }
                  setRedirects(prev => prev.filter(r => r.status !== 'no_match'));
                  toast({ title: 'Fjernet', description: `${noMatchIds.length} uden match fjernet` });
                }}
                disabled={stats.noMatch === 0}
              >
                <XCircle className="w-3 h-3 mr-1" />
                Fjern alle uden match ({stats.noMatch})
              </Button>
              <div className="ml-auto flex gap-2">
                <Button variant="outline" size="sm" onClick={downloadApprovedCSV}>
                  <Download className="w-3 h-3 mr-1" />
                  Eksportér godkendte (CSV)
                </Button>
                <Button variant="outline" size="sm" onClick={downloadAllExcel}>
                  <Download className="w-3 h-3 mr-1" />
                  Alle (Excel)
                </Button>
              </div>
            </div>
          )}

          {(isMatching || isCreating) && progress.total > 0 && (
            <div className="mt-4">
              <Progress value={(progress.current / progress.total) * 100} />
              <p className="text-sm text-muted-foreground mt-1">
                {isMatching ? 'Genererer forslag...' : 'Opretter i Shopify...'}
                {' '}{progress.current} af {progress.total}
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
              Redirect-tabel ({stats.total})
            </CardTitle>
            <CardDescription>
              Alle matches er forslag — godkend hver enkelt før oprettelse i Shopify
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v as TabType); setCurrentPage(1); }}>
              <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                <TabsList>
                  <TabsTrigger value="pending_approval" className="gap-1">
                    <Clock className="w-3 h-3" />
                    Afventer ({stats.pendingApproval})
                  </TabsTrigger>
                  <TabsTrigger value="approved" className="gap-1">
                    <CheckCircle className="w-3 h-3" />
                    Godkendt ({stats.approved})
                  </TabsTrigger>
                  <TabsTrigger value="no_match" className="gap-1">
                    <XCircle className="w-3 h-3" />
                    Ingen match ({stats.noMatch})
                  </TabsTrigger>
                  <TabsTrigger value="all">Alle</TabsTrigger>
                </TabsList>

                <div className="relative w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input placeholder="Søg i URLs..." value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }} className="pl-9" />
                </div>
              </div>

              <TabsContent value={activeTab} className="mt-0">
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            checked={filteredRedirects.filter(r => r.status !== 'created' && r.status !== 'failed').length > 0 && filteredRedirects.filter(r => r.status !== 'created' && r.status !== 'failed').every(r => r.selected)}
                            onCheckedChange={toggleAllInTab}
                          />
                        </TableHead>
                        <TableHead>Gammel URL</TableHead>
                        <TableHead className="w-20">Type</TableHead>
                        <TableHead className="w-10"></TableHead>
                        <TableHead>Foreslået match</TableHead>
                        <TableHead className="w-20">Score</TableHead>
                        <TableHead className="w-36">Status / Handling</TableHead>
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
                        filteredRedirects.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE).map((redirect) => {
                          const statusInfo = getStatusInfo(redirect.status);
                          const typeMismatch = isTypeMismatch(redirect.old_type, redirect.new_path);

                          return (
                            <TableRow key={redirect.id} className={typeMismatch ? 'bg-destructive/5' : ''}>
                              <TableCell>
                                <Checkbox
                                  checked={redirect.selected}
                                  onCheckedChange={() => toggleSelection(redirect.id)}
                                  disabled={redirect.status === 'created' || redirect.status === 'failed'}
                                />
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                <div className="flex items-center gap-1">
                                  <span className="truncate max-w-[200px]" title={redirect.old_path}>{redirect.old_path}</span>
                                  {redirect.old_path && (
                                    <a href={buildOldUrl(project, redirect.old_path)} target="_blank" rel="noopener noreferrer"
                                      className="h-6 w-6 flex items-center justify-center shrink-0 text-muted-foreground hover:text-primary">
                                      <ExternalLink className="w-3 h-3" />
                                    </a>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className="text-[10px] gap-1">
                                  {getTypeIcon(redirect.old_type)}
                                  {getTypeLabel(redirect.old_type)}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <ArrowRight className={`w-4 h-4 ${typeMismatch ? 'text-destructive' : 'text-muted-foreground'}`} />
                              </TableCell>
                              <TableCell>
                                <div className="space-y-1">
                                  {typeMismatch && (
                                    <div className="flex items-center gap-1 text-destructive text-xs font-semibold">
                                      <AlertTriangle className="w-3 h-3" />
                                      TYPE-MISMATCH!
                                    </div>
                                  )}

                                  {/* Product card display for matched destination */}
                                  {redirect.new_path && redirect.new_path !== '/' && (
                                    <div className="flex items-center gap-2 p-1.5 rounded-md bg-muted/30 border border-border/40">
                                      <div className="w-8 h-8 rounded border border-border/60 bg-background flex items-center justify-center shrink-0 overflow-hidden">
                                        {redirect.matchedImageUrl ? (
                                          <img src={redirect.matchedImageUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                                        ) : (
                                          getTypeIcon(redirect.old_type)
                                        )}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        {redirect.matchedTitle && (
                                          <div className="text-xs font-medium truncate">{redirect.matchedTitle}</div>
                                        )}
                                        <div className="text-[10px] text-muted-foreground font-mono truncate">{redirect.new_path}</div>
                                      </div>
                                    </div>
                                  )}

                                  {/* Search to change destination — type-filtered, no free text */}
                                  {redirect.status !== 'created' && (
                                    <ShopifyDestinationSearch
                                      projectId={project.id}
                                      currentValue={redirect.new_path}
                                      onSelect={(path, entity) => updateNewPath(redirect.id, path, entity)}
                                      disabled={false}
                                      shopifyDomain={project.shopify_store_domain || undefined}
                                      inline={true}
                                      filterByOldType={redirect.old_type}
                                    />
                                  )}

                                  {/* Suggestions for review */}
                                  {redirect.status !== 'approved' && redirect.status !== 'created' && 
                                   redirect.suggestions && redirect.suggestions.length > 1 && (
                                    <div className="mt-1 space-y-0.5">
                                      <span className="text-[10px] text-muted-foreground">Andre forslag:</span>
                                      {redirect.suggestions.slice(1, 3).map((s, idx) => (
                                        <button key={idx} onClick={() => {
                                          const entity = shopifyEntities.find(e => e.id === s.destination.id);
                                          updateNewPath(redirect.id, s.destination.path, entity ? {
                                            id: entity.id, type: entity.type, title: entity.title,
                                            handle: entity.handle, path: entity.path, imageUrl: entity.imageUrl,
                                          } : undefined);
                                        }}
                                          className="block w-full text-left px-2 py-0.5 text-xs rounded bg-muted/50 hover:bg-muted transition-colors">
                                          <span className="font-medium">{s.destination.title}</span>
                                          <span className="text-muted-foreground ml-1">({s.score}%)</span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className={`border ${getScoreColor(redirect.confidence_score)}`}>
                                  {redirect.confidence_score}%
                                </Badge>
                                {redirect.matched_by && (
                                  <div className="text-[10px] text-muted-foreground mt-0.5">
                                    {redirect.matched_by === 'exact_handle' && 'Eksakt'}
                                    {redirect.matched_by === 'handle_overlap' && 'Handle'}
                                    {redirect.matched_by === 'semantic' && 'Semantisk'}
                                    {redirect.matched_by === 'manual' && 'Manuel'}
                                    {redirect.matched_by === 'none' && '—'}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell>
                                <div className="space-y-1">
                                  <Badge variant={statusInfo.variant as any} className="gap-1">
                                    {statusInfo.icon}
                                    {statusInfo.label}
                                  </Badge>

                                  {/* Action buttons */}
                                  {redirect.status === 'pending_approval' && redirect.new_path && redirect.new_path !== '/' && (
                                    <Button
                                      size="sm"
                                      variant="default"
                                      className="w-full h-7 text-xs"
                                      onClick={() => approveRedirect(redirect.id)}
                                    >
                                      <ThumbsUp className="w-3 h-3 mr-1" />
                                      Godkend
                                    </Button>
                                  )}
                                  {redirect.status === 'approved' && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="w-full h-7 text-xs"
                                      onClick={() => unapproveRedirect(redirect.id)}
                                    >
                                      <X className="w-3 h-3 mr-1" />
                                      Fortryd
                                    </Button>
                                  )}

                                  {redirect.error_message && (
                                    <div className="text-xs text-destructive truncate max-w-[120px]" title={redirect.error_message}>
                                      {redirect.error_message}
                                    </div>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                  {/* Pagination */}
                  {filteredRedirects.length > ITEMS_PER_PAGE && (
                    <div className="p-3 flex items-center justify-between border-t bg-muted/30">
                      <span className="text-sm text-muted-foreground">
                        Viser {((currentPage - 1) * ITEMS_PER_PAGE) + 1}-{Math.min(currentPage * ITEMS_PER_PAGE, filteredRedirects.length)} af {filteredRedirects.length}
                      </span>
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}>Forrige</Button>
                        <span className="text-sm px-2">Side {currentPage} af {Math.ceil(filteredRedirects.length / ITEMS_PER_PAGE)}</span>
                        <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.min(Math.ceil(filteredRedirects.length / ITEMS_PER_PAGE), p + 1))} disabled={currentPage >= Math.ceil(filteredRedirects.length / ITEMS_PER_PAGE)}>Næste</Button>
                      </div>
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
              Hent DanDomain sitemap (eller upload Excel/CSV) for at starte matching.
            </p>
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
