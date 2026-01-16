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
} from 'lucide-react';
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
  error_details: ErrorDetail[] | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  current_batch: number;
  last_heartbeat_at: string | null;
  is_test_mode: boolean;
}

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

export function UploadStep({ project, onUpdateProject, onNext }: UploadStepProps) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [uiNow, setUiNow] = useState<number>(() => Date.now());

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
            setJobs(prev => [...prev, payload.new as UploadJob]);
          } else if (payload.eventType === 'UPDATE') {
            setJobs(prev => prev.map(j => j.id === payload.new.id ? payload.new as UploadJob : j));
          } else if (payload.eventType === 'DELETE') {
            setJobs(prev => prev.filter(j => j.id !== payload.old.id));
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

  // Heartbeat timer for UI updates
  useEffect(() => {
    const hasActiveJobs = jobs.some(j => j.status === 'running' || j.status === 'paused');
    if (!hasActiveJobs) return;
    
    const id = window.setInterval(() => setUiNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [jobs]);

  const fetchJobs = async () => {
    const { data } = await supabase
      .from('upload_jobs')
      .select('*')
      .eq('project_id', project.id)
      .order('created_at', { ascending: true });
    
    if (data) {
      setJobs(data as unknown as UploadJob[]);
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
    const entityTypes: EntityType[] = ['products', 'customers', 'orders', 'categories', 'pages'];
    
    for (const entityType of entityTypes) {
      if (entityType === 'products') {
        await supabase.from('canonical_products').update({ status: 'pending' as const, error_message: null }).eq('project_id', project.id).eq('status', 'failed');
      } else if (entityType === 'customers') {
        await supabase.from('canonical_customers').update({ status: 'pending' as const, error_message: null }).eq('project_id', project.id).eq('status', 'failed');
      } else if (entityType === 'orders') {
        await supabase.from('canonical_orders').update({ status: 'pending' as const, error_message: null }).eq('project_id', project.id).eq('status', 'failed');
      } else if (entityType === 'categories') {
        await supabase.from('canonical_categories').update({ status: 'pending' as const, error_message: null }).eq('project_id', project.id).eq('status', 'failed');
      } else if (entityType === 'pages') {
        await supabase.from('canonical_pages').update({ status: 'pending' as const, error_message: null }).eq('project_id', project.id).eq('status', 'failed');
      }
    }

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
  
  const runningJob = jobs.find(j => j.status === 'running');
  const secondsSinceHeartbeat = runningJob?.last_heartbeat_at 
    ? Math.floor((uiNow - new Date(runningJob.last_heartbeat_at).getTime()) / 1000)
    : 0;

  const totalProcessed = jobs.reduce((acc, j) => acc + j.processed_count, 0);
  const totalItems = jobs.reduce((acc, j) => acc + j.total_count, 0);
  const totalErrors = jobs.reduce((acc, j) => acc + j.error_count, 0);
  const totalSkipped = jobs.reduce((acc, j) => acc + j.skipped_count, 0);

  // Get progress for each entity type
  const getJobForEntity = (entityType: EntityType) => jobs.find(j => j.entity_type === entityType);

  // Calculate ETA for running job
  const currentSpeed = runningJob?.items_per_minute || 0;
  const currentRemaining = runningJob ? runningJob.total_count - runningJob.processed_count : 0;
  const etaMinutes = currentSpeed > 0 ? Math.ceil(currentRemaining / currentSpeed) : null;

  const formatEta = (minutes: number) => {
    if (minutes >= 90) {
      const hours = minutes / 60;
      return `${hours.toFixed(1).replace('.', ',')} timer`;
    }
    return `${minutes.toLocaleString('da-DK')} min`;
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

      {/* Background processing info banner */}
      {isUploading && (
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
            Data uploades i rækkefølgen: Sider → Collections → Produkter → Kunder → Ordrer
          </CardDescription>
          {(isUploading || isStarting) && (
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
                {currentSpeed > 0 && (
                  <span className="text-primary font-medium">
                    {currentSpeed.toFixed(1).replace('.', ',')} / min
                  </span>
                )}
                {etaMinutes != null && (
                  <span className="bg-muted px-2 py-0.5 rounded-md font-medium">
                    ~{formatEta(etaMinutes)} tilbage
                  </span>
                )}
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {ENTITY_CONFIG.map(({ type, icon: Icon, label }) => {
            const job = getJobForEntity(type);
            const counts = statusCounts[type];
            const totalCount = counts.pending + counts.uploaded + counts.failed;
            
            // Use job data if available, otherwise show status counts
            const processed = job?.processed_count || counts.uploaded;
            const total = job?.total_count || totalCount;
            const errors = job?.error_count || 0;
            const skipped = job?.skipped_count || 0;
            const status = job?.status || (counts.uploaded === totalCount && totalCount > 0 ? 'completed' : 'pending');
            
            const percent = total > 0 ? (processed / total) * 100 : 0;

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
                      {!isUploading && totalCount > 0 && (
                        <div className="text-xs text-muted-foreground flex gap-2">
                          {counts.pending > 0 && <span>{counts.pending} pending</span>}
                          {counts.uploaded > 0 && <span className="text-green-600">{counts.uploaded} uploadet</span>}
                          {counts.failed > 0 && <span className="text-destructive">{counts.failed} fejlet</span>}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {skipped > 0 && (
                      <span className="flex items-center gap-1 text-amber-600 text-sm">
                        {skipped} skipped
                      </span>
                    )}
                    {errors > 0 && (
                      <span className="flex items-center gap-1 text-destructive text-sm">
                        <AlertCircle className="w-3 h-3" />
                        {errors} fejl
                      </span>
                    )}
                    {isUploading && job && (
                      <span className="text-sm text-muted-foreground">
                        <span className="text-green-600 font-medium">{processed.toLocaleString('da-DK')}</span>
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
                            disabled={totalCount === 0}
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
            <div className="pt-4 border-t">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Total: {totalProcessed.toLocaleString('da-DK')} / {totalItems.toLocaleString('da-DK')}
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

        {isUploading && (
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

        {allCompleted && (
          <Button onClick={onNext}>
            Se rapport
          </Button>
        )}
      </div>

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
