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
  FileUp,
  FileSpreadsheet,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Eye,
  Package,
  FolderOpen,
  FileText,
  Sparkles,
  Wand2
} from 'lucide-react';

// Interface for URL inspection result
interface UrlInspectionResult {
  success: boolean;
  pageType: 'product' | 'collection' | 'page' | 'unknown';
  title?: string;
  productInfo?: {
    name: string;
    sku?: string;
    price?: string;
  };
  collectionInfo?: {
    name: string;
    productCount?: number;
  };
  error?: string;
}

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
  isValidPath?: boolean; // Whether the new_path exists in Shopify
  confidence_score: number; // 0-100 confidence score for the match
  matched_by?: string; // Strategy used: exact, sku, title, ai, manual
  ai_suggestions?: Array<{
    entity_id: string;
    new_path: string;
    title: string;
    score: number;
  }>;
}

// Threshold for "unmatched" - redirects below this score go to the Unmatched tab
const CONFIDENCE_THRESHOLD = 70;

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

// Extended tab type to include "unmatched"
type TabType = RedirectEntityType | 'unmatched';

export function RedirectsStep({ project, onNext }: RedirectsStepProps) {
  const { toast } = useToast();
  const [redirects, setRedirects] = useState<RedirectRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('product');
  const [searchQuery, setSearchQuery] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [unmatchedUrls, setUnmatchedUrls] = useState<UnmatchedUrl[]>([]);
  const [unmatchedExpanded, setUnmatchedExpanded] = useState(true);
  const [validShopifyPaths, setValidShopifyPaths] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // URL inspection state
  const [inspectionResult, setInspectionResult] = useState<UrlInspectionResult | null>(null);
  const [inspectionUrl, setInspectionUrl] = useState<string>('');
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectionDialogOpen, setInspectionDialogOpen] = useState(false);
  
  // AI matching state
  const [isAiMatching, setIsAiMatching] = useState(false);
  const [aiMatchProgress, setAiMatchProgress] = useState({ current: 0, total: 0 });

  // Load existing redirects and valid paths
  useEffect(() => {
    loadValidPaths();
    loadRedirects();
  }, [project.id]);

  // Fetch all valid Shopify paths (uploaded entities)
  const loadValidPaths = async () => {
    try {
      const entities = await fetchUploadedEntities();
      const paths = new Set<string>();
      
      for (const entity of entities) {
        paths.add(entity.shopify_handle.toLowerCase());
      }
      
      setValidShopifyPaths(paths);
    } catch (err) {
      console.error('Error loading valid paths:', err);
    }
  };

  // Check if a path is valid (exists in Shopify)
  const isPathValid = (path: string): boolean => {
    if (!path) return false;
    return validShopifyPaths.has(path.toLowerCase());
  };

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
          isValidPath: true, // Will be validated when validShopifyPaths is loaded
          confidence_score: (r as unknown as { confidence_score?: number }).confidence_score ?? 0,
          matched_by: (r as unknown as { matched_by?: string }).matched_by ?? 'auto',
          ai_suggestions: (r as unknown as { ai_suggestions?: Array<{ entity_id: string; new_path: string; title: string; score: number }> }).ai_suggestions ?? [],
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

  // AI-driven matching for unmatched URLs
  const runAiMatching = async () => {
    // Get low-confidence or unmatched redirects
    const unmatchedRedirects = redirects.filter(r => 
      r.confidence_score < CONFIDENCE_THRESHOLD && r.status === 'pending'
    );
    
    // Also get URLs from the unmatchedUrls state (from Excel upload)
    const allUrlsToMatch = [
      ...unmatchedUrls.map(u => u.normalizedPath),
      ...unmatchedRedirects.map(r => r.old_path),
    ];
    
    // Remove duplicates
    const uniqueUrls = [...new Set(allUrlsToMatch)];
    
    if (uniqueUrls.length === 0) {
      toast({
        title: 'Ingen URLs at matche',
        description: 'Der er ingen umatchede URLs at behandle.',
      });
      return;
    }
    
    setIsAiMatching(true);
    setAiMatchProgress({ current: 0, total: uniqueUrls.length });
    
    try {
      // Process in batches for progress updates
      const BATCH_SIZE = 50;
      let totalMatched = 0;
      let totalUnmatched = 0;
      
      for (let i = 0; i < uniqueUrls.length; i += BATCH_SIZE) {
        const batch = uniqueUrls.slice(i, i + BATCH_SIZE);
        
        const { data, error } = await supabase.functions.invoke('match-redirects', {
          body: {
            projectId: project.id,
            oldPaths: batch,
          },
        });
        
        if (error) throw error;
        
        totalMatched += data.matched || 0;
        totalUnmatched += data.unmatched || 0;
        
        setAiMatchProgress({ current: Math.min(i + BATCH_SIZE, uniqueUrls.length), total: uniqueUrls.length });
      }
      
      // Clear the unmatchedUrls state since they've been processed
      setUnmatchedUrls([]);
      
      toast({
        title: 'AI-matching fuldført',
        description: `${totalMatched} URLs matchet automatisk. ${totalUnmatched} kræver manuel gennemgang.`,
      });
      
      // Reload redirects to show updated data
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
      setAiMatchProgress({ current: 0, total: 0 });
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
        // Use actual Shopify handle if stored, otherwise fallback to generated
        const storedHandle = data?.shopify_handle as string | null;
        const handle = storedHandle || generateShopifyHandle(title);
        
        if (sourcePath && product.shopify_id) {
          redirectsToInsert.push({
            project_id: project.id,
            entity_type: 'product',
            entity_id: product.id,
            old_path: sourcePath,
            new_path: `/products/${handle}`,
          });
        }
      }

      // Categories - shopify_tag stores actual handle after upload
      const { data: categories } = await supabase
        .from('canonical_categories')
        .select('id, external_id, slug, shopify_collection_id, name, shopify_tag')
        .eq('project_id', project.id)
        .eq('status', 'uploaded');

      for (const category of categories || []) {
        if (category.slug && category.shopify_collection_id) {
          // Use shopify_tag (actual Shopify handle) if available, otherwise generate
          const handle = category.shopify_tag || generateShopifyHandle(category.name);
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
        // Use actual Shopify handle if stored, otherwise fallback to slug
        const storedHandle = data?.shopify_handle as string | null;
        const handle = storedHandle || slug;
        
        if (handle && page.shopify_id) {
          redirectsToInsert.push({
            project_id: project.id,
            entity_type: 'page',
            entity_id: page.id,
            old_path: `/${slug || handle}`,
            new_path: `/pages/${handle}`,
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

  // Generate proper Shopify handle - MUST NOT contain spaces!
  const generateShopifyHandle = (title: string): string => {
    return title
      .toLowerCase()
      .trim()
      .replace(/[æ]/g, 'ae')
      .replace(/[ø]/g, 'oe')
      .replace(/[å]/g, 'aa')
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/[^a-z0-9-]+/g, '-') // Replace non-alphanumeric (except hyphens) with hyphens
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
      .substring(0, 255);
  };

  // Create redirects in Shopify
  const createRedirectsInShopify = async () => {
    const selectedRedirects = redirects.filter(r => r.selected && r.status === 'pending');
    
    // Filter out redirects with invalid paths
    const validRedirects = selectedRedirects.filter(r => isPathValid(r.new_path));
    const invalidCount = selectedRedirects.length - validRedirects.length;
    
    if (validRedirects.length === 0) {
      toast({
        title: invalidCount > 0 ? 'Ingen gyldige redirects' : 'Ingen valgt',
        description: invalidCount > 0 
          ? `${invalidCount} valgte redirects har ugyldige stier. Ret dem før oprettelse.`
          : 'Vælg mindst én redirect at oprette',
        variant: 'destructive',
      });
      return;
    }
    
    if (invalidCount > 0) {
      toast({
        title: 'Springer ugyldige over',
        description: `${invalidCount} redirects med ugyldige stier vil blive sprunget over.`,
      });
    }

    setIsCreating(true);
    setProgress({ current: 0, total: validRedirects.length });

    try {
      const { error } = await supabase.functions.invoke('create-redirects', {
        body: {
          projectId: project.id,
          redirectIds: validRedirects.map(r => r.id),
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
      // Use actual Shopify handle if stored, otherwise fallback to generated
      const storedHandle = data?.shopify_handle as string | null;
      const shopifyHandle = storedHandle 
        ? `/products/${storedHandle}` 
        : `/products/${generateShopifyHandle(title)}`;
      
      if (product.shopify_id) {
        entities.push({
          id: product.id,
          source_path: sourcePath,
          shopify_handle: shopifyHandle,
          entity_type: 'product',
          title: title,
          external_id: externalId,
        });
      }
    }

    // Categories - include all uploaded categories
    // Note: shopify_tag field now stores the actual Shopify handle
    const { data: categories } = await supabase
      .from('canonical_categories')
      .select('id, external_id, slug, shopify_collection_id, name, shopify_tag')
      .eq('project_id', project.id)
      .eq('status', 'uploaded');

    for (const category of categories || []) {
      if (category.shopify_collection_id) {
        // shopify_tag stores actual Shopify handle after upload
        const actualHandle = category.shopify_tag || generateShopifyHandle(category.name);
        entities.push({
          id: category.id,
          source_path: category.slug ? `/shop/${category.slug}/` : null,
          shopify_handle: `/collections/${actualHandle}`,
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
      // Use actual Shopify handle if stored, otherwise fallback to slug or generated
      const storedHandle = data?.shopify_handle as string | null;
      const shopifyHandle = storedHandle 
        ? `/pages/${storedHandle}` 
        : `/pages/${slug || generateShopifyHandle(title)}`;
      
      if (page.shopify_id) {
        entities.push({
          id: page.id,
          source_path: slug ? `/${slug}` : null,
          shopify_handle: shopifyHandle,
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
        confidence_score: number;
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
        
        // Try multiple matching strategies with confidence scores
        // PRIORITY ORDER: Products first (we have 1360+), then Pages, then Collections (only 174)
        let matchedEntity: UploadedEntity | undefined;
        let confidenceScore = 0;
        
        // Separate entities by type for prioritized matching
        const productEntities = uploadedEntities.filter(e => e.entity_type === 'product');
        const pageEntities = uploadedEntities.filter(e => e.entity_type === 'page');
        const categoryEntities = uploadedEntities.filter(e => e.entity_type === 'category');
        
        // Strategy 1: EXACT source_path match (highest confidence)
        // Check products first
        for (const entity of productEntities) {
          if (entity.source_path && normalizePath(entity.source_path) === normalizedOldPath) {
            matchedEntity = entity;
            confidenceScore = 100;
            break;
          }
        }
        
        // Then pages
        if (!matchedEntity) {
          for (const entity of pageEntities) {
            if (entity.source_path && normalizePath(entity.source_path) === normalizedOldPath) {
              matchedEntity = entity;
              confidenceScore = 100;
              break;
            }
          }
        }
        
        // Categories last - require EXACT source_path match (strict)
        if (!matchedEntity) {
          for (const entity of categoryEntities) {
            if (entity.source_path && normalizePath(entity.source_path) === normalizedOldPath) {
              matchedEntity = entity;
              confidenceScore = 100;
              break;
            }
          }
        }
        
        // Strategy 2: EXACT slug match - products get priority
        if (!matchedEntity && oldSlug) {
          // Check product slugs first
          for (const entity of productEntities) {
            const handleSlug = entity.shopify_handle.split('/').pop() || '';
            if (handleSlug && handleSlug === oldSlug) {
              matchedEntity = entity;
              confidenceScore = 95;
              break;
            }
          }
          
          // Then page slugs
          if (!matchedEntity) {
            for (const entity of pageEntities) {
              const handleSlug = entity.shopify_handle.split('/').pop() || '';
              if (handleSlug && handleSlug === oldSlug) {
                matchedEntity = entity;
                confidenceScore = 95;
                break;
              }
            }
          }
          
          // Categories - only exact slug match (strict)
          if (!matchedEntity) {
            for (const entity of categoryEntities) {
              const handleSlug = entity.shopify_handle.split('/').pop() || '';
              if (handleSlug && handleSlug === oldSlug) {
                matchedEntity = entity;
                confidenceScore = 90;
                break;
              }
            }
          }
        }
        
        // Strategy 3: Normalized title EXACT match - products first
        if (!matchedEntity && normalizedOldSlug) {
          // Products
          for (const entity of productEntities) {
            if (entity.title) {
              const normalizedEntityTitle = normalizeForComparison(entity.title);
              if (normalizedEntityTitle === normalizedOldSlug) {
                matchedEntity = entity;
                confidenceScore = 85;
                break;
              }
            }
          }
          
          // Pages
          if (!matchedEntity) {
            for (const entity of pageEntities) {
              if (entity.title) {
                const normalizedEntityTitle = normalizeForComparison(entity.title);
                if (normalizedEntityTitle === normalizedOldSlug) {
                  matchedEntity = entity;
                  confidenceScore = 85;
                  break;
                }
              }
            }
          }
          
          // NO category matching by title - too many false positives
        }
        
        // Strategy 4: Partial title match - ONLY for products (looser matching)
        // Categories are NOT matched here to prevent false positives
        if (!matchedEntity && normalizedOldSlug && normalizedOldSlug.length > 5) {
          for (const entity of productEntities) {
            if (entity.title) {
              const normalizedEntityTitle = normalizeForComparison(entity.title);
              // Product title contains the slug OR slug contains title (for short product names)
              if (normalizedEntityTitle.includes(normalizedOldSlug)) {
                matchedEntity = entity;
                confidenceScore = 65; // Lower confidence for partial match
                break;
              }
              if (normalizedOldSlug.includes(normalizedEntityTitle) && normalizedEntityTitle.length > 5) {
                matchedEntity = entity;
                confidenceScore = 55; // Even lower for reverse partial match
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
            confidence_score: confidenceScore,
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
    let tabRedirects: RedirectRow[];
    
    if (activeTab === 'unmatched') {
      // Unmatched = low confidence
      tabRedirects = redirects.filter(r => 
        r.confidence_score < CONFIDENCE_THRESHOLD && r.status === 'pending'
      );
    } else {
      // High confidence for specific entity type
      tabRedirects = redirects.filter(r => 
        r.entity_type === activeTab && 
        r.confidence_score >= CONFIDENCE_THRESHOLD && 
        r.status === 'pending'
      );
    }
    
    const allSelected = tabRedirects.every(r => r.selected);
    const tabRedirectIds = new Set(tabRedirects.map(r => r.id));
    
    setRedirects(prev =>
      prev.map(r => 
        tabRedirectIds.has(r.id)
          ? { ...r, selected: !allSelected }
          : r
      )
    );
  };

  // Update new_path for a redirect with validation (and boost confidence if manually selected)
  const updateNewPath = async (id: string, newPath: string, isManualSelection = false) => {
    const pathIsValid = isPathValid(newPath);
    
    // If manually selected via search, boost confidence to 100
    const newConfidence = isManualSelection ? 100 : undefined;
    
    // Update locally first with validation status
    setRedirects(prev =>
      prev.map(r => r.id === id ? { 
        ...r, 
        new_path: newPath, 
        isValidPath: pathIsValid,
        confidence_score: newConfidence ?? r.confidence_score 
      } : r)
    );

    // Persist to database
    try {
      const updateData: Record<string, unknown> = { new_path: newPath };
      if (newConfidence !== undefined) {
        updateData.confidence_score = newConfidence;
      }
      
      const { error } = await supabase
        .from('project_redirects')
        .update(updateData)
        .eq('id', id);

      if (error) throw error;
    } catch (err) {
      console.error('Error updating new_path:', err);
      toast({
        title: 'Fejl',
        description: 'Kunne ikke gemme ændring',
        variant: 'destructive',
      });
    }
  };

  // Inspect a URL to determine its page type
  const inspectUrl = async (oldPath: string) => {
    const fullUrl = getOldPathUrl(oldPath);
    setInspectionUrl(fullUrl);
    setIsInspecting(true);
    setInspectionResult(null);
    setInspectionDialogOpen(true);

    try {
      const { data, error } = await supabase.functions.invoke('inspect-url', {
        body: { url: fullUrl },
      });

      if (error) throw error;
      setInspectionResult(data as UrlInspectionResult);
    } catch (err) {
      console.error('Error inspecting URL:', err);
      setInspectionResult({
        success: false,
        pageType: 'unknown',
        error: err instanceof Error ? err.message : 'Kunne ikke inspicere URL',
      });
    } finally {
      setIsInspecting(false);
    }
  };

  // Sanitize a path to ensure it's a valid Shopify URL (no spaces, proper encoding)
  const sanitizeShopifyPath = (path: string): string => {
    return path
      .trim()
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/[^\w\-\/]/g, '-') // Replace non-word chars (except / and -) with hyphens
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .replace(/\/-/g, '/') // Remove hyphens after slashes
      .replace(/-\//g, '/') // Remove hyphens before slashes
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
  };

  // Build full URL for old path using DanDomain base URL
  const getOldPathUrl = (oldPath: string): string => {
    const baseUrl = project.dandomain_shop_url || '';
    if (!baseUrl) return oldPath;
    
    // Clean up base URL
    let cleanBase = baseUrl.replace(/\/$/, '');
    if (!cleanBase.startsWith('http')) {
      cleanBase = 'https://' + cleanBase;
    }
    
    return cleanBase + oldPath;
  };

  // Filter redirects based on active tab (including unmatched)
  const filteredRedirects = useMemo(() => {
    let filtered: RedirectRow[];
    
    if (activeTab === 'unmatched') {
      // Show redirects with low confidence scores (below threshold)
      filtered = redirects.filter(r => r.confidence_score < CONFIDENCE_THRESHOLD);
    } else {
      // Show redirects with high confidence scores for the specific entity type
      filtered = redirects.filter(r => 
        r.entity_type === activeTab && 
        r.confidence_score >= CONFIDENCE_THRESHOLD
      );
    }
    
    // Apply search filter
    return filtered.filter(r => 
      searchQuery === '' ||
      r.old_path.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.new_path.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [redirects, activeTab, searchQuery]);

  // Stats including unmatched count
  const stats = useMemo(() => {
    const highConfidence = redirects.filter(r => r.confidence_score >= CONFIDENCE_THRESHOLD);
    const lowConfidence = redirects.filter(r => r.confidence_score < CONFIDENCE_THRESHOLD);
    
    const byType = {
      product: highConfidence.filter(r => r.entity_type === 'product'),
      category: highConfidence.filter(r => r.entity_type === 'category'),
      page: highConfidence.filter(r => r.entity_type === 'page'),
      unmatched: lowConfidence,
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
            
            {/* AI Match Button */}
            <Button
              onClick={runAiMatching}
              disabled={isAiMatching || (unmatchedUrls.length === 0 && stats.byType.unmatched.length === 0)}
              variant="secondary"
              className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 text-primary-foreground border-0"
            >
              {isAiMatching ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Wand2 className="w-4 h-4 mr-2" />
              )}
              AI Match ({unmatchedUrls.length + stats.byType.unmatched.length})
            </Button>
            
            <Button
              onClick={createRedirectsInShopify}
              disabled={isCreating || redirects.filter(r => r.selected && r.status === 'pending' && isPathValid(r.new_path)).length === 0}
            >
              {isCreating ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-2" />
              )}
              Opret i Shopify ({redirects.filter(r => r.selected && r.status === 'pending' && isPathValid(r.new_path)).length})
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
          
          {isAiMatching && aiMatchProgress.total > 0 && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-primary animate-pulse" />
                <span className="text-sm font-medium">AI matcher URLs...</span>
              </div>
              <Progress value={(aiMatchProgress.current / aiMatchProgress.total) * 100} />
              <p className="text-sm text-muted-foreground mt-1">
                {aiMatchProgress.current} af {aiMatchProgress.total} behandlet...
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Unmatched URLs section */}
      {unmatchedUrls.length > 0 && (
        <Card className="border-warning/30">
          <Collapsible open={unmatchedExpanded} onOpenChange={setUnmatchedExpanded}>
            <CardHeader className="pb-3">
              <CollapsibleTrigger className="flex items-center justify-between w-full">
                <CardTitle className="flex items-center gap-2 text-warning">
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
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabType)}>
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
                  <TabsTrigger value="unmatched" className="text-warning">
                    Unmatched ({stats.byType.unmatched.length})
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
                        <TableHead className="w-16">Score</TableHead>
                        <TableHead className="w-24">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRedirects.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                            {searchQuery ? 'Ingen resultater' : activeTab === 'unmatched' ? 'Ingen usikre matches' : 'Ingen redirects - klik "Generer redirects"'}
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
                              <div className="flex items-center gap-1">
                                <a
                                  href={getOldPathUrl(redirect.old_path)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline inline-flex items-center gap-1 flex-1 truncate"
                                >
                                  {redirect.old_path}
                                  <ExternalLink className="w-3 h-3 shrink-0" />
                                </a>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0"
                                  onClick={() => inspectUrl(redirect.old_path)}
                                  title="Inspicér gammel URL"
                                >
                                  <Eye className="w-3 h-3" />
                                </Button>
                              </div>
                            </TableCell>
                            <TableCell>
                              <ArrowRight className="w-4 h-4 text-muted-foreground" />
                            </TableCell>
                            <TableCell>
                              <div className="space-y-1">
                                <div className="flex items-center gap-1">
                                  <Input
                                    value={redirect.new_path}
                                    onChange={(e) => updateNewPath(redirect.id, e.target.value)}
                                    className={`font-mono text-xs h-8 flex-1 ${
                                      redirect.status === 'pending' && !isPathValid(redirect.new_path)
                                        ? 'border-destructive focus-visible:ring-destructive'
                                        : ''
                                    }`}
                                    disabled={redirect.status !== 'pending'}
                                  />
                                  <ShopifyDestinationSearch
                                    projectId={project.id}
                                    currentValue={redirect.new_path}
                                    onSelect={(path) => updateNewPath(redirect.id, path, true)}
                                    disabled={redirect.status !== 'pending'}
                                    shopifyDomain={project.shopify_store_domain || undefined}
                                  />
                                  {project.shopify_store_domain && redirect.new_path && (
                                    <a
                                      href={`https://${project.shopify_store_domain.replace(/^https?:\/\//, '')}${redirect.new_path}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="h-8 w-8 flex items-center justify-center shrink-0 text-muted-foreground hover:text-primary transition-colors"
                                      title="Se siden i Shopify"
                                    >
                                      <ExternalLink className="w-4 h-4" />
                                    </a>
                                  )}
                                </div>
                                {redirect.status === 'pending' && !isPathValid(redirect.new_path) && (
                                  <div className="text-xs text-destructive flex items-center gap-1">
                                    <AlertCircle className="w-3 h-3" />
                                    Stien findes ikke i Shopify
                                  </div>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-1">
                                <Badge 
                                  variant={redirect.confidence_score >= 85 ? "default" : redirect.confidence_score >= 70 ? "secondary" : "outline"}
                                  className={redirect.confidence_score < 70 ? "text-warning border-warning/50" : ""}
                                >
                                  {redirect.confidence_score}%
                                </Badge>
                                {redirect.matched_by && redirect.matched_by !== 'auto' && (
                                  <span className="text-[10px] text-muted-foreground">
                                    {redirect.matched_by === 'exact' && 'Eksakt'}
                                    {redirect.matched_by === 'sku' && 'SKU'}
                                    {redirect.matched_by === 'title' && 'Titel'}
                                    {redirect.matched_by === 'ai' && '✨ AI'}
                                    {redirect.matched_by === 'manual' && 'Manuel'}
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              {getStatusBadge(redirect.status)}
                              {redirect.error_message && (
                                <div className="text-xs text-destructive mt-1">
                                  {redirect.error_message}
                                </div>
                              )}
                              {/* AI suggestions for unmatched */}
                              {activeTab === 'unmatched' && redirect.ai_suggestions && redirect.ai_suggestions.length > 0 && (
                                <div className="mt-2 space-y-1">
                                  <span className="text-xs text-muted-foreground">AI forslag:</span>
                                  {redirect.ai_suggestions.slice(0, 2).map((suggestion, idx) => (
                                    <button
                                      key={idx}
                                      onClick={() => updateNewPath(redirect.id, suggestion.new_path, true)}
                                      className="block w-full text-left px-2 py-1 text-xs rounded bg-muted/50 hover:bg-muted transition-colors"
                                    >
                                      <span className="font-medium">{suggestion.title}</span>
                                      <span className="text-muted-foreground ml-1">({suggestion.score}%)</span>
                                    </button>
                                  ))}
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
                    {inspectionResult.pageType === 'product' && (
                      <Package className="w-8 h-8 text-primary" />
                    )}
                    {inspectionResult.pageType === 'collection' && (
                      <FolderOpen className="w-8 h-8 text-primary" />
                    )}
                    {inspectionResult.pageType === 'page' && (
                      <FileText className="w-8 h-8 text-muted-foreground" />
                    )}
                    {inspectionResult.pageType === 'unknown' && (
                      <AlertCircle className="w-8 h-8 text-muted-foreground" />
                    )}
                    <div>
                      <Badge variant={
                        inspectionResult.pageType === 'product' ? 'default' :
                        inspectionResult.pageType === 'collection' ? 'secondary' :
                        'outline'
                      }>
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
                  
                  <div className="text-xs text-muted-foreground border-t pt-3">
                    <p>Brug denne information til at vælge den rigtige destination i Shopify.</p>
                    <p className="mt-1">Klik på søgeikonet ved "Ny sti" for at finde det matchende produkt/kollektion.</p>
                  </div>
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
