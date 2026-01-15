import { useState, useRef, useEffect } from 'react';
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

interface UploadProgress {
  entityType: EntityType;
  status: 'pending' | 'running' | 'completed' | 'failed';
  processed: number;
  total: number;
  errors: number;
  skipped: number;
  errorDetails: ErrorDetail[];
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
  const [uploading, setUploading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const pausedRef = useRef(false);
  const [progress, setProgress] = useState<UploadProgress[]>(
    ENTITY_CONFIG.map(e => ({
      entityType: e.type,
      status: 'pending',
      processed: 0,
      total: 0,
      errors: 0,
      skipped: 0,
      errorDetails: [],
    }))
  );

  // Status counts for each entity type
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
  const fetchStatusCounts = async () => {
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
  };

  useEffect(() => {
    fetchStatusCounts();
  }, [project.id]);

  const getCounts = async () => {
    const counts: Record<EntityType, number> = {
      products: 0,
      customers: 0,
      orders: 0,
      categories: 0,
      pages: 0,
    };

    const { count: productCount } = await supabase
      .from('canonical_products')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'pending');
    counts.products = productCount || 0;

    const { count: customerCount } = await supabase
      .from('canonical_customers')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'pending');
    counts.customers = customerCount || 0;

    const { count: orderCount } = await supabase
      .from('canonical_orders')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'pending');
    counts.orders = orderCount || 0;

    const { count: categoryCount } = await supabase
      .from('canonical_categories')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'pending')
      .eq('exclude', false);
    counts.categories = categoryCount || 0;

    const { count: pageCount } = await supabase
      .from('canonical_pages')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'pending');
    counts.pages = pageCount || 0;

    return counts;
  };

  const uploadEntityBatch = async (entityType: EntityType, isTestMode: boolean): Promise<{ processed: number; errors: number; skipped: number; hasMore: boolean; errorDetails?: ErrorDetail[] }> => {
    const response = await supabase.functions.invoke('shopify-upload', {
      body: {
        projectId: project.id,
        entityType,
        batchSize: isTestMode ? 3 : 50,
      },
    });

    if (response.error) {
      throw new Error(response.error.message || 'Upload failed');
    }

    return {
      processed: response.data.processed || 0,
      errors: response.data.errors || 0,
      skipped: response.data.skipped || 0,
      // In test mode, never fetch more
      hasMore: isTestMode ? false : (response.data.hasMore || false),
      errorDetails: response.data.errorDetails || [],
    };
  };

  const uploadEntity = async (entityType: EntityType, total: number, isTestMode: boolean) => {
    // Update status to running
    const displayTotal = isTestMode ? Math.min(total, 3) : total;
    setProgress(prev => prev.map(p => 
      p.entityType === entityType ? { ...p, status: 'running', total: displayTotal, errorDetails: [], skipped: 0 } : p
    ));

    let totalProcessed = 0;
    let totalErrors = 0;
    let totalSkipped = 0;
    let allErrorDetails: ErrorDetail[] = [];
    let hasMore = true;

    while (hasMore) {
      // Check if paused
      while (pausedRef.current) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      try {
        const result = await uploadEntityBatch(entityType, isTestMode);
        totalProcessed += result.processed;
        totalErrors += result.errors;
        totalSkipped += result.skipped;
        hasMore = result.hasMore;
        
        // Collect error details from the batch
        if (result.errorDetails && result.errorDetails.length > 0) {
          allErrorDetails = [...allErrorDetails, ...result.errorDetails];
        }

        // Ensure processed count never exceeds total
        const cappedProcessed = Math.min(totalProcessed, displayTotal);
        setProgress(prev => prev.map(p => 
          p.entityType === entityType 
            ? { ...p, processed: cappedProcessed, errors: totalErrors, skipped: totalSkipped, errorDetails: allErrorDetails } 
            : p
        ));

        // Refresh status counts after each batch for real-time updates
        await fetchStatusCounts();

        // Small delay between batches to avoid rate limiting
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(`Error uploading ${entityType}:`, error);
        toast.error(`Fejl ved upload af ${entityType}: ${error instanceof Error ? error.message : 'Ukendt fejl'}`);
        
        setProgress(prev => prev.map(p => 
          p.entityType === entityType 
            ? { ...p, status: 'failed' } 
            : p
        ));
        return;
      }
    }

    // Mark as completed
    setProgress(prev => prev.map(p => 
      p.entityType === entityType 
        ? { ...p, status: totalErrors > 0 ? 'completed' : 'completed' } 
        : p
    ));
  };

  const handleStartUpload = async (isTestMode: boolean = false) => {
    setUploading(true);
    setTestMode(isTestMode);
    pausedRef.current = false;
    setPaused(false);
    
    await onUpdateProject({ status: 'migrating' });

    const counts = await getCounts();

    // In test mode, limit to 3 of each type
    const effectiveCounts = isTestMode 
      ? Object.fromEntries(
          Object.entries(counts).map(([key, value]) => [key, Math.min(value, 3)])
        ) as Record<EntityType, number>
      : counts;

    // Update totals
    setProgress(prev => prev.map(p => ({
      ...p,
      total: effectiveCounts[p.entityType],
      processed: 0,
      errors: 0,
      skipped: 0,
      status: 'pending',
      errorDetails: [],
    })));

    if (isTestMode) {
      toast.info('Test-tilstand: Uploader kun 3 af hver type');
    }

    // Process in order: Pages → Collections → Products → Customers → Orders
    for (const entity of ENTITY_CONFIG) {
      if (effectiveCounts[entity.type] > 0) {
        await uploadEntity(entity.type, effectiveCounts[entity.type], isTestMode);
        
        // In test mode, stop after processing 3
        if (isTestMode) {
          // The uploadEntityBatch already handles limiting, but we update the display
          setProgress(prev => prev.map(p => 
            p.entityType === entity.type 
              ? { ...p, status: 'completed', processed: Math.min(p.processed, 3) } 
              : p
          ));
        }
      } else {
        setProgress(prev => prev.map(p => 
          p.entityType === entity.type ? { ...p, status: 'completed' } : p
        ));
      }
    }

    if (!isTestMode) {
      await onUpdateProject({ status: 'completed' });
    }
    setUploading(false);
    await fetchStatusCounts();
    toast.success(isTestMode ? 'Test upload gennemført!' : 'Upload til Shopify gennemført!');
  };

  const handlePauseToggle = () => {
    pausedRef.current = !pausedRef.current;
    setPaused(!paused);
  };

  const handleRetry = async () => {
    // Reset failed items to pending for each entity type
    const failedEntities = progress.filter(p => p.status === 'failed');
    
    for (const entity of failedEntities) {
      const updates = { status: 'pending' as const, error_message: null };
      const filters = { project_id: project.id, status: 'failed' as const };
      
      switch (entity.entityType) {
        case 'products':
          await supabase.from('canonical_products').update(updates).match(filters);
          break;
        case 'customers':
          await supabase.from('canonical_customers').update(updates).match(filters);
          break;
        case 'orders':
          await supabase.from('canonical_orders').update(updates).match(filters);
          break;
        case 'categories':
          await supabase.from('canonical_categories').update(updates).match(filters);
          break;
        case 'pages':
          await supabase.from('canonical_pages').update(updates).match(filters);
          break;
      }
    }

    // Restart upload
    handleStartUpload();
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
      
      // Refresh status counts
      await fetchStatusCounts();
    } catch (error) {
      console.error('Reset error:', error);
      toast.error(`Fejl ved nulstilling: ${error instanceof Error ? error.message : 'Ukendt fejl'}`);
    } finally {
      setResetDialog({ open: false, entityType: null, scope: null, count: 0 });
    }
  };

  const allCompleted = progress.every(p => p.status === 'completed');
  const hasFailed = progress.some(p => p.status === 'failed');
  const totalProcessed = progress.reduce((acc, p) => acc + p.processed, 0);
  const totalItems = progress.reduce((acc, p) => acc + p.total, 0);
  const totalErrors = progress.reduce((acc, p) => acc + p.errors, 0);
  const totalSkipped = progress.reduce((acc, p) => acc + p.skipped, 0);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-semibold mb-2">Upload til Shopify</h2>
        <p className="text-muted-foreground">
          Overfør dine data til Shopify i den optimale rækkefølge
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Upload Progress</CardTitle>
          <CardDescription>
            Data uploades i rækkefølgen: Sider → Collections → Produkter → Kunder → Ordrer
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {ENTITY_CONFIG.map(({ type, icon: Icon, label }) => {
            const p = progress.find(p => p.entityType === type)!;
            const counts = statusCounts[type];
            const percent = p.total > 0 ? (p.processed / p.total) * 100 : 0;
            const totalCount = counts.pending + counts.uploaded + counts.failed;

            return (
              <div key={type} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                      p.status === 'completed' ? 'bg-green-100 dark:bg-green-900' :
                      p.status === 'failed' ? 'bg-destructive/10' :
                      p.status === 'running' ? 'bg-primary/10' :
                      'bg-muted'
                    }`}>
                      {p.status === 'completed' ? (
                        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400" />
                      ) : p.status === 'failed' ? (
                        <AlertCircle className="w-4 h-4 text-destructive" />
                      ) : p.status === 'running' ? (
                        paused ? (
                          <Pause className="w-4 h-4 text-primary" />
                        ) : (
                          <Loader2 className="w-4 h-4 text-primary animate-spin" />
                        )
                      ) : (
                        <Icon className="w-4 h-4 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <span className="font-medium">{label}</span>
                      {!uploading && totalCount > 0 && (
                        <div className="text-xs text-muted-foreground flex gap-2">
                          {counts.pending > 0 && <span>{counts.pending} pending</span>}
                          {counts.uploaded > 0 && <span className="text-green-600">{counts.uploaded} uploadet</span>}
                          {counts.failed > 0 && <span className="text-destructive">{counts.failed} fejlet</span>}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.skipped > 0 && (
                      <span className="flex items-center gap-1 text-amber-600 text-sm">
                        {p.skipped} skipped
                      </span>
                    )}
                    {p.errors > 0 && (
                      <span className="flex items-center gap-1 text-destructive text-sm">
                        <AlertCircle className="w-3 h-3" />
                        {p.errors} fejl
                      </span>
                    )}
                    {uploading && (
                      <span className="text-sm text-muted-foreground">
                        {p.processed.toLocaleString('da-DK')} / {p.total.toLocaleString('da-DK')}
                      </span>
                    )}
                    {!uploading && (
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
                {uploading && <Progress value={percent} className="h-2" />}
              </div>
            );
          })}

          {uploading && (
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

      {/* Action Buttons - between progress and error explanation */}
      <div className="flex justify-end gap-3">
        {!uploading && !allCompleted && !hasFailed && (
          <>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" onClick={() => handleStartUpload(true)}>
                    <FlaskConical className="w-4 h-4 mr-2" />
                    Test
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="font-medium mb-1">Test upload</p>
                  <p className="text-sm text-muted-foreground">
                    Uploader kun 3 af hver kategori til Shopify for at teste at alt virker korrekt:
                  </p>
                  <ul className="text-sm text-muted-foreground mt-1 list-disc list-inside">
                    <li>3 produkter</li>
                    <li>3 collections</li>
                    <li>3 kunder</li>
                    <li>3 ordrer</li>
                  </ul>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Button onClick={() => handleStartUpload(false)}>
              <Play className="w-4 h-4 mr-2" />
              Start upload
            </Button>
          </>
        )}

        {hasFailed && !uploading && (
          <Button onClick={handleRetry} variant="outline">
            <RotateCcw className="w-4 h-4 mr-2" />
            Prøv igen
          </Button>
        )}

        {uploading && (
          <Button variant="outline" onClick={handlePauseToggle}>
            {paused ? (
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
        )}

        {allCompleted && (
          <Button onClick={onNext}>
            Se rapport
          </Button>
        )}
      </div>

      {/* Error Details Section - Only show if there are actual errors */}
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
                const p = progress.find(p => p.entityType === type)!;
                if (p.errorDetails.length === 0) return null;

                // Group errors by message
                const groupedErrors = p.errorDetails.reduce((acc, err) => {
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
                        <span>{label}: {p.errorDetails.length} fejl</span>
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
