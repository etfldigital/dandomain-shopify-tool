import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
  Loader2, 
  Copy, 
  Trash2, 
  AlertTriangle, 
  Package, 
  Users, 
  ShoppingCart, 
  Folder,
  Plus,
  ArrowRight,
  Search,
  CheckCircle2,
  Download,
  ExternalLink
} from 'lucide-react';
import { Project, EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

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

interface FieldMapping {
  id: string;
  sourceField: string;
  targetField: string;
  entityType: EntityType;
}

// Common Shopify product fields that can be mapped
const SHOPIFY_PRODUCT_FIELDS = [
  { value: 'title', label: 'Titel' },
  { value: 'body_html', label: 'Beskrivelse (HTML)' },
  { value: 'vendor', label: 'Leverandør' },
  { value: 'product_type', label: 'Produkttype' },
  { value: 'tags', label: 'Tags' },
  { value: 'variants[0].sku', label: 'SKU' },
  { value: 'variants[0].barcode', label: 'Stregkode' },
  { value: 'variants[0].price', label: 'Pris' },
  { value: 'variants[0].compare_at_price', label: 'Sammenlign ved pris' },
  { value: 'variants[0].weight', label: 'Vægt' },
  { value: 'variants[0].inventory_quantity', label: 'Lagerbeholdning' },
  { value: 'metafields.custom.field', label: 'Brugerdefineret metafelt' },
];

// Known source fields from DanDomain CSV
const KNOWN_SOURCE_FIELDS = [
  'PROD_BARCODE_NUMBER',
  'PROD_EAN',
  'PROD_MANUFACTURER',
  'PROD_SUPPLIER',
  'PROD_COST_PRICE',
  'PROD_WEIGHT',
  'PROD_WIDTH',
  'PROD_HEIGHT',
  'PROD_DEPTH',
  'PROD_META_TITLE',
  'PROD_META_DESCRIPTION',
  'PROD_META_KEYWORDS',
];

export function ReviewStep({ project, onUpdateProject, onNext }: ReviewStepProps) {
  const [activeTab, setActiveTab] = useState('duplicates');
  const [loading, setLoading] = useState(false);
  const [duplicates, setDuplicates] = useState<Record<EntityType, DuplicateGroup[]>>({
    products: [],
    customers: [],
    orders: [],
    categories: [],
    pages: [],
  });
  const [scanning, setScanning] = useState<EntityType | null>(null);
  const [fieldMappings, setFieldMappings] = useState<FieldMapping[]>([]);
  const [newMapping, setNewMapping] = useState({ sourceField: '', targetField: '' });
  const [saving, setSaving] = useState(false);
  const [expandedEntity, setExpandedEntity] = useState<EntityType | null>(null);
  const [downloadingCsv, setDownloadingCsv] = useState<EntityType | null>(null);
  const [deletingAll, setDeletingAll] = useState<EntityType | null>(null);

  // Load existing field mappings from project or mapping_profiles
  useEffect(() => {
    loadFieldMappings();
  }, [project.id]);

  const loadFieldMappings = async () => {
    const { data } = await supabase
      .from('mapping_profiles')
      .select('*')
      .eq('project_id', project.id)
      .eq('is_active', true)
      .single();

    if (data?.mappings) {
      // Parse field mappings from the profile
      const mappings = (data.mappings as any[]).filter(m => m.type === 'field');
      setFieldMappings(mappings.map((m, i) => ({
        id: `mapping-${i}`,
        sourceField: m.sourceField,
        targetField: m.targetField,
        entityType: m.entityType || 'products',
      })));
    }
  };

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
        // Check for duplicate titles among items that have shopify_id (actually created in Shopify)
        const titleMap = new Map<string, any[]>();
        for (const item of allItems) {
          const title = item.data?.title?.toLowerCase()?.trim();
          if (title && title !== 'untitled') {
            if (!titleMap.has(title)) {
              titleMap.set(title, []);
            }
            titleMap.get(title)!.push(item);
          }
        }
        
        for (const [title, items] of titleMap) {
          if (items.length > 1) {
            duplicateGroups.push({
              key: title,
              count: items.length,
              ids: items.map(i => i.id),
              externalIds: items.map(i => i.external_id),
              shopifyIds: items.map(i => i.shopify_id).filter(Boolean),
              title: items[0].data?.title,
              items: items,
            });
          }
        }
        
        // Check for duplicate SKUs
        const skuMap = new Map<string, any[]>();
        for (const item of allItems) {
          const sku = item.data?.sku?.toLowerCase()?.trim();
          if (sku) {
            if (!skuMap.has(sku)) {
              skuMap.set(sku, []);
            }
            skuMap.get(sku)!.push(item);
          }
        }
        
        for (const [sku, items] of skuMap) {
          if (items.length > 1) {
            const existing = duplicateGroups.find(g => 
              g.ids.some(id => items.some(i => i.id === id))
            );
            if (!existing) {
              duplicateGroups.push({
                key: `SKU: ${sku}`,
                count: items.length,
                ids: items.map(i => i.id),
                externalIds: items.map(i => i.external_id),
                shopifyIds: items.map(i => i.shopify_id).filter(Boolean),
                title: items[0].data?.title,
                items: items,
              });
            }
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

  const addFieldMapping = async () => {
    if (!newMapping.sourceField || !newMapping.targetField) {
      toast.error('Vælg både kilde- og målfelt');
      return;
    }

    const mapping: FieldMapping = {
      id: `mapping-${Date.now()}`,
      sourceField: newMapping.sourceField,
      targetField: newMapping.targetField,
      entityType: 'products',
    };

    setFieldMappings(prev => [...prev, mapping]);
    setNewMapping({ sourceField: '', targetField: '' });
    toast.success('Felt-mapping tilføjet');
  };

  const removeFieldMapping = (id: string) => {
    setFieldMappings(prev => prev.filter(m => m.id !== id));
  };

  const saveFieldMappings = async () => {
    setSaving(true);
    
    try {
      // Get or create mapping profile
      const { data: existing } = await supabase
        .from('mapping_profiles')
        .select('*')
        .eq('project_id', project.id)
        .eq('is_active', true)
        .single();

      const mappingsData = fieldMappings.map(m => ({
        type: 'field',
        sourceField: m.sourceField,
        targetField: m.targetField,
        entityType: m.entityType,
      }));

      if (existing) {
        // Merge with existing mappings
        const existingMappings = (existing.mappings as any[]) || [];
        const otherMappings = existingMappings.filter(m => m.type !== 'field');
        
        await supabase
          .from('mapping_profiles')
          .update({ 
            mappings: [...otherMappings, ...mappingsData],
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('mapping_profiles')
          .insert({
            project_id: project.id,
            name: 'Standard',
            mappings: mappingsData,
            is_active: true,
          });
      }

      toast.success('Felt-mappings gemt');
    } catch (error) {
      console.error('Error saving field mappings:', error);
      toast.error('Fejl ved gemning af felt-mappings');
    } finally {
      setSaving(false);
    }
  };

  const handleContinue = async () => {
    setSaving(true);
    await saveFieldMappings();
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
        <h2 className="text-2xl font-semibold mb-2">Gennemgang & Justering</h2>
        <p className="text-muted-foreground">
          Tjek for duplikater og tilføj ekstra felt-mappings før du afslutter
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="duplicates" className="gap-2">
            <Copy className="w-4 h-4" />
            Duplikater
          </TabsTrigger>
          <TabsTrigger value="field-mappings" className="gap-2">
            <ArrowRight className="w-4 h-4" />
            Felt-Mappings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="duplicates" className="mt-6 space-y-4">
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
                        Produkter med Shopify ID er oprettet i din Shopify butik og skal slettes manuelt der.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="py-0 pb-3 space-y-3">
                      {/* Action buttons */}
                      <div className="flex gap-2 flex-wrap">
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
                          Download alle ({groups.length} grupper) som CSV
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
                          Slet alle {getTotalDuplicateCount(entityType as EntityType)} duplikater fra DB
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setExpandedEntity(expandedEntity === entityType ? null : entityType as EntityType)}
                        >
                          {expandedEntity === entityType ? 'Skjul detaljer' : `Vis alle ${groups.length} grupper`}
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
                                    <Badge variant="default" className="bg-green-600">
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
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => deleteDuplicates(entityType as EntityType, group)}
                                    className="text-destructive hover:text-destructive"
                                  >
                                    <Trash2 className="w-4 h-4 mr-1" />
                                    Slet {group.count - 1}
                                  </Button>
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
                  <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>Klik på en entity-type ovenfor for at scanne for duplikater</p>
                  <p className="text-sm mt-2">Scanningen viser alle duplikater inkl. dem der er oprettet i Shopify</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="field-mappings" className="mt-6 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Tilføj felt-mappings</CardTitle>
              <CardDescription>
                Map ekstra felter fra DanDomain CSV til Shopify felter
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Add new mapping */}
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <Label className="text-xs">Kilde felt (DanDomain)</Label>
                  <Select
                    value={newMapping.sourceField}
                    onValueChange={(v) => setNewMapping(prev => ({ ...prev, sourceField: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Vælg kilde felt..." />
                    </SelectTrigger>
                    <SelectContent>
                      {KNOWN_SOURCE_FIELDS.map(field => (
                        <SelectItem key={field} value={field}>
                          {field}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <ArrowRight className="w-5 h-5 text-muted-foreground mb-2" />
                <div className="flex-1">
                  <Label className="text-xs">Mål felt (Shopify)</Label>
                  <Select
                    value={newMapping.targetField}
                    onValueChange={(v) => setNewMapping(prev => ({ ...prev, targetField: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Vælg mål felt..." />
                    </SelectTrigger>
                    <SelectContent>
                      {SHOPIFY_PRODUCT_FIELDS.map(field => (
                        <SelectItem key={field.value} value={field.value}>
                          {field.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={addFieldMapping} size="icon">
                  <Plus className="w-4 h-4" />
                </Button>
              </div>

              {/* Existing mappings */}
              {fieldMappings.length > 0 ? (
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Kilde felt (DanDomain)</TableHead>
                        <TableHead></TableHead>
                        <TableHead>Mål felt (Shopify)</TableHead>
                        <TableHead className="w-16"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fieldMappings.map(mapping => (
                        <TableRow key={mapping.id}>
                          <TableCell className="font-mono text-sm">
                            {mapping.sourceField}
                          </TableCell>
                          <TableCell className="w-12">
                            <ArrowRight className="w-4 h-4 text-muted-foreground" />
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">
                              {SHOPIFY_PRODUCT_FIELDS.find(f => f.value === mapping.targetField)?.label || mapping.targetField}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeFieldMapping(mapping.id)}
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground border rounded-lg">
                  <Plus className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>Ingen ekstra felt-mappings tilføjet endnu</p>
                  <p className="text-sm">Brug dropdown ovenfor til at tilføje mappings</p>
                </div>
              )}

              {/* Common mapping suggestion */}
              <Card className="bg-muted/50 border-dashed">
                <CardContent className="py-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5" />
                    <div>
                      <p className="font-medium text-sm">Forslag: Stregkode mapping</p>
                      <p className="text-sm text-muted-foreground">
                        Du nævnte at PROD_BARCODE_NUMBER skal mappes til Shopify stregkode. 
                        Tilføj denne mapping ovenfor.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

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
    </div>
  );
}
