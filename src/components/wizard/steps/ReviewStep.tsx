import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { 
  Loader2, 
  Copy, 
  Trash2, 
  AlertTriangle, 
  Package, 
  Users, 
  ShoppingCart, 
  Folder,
  CheckCircle2,
  Download,
  ExternalLink,
  Merge,
  Eye,
  ArrowRight,
} from 'lucide-react';
import { Project, EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface MergePreview {
  primaryProduct: {
    id: string;
    title: string;
    variantCount: number;
    variants: { sku: string; option: string; price: string }[];
  };
  duplicateProducts: {
    id: string;
    title: string;
    variantCount: number;
    variants: { sku: string; option: string; price: string }[];
  }[];
  newVariantsToAdd: { sku: string; option: string; price: string }[];
  productsToDelete: number;
  summary: {
    totalVariantsAfterMerge: number;
    variantsToAdd: number;
    productsToDelete: number;
  };
}

interface ReviewStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

interface DuplicateGroup {
  key: string;
  count: number;
  ids: string[];
  externalIds: string[];
  shopifyIds: string[];
  title?: string;
  items: any[];
}

export function ReviewStep({ project, onUpdateProject, onNext }: ReviewStepProps) {
  const [duplicates, setDuplicates] = useState<Record<EntityType, DuplicateGroup[]>>({
    products: [],
    customers: [],
    orders: [],
    categories: [],
    pages: [],
  });
  const [scanning, setScanning] = useState<EntityType | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedEntity, setExpandedEntity] = useState<EntityType | null>(null);
  const [downloadingCsv, setDownloadingCsv] = useState<EntityType | null>(null);
  const [deletingAll, setDeletingAll] = useState<EntityType | null>(null);
  const [mergingGroup, setMergingGroup] = useState<string | null>(null);
  const [mergingAll, setMergingAll] = useState<EntityType | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [mergePreview, setMergePreview] = useState<{ group: DuplicateGroup; preview: MergePreview } | null>(null);

  const scanForDuplicates = async (entityType: EntityType) => {
    setScanning(entityType);
    
    try {
      const tableName = `canonical_${entityType}` as const;
      
      // Fetch all items for the entity type
      let allItems: any[] = [];
      let page = 0;
      const pageSize = 1000;
      
      while (true) {
        const { data, error } = await supabase
          .from(tableName)
          .select('id, external_id, data, shopify_id')
          .eq('project_id', project.id)
          .range(page * pageSize, (page + 1) * pageSize - 1);
        
        if (error) throw error;
        if (!data || data.length === 0) break;
        
        allItems = [...allItems, ...data];
        if (data.length < pageSize) break;
        page++;
      }

      // Find duplicates based on different criteria
      const duplicateGroups: DuplicateGroup[] = [];
      
      if (entityType === 'products') {
        // For products: Find actual duplicates in Shopify by looking for
        // multiple DIFFERENT Shopify product IDs with the same title.
        // Multiple DB records with the same shopify_id = variants of same product (OK, not duplicates)
        
        // Step 1: Get unique Shopify product IDs with their titles
        const shopifyProductMap = new Map<string, { shopifyId: string; title: string; items: any[] }>();
        
        for (const item of allItems) {
          const shopifyId = item.shopify_id;
          
          if (shopifyId) {
            if (!shopifyProductMap.has(shopifyId)) {
              shopifyProductMap.set(shopifyId, {
                shopifyId,
                title: item.data?.title || 'Ukendt',
                items: [item],
              });
            } else {
              // Same Shopify ID = variants, add to existing group
              shopifyProductMap.get(shopifyId)!.items.push(item);
            }
          }
        }
        
        // Step 2: Group unique Shopify products by title
        const titleToShopifyProducts = new Map<string, { shopifyId: string; title: string; items: any[] }[]>();
        
        for (const product of shopifyProductMap.values()) {
          const titleKey = product.title.toLowerCase().trim();
          if (titleKey && titleKey !== 'untitled') {
            if (!titleToShopifyProducts.has(titleKey)) {
              titleToShopifyProducts.set(titleKey, []);
            }
            titleToShopifyProducts.get(titleKey)!.push(product);
          }
        }
        
        // Step 3: Only report as duplicates if there are multiple DIFFERENT Shopify products with same title
        for (const [titleKey, products] of titleToShopifyProducts) {
          if (products.length > 1) {
            // Multiple unique Shopify products with same title = real duplicates in Shopify
            const allItemsInGroup = products.flatMap(p => p.items);
            duplicateGroups.push({
              key: titleKey,
              count: products.length, // Count of unique Shopify products, not DB rows/variants
              ids: allItemsInGroup.map(i => i.id),
              externalIds: allItemsInGroup.map(i => i.external_id),
              shopifyIds: products.map(p => p.shopifyId), // Unique Shopify product IDs
              title: products[0].title,
              items: allItemsInGroup,
            });
          }
        }
      } else if (entityType === 'customers') {
        // Check for duplicate emails
        const emailMap = new Map<string, any[]>();
        for (const item of allItems) {
          const email = item.data?.email?.toLowerCase()?.trim();
          if (email) {
            if (!emailMap.has(email)) {
              emailMap.set(email, []);
            }
            emailMap.get(email)!.push(item);
          }
        }
        
        for (const [email, items] of emailMap) {
          if (items.length > 1) {
            duplicateGroups.push({
              key: email,
              count: items.length,
              ids: items.map(i => i.id),
              externalIds: items.map(i => i.external_id),
              shopifyIds: items.map(i => i.shopify_id).filter(Boolean),
              title: `${items[0].data?.first_name} ${items[0].data?.last_name}`,
              items: items,
            });
          }
        }
      } else if (entityType === 'orders') {
        // Check for duplicate order numbers/external_ids
        const orderMap = new Map<string, any[]>();
        for (const item of allItems) {
          const orderId = item.external_id;
          if (orderId) {
            if (!orderMap.has(orderId)) {
              orderMap.set(orderId, []);
            }
            orderMap.get(orderId)!.push(item);
          }
        }
        
        for (const [orderId, items] of orderMap) {
          if (items.length > 1) {
            duplicateGroups.push({
              key: orderId,
              count: items.length,
              ids: items.map(i => i.id),
              externalIds: items.map(i => i.external_id),
              shopifyIds: items.map(i => i.shopify_id).filter(Boolean),
              items: items,
            });
          }
        }
      } else if (entityType === 'categories') {
        // Check for duplicate category names
        const nameMap = new Map<string, any[]>();
        for (const item of allItems) {
          const name = (item as any).name?.toLowerCase()?.trim();
          if (name) {
            if (!nameMap.has(name)) {
              nameMap.set(name, []);
            }
            nameMap.get(name)!.push(item);
          }
        }
        
        for (const [name, items] of nameMap) {
          if (items.length > 1) {
            duplicateGroups.push({
              key: name,
              count: items.length,
              ids: items.map(i => i.id),
              externalIds: items.map(i => i.external_id),
              shopifyIds: items.map(i => (i as any).shopify_collection_id).filter(Boolean),
              title: (items[0] as any).name,
              items: items,
            });
          }
        }
      }
      
      // Sort by count descending
      duplicateGroups.sort((a, b) => b.count - a.count);
      
      setDuplicates(prev => ({
        ...prev,
        [entityType]: duplicateGroups,
      }));
      
      toast.success(`Fandt ${duplicateGroups.length} grupper af duplikater i ${entityType}`);
    } catch (error) {
      console.error('Error scanning for duplicates:', error);
      toast.error('Fejl ved scanning af duplikater');
    } finally {
      setScanning(null);
    }
  };

  const deleteDuplicates = async (entityType: EntityType, group: DuplicateGroup) => {
    // Keep the first one, delete the rest
    const idsToDelete = group.ids.slice(1);
    const tableName = `canonical_${entityType}` as const;
    
    try {
      const { error } = await supabase
        .from(tableName)
        .delete()
        .in('id', idsToDelete);
      
      if (error) throw error;
      
      // Update local state
      setDuplicates(prev => ({
        ...prev,
        [entityType]: prev[entityType].filter(g => g.key !== group.key),
      }));
      
      toast.success(`Slettede ${idsToDelete.length} duplikater fra databasen. Bemærk: Produkter i Shopify skal slettes manuelt.`);
    } catch (error) {
      console.error('Error deleting duplicates:', error);
      toast.error('Fejl ved sletning af duplikater');
    }
  };

  // Merge a single duplicate group as variants
  const mergeAsVariants = async (group: DuplicateGroup) => {
    if (group.shopifyIds.length < 2) {
      toast.error('Der skal være mindst 2 produkter i Shopify for at merge varianter');
      return;
    }

    setMergingGroup(group.key);

    try {
      const { data, error } = await supabase.functions.invoke('merge-variants', {
        body: {
          projectId: project.id,
          duplicateGroup: {
            key: group.key,
            shopifyIds: group.shopifyIds,
            itemIds: group.ids,
          },
        },
      });

      if (error) throw error;
      
      if (data.rateLimited) {
        toast.error(`Rate limited - vent ${Math.ceil(data.retryAfterMs / 1000)}s og prøv igen`);
        return;
      }

      if (!data.success) {
        throw new Error(data.error || 'Ukendt fejl');
      }

      // Remove this group from duplicates
      setDuplicates(prev => ({
        ...prev,
        products: prev.products.filter(g => g.key !== group.key),
      }));

      // Close preview dialog
      setMergePreview(null);

      toast.success(`Merged ${data.variantsAdded} varianter ind i produkt ${data.primaryProductId}. Slettede ${data.productsDeleted} duplikater fra Shopify.`);
    } catch (error) {
      console.error('Error merging variants:', error);
      toast.error(`Fejl ved merge: ${error instanceof Error ? error.message : 'Ukendt fejl'}`);
    } finally {
      setMergingGroup(null);
    }
  };

  // Preview merge without making changes
  const previewMerge = async (group: DuplicateGroup) => {
    if (group.shopifyIds.length < 2) {
      toast.error('Der skal være mindst 2 produkter i Shopify for at merge varianter');
      return;
    }

    setPreviewLoading(group.key);

    try {
      const { data, error } = await supabase.functions.invoke('merge-variants', {
        body: {
          projectId: project.id,
          dryRun: true,
          duplicateGroup: {
            key: group.key,
            shopifyIds: group.shopifyIds,
            itemIds: group.ids,
          },
        },
      });

      if (error) throw error;
      
      if (data.rateLimited) {
        toast.error(`Rate limited - vent ${Math.ceil(data.retryAfterMs / 1000)}s og prøv igen`);
        return;
      }

      if (!data.success || !data.preview) {
        throw new Error(data.error || 'Kunne ikke hente preview');
      }

      setMergePreview({ group, preview: data.preview });
    } catch (error) {
      console.error('Error previewing merge:', error);
      toast.error(`Fejl ved preview: ${error instanceof Error ? error.message : 'Ukendt fejl'}`);
    } finally {
      setPreviewLoading(null);
    }
  };

  // Merge all duplicate groups as variants
  const mergeAllAsVariants = async (entityType: EntityType) => {
    const groups = duplicates[entityType];
    if (groups.length === 0) return;
    
    // Only for products
    if (entityType !== 'products') {
      toast.error('Merge som varianter er kun tilgængelig for produkter');
      return;
    }

    // Filter to groups that have multiple Shopify IDs
    const mergeableGroups = groups.filter(g => g.shopifyIds.length >= 2);
    if (mergeableGroups.length === 0) {
      toast.error('Ingen grupper med flere Shopify produkter at merge');
      return;
    }

    setMergingAll(entityType);
    
    let successCount = 0;
    let errorCount = 0;

    for (const group of mergeableGroups) {
      try {
        const { data, error } = await supabase.functions.invoke('merge-variants', {
          body: {
            projectId: project.id,
            duplicateGroup: {
              key: group.key,
              shopifyIds: group.shopifyIds,
              itemIds: group.ids,
            },
          },
        });

        if (error) throw error;
        
        if (data.rateLimited) {
          toast.info(`Rate limited - venter ${Math.ceil(data.retryAfterMs / 1000)}s...`);
          await new Promise(r => setTimeout(r, data.retryAfterMs + 1000));
          // Retry this group
          const retryResult = await supabase.functions.invoke('merge-variants', {
            body: {
              projectId: project.id,
              duplicateGroup: {
                key: group.key,
                shopifyIds: group.shopifyIds,
                itemIds: group.ids,
              },
            },
          });
          if (retryResult.data?.success) {
            successCount++;
          } else {
            errorCount++;
          }
          continue;
        }

        if (data.success) {
          successCount++;
        } else {
          errorCount++;
        }
      } catch (error) {
        console.error(`Error merging group ${group.key}:`, error);
        errorCount++;
      }

      // Small delay between groups to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    }

    // Rescan to update the list
    await scanForDuplicates('products');

    setMergingAll(null);
    toast.success(`Merged ${successCount} grupper. ${errorCount > 0 ? `${errorCount} fejlede.` : ''}`);
  };

  const handleContinue = async () => {
    setSaving(true);
    await onUpdateProject({ status: 'completed' });
    setSaving(false);
    onNext();
  };

  const downloadDuplicatesCsv = async (entityType: EntityType) => {
    const groups = duplicates[entityType];
    if (groups.length === 0) {
      toast.error('Ingen duplikater at downloade');
      return;
    }

    setDownloadingCsv(entityType);

    try {
      let csv = '';
      
      if (entityType === 'products') {
        csv = 'Gruppe,Titel,External ID,Shopify ID,SKU,Pris,Status\n';
        for (const group of groups) {
          for (const item of group.items) {
            const d = item.data || {};
            csv += [
              `"${group.key.replace(/"/g, '""')}"`,
              `"${(d.title || '').replace(/"/g, '""')}"`,
              `"${item.external_id || ''}"`,
              `"${item.shopify_id || 'Ikke oprettet'}"`,
              `"${d.sku || ''}"`,
              `"${d.price || ''}"`,
              `"${item.shopify_id ? 'I Shopify' : 'Kun i database'}"`,
            ].join(',') + '\n';
          }
        }
      } else if (entityType === 'customers') {
        csv = 'Gruppe,Navn,Email,External ID,Shopify ID,Status\n';
        for (const group of groups) {
          for (const item of group.items) {
            const d = item.data || {};
            csv += [
              `"${group.key.replace(/"/g, '""')}"`,
              `"${(d.first_name || '')} ${(d.last_name || '')}"`,
              `"${d.email || ''}"`,
              `"${item.external_id || ''}"`,
              `"${item.shopify_id || 'Ikke oprettet'}"`,
              `"${item.shopify_id ? 'I Shopify' : 'Kun i database'}"`,
            ].join(',') + '\n';
          }
        }
      } else if (entityType === 'orders') {
        csv = 'Gruppe,Ordre ID,External ID,Shopify ID,Status\n';
        for (const group of groups) {
          for (const item of group.items) {
            csv += [
              `"${group.key.replace(/"/g, '""')}"`,
              `"${item.external_id || ''}"`,
              `"${item.external_id || ''}"`,
              `"${item.shopify_id || 'Ikke oprettet'}"`,
              `"${item.shopify_id ? 'I Shopify' : 'Kun i database'}"`,
            ].join(',') + '\n';
          }
        }
      } else if (entityType === 'categories') {
        csv = 'Gruppe,Navn,External ID,Shopify Collection ID,Status\n';
        for (const group of groups) {
          for (const item of group.items) {
            csv += [
              `"${group.key.replace(/"/g, '""')}"`,
              `"${(item as any).name || ''}"`,
              `"${item.external_id || ''}"`,
              `"${(item as any).shopify_collection_id || 'Ikke oprettet'}"`,
              `"${(item as any).shopify_collection_id ? 'I Shopify' : 'Kun i database'}"`,
            ].join(',') + '\n';
          }
        }
      }

      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `duplikater_${entityType}_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success('CSV downloadet');
    } finally {
      setDownloadingCsv(null);
    }
  };

  const deleteAllDuplicates = async (entityType: EntityType) => {
    const groups = duplicates[entityType];
    if (groups.length === 0) return;

    setDeletingAll(entityType);

    try {
      // Collect all IDs to delete (keep first of each group)
      const allIdsToDelete: string[] = [];
      for (const group of groups) {
        allIdsToDelete.push(...group.ids.slice(1));
      }

      if (allIdsToDelete.length === 0) {
        toast.info('Ingen duplikater at slette');
        return;
      }

      const tableName = `canonical_${entityType}` as const;

      // Delete in batches
      const batchSize = 100;
      for (let i = 0; i < allIdsToDelete.length; i += batchSize) {
        const batch = allIdsToDelete.slice(i, i + batchSize);
        const { error } = await supabase
          .from(tableName)
          .delete()
          .in('id', batch);

        if (error) throw error;
      }

      // Clear duplicates for this entity type
      setDuplicates(prev => ({
        ...prev,
        [entityType]: [],
      }));

      toast.success(`Slettede ${allIdsToDelete.length} duplikater fra databasen`);
    } catch (error) {
      console.error('Error deleting all duplicates:', error);
      toast.error('Fejl ved sletning af duplikater');
    } finally {
      setDeletingAll(null);
    }
  };

  const getTotalDuplicateCount = (entityType: EntityType) => {
    return duplicates[entityType].reduce((sum, g) => sum + g.count - 1, 0);
  };

  const getShopifyDuplicateCount = (entityType: EntityType) => {
    return duplicates[entityType].reduce((sum, g) => sum + (g.shopifyIds.length > 1 ? g.shopifyIds.length - 1 : 0), 0);
  };

  const entityIcons: Record<EntityType, React.ReactNode> = {
    products: <Package className="w-4 h-4" />,
    customers: <Users className="w-4 h-4" />,
    orders: <ShoppingCart className="w-4 h-4" />,
    categories: <Folder className="w-4 h-4" />,
    pages: <Folder className="w-4 h-4" />,
  };

  const entityLabels: Record<EntityType, string> = {
    products: 'Produkter',
    customers: 'Kunder',
    orders: 'Ordrer',
    categories: 'Kategorier',
    pages: 'Sider',
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-semibold mb-2">Gennemgang</h2>
        <p className="text-muted-foreground">
          Tjek for duplikater før du afslutter
        </p>
      </div>

      <Card>
            <CardHeader>
              <CardTitle className="text-lg">Scan for duplikater</CardTitle>
              <CardDescription>
                Find og fjern duplikerede records i dine data
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {(['products', 'customers', 'orders', 'categories'] as EntityType[]).map(entityType => (
                  <Button
                    key={entityType}
                    variant="outline"
                    onClick={() => scanForDuplicates(entityType)}
                    disabled={scanning !== null}
                    className="h-auto py-3 flex flex-col gap-1"
                  >
                    {scanning === entityType ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        {entityIcons[entityType]}
                        <span className="text-xs">{entityLabels[entityType]}</span>
                        {duplicates[entityType].length > 0 && (
                          <Badge variant="destructive" className="text-xs">
                            {duplicates[entityType].length}
                          </Badge>
                        )}
                      </>
                    )}
                  </Button>
                ))}
              </div>

              {/* Show duplicate results */}
              {Object.entries(duplicates).map(([entityType, groups]) => (
                groups.length > 0 && (
                  <Card key={entityType} className="border-destructive/50">
                    <CardHeader className="py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-destructive" />
                          <CardTitle className="text-sm">
                            {entityLabels[entityType as EntityType]} - {groups.length} duplikatgrupper
                          </CardTitle>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">
                            {getTotalDuplicateCount(entityType as EntityType)} ekstra i DB
                          </Badge>
                          {getShopifyDuplicateCount(entityType as EntityType) > 0 && (
                            <Badge variant="destructive" className="text-xs">
                              {getShopifyDuplicateCount(entityType as EntityType)} ekstra i Shopify
                            </Badge>
                          )}
                        </div>
                      </div>
                      <CardDescription className="text-xs mt-1">
                        {entityType === 'products' 
                          ? 'Disse produkter har samme titel men er oprettet som separate produkter. Du kan merge dem som varianter.'
                          : 'Produkter med Shopify ID er oprettet i din Shopify butik.'}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="py-0 pb-3 space-y-3">
                      {/* Action buttons */}
                      <div className="flex gap-2 flex-wrap">
                        {entityType === 'products' && getShopifyDuplicateCount('products') > 0 && (
                          <Button
                            variant="default"
                            size="sm"
                            onClick={() => mergeAllAsVariants('products')}
                            disabled={mergingAll === 'products'}
                            className="bg-primary"
                          >
                            {mergingAll === 'products' ? (
                              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                            ) : (
                              <Merge className="w-4 h-4 mr-1" />
                            )}
                            Merge alle som varianter
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadDuplicatesCsv(entityType as EntityType)}
                          disabled={downloadingCsv === entityType}
                        >
                          {downloadingCsv === entityType ? (
                            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                          ) : (
                            <Download className="w-4 h-4 mr-1" />
                          )}
                          Download CSV
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => deleteAllDuplicates(entityType as EntityType)}
                          disabled={deletingAll === entityType}
                        >
                          {deletingAll === entityType ? (
                            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4 mr-1" />
                          )}
                          Slet fra DB
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setExpandedEntity(expandedEntity === entityType ? null : entityType as EntityType)}
                        >
                          {expandedEntity === entityType ? 'Skjul detaljer' : `Vis ${groups.length} grupper`}
                        </Button>
                      </div>
                      
                      {/* Scrollable table */}
                      <ScrollArea className={expandedEntity === entityType ? "h-[500px]" : "h-64"}>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Titel/Nøgle</TableHead>
                              <TableHead className="w-20">Antal</TableHead>
                              <TableHead className="w-32">I Shopify?</TableHead>
                              <TableHead className="w-48">Shopify IDs</TableHead>
                              <TableHead className="w-28">Handling</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {groups.map(group => (
                              <TableRow key={group.key}>
                                <TableCell className="font-medium max-w-xs truncate" title={group.title || group.key}>
                                  {group.title || group.key}
                                </TableCell>
                                <TableCell>
                                  <Badge variant="destructive">{group.count}x</Badge>
                                </TableCell>
                                <TableCell>
                                  {group.shopifyIds.length > 0 ? (
                                    <Badge variant="default" className="bg-primary">
                                      {group.shopifyIds.length}x i Shopify
                                    </Badge>
                                  ) : (
                                    <Badge variant="secondary">Kun i DB</Badge>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <div className="flex flex-col gap-0.5">
                                    {group.shopifyIds.slice(0, 2).map((sid, i) => (
                                      <span key={i} className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                                        {sid}
                                        {entityType === 'products' && (
                                          <a 
                                            href={`https://admin.shopify.com/store/${project.shopify_store_domain?.replace('.myshopify.com', '')}/products/${sid}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-primary hover:underline"
                                          >
                                            <ExternalLink className="w-3 h-3" />
                                          </a>
                                        )}
                                      </span>
                                    ))}
                                    {group.shopifyIds.length > 2 && (
                                      <span className="text-xs text-muted-foreground">
                                        +{group.shopifyIds.length - 2} mere
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <div className="flex gap-1">
                                    {entityType === 'products' && group.shopifyIds.length >= 2 && (
                                      <>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => previewMerge(group)}
                                          disabled={previewLoading === group.key}
                                          title="Preview merge"
                                        >
                                          {previewLoading === group.key ? (
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                          ) : (
                                            <Eye className="w-4 h-4" />
                                          )}
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => mergeAsVariants(group)}
                                          disabled={mergingGroup === group.key}
                                          className="text-primary hover:text-primary"
                                          title="Merge som varianter"
                                        >
                                          {mergingGroup === group.key ? (
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                          ) : (
                                            <Merge className="w-4 h-4" />
                                          )}
                                        </Button>
                                      </>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => deleteDuplicates(entityType as EntityType, group)}
                                      className="text-destructive hover:text-destructive"
                                      title="Slet fra DB"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </ScrollArea>
                    </CardContent>
                  </Card>
                )
              ))}

              {Object.values(duplicates).every(g => g.length === 0) && (
                <div className="text-center py-8 text-muted-foreground">
                  <Copy className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>Klik på en entity-type ovenfor for at scanne for duplikater</p>
                  <p className="text-sm mt-2">Scanningen viser alle duplikater inkl. dem der er oprettet i Shopify</p>
                </div>
              )}
            </CardContent>
          </Card>

      <div className="flex justify-between gap-3 pt-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="w-4 h-4 text-green-500" />
          Upload gennemført - gennemgå og juster før afslutning
        </div>
        <Button onClick={handleContinue} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Gemmer...
            </>
          ) : (
            'Afslut og gå til rapport'
          )}
        </Button>
      </div>

      {/* Merge Preview Dialog */}
      <Dialog open={mergePreview !== null} onOpenChange={() => setMergePreview(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="w-5 h-5" />
              Preview: Merge "{mergePreview?.group.title || mergePreview?.group.key}"
            </DialogTitle>
            <DialogDescription>
              Se hvad der vil ske når du merger disse produkter som varianter
            </DialogDescription>
          </DialogHeader>

          {mergePreview && (
            <div className="space-y-4">
              {/* Summary */}
              <Card className="border-primary/50 bg-primary/5">
                <CardContent className="py-4">
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <div className="text-2xl font-bold text-primary">{mergePreview.preview.summary.variantsToAdd}</div>
                      <div className="text-sm text-muted-foreground">Varianter tilføjes</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-destructive">{mergePreview.preview.summary.productsToDelete}</div>
                      <div className="text-sm text-muted-foreground">Produkter slettes</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold">{mergePreview.preview.summary.totalVariantsAfterMerge}</div>
                      <div className="text-sm text-muted-foreground">Varianter i alt</div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Primary Product */}
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-primary" />
                    Primært produkt (beholdes)
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Shopify ID: {mergePreview.preview.primaryProduct.id}
                  </CardDescription>
                </CardHeader>
                <CardContent className="py-2">
                  <div className="text-sm font-medium mb-2">{mergePreview.preview.primaryProduct.title}</div>
                  <div className="text-xs text-muted-foreground mb-2">
                    Eksisterende varianter ({mergePreview.preview.primaryProduct.variantCount}):
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {mergePreview.preview.primaryProduct.variants.map((v, i) => (
                      <Badge key={i} variant="secondary" className="text-xs">
                        {v.option} - {v.sku || 'No SKU'} ({v.price} DKK)
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Duplicate Products */}
              <Card className="border-destructive/30">
                <CardHeader className="py-3">
                  <CardTitle className="text-sm flex items-center gap-2 text-destructive">
                    <Trash2 className="w-4 h-4" />
                    Duplikater (slettes fra Shopify)
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-2 space-y-3">
                  {mergePreview.preview.duplicateProducts.map((product, idx) => (
                    <div key={idx} className="border-l-2 border-destructive/30 pl-3">
                      <div className="text-xs text-muted-foreground">Shopify ID: {product.id}</div>
                      <div className="text-sm">{product.title}</div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {product.variants.map((v, i) => (
                          <Badge key={i} variant="outline" className="text-xs">
                            {v.option} - {v.sku || 'No SKU'}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* New Variants to Add */}
              {mergePreview.preview.newVariantsToAdd.length > 0 && (
                <Card className="border-primary/30">
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm flex items-center gap-2 text-primary">
                      <ArrowRight className="w-4 h-4" />
                      Nye varianter der tilføjes
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="py-2">
                    <div className="flex flex-wrap gap-1">
                      {mergePreview.preview.newVariantsToAdd.map((v, i) => (
                        <Badge key={i} className="text-xs bg-primary/10 text-primary border-primary/30">
                          {v.option} - {v.sku || 'No SKU'} ({v.price} DKK)
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {mergePreview.preview.newVariantsToAdd.length === 0 && (
                <Card className="border-muted">
                  <CardContent className="py-4 text-center text-muted-foreground">
                    <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">Ingen nye varianter at tilføje (alle varianter findes allerede)</p>
                    <p className="text-xs mt-1">Duplikaterne vil stadig blive slettet fra Shopify</p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setMergePreview(null)}>
              Annuller
            </Button>
            <Button
              onClick={() => mergePreview && mergeAsVariants(mergePreview.group)}
              disabled={mergingGroup !== null}
              className="gap-2"
            >
              {mergingGroup ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Merge className="w-4 h-4" />
              )}
              Udfør merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
