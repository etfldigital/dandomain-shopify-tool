import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
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
  RotateCcw
} from 'lucide-react';
import { Project, EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface UploadStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

interface UploadProgress {
  entityType: EntityType;
  status: 'pending' | 'running' | 'completed' | 'failed';
  processed: number;
  total: number;
  errors: number;
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
  const pausedRef = useRef(false);
  const [progress, setProgress] = useState<UploadProgress[]>(
    ENTITY_CONFIG.map(e => ({
      entityType: e.type,
      status: 'pending',
      processed: 0,
      total: 0,
      errors: 0,
    }))
  );

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

  const uploadEntityBatch = async (entityType: EntityType): Promise<{ processed: number; errors: number; hasMore: boolean }> => {
    const response = await supabase.functions.invoke('shopify-upload', {
      body: {
        projectId: project.id,
        entityType,
        batchSize: 50,
      },
    });

    if (response.error) {
      throw new Error(response.error.message || 'Upload failed');
    }

    return {
      processed: response.data.processed || 0,
      errors: response.data.errors || 0,
      hasMore: response.data.hasMore || false,
    };
  };

  const uploadEntity = async (entityType: EntityType, total: number) => {
    // Update status to running
    setProgress(prev => prev.map(p => 
      p.entityType === entityType ? { ...p, status: 'running', total } : p
    ));

    let totalProcessed = 0;
    let totalErrors = 0;
    let hasMore = true;

    while (hasMore) {
      // Check if paused
      while (pausedRef.current) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      try {
        const result = await uploadEntityBatch(entityType);
        totalProcessed += result.processed;
        totalErrors += result.errors;
        hasMore = result.hasMore;

        setProgress(prev => prev.map(p => 
          p.entityType === entityType 
            ? { ...p, processed: totalProcessed, errors: totalErrors } 
            : p
        ));

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

  const handleStartUpload = async () => {
    setUploading(true);
    pausedRef.current = false;
    setPaused(false);
    
    await onUpdateProject({ status: 'migrating' });

    const counts = await getCounts();

    // Update totals
    setProgress(prev => prev.map(p => ({
      ...p,
      total: counts[p.entityType],
      processed: 0,
      errors: 0,
      status: 'pending',
    })));

    // Process in order: Pages → Collections → Products → Customers → Orders
    for (const entity of ENTITY_CONFIG) {
      if (counts[entity.type] > 0) {
        await uploadEntity(entity.type, counts[entity.type]);
      } else {
        setProgress(prev => prev.map(p => 
          p.entityType === entity.type ? { ...p, status: 'completed' } : p
        ));
      }
    }

    await onUpdateProject({ status: 'completed' });
    setUploading(false);
    toast.success('Upload til Shopify gennemført!');
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

  const allCompleted = progress.every(p => p.status === 'completed');
  const hasFailed = progress.some(p => p.status === 'failed');
  const totalProcessed = progress.reduce((acc, p) => acc + p.processed, 0);
  const totalItems = progress.reduce((acc, p) => acc + p.total, 0);
  const totalErrors = progress.reduce((acc, p) => acc + p.errors, 0);

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
            const percent = p.total > 0 ? (p.processed / p.total) * 100 : 0;

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
                        <Loader2 className="w-4 h-4 text-primary animate-spin" />
                      ) : (
                        <Icon className="w-4 h-4 text-muted-foreground" />
                      )}
                    </div>
                    <span className="font-medium">{label}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    {p.errors > 0 && (
                      <span className="flex items-center gap-1 text-destructive">
                        <AlertCircle className="w-3 h-3" />
                        {p.errors} fejl
                      </span>
                    )}
                    <span>{p.processed.toLocaleString('da-DK')} / {p.total.toLocaleString('da-DK')}</span>
                  </div>
                </div>
                <Progress value={percent} className="h-2" />
              </div>
            );
          })}

          {uploading && (
            <div className="pt-4 border-t">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Total: {totalProcessed.toLocaleString('da-DK')} / {totalItems.toLocaleString('da-DK')}
                </span>
                {totalErrors > 0 && (
                  <span className="text-destructive">{totalErrors} fejl i alt</span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3 pt-4">
        {!uploading && !allCompleted && !hasFailed && (
          <Button onClick={handleStartUpload}>
            <Play className="w-4 h-4 mr-2" />
            Start upload
          </Button>
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
    </div>
  );
}
