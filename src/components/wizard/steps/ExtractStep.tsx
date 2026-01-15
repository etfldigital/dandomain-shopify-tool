import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { useAuth } from '@/hooks/useAuth';

interface ExtractStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

interface UploadedFile {
  type: EntityType;
  file: File;
  storagePath?: string;
  status: 'pending' | 'processing' | 'success' | 'error';
  count?: number;
  error?: string;
}

interface ProjectFile {
  id: string;
  entity_type: string;
  file_name: string;
  storage_path: string;
  row_count: number | null;
  status: string;
  error_message?: string | null;
}

const ENTITY_CONFIG: Record<EntityType, { icon: typeof ShoppingBag; label: string; acceptedLabel: string }> = {
  products: { icon: ShoppingBag, label: 'Produkter', acceptedLabel: 'products.csv' },
  categories: { icon: Folder, label: 'Produktgrupper / Kategorier', acceptedLabel: 'categories.csv' },
  customers: { icon: Users, label: 'Kunder', acceptedLabel: 'customers.csv' },
  orders: { icon: FileText, label: 'Ordrer', acceptedLabel: 'orders.csv' },
  pages: { icon: FileSpreadsheet, label: 'Sider', acceptedLabel: 'pages.csv' },
};

export function ExtractStep({ project, onUpdateProject, onNext }: ExtractStepProps) {
  const { user } = useAuth();
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentUploadType, setCurrentUploadType] = useState<EntityType | null>(null);

  // Load previously uploaded files on mount
  useEffect(() => {
    loadExistingFiles();
  }, [project.id]);

  const loadExistingFiles = async () => {
    setLoadingFiles(true);
    try {
      const { data, error } = await supabase
        .from('project_files')
        .select('*')
        .eq('project_id', project.id);

      if (error) {
        console.error('Error loading project files:', error);
        return;
      }

      if (data && data.length > 0) {
        const files: UploadedFile[] = data.map((pf: ProjectFile) => {
          const rowCount = pf.row_count ?? 0;
          const success = pf.status === 'processed';

          return {
            type: pf.entity_type as EntityType,
            // Placeholder file (we download from storage on process)
            file: new File([], pf.file_name),
            storagePath: pf.storage_path,
            status: success ? 'success' : (pf.status === 'error' ? 'error' : 'pending'),
            count: success ? rowCount : undefined,
            error: pf.status === 'error' ? (pf.error_message || 'Kunne ikke læse filen (klik Start udtræk igen)') : undefined,
          };
        });
        setUploadedFiles(files);
      }
    } catch (err) {
      console.error('Error loading files:', err);
    } finally {
      setLoadingFiles(false);
    }
  };

  const handleFileSelect = (entityType: EntityType) => {
    setCurrentUploadType(entityType);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUploadType || !user) return;

    try {
      // Upload to storage
      const storagePath = `${user.id}/${project.id}/${currentUploadType}.csv`;
      
      const { error: uploadError } = await supabase.storage
        .from('csv-uploads')
        .upload(storagePath, file, { upsert: true });

      if (uploadError) {
        console.error('Storage upload error:', uploadError);
        throw uploadError;
      }

      // Save file record
      const { error: dbError } = await supabase
        .from('project_files')
        .upsert({
          project_id: project.id,
          entity_type: currentUploadType,
          file_name: file.name,
          storage_path: storagePath,
          file_size: file.size,
          status: 'pending',
        }, { onConflict: 'project_id,entity_type' });

      if (dbError) {
        console.error('DB insert error:', dbError);
        throw dbError;
      }

      const newFile: UploadedFile = {
        type: currentUploadType,
        file,
        storagePath,
        status: 'pending',
      };

      setUploadedFiles(prev => [...prev.filter(f => f.type !== currentUploadType), newFile]);
    } catch (err: any) {
      console.error('Error uploading file:', err);
    }
    
    e.target.value = '';
  };

  const removeFile = async (type: EntityType) => {
    const fileToRemove = uploadedFiles.find(f => f.type === type);
    
    if (fileToRemove?.storagePath) {
      await supabase.storage
        .from('csv-uploads')
        .remove([fileToRemove.storagePath]);
    }
    
    await supabase
      .from('project_files')
      .delete()
      .eq('project_id', project.id)
      .eq('entity_type', type);
    
    setUploadedFiles(prev => prev.filter(f => f.type !== type));
  };

  const handleProcessFiles = async () => {
    if (!user) return;
    
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
        // Get file content from storage or from file object
        let text: string;
        
        if (uploadedFile.storagePath && uploadedFile.file.size === 0) {
          // File was loaded from storage, download it
          const { data, error } = await supabase.storage
            .from('csv-uploads')
            .download(uploadedFile.storagePath);
          
          if (error) throw error;
          text = await data.text();
        } else {
          text = await uploadedFile.file.text();
        }

        let parsedData: any[] = [];
        let recordCount = 0;
        
        switch (uploadedFile.type) {
          case 'products':
            parsedData = parseProductsCSV(text);
            
            // Deduplicate by SKU - keep last occurrence
            const productMap = new Map<string, typeof parsedData[0]>();
            parsedData.forEach(product => {
              if (product.sku) {
                productMap.set(product.sku, product);
              }
            });
            const uniqueProducts = Array.from(productMap.values());
            productCount = uniqueProducts.length;
            recordCount = uniqueProducts.length;
            
            // Insert into canonical_products in batches
            for (let i = 0; i < uniqueProducts.length; i += 100) {
              const batch = uniqueProducts.slice(i, i + 100).map(product => ({
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
            uniqueProducts.forEach(p => {
              if (p.category_external_ids) {
                p.category_external_ids.forEach((c: string) => categories.add(c));
              }
            });

            // Insert categories (already unique via Set)
            const categoryData = Array.from(categories).filter(cat => cat).map(cat => ({
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
            
            // Deduplicate by email - keep last occurrence
            const customerMap = new Map<string, typeof parsedData[0]>();
            parsedData.forEach(customer => {
              const key = customer.external_id || customer.email;
              if (key) {
                customerMap.set(key, customer);
              }
            });
            const uniqueCustomers = Array.from(customerMap.values());
            customerCount = uniqueCustomers.length;
            recordCount = uniqueCustomers.length;
            
            for (let i = 0; i < uniqueCustomers.length; i += 100) {
              const batch = uniqueCustomers.slice(i, i + 100).map(customer => ({
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
            
            // Deduplicate by order ID - keep last occurrence
            const orderMap = new Map<string, typeof parsedData[0]>();
            parsedData.forEach(order => {
              if (order.external_id) {
                orderMap.set(order.external_id, order);
              }
            });
            const uniqueOrders = Array.from(orderMap.values());
            orderCount = uniqueOrders.length;
            recordCount = uniqueOrders.length;
            
            for (let i = 0; i < uniqueOrders.length; i += 100) {
              const batch = uniqueOrders.slice(i, i + 100).map(order => ({
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
            console.log('Parsed categories:', parsedData.length, 'First few:', parsedData.slice(0, 3));
            
            // Deduplicate by category ID - keep last occurrence
            const catMap = new Map<string, typeof parsedData[0]>();
            parsedData.forEach(category => {
              if (category.external_id) {
                catMap.set(category.external_id, category);
              }
            });
            const uniqueCategories = Array.from(catMap.values());
            categoryCount = uniqueCategories.length;
            recordCount = uniqueCategories.length;
            
            console.log('Unique categories to insert:', uniqueCategories.length);
            
            for (let i = 0; i < uniqueCategories.length; i += 100) {
              const batch = uniqueCategories.slice(i, i + 100).map(category => ({
                project_id: project.id,
                external_id: category.external_id,
                name: category.name || category.external_id,
                parent_external_id: category.parent_external_id || null,
                shopify_tag: category.name || category.external_id,
                status: 'pending' as const,
              }));

              console.log('Inserting batch:', batch.length, 'categories');
              
              const { error } = await supabase
                .from('canonical_categories')
                .upsert(batch, { onConflict: 'project_id,external_id' });
              
              if (error) {
                console.error('Error inserting categories:', error);
                throw error;
              }
            }
            break;
        }

        // Note: 0 rækker er tilladt (fx hvis CSV'en er tom / filtreret), vi gemmer stadig status.
        // UI viser antal rækker, så det er tydeligt hvis noget er 0.
        // Update file record with row count
        await supabase
          .from('project_files')
          .update({
            row_count: recordCount,
            status: 'processed',
            error_message: null,
          })
          .eq('project_id', project.id)
          .eq('entity_type', uploadedFile.type);

        setUploadedFiles(prev =>
          prev.map(f => f.type === uploadedFile.type ? { ...f, status: 'success', count: recordCount, error: undefined } : f)
        );
      } catch (error: any) {
        console.error('Error processing file:', error);
        const errorMessage = error?.message || error?.hint || 'Ukendt fejl ved behandling af fil';
        
        await supabase
          .from('project_files')
          .update({ 
            status: 'error',
            error_message: errorMessage 
          })
          .eq('project_id', project.id)
          .eq('entity_type', uploadedFile.type);
        
        setUploadedFiles(prev => 
          prev.map(f => f.type === uploadedFile.type ? { 
            ...f, 
            status: 'error', 
            error: errorMessage
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

  if (loadingFiles) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

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
                            : uploadedFile.file.name || config.acceptedLabel
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
