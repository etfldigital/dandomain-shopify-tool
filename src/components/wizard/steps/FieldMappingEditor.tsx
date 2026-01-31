import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, Trash2, AlertTriangle, Plus, ArrowRight, Save } from 'lucide-react';
import { EntityType } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { MetafieldTypeDialog, SHOPIFY_METAFIELD_TYPES } from './MetafieldTypeDialog';

interface FieldMappingEditorProps {
  projectId: string;
  showSaveButton?: boolean;
  onSave?: () => void;
}

export interface FieldMapping {
  id: string;
  sourceField: string;
  targetField: string;
  entityType: EntityType;
  metafieldType?: string; // Shopify metafield type (e.g., single_line_text_field)
}

// Base Shopify product fields that can be mapped
export const BASE_SHOPIFY_FIELDS = [
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
];

// For backwards compatibility
export const SHOPIFY_PRODUCT_FIELDS = BASE_SHOPIFY_FIELDS;

// Known source fields from DanDomain XML exports
export const KNOWN_SOURCE_FIELDS = [
  // GENERAL section
  'PROD_NUM',
  'PROD_NAME',
  'PROD_WEIGHT',
  'PROD_PHOTO_URL',
  'PROD_COST_PRICE',
  // PRICES section
  'UNIT_PRICE',
  'SPECIAL_OFFER_PRICE',
  // ADVANCED section
  'PROD_BARCODE_NUMBER',
  'VENDOR_NUM',
  'INTERNAL_ID',
  'PROD_HIDDEN',
  'PROD_NEW',
  'PROD_FRONT_PAGE',
  'DIRECT_LINK',
  // STOCK section
  'STOCK_COUNT',
  'STOCK_LIMIT',
  'PROD_LOCATION_NUMBER',
  // INFO section
  'PROD_CREATED',
  'PROD_EDITED',
  'PROD_VIEWED',
  'PROD_SALES_COUNT',
  // DESCRIPTION section
  'DESC_SHORT',
  'DESC_LONG',
  'META_DESCRIPTION',
  'TITLE',
  // MANUFACTURERS
  'MANUFAC_ID',
  // CUSTOM FIELDS (kun de anvendte)
  'FIELD_1',  // Materiale
  'FIELD_2',  // Farve
  'FIELD_3',  // Pasform
  'FIELD_9',  // Vaskeanvisning
];

interface ShopifyMetafield {
  namespace: string;
  key: string;
  name: string;
  type: string;
}

export function FieldMappingEditor({ projectId, showSaveButton = false, onSave }: FieldMappingEditorProps) {
  const [fieldMappings, setFieldMappings] = useState<FieldMapping[]>([]);
  const [newMapping, setNewMapping] = useState({ sourceField: '', targetField: '' });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchingMetafields, setFetchingMetafields] = useState(false);
  const [shopifyMetafields, setShopifyMetafields] = useState<ShopifyMetafield[]>([]);
  const [metafieldsLoaded, setMetafieldsLoaded] = useState(false);
  
  // New metafield dialog state
  const [showMetafieldDialog, setShowMetafieldDialog] = useState(false);
  const [pendingSourceField, setPendingSourceField] = useState('');
  const [creatingMetafield, setCreatingMetafield] = useState(false);

  // Combined list of Shopify fields including dynamically fetched metafields
  const allShopifyFields = [
    ...BASE_SHOPIFY_FIELDS,
    ...shopifyMetafields.map(mf => ({
      value: `metafields.${mf.namespace}.${mf.key}`,
      label: mf.name || `${mf.namespace}.${mf.key}`,
      isMetafield: true,
    })),
  ];

  useEffect(() => {
    loadFieldMappings();
  }, [projectId]);

  // Auto-fetch metafields on mount
  useEffect(() => {
    if (!metafieldsLoaded) {
      fetchShopifyMetafields(true);
    }
  }, [projectId, metafieldsLoaded]);

  const loadFieldMappings = async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('mapping_profiles')
        .select('*')
        .eq('project_id', projectId)
        .eq('is_active', true)
        .maybeSingle();

      if (data?.mappings) {
        const mappings = (data.mappings as any[]).filter(m => m.type === 'field');
        setFieldMappings(mappings.map((m, i) => ({
          id: `mapping-${i}`,
          sourceField: m.sourceField,
          targetField: m.targetField,
          entityType: m.entityType || 'products',
        })));
      }
    } catch (error) {
      console.error('Error loading field mappings:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchShopifyMetafields = async (silent = false) => {
    setFetchingMetafields(true);
    try {
      const { data, error } = await supabase.functions.invoke('fetch-metafields', {
        body: { projectId },
      });

      if (error) {
        console.error('Error fetching metafields:', error);
        if (!silent) toast.error('Kunne ikke hente metafelter fra Shopify');
        return;
      }

      if (data?.metafields) {
        setShopifyMetafields(data.metafields);
        setMetafieldsLoaded(true);
        if (!silent) toast.success(`Fandt ${data.metafields.length} metafelter fra Shopify`);
      }
    } catch (error) {
      console.error('Error fetching metafields:', error);
      if (!silent) toast.error('Fejl ved hentning af metafelter');
    } finally {
      setFetchingMetafields(false);
    }
  };

  // Handle when user selects "Create new metafield" option
  const handleTargetFieldChange = (value: string) => {
    if (value === '__create_new_metafield__') {
      if (!newMapping.sourceField) {
        toast.error('Vælg først et kilde felt');
        return;
      }
      setPendingSourceField(newMapping.sourceField);
      setShowMetafieldDialog(true);
    } else {
      setNewMapping(prev => ({ ...prev, targetField: value }));
    }
  };

  // Handle metafield creation from dialog
  const handleCreateMetafield = async (metafieldName: string, metafieldType: string) => {
    setCreatingMetafield(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-metafield-definition', {
        body: {
          projectId,
          name: metafieldName.charAt(0).toUpperCase() + metafieldName.slice(1).replace(/_/g, ' '),
          namespace: 'custom',
          key: metafieldName,
          type: metafieldType,
          ownerType: 'PRODUCT',
        },
      });

      if (error) {
        console.error('Error creating metafield:', error);
        toast.error('Fejl ved oprettelse af metafelt i Shopify');
        return;
      }

      if (data?.success) {
        const targetField = `metafields.custom.${metafieldName}`;
        
        // Add to local metafields list
        const newMetafield: ShopifyMetafield = {
          namespace: 'custom',
          key: metafieldName,
          name: metafieldName.charAt(0).toUpperCase() + metafieldName.slice(1).replace(/_/g, ' '),
          type: metafieldType,
        };
        setShopifyMetafields(prev => [...prev, newMetafield]);
        
        // Create and save the mapping
        const mapping: FieldMapping = {
          id: `mapping-${Date.now()}`,
          sourceField: pendingSourceField,
          targetField,
          entityType: 'products',
          metafieldType,
        };

        const updatedMappings = [...fieldMappings, mapping];
        setFieldMappings(updatedMappings);
        setNewMapping({ sourceField: '', targetField: '' });
        
        await saveMappings(updatedMappings);
        
        if (data.alreadyExists) {
          toast.success('Metafelt fandtes allerede - mapping tilføjet');
        } else {
          toast.success('Metafelt oprettet i Shopify og mapping tilføjet');
        }
        
        setShowMetafieldDialog(false);
      }
    } catch (error) {
      console.error('Error creating metafield:', error);
      toast.error('Fejl ved oprettelse af metafelt');
    } finally {
      setCreatingMetafield(false);
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

    const updatedMappings = [...fieldMappings, mapping];
    setFieldMappings(updatedMappings);
    setNewMapping({ sourceField: '', targetField: '' });
    
    // Auto-save when adding
    await saveMappings(updatedMappings);
    toast.success('Felt-mapping tilføjet');
  };

  const removeFieldMapping = async (id: string) => {
    const updatedMappings = fieldMappings.filter(m => m.id !== id);
    setFieldMappings(updatedMappings);
    
    // Auto-save when removing
    await saveMappings(updatedMappings);
    toast.success('Felt-mapping fjernet');
  };

  const saveMappings = async (mappings: FieldMapping[]) => {
    try {
      const { data: existing } = await supabase
        .from('mapping_profiles')
        .select('*')
        .eq('project_id', projectId)
        .eq('is_active', true)
        .maybeSingle();

      const mappingsData = mappings.map(m => ({
        type: 'field',
        sourceField: m.sourceField,
        targetField: m.targetField,
        entityType: m.entityType,
      }));

      if (existing) {
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
            project_id: projectId,
            name: 'Standard',
            mappings: mappingsData,
            is_active: true,
          });
      }
    } catch (error) {
      console.error('Error saving field mappings:', error);
      toast.error('Fejl ved gemning af felt-mappings');
    }
  };

  const handleSaveClick = async () => {
    setSaving(true);
    await saveMappings(fieldMappings);
    setSaving(false);
    toast.success('Felt-mappings gemt');
    onSave?.();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Feltmapping</CardTitle>
        <CardDescription>
          Map ekstra felter fra DanDomain XML til Shopify felter
          {fetchingMetafields && (
            <span className="ml-2 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 inline animate-spin mr-1" />
              Henter metafelter...
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Auto map button centered above columns */}
        <div className="flex justify-center">
          <Button
            onClick={addFieldMapping}
            disabled={!newMapping.sourceField || !newMapping.targetField}
          >
            <Plus className="w-4 h-4 mr-2" />
            Tilføj mapping
          </Button>
        </div>

        {/* Add new mapping */}
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <Label className="text-xs">Kilde felt</Label>
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
              onValueChange={handleTargetFieldChange}
            >
              <SelectTrigger>
                <SelectValue placeholder="Vælg mål felt..." />
              </SelectTrigger>
              <SelectContent>
                {allShopifyFields.map(field => (
                  <SelectItem key={field.value} value={field.value}>
                    <span className="flex items-center gap-2">
                      {field.label}
                      {'isMetafield' in field && field.isMetafield && (
                        <Badge variant="secondary" className="text-[10px] py-0 px-1.5 font-medium rounded-full">
                          Metafelt
                        </Badge>
                      )}
                    </span>
                  </SelectItem>
                ))}
                {/* Separator and create new option */}
                <SelectItem 
                  value="__create_new_metafield__" 
                  className="border-t mt-1 pt-2 text-primary font-medium"
                >
                  <span className="flex items-center gap-2">
                    <span className="flex items-center justify-center w-4 h-4 rounded-full bg-primary/10">
                      <Plus className="w-3 h-3 text-primary" />
                    </span>
                    Opret nyt metafelt...
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
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
                        {allShopifyFields.find(f => f.value === mapping.targetField)?.label || mapping.targetField}
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
                  Hvis dine produkter har stregkoder i PROD_BARCODE_NUMBER, kan du mappe dem til Shopify stregkode-feltet ovenfor.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {showSaveButton && (
          <div className="flex justify-end pt-2">
            <Button onClick={handleSaveClick} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Gemmer...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Gem mappings
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>

      {/* Metafield type dialog */}
      <MetafieldTypeDialog
        open={showMetafieldDialog}
        onOpenChange={setShowMetafieldDialog}
        sourceField={pendingSourceField}
        onConfirm={handleCreateMetafield}
        isCreating={creatingMetafield}
      />
    </Card>
  );
}
