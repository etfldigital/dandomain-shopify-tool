import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { 
  Upload, 
  FileSpreadsheet, 
  ShoppingBag, 
  Users, 
  FileText,
  Folder,
  Loader2,
  CheckCircle2,
  AlertCircle,
  X
} from 'lucide-react';
import { Project, EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { parseProductsCSV, parseCustomersCSV, parseOrdersCSV, parseCategoriesCSV } from '@/lib/csv-parser';

interface ExtractStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

interface UploadedFile {
  type: EntityType;
  file: File;
  status: 'pending' | 'processing' | 'success' | 'error';
  count?: number;
  error?: string;
}

const ENTITY_CONFIG: Record<EntityType, { icon: typeof ShoppingBag; label: string; acceptedLabel: string }> = {
  products: { icon: ShoppingBag, label: 'Produkter', acceptedLabel: 'products.csv' },
  categories: { icon: Folder, label: 'Produktgrupper / Kategorier', acceptedLabel: 'categories.csv' },
  customers: { icon: Users, label: 'Kunder', acceptedLabel: 'customers.csv' },
  orders: { icon: FileText, label: 'Ordrer', acceptedLabel: 'orders.csv' },
  pages: { icon: FileSpreadsheet, label: 'Sider', acceptedLabel: 'pages.csv' },
};

export function ExtractStep({ project, onUpdateProject, onNext }: ExtractStepProps) {
  const [selectedEntities, setSelectedEntities] = useState<EntityType[]>(['products', 'customers', 'orders', 'categories']);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentUploadType, setCurrentUploadType] = useState<EntityType | null>(null);

  const handleFileSelect = (entityType: EntityType) => {
    setCurrentUploadType(entityType);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUploadType) return;

    const newFile: UploadedFile = {
      type: currentUploadType,
      file,
      status: 'pending',
    };

    setUploadedFiles(prev => [...prev.filter(f => f.type !== currentUploadType), newFile]);
    e.target.value = '';
  };

  const removeFile = (type: EntityType) => {
    setUploadedFiles(prev => prev.filter(f => f.type !== type));
  };

  const handleProcessFiles = async () => {
    setProcessing(true);
    setProgress(0);

    const totalFiles = uploadedFiles.length;
    let processed = 0;
    let productCount = project.product_count;
    let customerCount = project.customer_count;
    let orderCount = project.order_count;
    let categoryCount = project.category_count;

    for (const uploadedFile of uploadedFiles) {
      setUploadedFiles(prev => 
        prev.map(f => f.type === uploadedFile.type ? { ...f, status: 'processing' } : f)
      );

      try {
        const text = await uploadedFile.file.text();
        let parsedData: any[] = [];
        
        switch (uploadedFile.type) {
          case 'products':
            parsedData = parseProductsCSV(text);
            productCount = parsedData.length;
            
            // Insert into canonical_products
            for (let i = 0; i < parsedData.length; i += 100) {
              const batch = parsedData.slice(i, i + 100).map(product => ({
                project_id: project.id,
                external_id: product.sku,
                data: product,
                status: 'pending' as const,
              }));

              const { error } = await supabase
                .from('canonical_products')
                .upsert(batch, { onConflict: 'project_id,external_id' });
              
              if (error) throw error;
            }

            // Extract categories from products
            const categories = new Set<string>();
            parsedData.forEach(p => {
              if (p.category_external_ids) {
                p.category_external_ids.forEach((c: string) => categories.add(c));
              }
            });
            categoryCount = categories.size;

            // Insert categories
            const categoryData = Array.from(categories).map(cat => ({
              project_id: project.id,
              external_id: cat,
              name: cat,
              shopify_tag: cat,
              status: 'pending' as const,
            }));

            if (categoryData.length > 0) {
              const { error } = await supabase
                .from('canonical_categories')
                .upsert(categoryData, { onConflict: 'project_id,external_id' });
              
              if (error) throw error;
            }
            break;

          case 'customers':
            parsedData = parseCustomersCSV(text);
            customerCount = parsedData.length;
            
            for (let i = 0; i < parsedData.length; i += 100) {
              const batch = parsedData.slice(i, i + 100).map(customer => ({
                project_id: project.id,
                external_id: customer.external_id || customer.email,
                data: customer,
                status: 'pending' as const,
              }));

              const { error } = await supabase
                .from('canonical_customers')
                .upsert(batch, { onConflict: 'project_id,external_id' });
              
              if (error) throw error;
            }
            break;

          case 'orders':
            parsedData = parseOrdersCSV(text);
            orderCount = parsedData.length;
            
            for (let i = 0; i < parsedData.length; i += 100) {
              const batch = parsedData.slice(i, i + 100).map(order => ({
                project_id: project.id,
                external_id: order.external_id,
                data: order,
                status: 'pending' as const,
              }));

              const { error } = await supabase
                .from('canonical_orders')
                .upsert(batch, { onConflict: 'project_id,external_id' });
              
              if (error) throw error;
            }
            break;

          case 'categories':
            parsedData = parseCategoriesCSV(text);
            categoryCount = parsedData.length;
            
            for (let i = 0; i < parsedData.length; i += 100) {
              const batch = parsedData.slice(i, i + 100).map(category => ({
                project_id: project.id,
                external_id: category.external_id,
                name: category.name,
                parent_external_id: category.parent_external_id || null,
                shopify_tag: category.name,
                status: 'pending' as const,
              }));

              const { error } = await supabase
                .from('canonical_categories')
                .upsert(batch, { onConflict: 'project_id,external_id' });
              
              if (error) throw error;
            }
            break;
        }

        setUploadedFiles(prev =>
          prev.map(f => f.type === uploadedFile.type ? { ...f, status: 'success', count: parsedData.length } : f)
        );
      } catch (error) {
        console.error('Error processing file:', error);
        setUploadedFiles(prev => 
          prev.map(f => f.type === uploadedFile.type ? { 
            ...f, 
            status: 'error', 
            error: error instanceof Error ? error.message : 'Ukendt fejl' 
          } : f)
        );
      }

      processed++;
      setProgress((processed / totalFiles) * 100);
    }

    await onUpdateProject({
      product_count: productCount,
      customer_count: customerCount,
      order_count: orderCount,
      category_count: categoryCount,
      status: 'extracted',
    });

    setProcessing(false);
  };

  const allFilesProcessed = uploadedFiles.length > 0 && uploadedFiles.every(f => f.status === 'success');

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-semibold mb-2">Udtræk data</h2>
        <p className="text-muted-foreground">
          Upload CSV-filer fra DanDomain for at starte migreringen
        </p>
      </div>

      <input
        type="file"
        ref={fileInputRef}
        accept=".csv"
        onChange={handleFileChange}
        className="hidden"
      />

      <div className="grid gap-4">
        {(['products', 'categories', 'customers', 'orders'] as EntityType[]).map((entityType) => {
          const config = ENTITY_CONFIG[entityType];
          const Icon = config.icon;
          const uploadedFile = uploadedFiles.find(f => f.type === entityType);

          return (
            <Card key={entityType} className={uploadedFile?.status === 'success' ? 'border-green-200 dark:border-green-800' : ''}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                      uploadedFile?.status === 'success' 
                        ? 'bg-green-100 dark:bg-green-900' 
                        : 'bg-primary/10'
                    }`}>
                      {uploadedFile?.status === 'success' ? (
                        <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
                      ) : uploadedFile?.status === 'processing' ? (
                        <Loader2 className="w-5 h-5 text-primary animate-spin" />
                      ) : uploadedFile?.status === 'error' ? (
                        <AlertCircle className="w-5 h-5 text-destructive" />
                      ) : (
                        <Icon className="w-5 h-5 text-primary" />
                      )}
                    </div>
                    <div>
                      <h4 className="font-medium">{config.label}</h4>
                      {uploadedFile ? (
                        <p className="text-sm text-muted-foreground">
                          {uploadedFile.status === 'success' 
                            ? `${uploadedFile.count?.toLocaleString('da-DK')} rækker importeret`
                            : uploadedFile.status === 'error'
                            ? uploadedFile.error
                            : uploadedFile.file.name
                          }
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">{config.acceptedLabel}</p>
                      )}
                    </div>
                  </div>
                  
                  {uploadedFile ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeFile(entityType)}
                      disabled={processing}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleFileSelect(entityType)}
                      disabled={processing}
                    >
                      <Upload className="w-4 h-4 mr-2" />
                      Vælg fil
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {processing && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>Behandler filer...</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress value={progress} />
        </div>
      )}

      <div className="flex justify-end gap-3 pt-4">
        {!allFilesProcessed ? (
          <Button
            onClick={handleProcessFiles}
            disabled={uploadedFiles.length === 0 || processing}
          >
            {processing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Behandler...
              </>
            ) : (
              'Start udtræk'
            )}
          </Button>
        ) : (
          <Button onClick={onNext}>
            Fortsæt til mapping
          </Button>
        )}
      </div>
    </div>
  );
}