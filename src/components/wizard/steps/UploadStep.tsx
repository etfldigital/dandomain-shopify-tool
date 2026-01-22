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
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { Badge } from '@/components/ui/badge';
import { Project, EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { UploadErrorReport } from './UploadErrorReport';

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
const WATCHDOG_INTERVAL_MS = 60_000;

export function UploadStep({ project, onNext }: UploadStepProps) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [uiNow, setUiNow] = useState<number>(() => Date.now());
  
  // Countdown timer state for rate limit waits
  const [countdownEndTime, setCountdownEndTime] = useState<number | null>(null);
  const [countdownTotalSeconds, setCountdownTotalSeconds] = useState<number | null>(null);
  const [lastWorkerMessage, setLastWorkerMessage] = useState<string | null>(null);

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
    scope: 'all' | 'failed' | 'uploaded' | null;
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

  const handleStartUpload = async (isTestMode: boolean = false, singleEntityType?: EntityType) => {
    setIsStarting(true);
    try {
      const body: {
        projectId: string;
        action: string;
        isTestMode: boolean;
        entityTypes?: string[];
      } = {
        projectId: project.id,
        action: 'start',
        isTestMode,
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

  const handleResetRequest = (entityType: EntityType, scope: 'all' | 'failed' | 'uploaded') => {
    const counts = statusCounts[entityType];
    let count = 0;
    
    if (scope === 'all') {
      count = counts.pending + counts.uploaded + counts.failed;
    } else if (scope === 'failed') {
      count = counts.failed;
    } else if (scope === 'uploaded') {
      count = counts.uploaded;
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
  
  // Detect new rate limit message and start countdown
  const currentWorkerMessage = getLatestWorkerMessage(runningJob);
  useEffect(() => {
    if (currentWorkerMessage && currentWorkerMessage !== lastWorkerMessage) {
      setLastWorkerMessage(currentWorkerMessage);
      const parsedSeconds = getWaitingSeconds(runningJob);
      if (parsedSeconds && parsedSeconds > 0) {
        // Set countdown end time based on current time + wait seconds
        setCountdownEndTime(Date.now() + parsedSeconds * 1000);
        setCountdownTotalSeconds(parsedSeconds);
      }
    }
    // Reset countdown when job completes or no running job
    if (!runningJob) {
      setCountdownEndTime(null);
      setCountdownTotalSeconds(null);
      setLastWorkerMessage(null);
    }
  }, [currentWorkerMessage, lastWorkerMessage, runningJob]);
  
  // Calculate live countdown seconds
  const liveWaitingSeconds = countdownEndTime 
    ? Math.max(0, Math.ceil((countdownEndTime - uiNow) / 1000))
    : null;

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

  // Calculate overall speed and ETA
  const currentSpeed = runningJob?.items_per_minute || 0;

  const isRateLimited = Boolean(currentWorkerMessage && /rate limit|\b429\b/i.test(currentWorkerMessage));
  // If we're rate limited and waiting X seconds between batches, there is a hard throughput cap.
  const rateLimitSpeedCap =
    isRateLimited && countdownTotalSeconds != null && countdownTotalSeconds > 0
      ? ((runningJob?.batch_size ?? 1) * 60) / Math.max(1, countdownTotalSeconds)
      : null;
  const effectiveSpeed =
    rateLimitSpeedCap != null && rateLimitSpeedCap > 0
      ? Math.min(currentSpeed || 0, rateLimitSpeedCap)
      : currentSpeed;
  
  // Calculate remaining items across ALL pending and running jobs
  const totalRemainingItems = jobs
    .filter(j => j.status === 'running' || j.status === 'pending' || j.status === 'paused')
    .reduce((acc, j) => acc + Math.max(0, j.total_count - j.processed_count), 0);
  
  const etaMinutes = effectiveSpeed > 0 ? Math.ceil(totalRemainingItems / effectiveSpeed) : null;

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
    return `${speed.toFixed(1).replace('.', ',')} / min`;
  };

  const getHeartbeatStatus = (seconds: number) => {
    if (seconds > 60) {
      return { label: 'Afventer', color: 'bg-amber-500' };
    }
    return { label: 'Aktiv', color: 'bg-green-500' };
  };

  function getLatestWorkerMessage(job?: UploadJob): string | null {
    const details = job?.error_details || [];
    for (let i = details.length - 1; i >= 0; i--) {
      if (details[i]?.externalId === '__worker__' && details[i]?.message) {
        return details[i].message;
      }
    }
    return null;
  }

  function getWaitingSeconds(job?: UploadJob): number | null {
    const msg = getLatestWorkerMessage(job);
    if (!msg) return null;
    // Matches: "venter 30s" or "retry om 60s"
    const m = msg.match(/venter\s+(\d+)s/i) || msg.match(/retry\s+om\s+(\d+)s/i);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  // Get current activity message
  const getActivityMessage = () => {
    if (isStarting) return 'Starter upload…';
    if (!runningJob) return isPaused ? 'Paused' : '';
    const label = ENTITY_CONFIG.find(e => e.type === runningJob.entity_type)?.label || runningJob.entity_type;
    const workerMsg = getLatestWorkerMessage(runningJob);
    if (workerMsg && (workerMsg.includes('Rate limit') || workerMsg.includes('429'))) {
      return liveWaitingSeconds ? `${label}: venter pga. rate limit (${liveWaitingSeconds}s)…` : `${label}: venter pga. rate limit…`;
    }
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
                  <span className={`w-2 h-2 rounded-full ${getHeartbeatStatus(secondsSinceHeartbeat).color} animate-pulse`} />
                  <span className="text-sm">{getHeartbeatStatus(secondsSinceHeartbeat).label}</span>
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
                        <p>Aktuel upload-hastighed</p>
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
                          {isRateLimited ? 'mindst ' : '~'}{formatEta(etaMinutes)} tilbage
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{totalRemainingItems.toLocaleString('da-DK')} elementer tilbage</p>
                        {isRateLimited && liveWaitingSeconds != null && liveWaitingSeconds > 0 && (
                          <p className="text-muted-foreground mt-1">
                            Beregnet med rate limit (ca. {liveWaitingSeconds}s pause mellem batches)
                          </p>
                        )}
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
                    {/* Show speed for the currently running entity */}
                    {job?.status === 'running' && (
                      job.items_per_minute && job.items_per_minute > 0 ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-xs text-primary font-medium cursor-help flex items-center gap-1">
                                ⚡ {job.items_per_minute >= 100
                                  ? Math.round(job.items_per_minute)
                                  : job.items_per_minute.toFixed(1).replace('.', ',')} / min
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Aktuel hastighed for {label.toLowerCase()}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                          ⚡ beregner…
                        </span>
                      )
                    )}
                    {skipped > 0 && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="flex items-center gap-1 text-amber-600 text-sm cursor-help">
                              <SkipForward className="w-3 h-3" />
                              {skipped.toLocaleString('da-DK')} eksisterer allerede
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p className="font-medium mb-1">Skipped: Findes allerede i Shopify</p>
                            <p className="text-sm text-muted-foreground">
                              Disse {label.toLowerCase()} blev ikke oprettet igen, fordi de allerede eksisterer i Shopify 
                              (matchet på email, telefon eller andet unikt felt).
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
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
                        value: skipped, 
                        className: "bg-amber-500",
                        label: `${skipped} skipped` 
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
        {!isUploading && !allCompleted && (
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

      {/* Error and Skipped Report Section */}
      <UploadErrorReport 
        projectId={project.id}
        jobs={jobs.map(j => ({
          id: j.id,
          entity_type: j.entity_type,
          skipped_count: j.skipped_count,
          error_count: j.error_count,
          error_details: j.error_details,
        }))}
        statusCounts={statusCounts}
        onRetryFailed={handleRetryFailed}
        isRetrying={retryingEntityType}
        retryingIds={retryingIds}
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
              {resetDialog.scope === 'uploaded' && (
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
    </div>
  );
}
