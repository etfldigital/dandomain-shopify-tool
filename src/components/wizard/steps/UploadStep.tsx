import { useState, useRef } from 'react';
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
  HelpCircle,
  XCircle,
  AlertTriangle
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
  const [testMode, setTestMode] = useState(false);
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

  const uploadEntityBatch = async (entityType: EntityType, isTestMode: boolean): Promise<{ processed: number; errors: number; hasMore: boolean }> => {
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
      // In test mode, never fetch more
      hasMore: isTestMode ? false : (response.data.hasMore || false),
    };
  };

  const uploadEntity = async (entityType: EntityType, total: number, isTestMode: boolean) => {
    // Update status to running
    const displayTotal = isTestMode ? Math.min(total, 3) : total;
    setProgress(prev => prev.map(p => 
      p.entityType === entityType ? { ...p, status: 'running', total: displayTotal } : p
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
        const result = await uploadEntityBatch(entityType, isTestMode);
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
      status: 'pending',
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

      {/* Error Explanation Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <HelpCircle className="w-5 h-5" />
            Hvorfor opstår der fejl?
          </CardTitle>
          <CardDescription>
            Forklaring på de mest almindelige fejl under upload
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="untitled">
              <AccordionTrigger className="text-left">
                <div className="flex items-center gap-2">
                  <XCircle className="w-4 h-4 text-destructive" />
                  <span>Produkter med "Untitled" eller manglende titel</span>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground">
                  Når CSV-filen ikke indeholder et produktnavn (PROD_NAME), oprettes produktet med titlen "Untitled". 
                  Disse produkter ekskluderes automatisk, da de typisk er tomme rækker eller ufuldstændige data.
                </p>
                <p className="text-muted-foreground mt-2">
                  <strong>Løsning:</strong> Tjek din eksport fra DanDomain og sikr at alle produkter har et navn.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="api-auth">
              <AccordionTrigger className="text-left">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-destructive" />
                  <span>401 - Invalid API key or access token</span>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground">
                  Denne fejl opstår når Shopify API-nøglen er forkert eller mangler de nødvendige tilladelser.
                </p>
                <ul className="list-disc list-inside text-muted-foreground mt-2 space-y-1">
                  <li>Sørg for at bruge <strong>Admin API access token</strong> (starter med <code className="bg-muted px-1 rounded">shpat_</code>)</li>
                  <li>Storefront API tokens (<code className="bg-muted px-1 rounded">shpss_</code>) virker IKKE</li>
                  <li>Tjek at din app har de nødvendige scopes: write_products, write_customers, write_orders</li>
                </ul>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="rate-limit">
              <AccordionTrigger className="text-left">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  <span>429 - Rate limit exceeded</span>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground">
                  Shopify har en grænse på antal API-kald per minut. Når denne grænse nås, 
                  returneres en 429-fejl. Systemet venter automatisk og prøver igen.
                </p>
                <p className="text-muted-foreground mt-2">
                  <strong>Løsning:</strong> Vent et øjeblik og kør upload igen. Systemet håndterer dette automatisk.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="duplicate">
              <AccordionTrigger className="text-left">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-500" />
                  <span>Duplikerede kunder (samme email)</span>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground">
                  Shopify tillader kun én kunde per email-adresse. Hvis en kunde med samme email allerede eksisterer, 
                  vil systemet forsøge at finde den eksisterende kunde i stedet for at oprette en ny.
                </p>
                <p className="text-muted-foreground mt-2">
                  <strong>Bemærk:</strong> Dette er normalt og påvirker ikke migreringen negativt.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="missing-data">
              <AccordionTrigger className="text-left">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  <span>Manglende eller ugyldige data</span>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground">
                  Nogle felter i DanDomain-eksporten kan mangle eller have ugyldige værdier:
                </p>
                <ul className="list-disc list-inside text-muted-foreground mt-2 space-y-1">
                  <li>Pris = 0 (produkter uden pris)</li>
                  <li>Manglende billeder</li>
                  <li>Ugyldige kategori-ID'er</li>
                  <li>Manglende kundeoplysninger (email, adresse)</li>
                </ul>
                <p className="text-muted-foreground mt-2">
                  <strong>Løsning:</strong> Gennemgå fejlrapporten efter upload og ret manuelt i Shopify Admin.
                </p>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3 pt-4">
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
    </div>
  );
}
