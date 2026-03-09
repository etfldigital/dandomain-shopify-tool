import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { MultiProgress } from '@/components/ui/multi-progress';
import { 
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  ShoppingBag,
  Users,
  FileText,
  Folder,
  FileSpreadsheet,
  Play,
  Pause,
  RotateCcw,
  FlaskConical,
  MoreVertical,
  Cloud,
  CloudOff,
  SkipForward,
  PartyPopper,
  ArrowRight,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Project, EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { UploadErrorReport } from './UploadErrorReport';
import { DuplicateAnalysisDialog } from './DuplicateAnalysisDialog';
import { SkippedProductsDialog } from './SkippedProductsDialog';
import { RejectedProductsDialog } from './RejectedProductsDialog';

interface UploadStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

interface ErrorDetail {
  externalId: string;
  message: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UploadJobRaw = any;

interface UploadJob {
  id: string;
  project_id: string;
  entity_type: EntityType;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  total_count: number;
  processed_count: number;
  error_count: number;
  skipped_count: number;
  items_per_minute: number | null;
  batch_size: number;
  error_details: ErrorDetail[] | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  current_batch: number;
  last_heartbeat_at: string | null;
  is_test_mode: boolean;
  // NEW: Actual batch metrics for accurate speed display
  last_batch_speed: number | null;
  last_batch_items: number | null;
  last_batch_duration_ms: number | null;
  next_attempt_at: string | null;
}

const toUploadJob = (raw: UploadJobRaw): UploadJob => ({
  id: raw.id,
  project_id: raw.project_id,
  entity_type: raw.entity_type as EntityType,
  status: raw.status,
  total_count: raw.total_count ?? 0,
  processed_count: raw.processed_count ?? 0,
  error_count: raw.error_count ?? 0,
  skipped_count: raw.skipped_count ?? 0,
  items_per_minute: raw.items_per_minute ?? null,
  batch_size: raw.batch_size ?? 10,
  error_details: raw.error_details as ErrorDetail[] | null,
  created_at: raw.created_at,
  started_at: raw.started_at,
  completed_at: raw.completed_at,
  current_batch: raw.current_batch ?? 1,
  last_heartbeat_at: raw.last_heartbeat_at,
  is_test_mode: raw.is_test_mode ?? false,
  // NEW fields
  last_batch_speed: raw.last_batch_speed ?? null,
  last_batch_items: raw.last_batch_items ?? null,
  last_batch_duration_ms: raw.last_batch_duration_ms ?? null,
  next_attempt_at: raw.next_attempt_at ?? null,
});

interface StatusCounts {
  pending: number;
  uploaded: number;
  failed: number;
  duplicate: number;
}

// Shopify live counts (fetched from API) per entity type
interface ShopifyLiveCounts {
  products: number | null;
  customers: number | null;
  orders: number | null;
  categories: number | null;
  pages: number | null;
  fetchFailed: boolean;
  isLoading: boolean;
}

interface ManufacturerLookupStatus {
  fileName: string | null;
  fileStatus: 'missing' | 'pending' | 'processed' | 'error';
  parsedCount: number;
  mappingCount: number;
}


const ENTITY_CONFIG: { type: EntityType; icon: typeof ShoppingBag; label: string }[] = [
  { type: 'pages', icon: FileSpreadsheet, label: 'Sider' },
  { type: 'categories', icon: Folder, label: 'Collections' },
  { type: 'products', icon: ShoppingBag, label: 'Produkter' },
  { type: 'customers', icon: Users, label: 'Kunder' },
  { type: 'orders', icon: FileText, label: 'Ordrer' },
];

// Watchdog is now self-scheduling on the server side, no browser polling needed.

// Preparation phase state
interface PrepareResult {
  groups: number;
  variants: number;
  rejected: number;
  totalRecords: number;
  cachedAt: number; // Timestamp to avoid re-running prepare
}

export function UploadStep({ project, onNext }: UploadStepProps) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [isForceRestarting, setIsForceRestarting] = useState(false);
  const [uiNow, setUiNow] = useState<number>(() => Date.now());
  const [showDuplicateAnalysis, setShowDuplicateAnalysis] = useState(false);
  const [showSkippedProducts, setShowSkippedProducts] = useState(false);
  const [showRejectedProducts, setShowRejectedProducts] = useState(false);
  // NEW: Two-phase upload state
  const [isPreparing, setIsPreparing] = useState(false);
  const [prepareResult, setPrepareResult] = useState<PrepareResult | null>(null);
  const [showPrepareConfirm, setShowPrepareConfirm] = useState(false);
  const [syncingEntity, setSyncingEntity] = useState<EntityType | null>(null);
  
  // Live speed tracking based on processed_count delta over time
  const [speedHistory, setSpeedHistory] = useState<{ timestamp: number; processed: number }[]>([]);
  
  // ANTI-FLICKER: Throttle realtime updates to prevent UI hopping
  const lastRealtimeUpdateRef = useRef<number>(0);
  const pendingRealtimeJobRef = useRef<UploadJob | null>(null);
  
  // Stable displayed values - only update every 3s to prevent visual flicker
  const [stableJob, setStableJob] = useState<UploadJob | null>(null);
  const stableJobUpdateRef = useRef<number>(0);

  // Status counts cached to avoid excessive DB queries
  const [statusCounts, setStatusCounts] = useState<Record<EntityType, StatusCounts>>({
    products: { pending: 0, uploaded: 0, failed: 0, duplicate: 0 },
    customers: { pending: 0, uploaded: 0, failed: 0, duplicate: 0 },
    orders: { pending: 0, uploaded: 0, failed: 0, duplicate: 0 },
    categories: { pending: 0, uploaded: 0, failed: 0, duplicate: 0 },
    pages: { pending: 0, uploaded: 0, failed: 0, duplicate: 0 },
  });
  const lastCountsFetchRef = useRef<number>(0);
  const autoRecoverRef = useRef<Record<string, number>>({}); // jobId -> last auto recover ts
  
  // Shopify live counts (actual product count from Shopify API)
  const [shopifyLiveCounts, setShopifyLiveCounts] = useState<ShopifyLiveCounts>({ products: null, customers: null, orders: null, categories: null, pages: null, fetchFailed: false, isLoading: false });
  const lastShopifyFetchRef = useRef<number>(0);

  const [manufacturerLookupStatus, setManufacturerLookupStatus] = useState<ManufacturerLookupStatus>({
    fileName: null,
    fileStatus: 'missing',
    parsedCount: 0,
    mappingCount: 0,
  });

  // Reset confirmation dialog state
  const [resetDialog, setResetDialog] = useState<{
    open: boolean;
    entityType: EntityType | null;
    scope: 'all' | 'failed' | 'uploaded' | 'skipped' | null;
    count: number;
  }>({ open: false, entityType: null, scope: null, count: 0 });

  // Fetch status counts - CACHED to avoid overloading DB
  const fetchStatusCounts = async (): Promise<Record<EntityType, StatusCounts>> => {
    // Throttle: avoid hammering DB (this was causing UI "freeze" feelings)
    const now = Date.now();
    if (now - lastCountsFetchRef.current < 15_000) {
      return statusCounts;
    }
    lastCountsFetchRef.current = now;
    
    const counts: Record<EntityType, StatusCounts> = {
      products: { pending: 0, uploaded: 0, failed: 0, duplicate: 0 },
      customers: { pending: 0, uploaded: 0, failed: 0, duplicate: 0 },
      orders: { pending: 0, uploaded: 0, failed: 0, duplicate: 0 },
      categories: { pending: 0, uploaded: 0, failed: 0, duplicate: 0 },
      pages: { pending: 0, uploaded: 0, failed: 0, duplicate: 0 },
    };

    // Products - count primary products (unique titles) per status using DB function.
    // This correctly counts ~3,478 primary products regardless of variant rows.
    const { data: primaryCounts } = await supabase.rpc('count_primary_products', {
      p_project_id: project.id,
    });

    let productPending = 0;
    let productUploaded = 0;
    let productFailed = 0;
    let productDuplicate = 0;
    if (primaryCounts && Array.isArray(primaryCounts)) {
      for (const row of primaryCounts) {
        if (row.status === 'pending') productPending = Number(row.primary_count) || 0;
        else if (row.status === 'uploaded') productUploaded = Number(row.primary_count) || 0;
        else if (row.status === 'failed') productFailed = Number(row.primary_count) || 0;
        else if (row.status === 'duplicate') productDuplicate = Number(row.primary_count) || 0;
      }
    }

    counts.products = { pending: productPending, uploaded: productUploaded, failed: productFailed, duplicate: productDuplicate };

    // Customers
    const [customerPendingR, customerUploadedR, customerFailedR, customerDuplicateR] = await Promise.all([
      supabase.from('canonical_customers').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'pending'),
      supabase.from('canonical_customers').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'uploaded'),
      supabase.from('canonical_customers').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'failed'),
      supabase.from('canonical_customers').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'duplicate'),
    ]);
    counts.customers = { pending: customerPendingR.count || 0, uploaded: customerUploadedR.count || 0, failed: customerFailedR.count || 0, duplicate: customerDuplicateR.count || 0 };

    // Orders
    const [orderPendingR, orderUploadedR, orderFailedR, orderDuplicateR] = await Promise.all([
      supabase.from('canonical_orders').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'pending'),
      supabase.from('canonical_orders').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'uploaded'),
      supabase.from('canonical_orders').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'failed'),
      supabase.from('canonical_orders').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'duplicate'),
    ]);
    counts.orders = { pending: orderPendingR.count || 0, uploaded: orderUploadedR.count || 0, failed: orderFailedR.count || 0, duplicate: orderDuplicateR.count || 0 };

    // Categories
    const [categoryPendingR, categoryUploadedR, categoryFailedR, categoryDuplicateR] = await Promise.all([
      supabase.from('canonical_categories').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'pending'),
      supabase.from('canonical_categories').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'uploaded'),
      supabase.from('canonical_categories').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'failed'),
      supabase.from('canonical_categories').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'duplicate'),
    ]);
    counts.categories = { pending: categoryPendingR.count || 0, uploaded: categoryUploadedR.count || 0, failed: categoryFailedR.count || 0, duplicate: categoryDuplicateR.count || 0 };

    // Pages
    const [pagePendingR, pageUploadedR, pageFailedR, pageDuplicateR] = await Promise.all([
      supabase.from('canonical_pages').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'pending'),
      supabase.from('canonical_pages').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'uploaded'),
      supabase.from('canonical_pages').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'failed'),
      supabase.from('canonical_pages').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'duplicate'),
    ]);
    counts.pages = { pending: pagePendingR.count || 0, uploaded: pageUploadedR.count || 0, failed: pageFailedR.count || 0, duplicate: pageDuplicateR.count || 0 };

    setStatusCounts(counts);
    return counts;
  };

  // Manufacturer lookup status + validation before product uploads
  const fetchManufacturerLookupStatus = async (): Promise<ManufacturerLookupStatus> => {
    try {
      const [fileResult, manufacturerCountResult] = await Promise.all([
        supabase
          .from('project_files')
          .select('file_name, row_count, status')
          .eq('project_id', project.id)
          .eq('entity_type', 'manufacturers')
          .maybeSingle(),
        supabase
          .from('canonical_manufacturers')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', project.id),
      ]);

      if (fileResult.error) throw fileResult.error;
      if (manufacturerCountResult.error) throw manufacturerCountResult.error;

      const dbFileStatus = String(fileResult.data?.status || '').toLowerCase();
      const fileStatus: ManufacturerLookupStatus['fileStatus'] = !fileResult.data
        ? 'missing'
        : dbFileStatus === 'processed'
        ? 'processed'
        : dbFileStatus === 'error'
        ? 'error'
        : 'pending';

      const nextStatus: ManufacturerLookupStatus = {
        fileName: fileResult.data?.file_name || null,
        fileStatus,
        parsedCount: Number(fileResult.data?.row_count || 0),
        mappingCount: Number(manufacturerCountResult.count || 0),
      };

      setManufacturerLookupStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      console.warn('[UploadStep] Kunne ikke hente producent-status:', error);
      const fallbackStatus: ManufacturerLookupStatus = {
        fileName: null,
        fileStatus: 'missing',
        parsedCount: 0,
        mappingCount: 0,
      };
      setManufacturerLookupStatus(fallbackStatus);
      return fallbackStatus;
    }
  };

  const shouldValidateManufacturers = (
    freshCounts: Record<EntityType, StatusCounts>,
    singleEntityType?: EntityType
  ) => {
    if (singleEntityType) return singleEntityType === 'products' && freshCounts.products.pending > 0;
    return freshCounts.products.pending > 0;
  };

  const ensureManufacturerLookupReady = async (
    freshCounts: Record<EntityType, StatusCounts>,
    singleEntityType?: EntityType
  ): Promise<boolean> => {
    if (!shouldValidateManufacturers(freshCounts, singleEntityType)) return true;

    const status = await fetchManufacturerLookupStatus();
    const hasProcessedFile = status.fileStatus === 'processed' && Boolean(status.fileName);

    if (hasProcessedFile) return true;

    toast.warning('Producentfil mangler før produktupload', {
      description: 'Upload og udtræk filen "Producenter" først, så MANUFAC_ID kan mappes til MANUFAC_NAME.',
    });
    return false;
  };


  // logVendorResolutionPreview removed — was iterating all products just to console.log

  const fetchShopifyLiveCountForEntity = async (entityType: EntityType, force = false) => {
    
    
    try {
      const response = await supabase.functions.invoke('shopify-products-count', {
        body: { 
          projectId: project.id,
          entityTypes: [entityType],
        },
      });
      
      
      
      if (response.data?.success && response.data.counts) {
        const value = response.data.counts[entityType] ?? null;
        setShopifyLiveCounts(prev => ({
          ...prev,
          [entityType]: value,
          fetchFailed: false,
        }));
      } else {
        
        setShopifyLiveCounts(prev => ({
          ...prev,
          [entityType]: null,
          fetchFailed: true,
        }));
      }
    } catch (e) {
      
      setShopifyLiveCounts(prev => ({
        ...prev,
        [entityType]: null,
        fetchFailed: true,
      }));
    }
  };

  // Fetch live counts from Shopify API for all entity types (sequential to avoid 429)
  const fetchShopifyLiveCounts = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastShopifyFetchRef.current < 60_000) {
      return;
    }
    lastShopifyFetchRef.current = now;
    setShopifyLiveCounts(prev => ({ ...prev, isLoading: true }));
    
    try {
      const response = await supabase.functions.invoke('shopify-products-count', {
        body: { 
          projectId: project.id,
          entityTypes: ['products', 'customers', 'orders', 'categories', 'pages'],
        },
      });
      
      
      
      if (response.data?.success && response.data.counts) {
        const c = response.data.counts;
        setShopifyLiveCounts({
          products: c.products ?? null,
          customers: c.customers ?? null,
          orders: c.orders ?? null,
          categories: c.categories ?? null,
          pages: c.pages ?? null,
          fetchFailed: false,
          isLoading: false,
        });
      } else {
        setShopifyLiveCounts(prev => ({ ...prev, fetchFailed: true, isLoading: false }));
      }
    } catch (e) {
      console.warn('[UploadStep] Failed to fetch Shopify live counts:', e);
      setShopifyLiveCounts(prev => ({ ...prev, fetchFailed: true, isLoading: false }));
    }
  };

  useEffect(() => {
    // Initial fetch
    fetchJobs();
    fetchStatusCounts();
    fetchShopifyLiveCounts();
    fetchManufacturerLookupStatus();

    // ANTI-FLICKER: Throttled realtime subscription
    // Instead of updating state on every payload, we batch updates
    const THROTTLE_MS = 2000; // Only allow UI updates every 2 seconds
    
    const channel = supabase
      .channel(`upload_jobs_${project.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'upload_jobs',
          filter: `project_id=eq.${project.id}`,
        },
        (payload) => {
          const now = Date.now();
          
          if (payload.eventType === 'INSERT') {
            // Inserts always apply immediately
            setJobs(prev => [...prev, toUploadJob(payload.new)]);
          } else if (payload.eventType === 'UPDATE') {
            const updated = toUploadJob(payload.new);
            
            // Store the latest pending update
            pendingRealtimeJobRef.current = updated;
            
            // Throttle: only update UI if enough time has passed
            if (now - lastRealtimeUpdateRef.current >= THROTTLE_MS) {
              lastRealtimeUpdateRef.current = now;
              setJobs(prev => prev.map(j => j.id === updated.id ? updated : j));
            }
          } else if (payload.eventType === 'DELETE') {
            setJobs(prev => prev.filter(j => j.id !== (payload.old as { id: string }).id));
          }
          
          // Refresh counts only when jobs complete/fail (not on every heartbeat)
          const updated = toUploadJob(payload.new);
          if (updated && (updated.status === 'completed' || updated.status === 'failed' || updated.status === 'cancelled')) {
            fetchStatusCounts();
            fetchShopifyLiveCounts(true); // Refresh live Shopify counts after job ends
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [project.id]);

  // UI timer + minimal polling + ANTI-FLICKER flush
  useEffect(() => {
    const hasActiveJobs = jobs.some(j => j.status === 'running' || j.status === 'paused');
    if (!hasActiveJobs) return;
    
    // UI time for smooth ETA display - update every 3s instead of 1s to reduce re-renders
    const uiTimer = window.setInterval(() => setUiNow(Date.now()), 3000);
    
    // ANTI-FLICKER: Flush any pending realtime updates that were throttled
    const flushTimer = window.setInterval(() => {
      if (pendingRealtimeJobRef.current) {
        const pending = pendingRealtimeJobRef.current;
        pendingRealtimeJobRef.current = null;
        lastRealtimeUpdateRef.current = Date.now();
        setJobs(prev => prev.map(j => j.id === pending.id ? pending : j));
      }
    }, 3000);
    
    // Light polling every 15 seconds (increased from 10s for less flicker)
    const pollTimer = window.setInterval(() => {
      fetchJobs();
      fetchStatusCounts(); // Throttled internally
      fetchShopifyLiveCounts(); // Throttled internally (30s)
      fetchManufacturerLookupStatus();
    }, 15_000);

    // Watchdog is now self-scheduling on the server side (started by upload-worker).
    // No need for browser-side watchdog polling anymore.
    
    return () => {
      window.clearInterval(uiTimer);
      window.clearInterval(flushTimer);
      window.clearInterval(pollTimer);
    };
  }, [jobs]);
  
  // ANTI-FLICKER: Update stable job reference only when values change significantly
  useEffect(() => {
    const runningJob = jobs.find(j => j.status === 'running');
    if (!runningJob) {
      setStableJob(null);
      return;
    }
    
    const now = Date.now();
    const STABLE_UPDATE_INTERVAL = 3000; // Only update displayed values every 3s
    
    // Always update if no stable job or if status/entity changed
    if (!stableJob || 
        stableJob.id !== runningJob.id || 
        stableJob.status !== runningJob.status ||
        now - stableJobUpdateRef.current >= STABLE_UPDATE_INTERVAL) {
      stableJobUpdateRef.current = now;
      setStableJob(runningJob);
    }
  }, [jobs, stableJob]);

  const fetchJobs = async () => {
    const { data } = await supabase
      .from('upload_jobs')
      .select('*')
      .eq('project_id', project.id)
      .order('created_at', { ascending: true });
    
    if (data) {
      setJobs(data.map(toUploadJob));
    }
  };

  // NEW: Phase 1 - Prepare products (grouping & validation)
  // Uses cached result if available and recent (< 5 minutes old)
  const handlePrepareProducts = async () => {
    // If we have a recent cached result, just show the dialog
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
    if (prepareResult && prepareResult.cachedAt && Date.now() - prepareResult.cachedAt < CACHE_TTL_MS) {
      setShowPrepareConfirm(true);
      return;
    }
    
    setIsPreparing(true);
    
    try {
      // Resumable loop: prepare-upload processes chunks and returns continue=true until done
      let result: any = null;
      let currentOffset = 0;
      while (true) {
        const response = await supabase.functions.invoke('prepare-upload', {
          body: {
            projectId: project.id,
            entityType: 'products',
            previewOnly: false,
            resumeOffset: currentOffset,
          },
        });

        if (response.error) {
          throw new Error(response.error.message);
        }

        result = response.data;
        if (!result.success) {
          throw new Error(result.error || 'Forberedelse fejlede');
        }

        // If the function signals more work to do, keep calling
        if (result.continue) {
          currentOffset = result.progress;
          console.log(`[Prepare] Progress: ${result.progress}/${result.total}`);
          continue;
        }

        // Done
        break;
      }

      setPrepareResult({
        groups: result.stats.groupsCreated,
        variants: result.stats.variantsTotal,
        rejected: result.stats.recordsRejected,
        totalRecords: result.stats.totalRecords,
        cachedAt: Date.now(),
      });
      
      // Refresh status counts after prepare
      await fetchStatusCounts();
      
      // Show confirmation dialog with final counts
      setShowPrepareConfirm(true);
      
    } catch (error) {
      console.error('Prepare failed:', error);
      toast.error(`Forberedelse fejlede: ${error instanceof Error ? error.message : 'Ukendt fejl'}`);
    } finally {
      setIsPreparing(false);
    }
  };

  // NEW: Phase 2 - Actually start the upload after preparation is confirmed
  const handleConfirmAndStartUpload = async () => {
    setShowPrepareConfirm(false);
    setPrepareResult(null);
    await handleStartUploadInternal(false);
  };

  // Internal upload starter (used after prepare or for non-product entities)
  const handleStartUploadInternal = async (isTestMode: boolean = false, singleEntityType?: EntityType, forceMode: boolean = false) => {
    // Check if there's anything to upload BEFORE starting
    const freshCounts = await fetchStatusCounts();
    
    // If a specific entity type, check that entity's pending count
    if (singleEntityType) {
      const pendingCount = freshCounts[singleEntityType]?.pending ?? 0;
      if (pendingCount === 0) {
        const entityLabel = ENTITY_CONFIG.find(e => e.type === singleEntityType)?.label || singleEntityType;
        toast.warning(`Ingen ${entityLabel.toLowerCase()} at uploade`, {
          description: 'Upload eller importer data først i de tidligere trin.',
        });
        return;
      }
    } else {
      // For full upload, check if ANY entity has pending items
      const totalPending = Object.values(freshCounts).reduce((sum, c) => sum + c.pending, 0);
      if (totalPending === 0) {
        toast.warning('Ingen data at uploade', {
          description: 'Upload eller importer data først i de tidligere trin.',
        });
        return;
      }
    }
    
    const manufacturerReady = await ensureManufacturerLookupReady(freshCounts, singleEntityType);
    if (!manufacturerReady) return;

    
    await logVendorResolutionPreview(freshCounts, singleEntityType);

    setIsStarting(true);
    try {
      const shouldSkipPrepare = !isTestMode; // In test mode, let the worker run prepare-upload for products

      const body: {
        projectId: string;
        action: string;
        isTestMode: boolean;
        entityTypes?: string[];
        skipPrepare?: boolean;
        triggerMode?: 'manual' | 'full' | 'force';
      } = {
        projectId: project.id,
        action: 'start',
        isTestMode,
        skipPrepare: shouldSkipPrepare,
      };
      
      // If a single entity type is specified, only upload that type
      if (singleEntityType) {
        body.entityTypes = [singleEntityType];
        body.triggerMode = forceMode ? 'force' : 'manual';
      } else {
        body.triggerMode = 'full';
      }
      
      const response = await supabase.functions.invoke('upload-worker', {
        body,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const entityLabel = singleEntityType 
        ? ENTITY_CONFIG.find(e => e.type === singleEntityType)?.label.toLowerCase() || singleEntityType
        : null;

      toast.success(isTestMode 
        ? `Test-upload startet${entityLabel ? ` for ${entityLabel}` : ''} i baggrunden` 
        : 'Upload startet i baggrunden - du kan lukke browseren');
      
      // Refresh jobs and live counts
      await fetchJobs();
      fetchShopifyLiveCounts(true);
    } catch (error) {
      console.error('Failed to start upload:', error);
      toast.error(`Kunne ikke starte upload: ${error instanceof Error ? error.message : 'Ukendt fejl'}`);
    } finally {
      setIsStarting(false);
    }
  };
  
  // Public handler - decides whether to prepare first or start directly
  const handleStartUpload = async (isTestMode: boolean = false, singleEntityType?: EntityType) => {
    // For test mode or single entity (non-products), start directly
    if (isTestMode || (singleEntityType && singleEntityType !== 'products')) {
      await handleStartUploadInternal(isTestMode, singleEntityType);
      return;
    }
    
    // For full upload with products, run prepare phase first
    if (!singleEntityType && statusCounts.products.pending > 0) {
      await handlePrepareProducts();
    } else {
      // No products or products-only single entity
      await handleStartUploadInternal(isTestMode, singleEntityType);
    }
  };

  // Sync: fetch Shopify records and match to local DB (chunked/resumable)
  const handleSync = async (entityType: EntityType) => {
    setSyncingEntity(entityType);
    try {
      // Phase 1: fetch Shopify records + first chunk
      let response = await supabase.functions.invoke('shopify-sync', {
        body: { projectId: project.id, entityType, phase: 'fetch' },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      let data = response.data;
      if (!data?.success) {
        throw new Error(data?.error || 'Synkronisering fejlede');
      }

      // Loop through remaining chunks
      while (!data.done && data.shopifyData && data.nextOffset != null) {
        const entityLabel = ENTITY_CONFIG.find(e => e.type === entityType)?.label || entityType;
        toast.info(`${entityLabel}: synkroniserer... (${data.nextOffset} behandlet)`, { duration: 3000 });

        response = await supabase.functions.invoke('shopify-sync', {
          body: {
            projectId: project.id,
            entityType,
            phase: 'apply',
            offset: data.nextOffset,
            shopifyData: data.shopifyData,
          },
        });

        if (response.error) {
          throw new Error(response.error.message);
        }

        data = response.data;
        if (!data?.success) {
          throw new Error(data?.error || 'Synkronisering fejlede');
        }
      }

      const entityLabel = ENTITY_CONFIG.find(e => e.type === entityType)?.label || entityType;
      const dupText = data.markedDuplicate > 0 ? `, ${data.markedDuplicate} duplikater markeret` : '';
      toast.success(`${entityLabel} synkroniseret`, {
        description: `${data.matched} matchet, ${data.alreadyUploaded} allerede uploadet${dupText}, ${data.notFound} ikke fundet i Shopify`,
        duration: 8000,
      });

      // Refresh counts so sequencing gate re-evaluates
      lastCountsFetchRef.current = 0;
      await fetchStatusCounts();
      await fetchShopifyLiveCounts(true);
      await fetchJobs();
    } catch (error) {
      console.error('Sync failed:', error);
      toast.error(`Synkronisering fejlede: ${error instanceof Error ? error.message : 'Ukendt fejl'}`);
    } finally {
      setSyncingEntity(null);
    }
  };

  const handlePauseResume = async () => {
    const runningJob = jobs.find(j => j.status === 'running');
    const pausedJob = jobs.find(j => j.status === 'paused');

    try {
      if (runningJob) {
        await supabase.functions.invoke('upload-worker', {
          body: { projectId: project.id, action: 'pause' },
        });
        toast.info('Upload sat på pause');
      } else if (pausedJob) {
        await supabase.functions.invoke('upload-worker', {
          body: { projectId: project.id, action: 'resume' },
        });
        toast.success('Upload genoptaget');
      }
      await fetchJobs();
    } catch (error) {
      toast.error('Kunne ikke pause/genoptage upload');
    }
  };

  const handleCancel = async () => {
    try {
      await supabase.functions.invoke('upload-worker', {
        body: { projectId: project.id, action: 'cancel' },
      });
      toast.info('Upload annulleret');
      await fetchJobs();
    } catch (error) {
      toast.error('Kunne ikke annullere upload');
    }
  };

  const handleForceRestart = async () => {
    if (isForceRestarting) return;
    setIsForceRestarting(true);
    const tId = toast.loading('Genstarter upload…');
    try {
      const { error } = await supabase.functions.invoke('upload-worker', {
        body: { projectId: project.id, action: 'force-restart' },
      });
      if (error) throw error;
      toast.dismiss(tId);
      toast.success('Upload genstartet');
      await fetchJobs();
    } catch (error) {
      toast.dismiss(tId);
      toast.error('Kunne ikke genstarte upload');
    } finally {
      setIsForceRestarting(false);
    }
  };

  const handleRetry = async () => {
    // Reset failed items to pending for each entity type
    await supabase.from('canonical_products').update({ status: 'pending', error_message: null }).eq('project_id', project.id).eq('status', 'failed');
    await supabase.from('canonical_customers').update({ status: 'pending', error_message: null }).eq('project_id', project.id).eq('status', 'failed');
    await supabase.from('canonical_orders').update({ status: 'pending', error_message: null }).eq('project_id', project.id).eq('status', 'failed');
    await supabase.from('canonical_categories').update({ status: 'pending', error_message: null }).eq('project_id', project.id).eq('status', 'failed');
    await supabase.from('canonical_pages').update({ status: 'pending', error_message: null }).eq('project_id', project.id).eq('status', 'failed');

    await fetchStatusCounts();
    await handleStartUpload(false);
  };

  const handleResetRequest = (entityType: EntityType, scope: 'all' | 'failed' | 'uploaded' | 'skipped', countOverride?: number) => {
    const counts = statusCounts[entityType];
    let count = 0;
    
    if (scope === 'all') {
      count = counts.pending + counts.uploaded + counts.failed + counts.duplicate;
    } else if (scope === 'failed') {
      count = counts.failed;
    } else if (scope === 'uploaded') {
      count = counts.uploaded;
    } else if (scope === 'skipped') {
      // For skipped, we need the count from the job, not statusCounts
      count = countOverride ?? 0;
    }

    if (count === 0) {
      toast.info('Ingen elementer at nulstille');
      return;
    }

    setResetDialog({ open: true, entityType, scope, count });
  };

  const handleResetConfirm = async () => {
    if (!resetDialog.entityType || !resetDialog.scope) return;

    try {
      // If anything is currently uploading, stop it first.
      // This ensures a reset never results in background uploads continuing “by themselves”.
      const hasActiveJobsNow = jobs.some(j => j.status === 'running' || j.status === 'paused' || j.status === 'pending');
      if (hasActiveJobsNow) {
        await supabase.functions.invoke('upload-worker', {
          body: { projectId: project.id, action: 'cancel' },
        });
        // Refresh jobs immediately so watchdog/polling doesn't keep treating them as active.
        await fetchJobs();
      }

      const response = await supabase.functions.invoke('reset-upload-status', {
        body: {
          projectId: project.id,
          entityType: resetDialog.entityType,
          resetScope: resetDialog.scope,
        },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const entityLabel = ENTITY_CONFIG.find(e => e.type === resetDialog.entityType)?.label || resetDialog.entityType;
      toast.success(`${response.data.resetCount} ${entityLabel.toLowerCase()} nulstillet til pending`);
      
      await fetchStatusCounts();
      // Also refetch jobs so skipped_count/error_count in the UI reflects the reset immediately
      await fetchJobs();
    } catch (error) {
      console.error('Reset error:', error);
      toast.error(`Fejl ved nulstilling: ${error instanceof Error ? error.message : 'Ukendt fejl'}`);
    } finally {
      setResetDialog({ open: false, entityType: null, scope: null, count: 0 });
    }
  };

  // Compute UI state from jobs
  const isUploading = jobs.some(j => j.status === 'running' || j.status === 'paused');
  const isPaused = jobs.some(j => j.status === 'paused');
  // Jobs are "done" when their status is completed or cancelled
  const allJobsDone = jobs.length > 0 && jobs.every(j => j.status === 'completed' || j.status === 'cancelled');
  const hasFailed = jobs.some(j => j.error_count > 0);
  // Check if a real (non-test) upload is currently running or paused
  const hasActiveRealUpload = jobs.some(j => !j.is_test_mode && (j.status === 'running' || j.status === 'paused'));
  // Check if any real upload jobs exist (running, completed, or cancelled)
  const hasStartedRealUpload = jobs.some(j => !j.is_test_mode);
  
  // Calculate totals from statusCounts (the source of truth from database) - EARLY for allCompleted
  // When DB counts timeout (return 0), fall back to job total_count
  const fixedTotalItems = ENTITY_CONFIG.reduce((acc, { type }) => {
    const counts = statusCounts[type];
    const dbTotal = counts.pending + counts.uploaded + counts.failed + counts.duplicate;
    if (dbTotal > 0) return acc + dbTotal;
    // Fallback: use job data when DB timed out
    const job = jobs.find(j => j.entity_type === type && (j.status === 'running' || j.status === 'paused' || j.status === 'completed'));
    return acc + (job?.total_count || 0);
  }, 0);
  const fixedTotalUploaded = ENTITY_CONFIG.reduce((acc, { type }) => {
    const counts = statusCounts[type];
    const dbTotal = counts.pending + counts.uploaded + counts.failed + counts.duplicate;
    if (dbTotal > 0) return acc + counts.uploaded;
    const job = jobs.find(j => j.entity_type === type && (j.status === 'running' || j.status === 'paused' || j.status === 'completed'));
    if (job && job.total_count > 0) return acc + Math.max(0, job.processed_count - job.error_count);
    return acc;
  }, 0);
  const fixedTotalFailed = ENTITY_CONFIG.reduce((acc, { type }) => {
    const counts = statusCounts[type];
    const dbTotal = counts.pending + counts.uploaded + counts.failed + counts.duplicate;
    if (dbTotal > 0) return acc + counts.failed;
    const job = jobs.find(j => j.entity_type === type && (j.status === 'running' || j.status === 'paused' || j.status === 'completed'));
    return acc + (job?.error_count || 0);
  }, 0);
  const fixedTotalPending = ENTITY_CONFIG.reduce((acc, { type }) => {
    const counts = statusCounts[type];
    const dbTotal = counts.pending + counts.uploaded + counts.failed + counts.duplicate;
    if (dbTotal > 0) return acc + counts.pending;
    const job = jobs.find(j => j.entity_type === type && (j.status === 'running' || j.status === 'paused' || j.status === 'completed'));
    if (job && job.total_count > 0) return acc + Math.max(0, job.total_count - job.processed_count);
    return acc;
  }, 0);
  
  // All entities are truly completed when zero pending items remain across all entity types
  // AND there's at least some data that has been uploaded
  const allCompleted = fixedTotalPending === 0 && fixedTotalItems > 0 && fixedTotalUploaded > 0;
  
  const [hasCelebrated, setHasCelebrated] = useState(false);
  const [retryingEntityType, setRetryingEntityType] = useState<EntityType | null>(null);
  const [retryingIds, setRetryingIds] = useState<string[] | null>(null);

  // Handle retry for failed items of a specific entity type (optionally with specific record IDs)
  const handleRetryFailed = async (entityType: EntityType, recordIds?: string[]) => {
    setRetryingEntityType(entityType);
    setRetryingIds(recordIds || null);
    try {
      // First, reset failed items to pending for the specific entity type
      const response = await supabase.functions.invoke('reset-upload-status', {
        body: {
          projectId: project.id,
          entityType: entityType,
          resetScope: 'failed',
          recordIds: recordIds, // Optional: if provided, only reset these specific rows
        },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const entityLabel = ENTITY_CONFIG.find(e => e.type === entityType)?.label || entityType;
      toast.success(`${response.data.resetCount} ${entityLabel.toLowerCase()} nulstillet - starter upload...`);
      
      // Refresh status counts
      await fetchStatusCounts();
      
      // Start the upload process
      await supabase.functions.invoke('upload-worker', {
        body: {
          projectId: project.id,
          action: 'start',
          isTestMode: false,
          entityTypes: [entityType],
        },
      });
      
      // Refresh jobs
      await fetchJobs();
    } catch (error) {
      console.error('Retry failed:', error);
      toast.error(`Kunne ikke genstarte upload: ${error instanceof Error ? error.message : 'Ukendt fejl'}`);
    } finally {
      setRetryingEntityType(null);
      setRetryingIds(null);
    }
  };

  // Celebration effect when all jobs complete
  useEffect(() => {
    if (allCompleted && !hasCelebrated) {
      setHasCelebrated(true);
      // Fire confetti celebration
      const duration = 3000;
      const end = Date.now() + duration;

      const frame = () => {
        confetti({
          particleCount: 3,
          angle: 60,
          spread: 55,
          origin: { x: 0, y: 0.8 },
          colors: ['#22c55e', '#3b82f6', '#a855f7'],
        });
        confetti({
          particleCount: 3,
          angle: 120,
          spread: 55,
          origin: { x: 1, y: 0.8 },
          colors: ['#22c55e', '#3b82f6', '#a855f7'],
        });

        if (Date.now() < end) {
          requestAnimationFrame(frame);
        }
      };
      frame();
    }
  }, [allCompleted, hasCelebrated]);
  
  const runningJob = jobs.find(j => j.status === 'running');
  const secondsSinceHeartbeat = runningJob?.last_heartbeat_at 
    ? Math.max(0, Math.floor((uiNow - new Date(runningJob.last_heartbeat_at).getTime()) / 1000))
    : 0;

  // Auto-recovery: if we have a running job that hasn't heartbeated for a while AND no retry is scheduled,
  // trigger a force-restart. This removes the need for manual stop/start loops.
  useEffect(() => {
    if (!runningJob) return;
    if (runningJob.status !== 'running') return;

    // If the worker has scheduled a retry (rate limit/backoff), don't interfere.
    if (runningJob.next_attempt_at) {
      const nextMs = new Date(runningJob.next_attempt_at).getTime();
      if (Number.isFinite(nextMs) && nextMs > Date.now()) return;
    }

    // Conservative stall threshold
    const STALL_SECONDS = 120;
    if (secondsSinceHeartbeat < STALL_SECONDS) return;

    const last = autoRecoverRef.current[runningJob.id] ?? 0;
    const COOLDOWN_MS = 5 * 60_000;
    if (Date.now() - last < COOLDOWN_MS) return;

    autoRecoverRef.current[runningJob.id] = Date.now();

    (async () => {
      try {
        console.log('[UploadStep] Auto-recover: force-restart', { jobId: runningJob.id, entity: runningJob.entity_type });
        const { error } = await supabase.functions.invoke('upload-worker', {
          body: { projectId: project.id, action: 'force-restart' },
        });
        if (error) throw error;
        toast.info('Upload fortsætter automatisk – processen blev genstartet.');
      } catch (e) {
        console.warn('[UploadStep] Auto-recover failed:', e);
      }
    })();
  }, [runningJob?.id, runningJob?.status, runningJob?.next_attempt_at, secondsSinceHeartbeat, project.id]);
  
  // Track speed history for live calculation
  useEffect(() => {
    if (runningJob && runningJob.status === 'running') {
      const now = Date.now();
      const currentProcessed = runningJob.processed_count;
      
      setSpeedHistory(prev => {
        const recent = prev.filter(p => now - p.timestamp < 60_000); // Keep last 60s
        // Only add if processed count changed
        if (recent.length === 0 || recent[recent.length - 1].processed !== currentProcessed) {
          return [...recent, { timestamp: now, processed: currentProcessed }];
        }
        return recent;
      });
    } else {
      setSpeedHistory([]);
    }
  }, [runningJob?.processed_count, runningJob?.status]);

  // Calculate live speed from history (items processed in last 30-60 seconds)
  const liveSpeed = (() => {
    if (speedHistory.length < 2) return null;
    const now = Date.now();
    const recentHistory = speedHistory.filter(p => now - p.timestamp < 60_000);
    if (recentHistory.length < 2) return null;
    
    const oldest = recentHistory[0];
    const newest = recentHistory[recentHistory.length - 1];
    const deltaItems = newest.processed - oldest.processed;
    const deltaMs = newest.timestamp - oldest.timestamp;
    
    if (deltaMs < 5000 || deltaItems <= 0) return null; // Need at least 5s of data
    return (deltaItems / deltaMs) * 60_000; // items per minute
  })();

  // UI-only "live" progress so the counter/bar can move smoothly between DB updates.
  // We cap the estimate to at most one batch.
  const getLiveProcessedCount = (job?: UploadJob, fallback = 0) => {
    if (!job) return fallback;

    const base = typeof job.processed_count === 'number' ? job.processed_count : fallback;
    if (job.status !== 'running') return base;

    const ipm = job.items_per_minute ?? 0;
    if (!ipm || !job.last_heartbeat_at) return base;

    const last = new Date(job.last_heartbeat_at).getTime();
    if (!Number.isFinite(last)) return base;

    const elapsedMs = Math.max(0, uiNow - last);
    const maxElapsedMs = ipm > 0 ? (job.batch_size / ipm) * 60_000 : 60_000;
    const effectiveElapsedMs = Math.min(elapsedMs, maxElapsedMs);

    const est = Math.floor(base + (effectiveElapsedMs / 60_000) * ipm);
    const hardCap = Math.min(job.total_count, base + job.batch_size);
    return Math.max(base, Math.min(est, hardCap));
  };


  // For live progress during upload, use the running job's processed count
  const runningJobProcessed = runningJob ? getLiveProcessedCount(runningJob, runningJob.processed_count) : 0;
  
  // Get errors and skipped only from the CURRENT set of jobs (not cancelled ones)
  // We only want to show stats from the most recent job run
  const activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'paused' || j.status === 'pending');
  const recentCompletedJobs = ENTITY_CONFIG.map(({ type }) => {
    const entityJobs = jobs.filter(j => j.entity_type === type);
    // Get the most recent job for this entity
    return entityJobs.length > 0 ? entityJobs[entityJobs.length - 1] : null;
  }).filter(Boolean) as UploadJob[];
  
  // Use active jobs if uploading, otherwise use recent completed jobs
  const relevantJobs = activeJobs.length > 0 ? [...activeJobs, ...recentCompletedJobs.filter(j => j.status === 'completed')] : recentCompletedJobs;
  const uniqueRelevantJobs = Array.from(new Map(relevantJobs.map(j => [j.id, j])).values());
  
  const totalErrors = uniqueRelevantJobs.reduce((acc, j) => acc + j.error_count, 0);
  const totalSkipped = uniqueRelevantJobs.reduce((acc, j) => acc + j.skipped_count, 0);

  // Get progress for each entity type - prioritize running/paused jobs over completed/cancelled
  const getJobForEntity = (entityType: EntityType) => {
    // First look for active jobs (running or paused)
    const activeJob = jobs.find(j => j.entity_type === entityType && (j.status === 'running' || j.status === 'paused'));
    if (activeJob) return activeJob;
    
    // Then look for pending jobs
    const pendingJob = jobs.find(j => j.entity_type === entityType && j.status === 'pending');
    if (pendingJob) return pendingJob;
    
    // Finally, get the most recent job for this entity type
    const entityJobs = jobs.filter(j => j.entity_type === entityType);
    return entityJobs.length > 0 ? entityJobs[entityJobs.length - 1] : undefined;
  };

  // Calculate ACTUAL current speed - prioritize live speed, then last_batch_speed
  const actualBatchSpeed = runningJob?.last_batch_speed ?? null;
  const smoothedSpeed = runningJob?.items_per_minute ?? 0;

  // Use live speed if available, otherwise fall back to batch speed
  const currentSpeed = liveSpeed ?? actualBatchSpeed ?? smoothedSpeed;

  // For ETA, use smoothed average (more stable)
  const etaSpeed = smoothedSpeed > 0 ? smoothedSpeed : (liveSpeed ?? 0);
  
  // Calculate remaining items across ALL pending and running jobs
  const totalRemainingItems = jobs
    .filter(j => j.status === 'running' || j.status === 'pending' || j.status === 'paused')
    .reduce((acc, j) => acc + Math.max(0, j.total_count - j.processed_count), 0);
  
  const etaMinutes = etaSpeed > 0 ? Math.ceil(totalRemainingItems / etaSpeed) : null;

  const formatEta = (minutes: number) => {
    if (minutes >= 90) {
      const hours = minutes / 60;
      return `${hours.toFixed(1).replace('.', ',')} timer`;
    }
    return `${minutes.toLocaleString('da-DK')} min`;
  };
  
  const formatSpeed = (speed: number) => {
    if (speed >= 100) {
      return `${Math.round(speed)} / min`;
    }
    if (speed > 0) {
      return `${speed.toFixed(1).replace('.', ',')} / min`;
    }
    return null; // Return null when no speed available
  };

  // Activity message with better retry/waiting states
  const getActivityMessage = () => {
    if (isStarting) return 'Starter upload…';
    if (!runningJob) {
      if (isPaused) return 'Sat på pause';
      return '';
    }
    
    const label = ENTITY_CONFIG.find(e => e.type === runningJob.entity_type)?.label || runningJob.entity_type;
    
    // If currently rate-limited or waiting - show friendly message without countdown
    if (runningJob.next_attempt_at) {
      const waitMs = new Date(runningJob.next_attempt_at).getTime() - Date.now();
      if (waitMs > 0) {
        return `Synkroniserer ${label.toLowerCase()} med Shopify…`;
      }
    }
    
    // Normal processing message
    return `Uploader ${label.toLowerCase()}…`;
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-semibold mb-2">Upload til Shopify</h2>
        <p className="text-muted-foreground">
          Overfør dine data til Shopify i den optimale rækkefølge
        </p>
      </div>


      {/* Celebration banner when all completed */}
      {allCompleted && (
        <Card className="border-green-500/50 bg-green-500/10">
          <CardContent className="pt-6 pb-6">
            <div className="flex items-center justify-center gap-4">
              <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center">
                <PartyPopper className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-xl font-semibold text-green-700 dark:text-green-400">
                  Upload færdig! 🎉
                </p>
                <p className="text-sm text-green-600 dark:text-green-500">
                  Alle dine data er blevet overført til Shopify
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Background processing info banner - STABILIZED with stableJob to prevent flicker */}
      {isUploading && !allCompleted && (
        <Card className="border-primary/50 bg-primary/5">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start gap-3">
              <Cloud className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-foreground">Upload kører automatisk i baggrunden</p>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={`w-2 h-2 rounded-full ${
                      secondsSinceHeartbeat > 60 ? 'bg-amber-500' : 'bg-green-500'
                    } animate-pulse`} />
                    {secondsSinceHeartbeat > 60 ? 'Venter på Shopify' : 'Arbejder'}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Du kan trygt lukke browseren – serveren fortsætter automatisk, også ved rate-limits.
                </p>
                {/* Live processing stats - use stableJob to prevent number flickering */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
                  {(stableJob || runningJob) && (
                    <>
                      <span>
                        <span className="font-medium text-foreground tabular-nums">
                          {(stableJob?.processed_count ?? runningJob?.processed_count ?? 0).toLocaleString('da-DK')}
                        </span>
                        {' / '}
                        <span className="tabular-nums">
                          {(stableJob?.total_count ?? runningJob?.total_count ?? 0).toLocaleString('da-DK')}
                        </span>
                        {' behandlet'}
                      </span>
                      {currentSpeed > 0 && (
                        <span className="tabular-nums">
                          ~{formatSpeed(currentSpeed)}
                        </span>
                      )}
                      {etaMinutes != null && totalRemainingItems > 0 && (
                        <span className="tabular-nums">
                          ~{formatEta(etaMinutes)} tilbage
                        </span>
                      )}
                      {/* Last activity timestamp for reassurance */}
                      {runningJob?.last_heartbeat_at && (
                        <span className="text-muted-foreground/70">
                          Seneste aktivitet: {secondsSinceHeartbeat < 5 ? 'nu' : `${secondsSinceHeartbeat}s siden`}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Upload Progress</CardTitle>
          <CardDescription>
            {allCompleted 
              ? 'Upload er fuldført. Alle data er nu i Shopify.'
              : 'Data uploades i rækkefølgen: Sider → Collections → Produkter → Kunder → Ordrer'
            }
          </CardDescription>
          {/* Only show live stats while actively uploading, NOT when completed - STABILIZED */}
          {(isUploading || isStarting) && !allCompleted && (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                <span className="font-medium text-foreground">{getActivityMessage()}</span>
              </div>
              <div className="flex items-center gap-4 text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${
                    secondsSinceHeartbeat > 60 ? 'bg-warning' : 'bg-success'
                  } animate-pulse`} />
                  <span className="text-sm">
                    {secondsSinceHeartbeat > 60 ? 'Synkroniserer' : 'Aktiv'}
                  </span>
                </span>
                {currentSpeed > 0 ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-primary font-medium cursor-help flex items-center gap-1 tabular-nums">
                          ⚡ {formatSpeed(currentSpeed)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{liveSpeed ? 'Live hastighed (sidste 60 sek)' : 'Seneste batch-hastighed'}</p>
                        {(stableJob || runningJob)?.last_batch_items && (stableJob || runningJob)?.last_batch_duration_ms && (
                          <p className="text-muted-foreground text-xs mt-1">
                            {(stableJob || runningJob)?.last_batch_items} items på {Math.round(((stableJob || runningJob)?.last_batch_duration_ms ?? 0) / 1000)}s
                          </p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <span className="text-muted-foreground font-medium flex items-center gap-1">
                    <span className="inline-block w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
                    {runningJob?.next_attempt_at ? 'Synkroniserer med Shopify…' : 'Forbereder næste batch…'}
                  </span>
                )}
                {etaMinutes != null && totalRemainingItems > 0 && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="bg-muted px-2 py-0.5 rounded-md font-medium cursor-help tabular-nums">
                          ~{formatEta(etaMinutes)} tilbage
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{totalRemainingItems.toLocaleString('da-DK')} elementer tilbage</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {ENTITY_CONFIG.map(({ type, icon: Icon, label }) => {
            const job = getJobForEntity(type);
            const counts = statusCounts[type];
            
            // Database counts are the SOURCE OF TRUTH for progress
            // BUT: when DB counts all return 0 (timeout), fall back to job data
            const totalFromDb = counts.pending + counts.uploaded + counts.failed + counts.duplicate;
            const dbTimedOut = totalFromDb === 0 && job && job.total_count > 0;
            
            const skipped = job?.skipped_count || 0;
            const errors = dbTimedOut ? (job?.error_count || 0) : counts.failed;
            
            // When DB timed out, derive progress from the job's own counters
            const effectivePending = dbTimedOut 
              ? Math.max(0, job!.total_count - job!.processed_count)
              : counts.pending;
            const effectiveUploaded = dbTimedOut 
              ? job!.processed_count - (job?.error_count || 0)
              : counts.uploaded;
            const effectiveDuplicate = dbTimedOut ? 0 : counts.duplicate;
            const effectiveFailed = dbTimedOut ? (job?.error_count || 0) : counts.failed;
            
            // CRITICAL: Progress is based on database state (or job fallback)
            const processedFromDb = effectiveUploaded + effectiveFailed + effectiveDuplicate;
            const total = (dbTimedOut ? job!.total_count : totalFromDb) + skipped;
            const processedActual = processedFromDb + skipped;
            
            // Live estimation for smooth UI during uploads
            const processedLive = job && job.status === 'running' 
              ? getLiveProcessedCount(job, processedActual)
              : processedActual;
            const isEstimated = Boolean(job && job.status === 'running' && processedLive !== processedActual);

            // UI-only: show when worker is waiting for next attempt (rate limit/backoff)
            const waitMs = job?.status === 'running' && job?.next_attempt_at
              ? new Date(job.next_attempt_at).getTime() - uiNow
              : 0;
            const isWaiting = Number.isFinite(waitMs) && waitMs > 0;
            
            // CRITICAL: Job is ONLY complete when pending = 0
            // This ensures the progress bar reaches 100% before showing green checkmark
            const isComplete = effectivePending === 0 && total > 0;
            const status = isComplete 
              ? 'completed' 
              : job?.status || (effectivePending === 0 && total > 0 ? 'completed' : 'pending');

            // Progress percentage: when pending=0, this will be 100%
            const percent = total > 0 ? (processedActual / total) * 100 : 0;

            return (
              <div key={type} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                      syncingEntity === type ? 'bg-primary/10' :
                      status === 'completed' ? 'bg-green-100 dark:bg-green-900' :
                      status === 'failed' ? 'bg-destructive/10' :
                      status === 'running' ? 'bg-primary/10' :
                      status === 'paused' ? 'bg-amber-100 dark:bg-amber-900' :
                      'bg-muted'
                    }`}>
                      {syncingEntity === type ? (
                        <RefreshCw className="w-4 h-4 text-primary animate-spin" />
                      ) : status === 'completed' ? (
                        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400" />
                      ) : status === 'failed' ? (
                        <AlertCircle className="w-4 h-4 text-destructive" />
                      ) : status === 'running' ? (
                        <Loader2 className="w-4 h-4 text-primary animate-spin" />
                      ) : status === 'paused' ? (
                        <Pause className="w-4 h-4 text-amber-600" />
                      ) : (
                        <Icon className="w-4 h-4 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <span className="font-medium">{label}</span>
                      {/* Clean summary showing processed breakdown */}
                      {(totalFromDb > 0 || dbTimedOut) && (
                        <div className="text-xs text-muted-foreground">
                          {isComplete ? (
                            <span className="text-green-600 font-medium">
                              {total.toLocaleString('da-DK')} behandlet
                              {effectiveUploaded > 0 && ` (${effectiveUploaded.toLocaleString('da-DK')} ny`}
                              {effectiveDuplicate > 0 && `, ${effectiveDuplicate.toLocaleString('da-DK')} duplikater`}
                              {skipped > 0 && `, ${skipped.toLocaleString('da-DK')} eksisterende`}
                              {effectiveFailed > 0 && `, ${effectiveFailed.toLocaleString('da-DK')} fejlet`}
                              {(effectiveUploaded > 0 || effectiveDuplicate > 0 || skipped > 0 || effectiveFailed > 0) && ')'}
                            </span>
                          ) : (
                            <span>
                              {effectivePending > 0 && <span className="mr-2">{effectivePending.toLocaleString('da-DK')} afventer</span>}
                              {/* Show Shopify live count for all entity types */}
                              {(() => {
                                const liveCount = shopifyLiveCounts[type];
                                if (liveCount !== null && liveCount !== undefined) {
                                  return (
                                    <span className="text-green-600 mr-2">
                                      {liveCount.toLocaleString('da-DK')} i Shopify
                                      <button
                                        onClick={(e) => { e.stopPropagation(); fetchShopifyLiveCountForEntity(type, true); }}
                                        className="ml-1 inline-flex items-center text-muted-foreground hover:text-foreground"
                                        title={`Opdater ${label} Shopify-tal`}
                                      >
                                        <RefreshCw className="w-3 h-3" />
                                      </button>
                                    </span>
                                  );
                                }
                                if (shopifyLiveCounts.isLoading) {
                                  return <span className="text-muted-foreground mr-2"><Loader2 className="w-3 h-3 inline animate-spin mr-1" />henter…</span>;
                                }
                                if (shopifyLiveCounts.fetchFailed) {
                                  return (
                                    <span className="text-muted-foreground mr-2">
                                      – i Shopify
                                      <button
                                        onClick={(e) => { e.stopPropagation(); fetchShopifyLiveCountForEntity(type, true); }}
                                        className="ml-1 inline-flex items-center hover:text-foreground"
                                        title="Prøv igen"
                                      >
                                        <RefreshCw className="w-3 h-3" />
                                      </button>
                                    </span>
                                  );
                                }
                                if (effectiveUploaded > 0) {
                                  return <span className="text-green-600 mr-2">{effectiveUploaded.toLocaleString('da-DK')} uploadet</span>;
                                }
                                return null;
                              })()}
                              {effectiveDuplicate > 0 && <span className="text-amber-600 mr-2">{effectiveDuplicate.toLocaleString('da-DK')} duplikater</span>}
                              {skipped > 0 && <span className="text-amber-600 mr-2">{skipped.toLocaleString('da-DK')} eksisterende</span>}
                              {effectiveFailed > 0 && <span className="text-destructive">{effectiveFailed.toLocaleString('da-DK')} fejlet</span>}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Extra clarity during uploads: DB-confirmed vs worker progress */}
                      {isUploading && job?.status === 'running' && (
                        <div className="mt-1 text-[11px] text-muted-foreground/80">
                          <span className="tabular-nums">
                            Server: {job.processed_count.toLocaleString('da-DK')} / {job.total_count.toLocaleString('da-DK')} gennemløbet
                          </span>
                          <span className="mx-2">•</span>
                          <span className="tabular-nums">
                            Bekræftet: {processedActual.toLocaleString('da-DK')} / {total.toLocaleString('da-DK')}
                          </span>
                          {isWaiting && (
                            <>
                              <span className="mx-2">•</span>
                              <span>Venter på Shopify (genoptager automatisk)</span>
                            </>
                          )}
                          {isEstimated && !isWaiting && (
                            <>
                              <span className="mx-2">•</span>
                              <span>Opdaterer…</span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Speed shown only in header - removed duplicate here */}
                    {/* Skipped count removed - no longer shown */}
                    {errors > 0 && (
                      <span className="flex items-center gap-1 text-destructive text-sm">
                        <AlertCircle className="w-3 h-3" />
                        {errors} fejl
                      </span>
                    )}
                    {isUploading && (
                      <span className="text-sm text-muted-foreground">
                        <span className="text-green-600 font-medium">
                          {processedActual.toLocaleString('da-DK')}
                        </span>
                        {' / '}
                        <span>{total.toLocaleString('da-DK')}</span>
                      </span>
                    )}
                    {!isUploading && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="bg-popover">
                          {/* Upload single entity type */}
                          {(() => {
                            const entityLabels: Record<EntityType, string> = {
                              pages: 'sider',
                              categories: 'collections',
                              products: 'produkter',
                              customers: 'kunder',
                              orders: 'ordrer',
                            };
                            const sequenceOrder: EntityType[] = ['pages', 'categories', 'products', 'customers', 'orders'];
                            const currentIdx = sequenceOrder.indexOf(type);
                            // Check if any predecessor entity still has pending items
                            // BUT: if Shopify live count >= local total, consider it "done" even if local DB hasn't synced
                            const predecessorBlocking = sequenceOrder.slice(0, currentIdx).find(
                              predType => {
                                if (statusCounts[predType].pending === 0) return false;
                                // If Shopify already has at least as many as local total, predecessor is effectively done
                                const localTotal = statusCounts[predType].pending + statusCounts[predType].uploaded + statusCounts[predType].failed;
                                const liveCount = shopifyLiveCounts[predType];
                                if (liveCount !== null && liveCount !== undefined && liveCount >= localTotal) return false;
                                return true;
                              }
                            );
                            const predecessorLabel = predecessorBlocking 
                              ? ENTITY_CONFIG.find(e => e.type === predecessorBlocking)?.label 
                              : null;
                            const jobRunning = job?.status === 'running';
                            const noPending = effectivePending === 0;

                          return (
                              <>
                                <DropdownMenuItem
                                  onClick={() => {
                                    if (predecessorBlocking) {
                                      toast.error(`Kan ikke starte endnu`, {
                                        description: `${predecessorLabel} skal uploades først – der er stadig ${statusCounts[predecessorBlocking].pending.toLocaleString('da-DK')} afventende.`,
                                      });
                                      return;
                                    }
                                    handleStartUpload(false, type);
                                  }}
                                  disabled={jobRunning || isStarting}
                                >
                                  <Play className="w-4 h-4 mr-2" />
                                  {jobRunning 
                                    ? `Upload kører allerede…` 
                                    : `Upload ${entityLabels[type]}`}
                                </DropdownMenuItem>
                                {predecessorBlocking && (
                                  <DropdownMenuItem
                                    onClick={() => {
                                      handleStartUploadInternal(false, type, true);
                                    }}
                                    disabled={jobRunning || isStarting || noPending}
                                    className="text-amber-600"
                                  >
                                    <AlertTriangle className="w-4 h-4 mr-2" />
                                    Tving start (ignorer rækkefølge)
                                  </DropdownMenuItem>
                                )}
                              </>
                            );
                          })()}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => handleStartUpload(true, type)}
                            disabled={effectivePending === 0 || isStarting}
                          >
                            <FlaskConical className="w-4 h-4 mr-2" />
                            Test upload (3 stk)
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => handleResetRequest(type, 'all')}
                            disabled={totalFromDb === 0 && !dbTimedOut}
                          >
                            <RotateCcw className="w-4 h-4 mr-2" />
                            Nulstil uploads
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => handleSync(type)}
                            disabled={syncingEntity !== null}
                          >
                            {syncingEntity === type ? (
                              <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                Synkroniserer…
                              </>
                            ) : (
                              <>
                                <Cloud className="w-4 h-4 mr-2" />
                                Synkroniser med Shopify
                              </>
                            )}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
                {(isUploading || job || totalFromDb > 0 || dbTimedOut) && (
                  <MultiProgress 
                    className="h-2"
                    total={total}
                    segments={[
                      { 
                        value: effectiveUploaded, 
                        className: "bg-green-500",
                        label: `${effectiveUploaded.toLocaleString('da-DK')} uploadet` 
                      },
                      { 
                        value: effectiveDuplicate, 
                        className: "bg-amber-400",
                        label: `${effectiveDuplicate.toLocaleString('da-DK')} duplikater` 
                      },
                      { 
                        value: skipped, 
                        className: "bg-yellow-300",
                        label: `${skipped} sprunget over (allerede i Shopify)` 
                      },
                      { 
                        value: effectiveFailed, 
                        className: "bg-destructive",
                        label: `${effectiveFailed.toLocaleString('da-DK')} fejlet` 
                      },
                    ]}
                  />
                )}
              </div>
            );
          })}

          {isUploading && (
            <div className="pt-4 border-t space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Total: {fixedTotalUploaded.toLocaleString('da-DK')} / {fixedTotalItems.toLocaleString('da-DK')}
                </span>
                <div className="flex items-center gap-3">
                  {totalSkipped > 0 && (
                    <button 
                      onClick={() => setShowSkippedProducts(true)}
                      className="text-amber-600 hover:text-amber-700 hover:underline cursor-pointer"
                    >
                      {totalSkipped} sprunget over
                    </button>
                  )}
                  {totalErrors > 0 && (
                    <span className="text-destructive">{totalErrors} fejl</span>
                  )}
                </div>
              </div>
              
            </div>
          )}


          {/* Summary when not uploading */}
          {!isUploading && fixedTotalItems > 0 && (
            <div className="pt-4 border-t">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Total: {fixedTotalItems.toLocaleString('da-DK')} elementer
                </span>
                <div className="flex items-center gap-3">
                  {fixedTotalUploaded > 0 && (
                    <span className="text-green-600">{fixedTotalUploaded.toLocaleString('da-DK')} uploadet</span>
                  )}
                  {fixedTotalPending > 0 && (
                    <span className="text-muted-foreground">{fixedTotalPending.toLocaleString('da-DK')} pending</span>
                  )}
                  {fixedTotalFailed > 0 && (
                    <span className="text-destructive">{fixedTotalFailed.toLocaleString('da-DK')} fejlet</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="flex justify-end gap-3">
        {/* Show Test + Start buttons when not uploading and not fully completed */}
        {!isUploading && !allCompleted && !isPreparing && (
          <>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" onClick={() => handleStartUpload(true)} disabled={isStarting}>
                    <FlaskConical className="w-4 h-4 mr-2" />
                    Test
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="font-medium mb-1">Test upload</p>
                  <p className="text-sm text-muted-foreground">
                    Uploader kun 3 af hver kategori til Shopify for at teste at alt virker korrekt
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Button onClick={() => handleStartUpload(false)} disabled={isStarting}>
              {isStarting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              Start upload
            </Button>
          </>
        )}

        {/* Show preparing spinner */}
        {isPreparing && (
          <Button disabled className="min-w-[200px]">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Forbereder produkter...
          </Button>
        )}

        {/* Show retry button when there are failed items and not currently uploading */}
        {hasFailed && !isUploading && !allCompleted && (
          <Button onClick={handleRetry} variant="outline">
            <RotateCcw className="w-4 h-4 mr-2" />
            Prøv igen
          </Button>
        )}

        {/* Show pause/stop only while actively uploading and NOT completed */}
        {isUploading && !allCompleted && (
          <>
            <Button variant="outline" onClick={handlePauseResume}>
              {isPaused ? (
                <>
                  <Play className="w-4 h-4 mr-2" />
                  Fortsæt
                </>
              ) : (
                <>
                  <Pause className="w-4 h-4 mr-2" />
                  Pause
                </>
              )}
            </Button>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      onClick={handleForceRestart}
                      disabled={isForceRestarting}
                    >
                      <RefreshCw className={`w-4 h-4 mr-2 ${isForceRestarting ? 'animate-spin' : ''}`} />
                      {isForceRestarting ? 'Genstarter…' : 'Genstart'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="font-medium mb-1">Force genstart</p>
                  <p className="text-sm text-muted-foreground">
                    Nulstiller rate limit cooldown og genstarter upload hvis den er gået i stå
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Button variant="destructive" onClick={handleCancel}>
              <CloudOff className="w-4 h-4 mr-2" />
              Stop
            </Button>
          </>
        )}

        {/* When ALL entity types are 100% uploaded (no pending): show "Start igen" and "Videre" */}
        {allCompleted && (
          <>
            <Button variant="outline" onClick={() => handleStartUpload(false)}>
              <RotateCcw className="w-4 h-4 mr-2" />
              Start igen
            </Button>
            <Button onClick={onNext} className="bg-green-600 hover:bg-green-700">
              <ArrowRight className="w-4 h-4 mr-2" />
              Videre
            </Button>
          </>
        )}
      </div>


      {/* Skipped products section removed */}

      {/* Error and Skipped Report Section */}
      <UploadErrorReport 
        projectId={project.id}
        jobs={jobs.map(j => ({
          id: j.id,
          entity_type: j.entity_type,
          skipped_count: j.skipped_count,
          error_count: j.error_count,
          error_details: (j.error_details || []).filter(e => e.externalId !== '__worker__'),
        }))}
        statusCounts={statusCounts}
        onRetryFailed={handleRetryFailed}
        isRetrying={retryingEntityType}
        retryingIds={retryingIds}
      />

      {/* Skipped Products Dialog */}
      <SkippedProductsDialog
        open={showSkippedProducts}
        onOpenChange={setShowSkippedProducts}
        projectId={project.id}
        skippedCount={totalSkipped}
      />

      {/* Rejected Products Dialog */}
      <RejectedProductsDialog
        open={showRejectedProducts}
        onOpenChange={setShowRejectedProducts}
        projectId={project.id}
        rejectedCount={prepareResult?.rejected || 0}
      />

      {/* Duplicate Analysis Dialog */}
      <DuplicateAnalysisDialog
        open={showDuplicateAnalysis}
        onOpenChange={setShowDuplicateAnalysis}
        projectId={project.id}
        skippedCount={jobs.find(j => j.entity_type === 'products')?.skipped_count || 0}
      />

      {/* Reset Confirmation Dialog */}
      <AlertDialog open={resetDialog.open} onOpenChange={(open) => !open && setResetDialog({ open: false, entityType: null, scope: null, count: 0 })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Bekræft nulstilling</AlertDialogTitle>
            <AlertDialogDescription>
              Er du sikker på, at du vil nulstille {resetDialog.count.toLocaleString('da-DK')} {
                ENTITY_CONFIG.find(e => e.type === resetDialog.entityType)?.label.toLowerCase() || 'elementer'
              } til pending status?
              {(resetDialog.scope === 'uploaded' || resetDialog.scope === 'skipped') && (
                <span className="block mt-2 text-amber-600">
                  Bemærk: Dette vil fjerne Shopify ID'erne, så de vil blive uploadet igen som nye elementer.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuller</AlertDialogCancel>
            <AlertDialogAction onClick={handleResetConfirm}>
              Nulstil
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Prepare Confirmation Dialog - Two-Phase Upload */}
      <AlertDialog open={showPrepareConfirm} onOpenChange={(open) => !open && setShowPrepareConfirm(false)}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              Klar til upload
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                {prepareResult && (
                  <>
                    <div className="text-center py-4">
                      <div className="text-4xl font-bold text-primary mb-1">
                        {prepareResult.groups.toLocaleString('da-DK')}
                      </div>
                      <div className="text-muted-foreground">
                        produkter oprettes i Shopify
                      </div>
                    </div>
                    
                    <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Varianter i alt:</span>
                        <span className="font-medium text-foreground">{prepareResult.variants.toLocaleString('da-DK')}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Gns. varianter pr. produkt:</span>
                        <span className="font-medium text-foreground">
                          {prepareResult.groups > 0 
                            ? (prepareResult.variants / prepareResult.groups).toFixed(1).replace('.', ',')
                            : '–'}
                        </span>
                      </div>
                      {prepareResult.rejected > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowPrepareConfirm(false);
                            setShowRejectedProducts(true);
                          }}
                          className="flex justify-between text-sm text-destructive pt-1 border-t border-border/50 w-full hover:underline cursor-pointer"
                        >
                          <span>Afvist (klik for detaljer):</span>
                          <span className="font-medium">{prepareResult.rejected.toLocaleString('da-DK')}</span>
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel onClick={() => setShowPrepareConfirm(false)}>Annuller</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmAndStartUpload} className="bg-primary hover:bg-primary/90">
              <Play className="w-4 h-4 mr-2" />
              Start upload
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
