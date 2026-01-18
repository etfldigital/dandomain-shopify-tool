import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { 
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { 
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
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
  XCircle,
  MoreVertical,
  Cloud,
  CloudOff,
  SkipForward,
  Store,
  FlaskConicalOff,
  Zap,
  PartyPopper,
  ArrowRight,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { Badge } from '@/components/ui/badge';
import { Project, EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

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

// Expected speed ranges for paid vs trial stores (items per minute)
const SPEED_THRESHOLDS: Record<EntityType, { trialMax: number; paidTypical: number }> = {
  orders: { trialMax: 5, paidTypical: 40 },      // Trial stores have ~1-2/min hard limit for orders
  customers: { trialMax: 10, paidTypical: 60 },  // Customers are slightly less restricted
  products: { trialMax: 15, paidTypical: 80 },   // Products can be faster
  categories: { trialMax: 20, paidTypical: 100 },
  pages: { trialMax: 20, paidTypical: 100 },
};

interface ShopTypeIndicatorProps {
  entityType: EntityType;
  itemsPerMinute: number;
}

function ShopTypeIndicator({ entityType, itemsPerMinute }: ShopTypeIndicatorProps) {
  const thresholds = SPEED_THRESHOLDS[entityType] || SPEED_THRESHOLDS.products;
  const isTrial = itemsPerMinute <= thresholds.trialMax;
  const entityLabel = ENTITY_CONFIG.find(e => e.type === entityType)?.label.toLowerCase() || entityType;
  
  if (isTrial) {
    return (
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/30">
            <FlaskConicalOff className="w-3 h-3 mr-1" />
            Trial butik
          </Badge>
          <span className="text-muted-foreground">
            Observeret hastighed: ~{itemsPerMinute.toFixed(1)} {entityLabel}/min
          </span>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-amber-600 cursor-help underline decoration-dotted">
                Hvorfor så langsomt?
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium mb-1">Hastighed = ikke kun "2 req/sek"</p>
              <p className="text-sm text-muted-foreground">
                2 requests/sek er en API-kald grænse. Én ordre kræver ofte flere API-kald (opslag af kunde/produkter + oprettelse)
                og hvis mange ordrer fejler validering, falder den effektive hastighed.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }
  
  return (
    <div className="flex items-center justify-between text-xs">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/30">
          <Zap className="w-3 h-3 mr-1" />
          Betalt butik
        </Badge>
        <span className="text-muted-foreground">
          Upload-hastighed: ~{itemsPerMinute.toFixed(1)} {entityLabel}/min
        </span>
      </div>
      <span className="text-green-600">
        Fuld hastighed
      </span>
    </div>
  );
}

export function UploadStep({ project, onNext }: UploadStepProps) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [uiNow, setUiNow] = useState<number>(() => Date.now());

  // Persistent shop type detection - once detected, stays visible
  const [detectedShopType, setDetectedShopType] = useState<{
    type: 'trial' | 'paid';
    entityType: EntityType;
    measuredSpeed: number;
  } | null>(null);

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
    
    return () => {
      window.clearInterval(uiTimer);
      window.clearInterval(pollTimer);
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

  const handleStartUpload = async (isTestMode: boolean = false) => {
    setIsStarting(true);
    try {
      const response = await supabase.functions.invoke('upload-worker', {
        body: {
          projectId: project.id,
          action: 'start',
          isTestMode,
        },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      toast.success(isTestMode 
        ? 'Test-upload startet i baggrunden' 
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
  const allCompleted = jobs.length > 0 && jobs.every(j => j.status === 'completed' || j.status === 'cancelled');
  const hasFailed = jobs.some(j => j.error_count > 0);
  const [hasCelebrated, setHasCelebrated] = useState(false);

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
    ? Math.floor((uiNow - new Date(runningJob.last_heartbeat_at).getTime()) / 1000)
    : 0;

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

  // Calculate totals from statusCounts (the source of truth from database)
  // This gives us fixed, accurate totals that don't change based on job iterations
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
  
  // Detect shop type based on upload speed - once detected, it persists
  useEffect(() => {
    if (runningJob && runningJob.items_per_minute && runningJob.items_per_minute > 0) {
      const thresholds = SPEED_THRESHOLDS[runningJob.entity_type] || SPEED_THRESHOLDS.products;
      const isTrial = runningJob.items_per_minute <= thresholds.trialMax;
      
      setDetectedShopType(prev => {
        // If we haven't detected yet, set initial detection
        if (!prev) {
          return {
            type: isTrial ? 'trial' : 'paid',
            entityType: runningJob.entity_type,
            measuredSpeed: runningJob.items_per_minute,
          };
        }
        // Update speed but keep the shop type decision
        return {
          ...prev,
          entityType: runningJob.entity_type,
          measuredSpeed: runningJob.items_per_minute,
        };
      });
    }
  }, [runningJob?.items_per_minute, runningJob?.entity_type]);
  
  // Calculate remaining items across ALL pending and running jobs
  const totalRemainingItems = jobs
    .filter(j => j.status === 'running' || j.status === 'pending' || j.status === 'paused')
    .reduce((acc, j) => acc + Math.max(0, j.total_count - j.processed_count), 0);
  
  const etaMinutes = currentSpeed > 0 ? Math.ceil(totalRemainingItems / currentSpeed) : null;

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

  const formatHeartbeat = (seconds: number) => {
    if (seconds >= 60) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}m ${secs}s siden`;
    }
    return `${seconds}s siden`;
  };

  // Get current activity message
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
                  <span className={`w-1.5 h-1.5 rounded-full ${secondsSinceHeartbeat > 60 ? 'bg-amber-500' : 'bg-green-500'} animate-pulse`} />
                  {formatHeartbeat(secondsSinceHeartbeat)}
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
                {(isUploading || job) && <Progress value={percent} className="h-2" />}
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

          {/* Persistent Shop Type Indicator - stays visible once detected */}
          {detectedShopType && (
            <div className="pt-4 border-t">
              <ShopTypeIndicator 
                entityType={detectedShopType.entityType}
                itemsPerMinute={detectedShopType.measuredSpeed}
              />
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
        {!isUploading && !allCompleted && !hasFailed && (
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

        {hasFailed && !isUploading && (
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

        {/* When completed: show "Start igen" and "Videre" */}
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

      {/* Skipped Details Section */}
      {totalSkipped > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <SkipForward className="w-5 h-5 text-amber-600" />
              Sprunget over ({totalSkipped})
            </CardTitle>
            <CardDescription>
              Disse elementer blev sprunget over under upload
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {ENTITY_CONFIG.map(({ type, label }) => {
                const job = getJobForEntity(type);
                const skippedCount = job?.skipped_count || 0;
                if (skippedCount === 0) return null;

                return (
                  <div key={type} className="border-l-2 border-amber-400/50 pl-3">
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                      {label}: {skippedCount.toLocaleString('da-DK')} sprunget over
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {type === 'products' && 'Produkter uden titel eller med titel "Untitled" blev sprunget over.'}
                      {type === 'customers' && 'Kunder der allerede eksisterede i Shopify blev linket i stedet for oprettet.'}
                      {type === 'orders' && 'Ordrer med ugyldige data blev sprunget over.'}
                      {type === 'categories' && 'Kategorier markeret som "exclude" blev sprunget over.'}
                      {type === 'pages' && 'Sider uden indhold blev sprunget over.'}
                    </p>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error Details Section */}
      {totalErrors > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-destructive" />
              Fejl under upload ({totalErrors})
            </CardTitle>
            <CardDescription>
              Disse elementer kunne ikke uploades til Shopify
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion type="multiple" className="w-full">
              {ENTITY_CONFIG.map(({ type, label }) => {
                const job = getJobForEntity(type);
                const errorDetails = job?.error_details || [];
                if (errorDetails.length === 0) return null;

                // Group errors by message
                const groupedErrors = errorDetails.reduce((acc, err) => {
                  const key = err.message;
                  if (!acc[key]) {
                    acc[key] = [];
                  }
                  acc[key].push(err.externalId);
                  return acc;
                }, {} as Record<string, string[]>);

                return (
                  <AccordionItem key={type} value={type}>
                    <AccordionTrigger className="text-left">
                      <div className="flex items-center gap-2">
                        <XCircle className="w-4 h-4 text-destructive" />
                        <span>{label}: {errorDetails.length} fejl</span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-4">
                        {Object.entries(groupedErrors).map(([message, ids]) => (
                          <div key={message} className="border-l-2 border-destructive/30 pl-3">
                            <p className="text-sm font-medium text-destructive mb-1">
                              {message}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {ids.length > 5 
                                ? `ID'er: ${ids.slice(0, 5).join(', ')} og ${ids.length - 5} flere.`
                                : `ID'er: ${ids.join(', ')}`
                              }
                            </p>
                          </div>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </CardContent>
        </Card>
      )}

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
