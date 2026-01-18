import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  AlertCircle,
  SkipForward,
  Download,
  FileWarning,
  Users,
  ShoppingBag,
  FileText,
  Folder,
  FileSpreadsheet,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { EntityType } from '@/types/database';

interface FailedItem {
  external_id: string;
  error_message: string | null;
  data?: Record<string, unknown>;
}

interface UploadJob {
  id: string;
  entity_type: EntityType;
  skipped_count: number;
  error_count: number;
  error_details: Array<{ externalId: string; message: string }> | null;
}

interface UploadErrorReportProps {
  projectId: string;
  jobs: UploadJob[];
  statusCounts: Record<EntityType, { pending: number; uploaded: number; failed: number }>;
}

const ENTITY_CONFIG: { type: EntityType; icon: typeof ShoppingBag; label: string; singular: string }[] = [
  { type: 'pages', icon: FileSpreadsheet, label: 'Sider', singular: 'side' },
  { type: 'categories', icon: Folder, label: 'Collections', singular: 'collection' },
  { type: 'products', icon: ShoppingBag, label: 'Produkter', singular: 'produkt' },
  { type: 'customers', icon: Users, label: 'Kunder', singular: 'kunde' },
  { type: 'orders', icon: FileText, label: 'Ordrer', singular: 'ordre' },
];

const SKIP_REASONS: Record<EntityType, string> = {
  products: 'Produkter uden titel eller med titel "Untitled" blev sprunget over',
  customers: 'Kunder der allerede eksisterede i Shopify blev linket',
  orders: 'Ordrer med ugyldige data blev sprunget over',
  categories: 'Kategorier markeret som "exclude" blev sprunget over',
  pages: 'Sider uden indhold blev sprunget over',
};

export function UploadErrorReport({ projectId, jobs, statusCounts }: UploadErrorReportProps) {
  const [loadingDownload, setLoadingDownload] = useState<string | null>(null);
  const [failedItems, setFailedItems] = useState<Record<EntityType, FailedItem[]>>({
    products: [],
    customers: [],
    orders: [],
    categories: [],
    pages: [],
  });

  // Get job for entity
  const getJobForEntity = (entityType: EntityType) => {
    const entityJobs = jobs.filter(j => j.entity_type === entityType);
    return entityJobs.length > 0 ? entityJobs[entityJobs.length - 1] : undefined;
  };

  // Calculate totals
  const totalFailed = Object.values(statusCounts).reduce((acc, c) => acc + c.failed, 0);
  const totalSkipped = jobs.reduce((acc, j) => acc + j.skipped_count, 0);

  // Fetch failed items from database for detailed reporting
  useEffect(() => {
    const fetchFailedItems = async () => {
      const results: Record<EntityType, FailedItem[]> = {
        products: [],
        customers: [],
        orders: [],
        categories: [],
        pages: [],
      };

      // Only fetch if there are failed items
      if (statusCounts.products.failed > 0) {
        const { data } = await supabase
          .from('canonical_products')
          .select('external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) results.products = data as FailedItem[];
      }

      if (statusCounts.customers.failed > 0) {
        const { data } = await supabase
          .from('canonical_customers')
          .select('external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) results.customers = data as FailedItem[];
      }

      if (statusCounts.orders.failed > 0) {
        const { data } = await supabase
          .from('canonical_orders')
          .select('external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) results.orders = data as FailedItem[];
      }

      if (statusCounts.categories.failed > 0) {
        const { data } = await supabase
          .from('canonical_categories')
          .select('external_id, error_message, name')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) results.categories = data.map(d => ({ 
          external_id: d.external_id, 
          error_message: d.error_message,
          data: { name: d.name }
        }));
      }

      if (statusCounts.pages.failed > 0) {
        const { data } = await supabase
          .from('canonical_pages')
          .select('external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) results.pages = data as FailedItem[];
      }

      setFailedItems(results);
    };

    fetchFailedItems();
  }, [projectId, statusCounts]);

  // Group failed items by error message
  const groupByError = (items: FailedItem[]): Map<string, FailedItem[]> => {
    const grouped = new Map<string, FailedItem[]>();
    for (const item of items) {
      const key = item.error_message || 'Ukendt fejl';
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(item);
    }
    return grouped;
  };

  // Generate CSV content
  const generateCsv = (entityType: EntityType, type: 'failed' | 'skipped') => {
    const items = failedItems[entityType];
    const job = getJobForEntity(entityType);
    
    if (type === 'failed') {
      const rows = [['External ID', 'Fejlbesked', 'Data']];
      for (const item of items) {
        rows.push([
          item.external_id,
          item.error_message || 'Ukendt fejl',
          JSON.stringify(item.data || {}).replace(/"/g, '""'),
        ]);
      }
      return rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    } else {
      // For skipped, we just create a summary since we don't store individual skipped items
      const rows = [['Type', 'Antal', 'Årsag']];
      rows.push([
        ENTITY_CONFIG.find(e => e.type === entityType)?.label || entityType,
        String(job?.skipped_count || 0),
        SKIP_REASONS[entityType],
      ]);
      return rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    }
  };

  // Download handler
  const handleDownload = async (entityType: EntityType, type: 'failed' | 'skipped' | 'all') => {
    setLoadingDownload(`${entityType}-${type}`);
    
    try {
      let csv = '';
      let filename = '';
      
      if (type === 'all') {
        // Combined report
        const config = ENTITY_CONFIG.find(e => e.type === entityType);
        const label = config?.label || entityType;
        
        csv = `# Fejlrapport for ${label}\n\n`;
        
        // Failed section
        const failedCount = statusCounts[entityType].failed;
        if (failedCount > 0) {
          csv += `## Fejlede (${failedCount})\n`;
          csv += generateCsv(entityType, 'failed');
          csv += '\n\n';
        }
        
        // Skipped section
        const job = getJobForEntity(entityType);
        const skippedCount = job?.skipped_count || 0;
        if (skippedCount > 0) {
          csv += `## Sprunget over (${skippedCount})\n`;
          csv += `Årsag: ${SKIP_REASONS[entityType]}\n`;
        }
        
        filename = `${entityType}-fejlrapport.txt`;
      } else {
        csv = generateCsv(entityType, type);
        filename = `${entityType}-${type}.csv`;
      }
      
      // Create and download file
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setLoadingDownload(null);
    }
  };

  // Download all errors combined
  const handleDownloadAll = async () => {
    setLoadingDownload('all');
    
    try {
      let csv = 'Entity Type,External ID,Fejlbesked,Data\n';
      
      for (const { type, label } of ENTITY_CONFIG) {
        for (const item of failedItems[type]) {
          csv += [
            `"${label}"`,
            `"${item.external_id}"`,
            `"${(item.error_message || 'Ukendt fejl').replace(/"/g, '""')}"`,
            `"${JSON.stringify(item.data || {}).replace(/"/g, '""')}"`,
          ].join(',') + '\n';
        }
      }
      
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'alle-fejl-rapport.csv';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setLoadingDownload(null);
    }
  };

  // If no errors or skips, don't render anything
  if (totalFailed === 0 && totalSkipped === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileWarning className="w-5 h-5 text-amber-600" />
              Upload rapport
            </CardTitle>
            <CardDescription className="mt-1">
              Oversigt over elementer der ikke blev uploadet
            </CardDescription>
          </div>
          {totalFailed > 0 && (
            <Button 
              variant="outline" 
              size="sm"
              onClick={handleDownloadAll}
              disabled={loadingDownload === 'all'}
            >
              <Download className="w-4 h-4 mr-2" />
              Download alle fejl
            </Button>
          )}
        </div>
        
        {/* Summary badges */}
        <div className="flex flex-wrap gap-2 mt-4">
          {totalFailed > 0 && (
            <Badge variant="destructive" className="text-sm">
              <AlertCircle className="w-3.5 h-3.5 mr-1" />
              {totalFailed.toLocaleString('da-DK')} fejlede
            </Badge>
          )}
          {totalSkipped > 0 && (
            <Badge variant="outline" className="text-sm bg-amber-500/10 text-amber-700 border-amber-500/30">
              <SkipForward className="w-3.5 h-3.5 mr-1" />
              {totalSkipped.toLocaleString('da-DK')} sprunget over
            </Badge>
          )}
        </div>
      </CardHeader>
      
      <CardContent>
        <Accordion type="multiple" className="w-full">
          {ENTITY_CONFIG.map(({ type, icon: Icon, label, singular }) => {
            const job = getJobForEntity(type);
            const failedCount = statusCounts[type].failed;
            const skippedCount = job?.skipped_count || 0;
            const items = failedItems[type];
            const groupedErrors = groupByError(items);
            
            // Skip if no errors or skips for this entity
            if (failedCount === 0 && skippedCount === 0) return null;

            return (
              <AccordionItem key={type} value={type} className="border rounded-lg mb-3 px-4">
                <AccordionTrigger className="hover:no-underline py-4">
                  <div className="flex items-center justify-between w-full pr-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                        <Icon className="w-5 h-5 text-muted-foreground" />
                      </div>
                      <div className="text-left">
                        <span className="font-medium">{label}</span>
                        <div className="flex gap-3 text-xs mt-0.5">
                          {failedCount > 0 && (
                            <span className="text-destructive flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" />
                              {failedCount} fejl
                            </span>
                          )}
                          {skippedCount > 0 && (
                            <span className="text-amber-600 flex items-center gap-1">
                              <SkipForward className="w-3 h-3" />
                              {skippedCount} sprunget over
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </AccordionTrigger>
                
                <AccordionContent className="pb-4">
                  <div className="space-y-4">
                    {/* Failed items section */}
                    {failedCount > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-medium text-destructive flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4" />
                            Fejlede elementer ({failedCount})
                          </h4>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDownload(type, 'failed')}
                            disabled={loadingDownload === `${type}-failed`}
                            className="text-xs h-7"
                          >
                            <Download className="w-3 h-3 mr-1" />
                            Download CSV
                          </Button>
                        </div>
                        
                        {/* Grouped errors */}
                        <div className="space-y-2">
                          {Array.from(groupedErrors.entries()).map(([message, errorItems]) => (
                            <div 
                              key={message} 
                              className="bg-destructive/5 border border-destructive/20 rounded-lg p-3"
                            >
                              <div className="flex items-start gap-2">
                                <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-destructive">
                                    {message}
                                  </p>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    {errorItems.length === 1 
                                      ? `1 ${singular}` 
                                      : `${errorItems.length} ${label.toLowerCase()}`
                                    }
                                    {errorItems.length <= 10 && (
                                      <span className="ml-1">
                                        (ID: {errorItems.map(e => e.external_id).join(', ')})
                                      </span>
                                    )}
                                    {errorItems.length > 10 && (
                                      <span className="ml-1">
                                        (ID: {errorItems.slice(0, 5).map(e => e.external_id).join(', ')} og {errorItems.length - 5} flere)
                                      </span>
                                    )}
                                  </p>
                                </div>
                                <Badge variant="outline" className="text-xs bg-destructive/10 text-destructive border-destructive/30">
                                  {errorItems.length}
                                </Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Skipped items section */}
                    {skippedCount > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-medium text-amber-700 dark:text-amber-500 flex items-center gap-2">
                            <SkipForward className="w-4 h-4" />
                            Sprunget over ({skippedCount})
                          </h4>
                        </div>
                        
                        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
                          <div className="flex items-start gap-2">
                            <ChevronRight className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                            <div className="flex-1">
                              <p className="text-sm text-amber-700 dark:text-amber-400">
                                {SKIP_REASONS[type]}
                              </p>
                              <p className="text-xs text-muted-foreground mt-1">
                                Disse elementer blev ikke uploadet til Shopify, men de ligger stadig i systemet.
                              </p>
                            </div>
                            <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-700 border-amber-500/30">
                              {skippedCount}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </CardContent>
    </Card>
  );
}
