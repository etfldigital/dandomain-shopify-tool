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
  Loader2,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { EntityType } from '@/types/database';

interface SkippedOrFailedItem {
  external_id: string;
  error_message: string | null;
  data?: Record<string, unknown>;
  title?: string;
  name?: string;
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

// Mapping of technical Shopify errors to user-friendly Danish messages
const ERROR_TRANSLATIONS: Record<string, string> = {
  // Phone errors
  'phone has already been taken': 'Telefonnummeret er allerede i brug hos en anden kunde',
  'has already been taken': 'er allerede i brug',
  'phone is invalid': 'Telefonnummeret er ugyldigt',
  
  // Email errors
  'email has already been taken': 'E-mailadressen er allerede registreret',
  'email is invalid': 'E-mailadressen er ugyldig',
  'email is required': 'E-mailadresse er påkrævet',
  
  // Product errors
  'title can\'t be blank': 'Produkttitel mangler',
  'title has already been taken': 'Et produkt med denne titel findes allerede',
  'sku has already been taken': 'Et produkt med dette varenummer (SKU) findes allerede',
  'price must be greater than or equal to 0': 'Prisen skal være større end eller lig med 0',
  'inventory_quantity must be greater than or equal to 0': 'Lagerbeholdningen skal være større end eller lig med 0',
  
  // Order errors
  'customer not found': 'Kunden kunne ikke findes i Shopify',
  'product not found': 'Produktet kunne ikke findes i Shopify',
  'line items can\'t be blank': 'Ordren skal indeholde mindst én varelinje',
  
  // Image errors
  'image url is invalid': 'Billedets URL er ugyldig eller kan ikke hentes',
  'image could not be downloaded': 'Billedet kunne ikke downloades',
  
  // General errors
  'is invalid': 'er ugyldig',
  'can\'t be blank': 'må ikke være tom',
  'is too long': 'er for lang',
  'is too short': 'er for kort',
};

// Translate a technical error message to a user-friendly version
function translateError(message: string): string {
  if (!message) return 'Ukendt fejl';
  
  // Check for Shopify API JSON errors like: Shopify API error: 422 - {"errors":{"phone":["has already been taken"]}}
  const jsonMatch = message.match(/\{"errors":\s*(\{[^}]+\})\}/);
  if (jsonMatch) {
    try {
      const errorsStr = message.match(/\{"errors":\s*(.+)\}$/)?.[1];
      if (errorsStr) {
        const parsed = JSON.parse(`{${errorsStr.slice(0, -1)}}`);
        const friendlyErrors: string[] = [];
        
        for (const [field, messages] of Object.entries(parsed)) {
          const fieldName = translateFieldName(field);
          const msgArray = Array.isArray(messages) ? messages : [messages];
          
          for (const msg of msgArray) {
            const translatedMsg = translateErrorMessage(String(msg));
            friendlyErrors.push(`${fieldName} ${translatedMsg}`);
          }
        }
        
        if (friendlyErrors.length > 0) {
          return friendlyErrors.join('. ');
        }
      }
    } catch {
      // Fall through to other methods
    }
  }
  
  // Check for simple matches
  const lowerMessage = message.toLowerCase();
  for (const [pattern, translation] of Object.entries(ERROR_TRANSLATIONS)) {
    if (lowerMessage.includes(pattern.toLowerCase())) {
      return translation;
    }
  }
  
  // Try to clean up Shopify API error format
  const shopifyMatch = message.match(/Shopify API error: (\d+) - (.+)/);
  if (shopifyMatch) {
    const statusCode = shopifyMatch[1];
    const errorBody = shopifyMatch[2];
    
    // Try to parse JSON error body
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.errors) {
        const friendlyErrors: string[] = [];
        
        if (typeof parsed.errors === 'string') {
          return translateErrorMessage(parsed.errors);
        }
        
        for (const [field, messages] of Object.entries(parsed.errors)) {
          const fieldName = translateFieldName(field);
          const msgArray = Array.isArray(messages) ? messages : [messages];
          
          for (const msg of msgArray) {
            const translatedMsg = translateErrorMessage(String(msg));
            friendlyErrors.push(`${fieldName} ${translatedMsg}`);
          }
        }
        
        return friendlyErrors.join('. ');
      }
    } catch {
      // Not JSON, continue
    }
    
    // Return cleaned version
    if (statusCode === '422') {
      return `Valideringsfejl: ${errorBody}`;
    } else if (statusCode === '429') {
      return 'For mange forespørgsler - prøv igen senere';
    } else if (statusCode === '404') {
      return 'Ressourcen blev ikke fundet';
    } else if (statusCode === '500') {
      return 'Shopify serverfejl - prøv igen senere';
    }
  }
  
  return message;
}

function translateFieldName(field: string): string {
  const fieldTranslations: Record<string, string> = {
    phone: 'Telefonnummer',
    email: 'E-mail',
    title: 'Titel',
    sku: 'Varenummer',
    price: 'Pris',
    name: 'Navn',
    address: 'Adresse',
    city: 'By',
    zip: 'Postnummer',
    country: 'Land',
    customer: 'Kunde',
    product: 'Produkt',
    variant: 'Variant',
    inventory: 'Lagerbeholdning',
    image: 'Billede',
    line_items: 'Varelinjer',
    first_name: 'Fornavn',
    last_name: 'Efternavn',
    company: 'Firma',
  };
  
  return fieldTranslations[field.toLowerCase()] || field;
}

function translateErrorMessage(msg: string): string {
  const msgTranslations: Record<string, string> = {
    'has already been taken': 'er allerede i brug',
    'is invalid': 'er ugyldig',
    'can\'t be blank': 'må ikke være tom',
    'is too long': 'er for lang',
    'is too short': 'er for kort',
    'is required': 'er påkrævet',
    'not found': 'blev ikke fundet',
    'must be greater than or equal to 0': 'skal være mindst 0',
    'must be a number': 'skal være et tal',
  };
  
  const lowerMsg = msg.toLowerCase();
  for (const [pattern, translation] of Object.entries(msgTranslations)) {
    if (lowerMsg.includes(pattern.toLowerCase())) {
      return translation;
    }
  }
  
  return msg;
}

const SKIP_REASONS: Record<EntityType, { title: string; description: string }> = {
  products: { 
    title: 'Produkter sprunget over',
    description: 'Produkter der allerede eksisterede i Shopify (matchet på titel) eller manglede titel'
  },
  customers: { 
    title: 'Kunder linket',
    description: 'Kunder der allerede eksisterede i Shopify (matchet på e-mail) blev linket i stedet for oprettet på ny'
  },
  orders: { 
    title: 'Ordrer sprunget over',
    description: 'Ordrer med ugyldige data eller manglende referencer til produkter/kunder'
  },
  categories: { 
    title: 'Collections sprunget over',
    description: 'Kategorier markeret som "exclude" eller som allerede eksisterede'
  },
  pages: { 
    title: 'Sider sprunget over',
    description: 'Sider uden indhold eller som allerede eksisterede'
  },
};

export function UploadErrorReport({ projectId, jobs, statusCounts }: UploadErrorReportProps) {
  const [loadingDownload, setLoadingDownload] = useState<string | null>(null);
  const [failedItems, setFailedItems] = useState<Record<EntityType, SkippedOrFailedItem[]>>({
    products: [],
    customers: [],
    orders: [],
    categories: [],
    pages: [],
  });
  const [skippedItems, setSkippedItems] = useState<Record<EntityType, SkippedOrFailedItem[]>>({
    products: [],
    customers: [],
    orders: [],
    categories: [],
    pages: [],
  });
  const [isLoading, setIsLoading] = useState(true);

  // Get job for entity
  const getJobForEntity = (entityType: EntityType) => {
    const entityJobs = jobs.filter(j => j.entity_type === entityType);
    return entityJobs.length > 0 ? entityJobs[entityJobs.length - 1] : undefined;
  };

  // Calculate totals
  const totalFailed = Object.values(statusCounts).reduce((acc, c) => acc + c.failed, 0);
  const totalSkipped = jobs.reduce((acc, j) => acc + j.skipped_count, 0);

  // Fetch failed and skipped items from database
  useEffect(() => {
    const fetchItems = async () => {
      setIsLoading(true);
      
      const failedResults: Record<EntityType, SkippedOrFailedItem[]> = {
        products: [],
        customers: [],
        orders: [],
        categories: [],
        pages: [],
      };
      
      const skippedResults: Record<EntityType, SkippedOrFailedItem[]> = {
        products: [],
        customers: [],
        orders: [],
        categories: [],
        pages: [],
      };

      // Fetch failed products
      if (statusCounts.products.failed > 0) {
        const { data } = await supabase
          .from('canonical_products')
          .select('external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) failedResults.products = data as SkippedOrFailedItem[];
      }

      // Fetch skipped products (status=uploaded but with skip error message)
      const productJob = getJobForEntity('products');
      if (productJob && productJob.skipped_count > 0) {
        const { data } = await supabase
          .from('canonical_products')
          .select('external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'uploaded')
          .like('error_message', 'Sprunget over%')
          .limit(500);
        if (data) {
          skippedResults.products = data.map(d => ({
            external_id: d.external_id,
            error_message: d.error_message,
            title: (d.data as Record<string, unknown>)?.title as string || '',
            data: d.data as Record<string, unknown>,
          }));
        }
      }

      // Fetch failed customers
      if (statusCounts.customers.failed > 0) {
        const { data } = await supabase
          .from('canonical_customers')
          .select('external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) failedResults.customers = data as SkippedOrFailedItem[];
      }

      // Fetch failed orders
      if (statusCounts.orders.failed > 0) {
        const { data } = await supabase
          .from('canonical_orders')
          .select('external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) failedResults.orders = data as SkippedOrFailedItem[];
      }

      // Fetch failed categories
      if (statusCounts.categories.failed > 0) {
        const { data } = await supabase
          .from('canonical_categories')
          .select('external_id, error_message, name')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) failedResults.categories = data.map(d => ({ 
          external_id: d.external_id, 
          error_message: d.error_message,
          name: d.name,
        }));
      }

      // Fetch failed pages
      if (statusCounts.pages.failed > 0) {
        const { data } = await supabase
          .from('canonical_pages')
          .select('external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) failedResults.pages = data as SkippedOrFailedItem[];
      }

      setFailedItems(failedResults);
      setSkippedItems(skippedResults);
      setIsLoading(false);
    };

    fetchItems();
  }, [projectId, statusCounts, jobs]);

  // Group items by error message (translated)
  const groupByError = (items: SkippedOrFailedItem[]): Map<string, SkippedOrFailedItem[]> => {
    const grouped = new Map<string, SkippedOrFailedItem[]>();
    for (const item of items) {
      const translatedKey = translateError(item.error_message || 'Ukendt fejl');
      if (!grouped.has(translatedKey)) {
        grouped.set(translatedKey, []);
      }
      grouped.get(translatedKey)!.push(item);
    }
    return grouped;
  };

  // Generate CSV content for failed items
  const generateFailedCsv = (entityType: EntityType) => {
    const items = failedItems[entityType];
    const rows = [['External ID', 'Titel/Navn', 'Fejlbesked', 'Brugervenlig fejl']];
    
    for (const item of items) {
      const title = item.title || item.name || (item.data as Record<string, unknown>)?.title as string || '';
      rows.push([
        item.external_id,
        title,
        item.error_message || 'Ukendt fejl',
        translateError(item.error_message || ''),
      ]);
    }
    return rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  };

  // Generate CSV content for skipped items
  const generateSkippedCsv = (entityType: EntityType) => {
    const items = skippedItems[entityType];
    const rows = [['External ID', 'Titel/Navn', 'Årsag']];
    
    for (const item of items) {
      const title = item.title || item.name || (item.data as Record<string, unknown>)?.title as string || '';
      rows.push([
        item.external_id,
        title,
        item.error_message || SKIP_REASONS[entityType].description,
      ]);
    }
    return rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  };

  // Download handler
  const handleDownload = async (entityType: EntityType, type: 'failed' | 'skipped') => {
    setLoadingDownload(`${entityType}-${type}`);
    
    try {
      let csv = '';
      let filename = '';
      
      if (type === 'failed') {
        csv = generateFailedCsv(entityType);
        filename = `${entityType}-fejl.csv`;
      } else {
        csv = generateSkippedCsv(entityType);
        filename = `${entityType}-sprunget-over.csv`;
      }
      
      // Create and download file
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
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
      let csv = 'Type,External ID,Titel/Navn,Fejlbesked,Brugervenlig fejl\n';
      
      for (const { type, label } of ENTITY_CONFIG) {
        for (const item of failedItems[type]) {
          const title = item.title || item.name || (item.data as Record<string, unknown>)?.title as string || '';
          csv += [
            `"${label}"`,
            `"${item.external_id}"`,
            `"${String(title).replace(/"/g, '""')}"`,
            `"${(item.error_message || 'Ukendt fejl').replace(/"/g, '""')}"`,
            `"${translateError(item.error_message || '').replace(/"/g, '""')}"`,
          ].join(',') + '\n';
        }
      }
      
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
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
              Oversigt over elementer der ikke blev uploadet som nye
            </CardDescription>
          </div>
          {totalFailed > 0 && (
            <Button 
              variant="outline" 
              size="sm"
              onClick={handleDownloadAll}
              disabled={loadingDownload === 'all'}
            >
              {loadingDownload === 'all' ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Download className="w-4 h-4 mr-2" />
              )}
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
              {totalSkipped.toLocaleString('da-DK')} sprunget over / linket
            </Badge>
          )}
        </div>
      </CardHeader>
      
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Accordion type="multiple" className="w-full">
            {ENTITY_CONFIG.map(({ type, icon: Icon, label, singular }) => {
              const job = getJobForEntity(type);
              const failedCount = statusCounts[type].failed;
              const skippedCount = job?.skipped_count || 0;
              const failed = failedItems[type];
              const skipped = skippedItems[type];
              const groupedErrors = groupByError(failed);
              const groupedSkipped = groupByError(skipped);
              
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
                              {loadingDownload === `${type}-failed` ? (
                                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                              ) : (
                                <Download className="w-3 h-3 mr-1" />
                              )}
                              Download CSV
                            </Button>
                          </div>
                          
                          {/* Grouped errors - with translated messages */}
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
                            {skipped.length > 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDownload(type, 'skipped')}
                                disabled={loadingDownload === `${type}-skipped`}
                                className="text-xs h-7"
                              >
                                {loadingDownload === `${type}-skipped` ? (
                                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                ) : (
                                  <Download className="w-3 h-3 mr-1" />
                                )}
                                Download CSV
                              </Button>
                            )}
                          </div>
                          
                          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
                            <div className="flex items-start gap-2">
                              <ChevronRight className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                              <div className="flex-1">
                                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                                  {SKIP_REASONS[type].title}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                  {SKIP_REASONS[type].description}
                                </p>
                              </div>
                              <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-700 border-amber-500/30">
                                {skippedCount}
                              </Badge>
                            </div>
                          </div>

                          {/* Show skipped item details if available */}
                          {skipped.length > 0 && (
                            <div className="space-y-2 mt-2">
                              {Array.from(groupedSkipped.entries()).map(([reason, items]) => (
                                <div 
                                  key={reason} 
                                  className="bg-amber-500/5 border border-amber-500/10 rounded-lg p-2"
                                >
                                  <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                                    {reason}
                                  </p>
                                  <p className="text-xs text-muted-foreground mt-0.5">
                                    {items.length <= 5 
                                      ? items.map(i => i.title || i.external_id).join(', ')
                                      : `${items.slice(0, 3).map(i => i.title || i.external_id).join(', ')} og ${items.length - 3} flere`
                                    }
                                  </p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}
