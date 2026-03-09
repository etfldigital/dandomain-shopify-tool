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
  X,
  Calendar,
  RefreshCw
} from 'lucide-react';
import { Project, EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { parseProductsXML, parseCustomersXML, parseOrdersXML, parseCategoriesXML, parsePeriodsXML, parseManufacturersXML, type ParseStats } from '@/lib/xml-parser';
import { useAuth } from '@/hooks/useAuth';

interface ExtractStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

type UploadEntityType = EntityType | 'periods' | 'manufacturers';

interface UploadedFile {
  type: UploadEntityType;
  file: File;
  storagePath?: string;
  status: 'pending' | 'processing' | 'success' | 'error';
  count?: number;
  error?: string;
  parseStats?: ParseStats;
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

const ENTITY_CONFIG: Record<UploadEntityType, { icon: typeof ShoppingBag; label: string; acceptedLabel: string }> = {
  products: { icon: ShoppingBag, label: 'Produkter', acceptedLabel: 'XML fil' },
  categories: { icon: Folder, label: 'Kategorier', acceptedLabel: 'XML fil' },
  customers: { icon: Users, label: 'Kunder', acceptedLabel: 'XML fil' },
  orders: { icon: FileText, label: 'Ordrer', acceptedLabel: 'XML fil' },
  pages: { icon: FileSpreadsheet, label: 'Sider', acceptedLabel: 'XML fil' },
  periods: { icon: Calendar, label: 'Periodestyring (priser)', acceptedLabel: 'XML fil' },
  manufacturers: { icon: ShoppingBag, label: 'Producenter', acceptedLabel: 'XML fil' },
};

export function ExtractStep({ project, onUpdateProject, onNext }: ExtractStepProps) {
  const { user } = useAuth();
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentUploadType, setCurrentUploadType] = useState<UploadEntityType | null>(null);

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
      
    } finally {
      setLoadingFiles(false);
    }
  };

  const handleFileSelect = (entityType: UploadEntityType) => {
    setCurrentUploadType(entityType);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUploadType || !user) return;

    try {
      // Upload to storage
      const storagePath = `${user.id}/${project.id}/${currentUploadType}.xml`;
      
      const { error: uploadError } = await supabase.storage
        .from('csv-uploads')
        .upload(storagePath, file, { upsert: true });

      if (uploadError) {
        
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
      
    }
    
    e.target.value = '';
  };

  const removeFile = async (type: UploadEntityType) => {
    const fileToRemove = uploadedFiles.find(f => f.type === type);
    
    if (fileToRemove?.storagePath) {
      await supabase.storage
        .from('csv-uploads')
        .remove([fileToRemove.storagePath]);
    }
    
    // For periods, also clear the price_periods table
    if (type === 'periods') {
      await supabase
        .from('price_periods')
        .delete()
        .eq('project_id', project.id);
    }
    
    if (type === 'manufacturers') {
      await supabase
        .from('canonical_manufacturers')
        .delete()
        .eq('project_id', project.id);
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

    const hasCategoriesFile = uploadedFiles.some((f) => f.type === 'categories');

    // Clear old data before re-importing so "Kør udtræk igen" always starts fresh
    // (Upsert updates rows but does NOT delete stale rows)
    const { error: mappingClearError } = await supabase
      .from('mapping_profiles')
      .delete()
      .eq('project_id', project.id);

    if (mappingClearError) {
      
      setProcessing(false);
      return;
    }

    const entityTypesToClear = uploadedFiles.map((f) => f.type);

    for (const entityType of entityTypesToClear) {
      let error: any = null;

      switch (entityType) {
        case 'products': {
          const res = await supabase.from('canonical_products').delete().eq('project_id', project.id);
          error = res.error;
          break;
        }
        case 'customers': {
          const res = await supabase.from('canonical_customers').delete().eq('project_id', project.id);
          error = res.error;
          break;
        }
        case 'orders': {
          const res = await supabase.from('canonical_orders').delete().eq('project_id', project.id);
          error = res.error;
          break;
        }
        case 'categories': {
          const res = await supabase.from('canonical_categories').delete().eq('project_id', project.id);
          error = res.error;
          break;
        }
        case 'periods': {
          const res = await supabase.from('price_periods').delete().eq('project_id', project.id);
          error = res.error;
          break;
        }
        case 'manufacturers': {
          const res = await supabase.from('canonical_manufacturers').delete().eq('project_id', project.id);
          error = res.error;
          break;
        }
      }

      if (error) {
        
        setProcessing(false);
        return;
      }
    }

    const totalFiles = uploadedFiles.length;
    let processed = 0;
    let productCount = 0;
    let lastProductStats: ParseStats | undefined;
    let customerCount = 0;
    let orderCount = 0;
    let categoryCount = 0;

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
            const productStats: ParseStats = {
              xmlCharLength: 0,
              totalElementsFound: 0,
              totalProcessed: 0,
              skippedNoTitle: 0,
              skippedNoTitleOrSku: 0,
              duplicateSkus: 0,
              uniqueAfterDedup: 0,
            };
            parsedData = parseProductsXML(text, productStats);
            
            // Deduplicate by SKU - keep last occurrence
            const productMap = new Map<string, typeof parsedData[0]>();
            parsedData.forEach(product => {
              if (product.sku) {
                productMap.set(product.sku, product);
              }
            });
            const uniqueProducts = Array.from(productMap.values());
            productStats.duplicateSkus = parsedData.length - uniqueProducts.length;
            productStats.uniqueAfterDedup = uniqueProducts.length;
            productCount = uniqueProducts.length;
            recordCount = uniqueProducts.length;
            
            
            lastProductStats = productStats;
            
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

            // Extract categories from products ONLY if no category CSV was uploaded.
            // Otherwise we rely on PRODUCTCATEGORIES (gives correct ID + name).
            if (!hasCategoriesFile) {
              const categories = new Set<string>();
              uniqueProducts.forEach(p => {
                if (p.category_external_ids) {
                  p.category_external_ids.forEach((c: string) => {
                    if (c && !c.includes('#')) categories.add(c);
                  });
                }
              });

              const categoryData = Array.from(categories)
                .filter(cat => cat)
                .map(cat => ({
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
            }
            break;

          case 'customers':
            parsedData = parseCustomersXML(text);
            
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
            parsedData = parseOrdersXML(text);
            
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
            parsedData = parseCategoriesXML(text);
            
            
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
            
            
            
            for (let i = 0; i < uniqueCategories.length; i += 100) {
              const batch = uniqueCategories.slice(i, i + 100).map(category => ({
                project_id: project.id,
                external_id: category.external_id,
                name: category.name || category.external_id,
                parent_external_id: category.parent_external_id || null,
                shopify_tag: category.name || category.external_id,
                status: 'pending' as const,
              }));

              
              
              const { error } = await supabase
                .from('canonical_categories')
                .upsert(batch, { onConflict: 'project_id,external_id' });
              
              if (error) {
                
                throw error;
              }
            }
            break;

          case 'periods':
            const periodsParsed = parsePeriodsXML(text);
            
            recordCount = periodsParsed.length;
            
            for (let i = 0; i < periodsParsed.length; i += 100) {
              const batch = periodsParsed.slice(i, i + 100).map(period => ({
                project_id: project.id,
                period_id: period.period_id,
                title: period.title,
                start_date: period.start_date,
                end_date: period.end_date,
                disabled: period.disabled,
              }));

              const { error } = await supabase
                .from('price_periods')
                .upsert(batch, { onConflict: 'project_id,period_id' });
              
              if (error) {
                
                throw error;
              }
            }
            break;

          case 'manufacturers':
            const mfrParsed = parseManufacturersXML(text);
            
            recordCount = mfrParsed.length;

            // Replace entire manufacturer mapping for the project to avoid stale/wrong keys
            {
              const { error: deleteError } = await supabase
                .from('canonical_manufacturers')
                .delete()
                .eq('project_id', project.id);
              if (deleteError) {
                
                throw deleteError;
              }
            }
            
            for (let i = 0; i < mfrParsed.length; i += 100) {
              const batch = mfrParsed.slice(i, i + 100).map(m => ({
                project_id: project.id,
                external_id: m.external_id,
                name: m.name,
              }));

              const { error } = await supabase
                .from('canonical_manufacturers')
                .upsert(batch, { onConflict: 'project_id,external_id' });
              
              if (error) {
                
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
          prev.map(f => f.type === uploadedFile.type ? { 
            ...f, 
            status: 'success', 
            count: recordCount, 
            error: undefined,
            parseStats: uploadedFile.type === 'products' ? lastProductStats : undefined,
          } : f)
        );
      } catch (error: any) {
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

  // Process a single entity type (for re-extracting after replacing a file)
  const handleProcessSingleFile = async (entityType: UploadEntityType) => {
    if (!user) return;
    
    const uploadedFile = uploadedFiles.find(f => f.type === entityType);
    if (!uploadedFile) return;

    setProcessing(true);
    setProgress(0);

    // Clear old data for this entity type only
    let clearError: any = null;
    switch (entityType) {
      case 'products': {
        const res = await supabase.from('canonical_products').delete().eq('project_id', project.id);
        clearError = res.error;
        break;
      }
      case 'customers': {
        const res = await supabase.from('canonical_customers').delete().eq('project_id', project.id);
        clearError = res.error;
        break;
      }
      case 'orders': {
        const res = await supabase.from('canonical_orders').delete().eq('project_id', project.id);
        clearError = res.error;
        break;
      }
      case 'categories': {
        const res = await supabase.from('canonical_categories').delete().eq('project_id', project.id);
        clearError = res.error;
        break;
      }
      case 'periods': {
        const res = await supabase.from('price_periods').delete().eq('project_id', project.id);
        clearError = res.error;
        break;
      }
      case 'manufacturers': {
        const res = await supabase.from('canonical_manufacturers').delete().eq('project_id', project.id);
        clearError = res.error;
        break;
      }
    }

    if (clearError) {
      console.error('Error clearing data for', entityType, clearError);
      setProcessing(false);
      return;
    }

    // Process just this one file by temporarily filtering uploadedFiles
    const originalFiles = uploadedFiles;
    const singleFileList = [uploadedFile];

    setUploadedFiles(prev =>
      prev.map(f => f.type === entityType ? { ...f, status: 'processing' } : f)
    );

    try {
      let text: string;
      if (uploadedFile.storagePath && uploadedFile.file.size === 0) {
        const { data, error } = await supabase.storage.from('csv-uploads').download(uploadedFile.storagePath);
        if (error) throw error;
        text = await data.text();
      } else {
        text = await uploadedFile.file.text();
      }

      let recordCount = 0;
      const hasCategoriesFile = uploadedFiles.some(f => f.type === 'categories');

      let singleStats: ParseStats | undefined;

      switch (entityType) {
        case 'products': {
          singleStats = {
            xmlCharLength: 0, totalElementsFound: 0, totalProcessed: 0,
            skippedNoTitle: 0, skippedNoTitleOrSku: 0, duplicateSkus: 0, uniqueAfterDedup: 0,
          };
          const parsedData = parseProductsXML(text, singleStats);
          const productMap = new Map<string, typeof parsedData[0]>();
          parsedData.forEach(product => { if (product.sku) productMap.set(product.sku, product); });
          const uniqueProducts = Array.from(productMap.values());
          singleStats.duplicateSkus = parsedData.length - uniqueProducts.length;
          singleStats.uniqueAfterDedup = uniqueProducts.length;
          recordCount = uniqueProducts.length;
          console.log(`[Extract Single] Product stats:`, singleStats);
          for (let i = 0; i < uniqueProducts.length; i += 100) {
            const batch = uniqueProducts.slice(i, i + 100).map(product => ({
              project_id: project.id, external_id: product.sku, data: product as any, status: 'pending' as const,
            }));
            const { error } = await supabase.from('canonical_products').upsert(batch, { onConflict: 'project_id,external_id' });
            if (error) throw error;
          }
          if (!hasCategoriesFile) {
            const categories = new Set<string>();
            uniqueProducts.forEach(p => { if (p.category_external_ids) p.category_external_ids.forEach((c: string) => { if (c && !c.includes('#')) categories.add(c); }); });
            const categoryData = Array.from(categories).filter(Boolean).map(cat => ({
              project_id: project.id, external_id: cat, name: cat, shopify_tag: cat, status: 'pending' as const,
            }));
            if (categoryData.length > 0) {
              await supabase.from('canonical_categories').upsert(categoryData, { onConflict: 'project_id,external_id' });
            }
          }
          await onUpdateProject({ product_count: recordCount });
          break;
        }
        case 'customers': {
          const parsedData = parseCustomersXML(text);
          const customerMap = new Map<string, typeof parsedData[0]>();
          parsedData.forEach(c => { const key = c.external_id || c.email; if (key) customerMap.set(key, c); });
          const unique = Array.from(customerMap.values());
          recordCount = unique.length;
          for (let i = 0; i < unique.length; i += 100) {
            const batch = unique.slice(i, i + 100).map(c => ({
              project_id: project.id, external_id: c.external_id || c.email, data: c as any, status: 'pending' as const,
            }));
            const { error } = await supabase.from('canonical_customers').upsert(batch, { onConflict: 'project_id,external_id' });
            if (error) throw error;
          }
          await onUpdateProject({ customer_count: recordCount });
          break;
        }
        case 'orders': {
          const parsedData = parseOrdersXML(text);
          const orderMap = new Map<string, typeof parsedData[0]>();
          parsedData.forEach(o => { if (o.external_id) orderMap.set(o.external_id, o); });
          const unique = Array.from(orderMap.values());
          recordCount = unique.length;
          for (let i = 0; i < unique.length; i += 100) {
            const batch = unique.slice(i, i + 100).map(o => ({
              project_id: project.id, external_id: o.external_id, data: o as any, status: 'pending' as const,
            }));
            const { error } = await supabase.from('canonical_orders').upsert(batch, { onConflict: 'project_id,external_id' });
            if (error) throw error;
          }
          await onUpdateProject({ order_count: recordCount });
          break;
        }
        case 'categories': {
          const parsedData = parseCategoriesXML(text);
          const catMap = new Map<string, typeof parsedData[0]>();
          parsedData.forEach(c => { if (c.external_id) catMap.set(c.external_id, c); });
          const unique = Array.from(catMap.values());
          recordCount = unique.length;
          for (let i = 0; i < unique.length; i += 100) {
            const batch = unique.slice(i, i + 100).map(c => ({
              project_id: project.id, external_id: c.external_id, name: c.name || c.external_id,
              parent_external_id: c.parent_external_id || null, shopify_tag: c.name || c.external_id, status: 'pending' as const,
            }));
            const { error } = await supabase.from('canonical_categories').upsert(batch, { onConflict: 'project_id,external_id' });
            if (error) throw error;
          }
          await onUpdateProject({ category_count: recordCount });
          break;
        }
        case 'periods': {
          const periodsParsed = parsePeriodsXML(text);
          recordCount = periodsParsed.length;
          for (let i = 0; i < periodsParsed.length; i += 100) {
            const batch = periodsParsed.slice(i, i + 100).map(p => ({
              project_id: project.id, period_id: p.period_id, title: p.title,
              start_date: p.start_date, end_date: p.end_date, disabled: p.disabled,
            }));
            const { error } = await supabase.from('price_periods').upsert(batch, { onConflict: 'project_id,period_id' });
            if (error) throw error;
          }
          break;
        }
        case 'manufacturers': {
          const mfrParsed = parseManufacturersXML(text);
          recordCount = mfrParsed.length;

          const { error: deleteError } = await supabase
            .from('canonical_manufacturers')
            .delete()
            .eq('project_id', project.id);
          if (deleteError) throw deleteError;

          for (let i = 0; i < mfrParsed.length; i += 100) {
            const batch = mfrParsed.slice(i, i + 100).map(m => ({
              project_id: project.id, external_id: m.external_id, name: m.name,
            }));
            const { error } = await supabase.from('canonical_manufacturers').upsert(batch, { onConflict: 'project_id,external_id' });
            if (error) throw error;
          }
          break;
        }
      }

      await supabase.from('project_files').update({ row_count: recordCount, status: 'processed', error_message: null })
        .eq('project_id', project.id).eq('entity_type', entityType);

      setUploadedFiles(prev =>
        prev.map(f => f.type === entityType ? { ...f, status: 'success', count: recordCount, error: undefined, parseStats: singleStats } : f)
      );
    } catch (error: any) {
      console.error('Error processing file:', error);
      const errorMessage = error?.message || 'Ukendt fejl';
      await supabase.from('project_files').update({ status: 'error', error_message: errorMessage })
        .eq('project_id', project.id).eq('entity_type', entityType);
      setUploadedFiles(prev =>
        prev.map(f => f.type === entityType ? { ...f, status: 'error', error: errorMessage } : f)
      );
    }

    setProgress(100);
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
          Upload XML-filer fra DanDomain for at starte migreringen
        </p>
      </div>

      <input
        type="file"
        ref={fileInputRef}
        accept=".xml"
        onChange={handleFileChange}
        className="hidden"
      />

      <div className="grid gap-4">
        {(['products', 'categories', 'customers', 'orders', 'periods', 'manufacturers'] as UploadEntityType[]).map((entityType) => {
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
                        <div>
                          <p className="text-sm text-muted-foreground">
                            {uploadedFile.status === 'success' 
                              ? `${uploadedFile.count?.toLocaleString('da-DK')} rækker importeret`
                              : uploadedFile.status === 'error'
                              ? uploadedFile.error
                              : uploadedFile.file.name || config.acceptedLabel
                            }
                          </p>
                          {uploadedFile.parseStats && uploadedFile.status === 'success' && (
                            <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
                              <p>📄 XML: {uploadedFile.parseStats.xmlCharLength.toLocaleString('da-DK')} tegn</p>
                              <p>📦 &lt;PRODUCT&gt; elementer i XML: <span className="font-medium text-foreground">{uploadedFile.parseStats.totalElementsFound.toLocaleString('da-DK')}</span></p>
                              <p>✅ Gyldige produkter (med titel): <span className="font-medium text-foreground">{uploadedFile.parseStats.totalProcessed.toLocaleString('da-DK')}</span></p>
                              {uploadedFile.parseStats.duplicateSkus > 0 && (
                                <p>🔄 Varianter (duplikat-SKU, slået sammen): <span className="font-medium text-foreground">{uploadedFile.parseStats.duplicateSkus.toLocaleString('da-DK')}</span></p>
                              )}
                              {(uploadedFile.parseStats.skippedNoTitle + uploadedFile.parseStats.skippedNoTitleOrSku) > 0 && (
                                <p>⚠️ Sprunget over (mangler titel/SKU): <span className="font-medium text-amber-600">{(uploadedFile.parseStats.skippedNoTitle + uploadedFile.parseStats.skippedNoTitleOrSku).toLocaleString('da-DK')}</span></p>
                              )}
                              <p>🎯 Unikke produktrækker importeret: <span className="font-medium text-foreground">{uploadedFile.parseStats.uniqueAfterDedup.toLocaleString('da-DK')}</span></p>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">{config.acceptedLabel}</p>
                      )}
                    </div>
                  </div>
                  
                  {uploadedFile ? (
                    <div className="flex items-center gap-1">
                      {(uploadedFile.status === 'success' || uploadedFile.status === 'error') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleFileSelect(entityType)}
                          disabled={processing}
                          title="Erstat fil"
                        >
                          <Upload className="w-4 h-4 mr-1" />
                          Erstat
                        </Button>
                      )}
                      {(uploadedFile.status === 'success' || uploadedFile.status === 'error') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleProcessSingleFile(entityType)}
                          disabled={processing}
                          title="Kør udtræk igen for denne type"
                        >
                          <RefreshCw className="w-4 h-4 mr-1" />
                          Genudtræk
                        </Button>
                      )}
                      {uploadedFile.status === 'pending' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleProcessSingleFile(entityType)}
                          disabled={processing}
                        >
                          Kør udtræk
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeFile(entityType)}
                        disabled={processing}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
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

      <div className="flex justify-between gap-3 pt-4">
        <div>
          {allFilesProcessed && (
            <Button
              variant="outline"
              onClick={handleProcessFiles}
              disabled={uploadedFiles.length === 0 || processing}
            >
              {processing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Behandler...
                </>
              ) : (
                'Kør udtræk igen'
              )}
            </Button>
          )}
        </div>
        <div className="flex gap-3">
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
    </div>
  );
}
