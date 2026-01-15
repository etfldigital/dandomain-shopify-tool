import { useState } from 'react';
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
  Pause
} from 'lucide-react';
import { Project, EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';

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
      .eq('project_id', project.id);
    counts.products = productCount || 0;

    const { count: customerCount } = await supabase
      .from('canonical_customers')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);
    counts.customers = customerCount || 0;

    const { count: orderCount } = await supabase
      .from('canonical_orders')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);
    counts.orders = orderCount || 0;

    const { count: categoryCount } = await supabase
      .from('canonical_categories')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('exclude', false);
    counts.categories = categoryCount || 0;

    const { count: pageCount } = await supabase
      .from('canonical_pages')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);
    counts.pages = pageCount || 0;

    return counts;
  };

  const simulateUpload = async (entityType: EntityType, total: number) => {
    // Update status to running
    setProgress(prev => prev.map(p => 
      p.entityType === entityType ? { ...p, status: 'running', total } : p
    ));

    // Simulate batch processing
    const batchSize = 100;
    let processed = 0;
    let errors = 0;

    while (processed < total) {
      if (paused) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      // Simulate processing delay
      await new Promise(resolve => setTimeout(resolve, 200));
      
      processed = Math.min(processed + batchSize, total);
      
      // Simulate occasional errors (5% rate)
      if (Math.random() < 0.05) {
        errors++;
      }

      setProgress(prev => prev.map(p => 
        p.entityType === entityType ? { ...p, processed, errors } : p
      ));

      // Update canonical items status (mark as uploaded)
      // In production, this would actually call Shopify API
    }

    // Mark as completed
    setProgress(prev => prev.map(p => 
      p.entityType === entityType ? { ...p, status: errors > 0 ? 'completed' : 'completed' } : p
    ));
  };

  const handleStartUpload = async () => {
    setUploading(true);
    await onUpdateProject({ status: 'migrating' });

    const counts = await getCounts();

    // Update totals
    setProgress(prev => prev.map(p => ({
      ...p,
      total: counts[p.entityType],
    })));

    // Process in order: Pages → Collections → Products → Customers → Orders
    for (const entity of ENTITY_CONFIG) {
      if (counts[entity.type] > 0) {
        await simulateUpload(entity.type, counts[entity.type]);
      } else {
        setProgress(prev => prev.map(p => 
          p.entityType === entity.type ? { ...p, status: 'completed' } : p
        ));
      }
    }

    await onUpdateProject({ status: 'completed' });
    setUploading(false);
  };

  const allCompleted = progress.every(p => p.status === 'completed');
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
                      p.status === 'running' ? 'bg-primary/10' :
                      'bg-muted'
                    }`}>
                      {p.status === 'completed' ? (
                        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400" />
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
        {!uploading && !allCompleted && (
          <Button onClick={handleStartUpload}>
            <Play className="w-4 h-4 mr-2" />
            Start upload
          </Button>
        )}

        {uploading && (
          <Button variant="outline" onClick={() => setPaused(!paused)}>
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