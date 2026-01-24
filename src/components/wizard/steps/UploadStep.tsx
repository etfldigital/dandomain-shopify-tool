import { useState, useEffect } from 'react';
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
import { Project, EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { UploadErrorReport } from './UploadErrorReport';
import { DuplicateAnalysisDialog } from './DuplicateAnalysisDialog';

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
}

const ENTITY_CONFIG: { type: EntityType; icon: typeof ShoppingBag; label: string }[] = [
  { type: 'pages', icon: FileSpreadsheet, label: 'Sider' },
  { type: 'categories', icon: Folder, label: 'Collections' },
  { type: 'products', icon: ShoppingBag, label: 'Produkter' },
  { type: 'customers', icon: Users, label: 'Kunder' },
  { type: 'orders', icon: FileText, label: 'Ordrer' },
];

// How often we run the backend watchdog to auto-restart stalled jobs.
// This is a safety net for cases where the worker's self-scheduling is interrupted.
const WATCHDOG_INTERVAL_MS = 20_000; // Run every 20 seconds for faster recovery

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
  
  // NEW: Two-phase upload state
  const [isPreparing, setIsPreparing] = useState(false);
  const [prepareResult, setPrepareResult] = useState<PrepareResult | null>(null);
  const [showPrepareConfirm, setShowPrepareConfirm] = useState(false);
  
  // Live speed tracking based on processed_count delta over time
  const [speedHistory, setSpeedHistory] = useState<{ timestamp: number; processed: number }[]>([]);

  // Status counts for each entity type (for the menu)
  const [statusCounts, setStatusCounts] = useState<Record<EntityType, StatusCounts>>({
    products: { pending: 0, uploaded: 0, failed: 0 },
    customers: { pending: 0, uploaded: 0, failed: 0 },
    orders: { pending: 0, uploaded: 0, failed: 0 },
    categories: { pending: 0, uploaded: 0, failed: 0 },
    pages: { pending: 0, uploaded: 0, failed: 0 },
  });

  // Reset confirmation dialog state
  const [resetDialog, setResetDialog] = useState<{
    open: boolean;
    entityType: EntityType | null;
    scope: 'all' | 'failed' | 'uploaded' | 'skipped' | null;
    count: number;
  }>({ open: false, entityType: null, scope: null, count: 0 });

  // Fetch status counts for all entity types
  const fetchStatusCounts = async (): Promise<Record<EntityType, StatusCounts>> => {
    const counts: Record<EntityType, StatusCounts> = {
      products: { pending: 0, uploaded: 0, failed: 0 },
      customers: { pending: 0, uploaded: 0, failed: 0 },
      orders: { pending: 0, uploaded: 0, failed: 0 },
      categories: { pending: 0, uploaded: 0, failed: 0 },
      pages: { pending: 0, uploaded: 0, failed: 0 },
    };

    // Products
    const { count: productPending } = await supabase.from('canonical_products').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'pending');
    const { count: productUploaded } = await supabase.from('canonical_products').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'uploaded');
    const { count: productFailed } = await supabase.from('canonical_products').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'failed');
    counts.products = { pending: productPending || 0, uploaded: productUploaded || 0, failed: productFailed || 0 };

    // Customers
    const { count: customerPending } = await supabase.from('canonical_customers').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'pending');
    const { count: customerUploaded } = await supabase.from('canonical_customers').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'uploaded');
    const { count: customerFailed } = await supabase.from('canonical_customers').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'failed');
    counts.customers = { pending: customerPending || 0, uploaded: customerUploaded || 0, failed: customerFailed || 0 };

    // Orders
    const { count: orderPending } = await supabase.from('canonical_orders').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'pending');
    const { count: orderUploaded } = await supabase.from('canonical_orders').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'uploaded');
    const { count: orderFailed } = await supabase.from('canonical_orders').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'failed');
    counts.orders = { pending: orderPending || 0, uploaded: orderUploaded || 0, failed: orderFailed || 0 };

    // Categories
    const { count: categoryPending } = await supabase.from('canonical_categories').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'pending');
    const { count: categoryUploaded } = await supabase.from('canonical_categories').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'uploaded');
    const { count: categoryFailed } = await supabase.from('canonical_categories').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'failed');
    counts.categories = { pending: categoryPending || 0, uploaded: categoryUploaded || 0, failed: categoryFailed || 0 };

    // Pages
    const { count: pagePending } = await supabase.from('canonical_pages').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'pending');
    const { count: pageUploaded } = await supabase.from('canonical_pages').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'uploaded');
    const { count: pageFailed } = await supabase.from('canonical_pages').select('*', { count: 'exact', head: true }).eq('project_id', project.id).eq('status', 'failed');
    counts.pages = { pending: pagePending || 0, uploaded: pageUploaded || 0, failed: pageFailed || 0 };

    setStatusCounts(counts);
    return counts;
  };

  // Subscribe to job updates via realtime
  useEffect(() => {
    // Initial fetch
    fetchJobs();
    fetchStatusCounts();

    // Subscribe to realtime updates
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
          console.log('Job update:', payload);
          if (payload.eventType === 'INSERT') {
            setJobs(prev => [...prev, toUploadJob(payload.new)]);
          } else if (payload.eventType === 'UPDATE') {
            const updated = toUploadJob(payload.new);
            setJobs(prev => prev.map(j => j.id === updated.id ? updated : j));
          } else if (payload.eventType === 'DELETE') {
            setJobs(prev => prev.filter(j => j.id !== (payload.old as { id: string }).id));
          }
          // Also refresh status counts periodically
          fetchStatusCounts();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [project.id]);

  // Heartbeat timer for UI updates + fallback polling
  useEffect(() => {
    const hasActiveJobs = jobs.some(j => j.status === 'running' || j.status === 'paused');
    if (!hasActiveJobs) return;
    
    // Update UI time every second for smooth animations
    const uiTimer = window.setInterval(() => setUiNow(Date.now()), 1000);
    
    // Fallback polling every 3 seconds for more frequent count updates
    const pollTimer = window.setInterval(() => {
      fetchJobs();
      fetchStatusCounts();
    }, 3000);

    // Safety net: regularly run watchdog to restart jobs if a batch gets stuck.
    const runWatchdog = async () => {
      try {
        const { error } = await supabase.functions.invoke('job-watchdog');
        if (error) throw error;
      } catch (e) {
        // Silent fail: watchdog is best-effort; polling + user controls still work.
        console.warn('[UploadStep] job-watchdog failed:', e);
      }
    };

    // Run once immediately (helps after tab refresh) and then on an interval.
    runWatchdog();
    const watchdogTimer = window.setInterval(runWatchdog, WATCHDOG_INTERVAL_MS);
    
    return () => {
      window.clearInterval(uiTimer);
      window.clearInterval(pollTimer);
      window.clearInterval(watchdogTimer);
    };
  }, [jobs]);

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
      const response = await supabase.functions.invoke('prepare-upload', {
        body: {
          projectId: project.id,
          entityType: 'products',
          previewOnly: false, // Actually commit the grouping
        },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const result = response.data;
      if (!result.success) {
        throw new Error(result.error || 'Forberedelse fejlede');
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
  const handleStartUploadInternal = async (isTestMode: boolean = false, singleEntityType?: EntityType) => {
    setIsStarting(true);
    try {
      const body: {
        projectId: string;
        action: string;
        isTestMode: boolean;
        entityTypes?: string[];
        skipPrepare?: boolean;
      } = {
        projectId: project.id,
        action: 'start',
        isTestMode,
        skipPrepare: true, // Products already prepared
      };
      
      // If a single entity type is specified, only upload that type
      if (singleEntityType) {
        body.entityTypes = [singleEntityType];
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
      
      // Refresh jobs
      await fetchJobs();
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
      count = counts.pending + counts.uploaded + counts.failed;
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
  const fixedTotalItems = Object.values(statusCounts).reduce(
    (acc, counts) => acc + counts.pending + counts.uploaded + counts.failed, 
    0
  );
  const fixedTotalUploaded = Object.values(statusCounts).reduce(
    (acc, counts) => acc + counts.uploaded, 
    0
  );
  const fixedTotalFailed = Object.values(statusCounts).reduce(
    (acc, counts) => acc + counts.failed, 
    0
  );
  const fixedTotalPending = Object.values(statusCounts).reduce(
    (acc, counts) => acc + counts.pending, 
    0
  );
  
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

  // Get current activity message - no "venter" text
  const getActivityMessage = () => {
    if (isStarting) return 'Starter upload…';
    if (!runningJob) return isPaused ? 'Paused' : '';
    const label = ENTITY_CONFIG.find(e => e.type === runningJob.entity_type)?.label || runningJob.entity_type;
    return `${label}: uploader batch ${runningJob.current_batch || 1}…`;
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

      {/* Background processing info banner - only show while actively uploading */}
      {isUploading && !allCompleted && (
        <Card className="border-primary/50 bg-primary/5">
          <CardContent className="pt-4">
            <div className="flex items-start gap-3">
              <Cloud className="w-5 h-5 text-primary mt-0.5" />
              <div>
                <p className="font-medium text-foreground">Upload kører i baggrunden</p>
                <p className="text-sm text-muted-foreground">
                  Du kan trygt lukke browseren – upload fortsætter automatisk på serveren.
                </p>
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
          {/* Only show live stats while actively uploading, NOT when completed */}
          {(isUploading || isStarting) && !allCompleted && (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                <span className="font-medium text-foreground">{getActivityMessage()}</span>
              </div>
              <div className="flex items-center gap-4 text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${secondsSinceHeartbeat > 60 ? 'bg-amber-500' : 'bg-green-500'} animate-pulse`} />
                  <span className="text-sm">{secondsSinceHeartbeat > 60 ? 'Synkroniserer' : 'Aktiv'}</span>
                </span>
                {currentSpeed > 0 ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-primary font-medium cursor-help flex items-center gap-1">
                          ⚡ {formatSpeed(currentSpeed)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{liveSpeed ? 'Live hastighed (sidste 60 sek)' : 'Seneste batch-hastighed'}</p>
                        {runningJob?.last_batch_items && runningJob?.last_batch_duration_ms && (
                          <p className="text-muted-foreground text-xs mt-1">
                            {runningJob.last_batch_items} items på {Math.round(runningJob.last_batch_duration_ms / 1000)}s
                          </p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <span className="text-muted-foreground font-medium flex items-center gap-1">
                    ⚡ beregner…
                  </span>
                )}
                {etaMinutes != null && totalRemainingItems > 0 && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="bg-muted px-2 py-0.5 rounded-md font-medium cursor-help">
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
            const totalFromDb = counts.pending + counts.uploaded + counts.failed;
            const skipped = job?.skipped_count || 0;
            const errors = counts.failed; // Use DB failed count, not job error_count
            
            // CRITICAL: Progress is based on database state
            // - Processed = uploaded + failed (items no longer pending)
            // - Total = all items in database + skipped (for percentage calculation)
            const processedFromDb = counts.uploaded + counts.failed;
            const total = totalFromDb + skipped;
            const processedActual = processedFromDb + skipped;
            
            // Live estimation for smooth UI during uploads
            const processedLive = job && job.status === 'running' 
              ? getLiveProcessedCount(job, processedActual)
              : processedActual;
            const isEstimated = Boolean(job && job.status === 'running' && processedLive !== processedActual);
            
            // CRITICAL: Job is ONLY complete when pending = 0
            // This ensures the progress bar reaches 100% before showing green checkmark
            const isComplete = counts.pending === 0 && total > 0;
            const status = isComplete 
              ? 'completed' 
              : job?.status || (counts.pending === 0 && total > 0 ? 'completed' : 'pending');

            // Progress percentage: when pending=0, this will be 100%
            const percent = total > 0 ? (processedActual / total) * 100 : 0;

            return (
              <div key={type} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                      status === 'completed' ? 'bg-green-100 dark:bg-green-900' :
                      status === 'failed' ? 'bg-destructive/10' :
                      status === 'running' ? 'bg-primary/10' :
                      status === 'paused' ? 'bg-amber-100 dark:bg-amber-900' :
                      'bg-muted'
                    }`}>
                      {status === 'completed' ? (
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
                      {!isUploading && totalFromDb > 0 && (
                        <div className="text-xs text-muted-foreground flex gap-2">
                          {counts.pending > 0 && <span>{counts.pending} pending</span>}
                          {counts.uploaded > 0 && <span className="text-green-600">{counts.uploaded} uploadet</span>}
                          {counts.failed > 0 && <span className="text-destructive">{counts.failed} fejlet</span>}
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
                          <DropdownMenuItem 
                            onClick={() => handleStartUpload(true, type)}
                            disabled={counts.pending === 0 || isStarting}
                          >
                            <FlaskConical className="w-4 h-4 mr-2" />
                            Test upload (3 stk)
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => handleResetRequest(type, 'all')}
                            disabled={totalFromDb === 0}
                          >
                            <RotateCcw className="w-4 h-4 mr-2" />
                            Nulstil alle til pending
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => handleResetRequest(type, 'failed')}
                            disabled={counts.failed === 0}
                          >
                            <AlertCircle className="w-4 h-4 mr-2" />
                            Nulstil fejlede ({counts.failed})
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={() => handleResetRequest(type, 'uploaded')}
                            disabled={counts.uploaded === 0}
                          >
                            <CheckCircle2 className="w-4 h-4 mr-2" />
                            Nulstil uploadede ({counts.uploaded})
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
                {(isUploading || job || totalFromDb > 0) && (
                  <MultiProgress 
                    className="h-2"
                    total={total}
                    segments={[
                      { 
                        value: counts.uploaded, 
                        className: "bg-primary",
                        label: `${counts.uploaded} uploadet` 
                      },
                      { 
                        value: counts.failed, 
                        className: "bg-destructive",
                        label: `${counts.failed} fejlet` 
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
                    <span className="text-amber-600">{totalSkipped} eksisterende (skipped)</span>
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
                    
                    {(prepareResult.variants > prepareResult.groups || prepareResult.rejected > 0) && (
                      <div className="bg-muted/50 rounded-lg p-3 text-sm space-y-1.5">
                        {prepareResult.variants > prepareResult.groups && (
                          <div className="flex items-start gap-2">
                            <span className="text-muted-foreground">•</span>
                            <span>
                              <span className="font-medium">{(prepareResult.variants - prepareResult.groups).toLocaleString('da-DK')}</span> størrelsesvarianter grupperes under disse produkter
                            </span>
                          </div>
                        )}
                        {prepareResult.rejected > 0 && (
                          <div className="flex items-start gap-2 text-amber-600">
                            <span>•</span>
                            <span>
                              <span className="font-medium">{prepareResult.rejected.toLocaleString('da-DK')}</span> rækker springes over (manglende data)
                            </span>
                          </div>
                        )}
                      </div>
                    )}
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
