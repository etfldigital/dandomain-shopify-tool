import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, ArrowRight, CheckCircle2, AlertCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

// Shopify metafield types organized by group
export const SHOPIFY_METAFIELD_TYPES = [
  // Anbefalet
  { value: 'single_line_text_field', label: 'Tekst med én linje', group: 'Anbefalede' },
  { value: 'multi_line_text_field', label: 'Tekst med flere linjer', group: 'Anbefalede' },
  { value: 'number_integer', label: 'Heltal', group: 'Anbefalede' },
  { value: 'file_reference', label: 'Billede (Fil)', group: 'Anbefalede' },
  
  // Tekst
  { value: 'rich_text_field', label: 'RTF', group: 'Tekst' },
  { value: 'list.single_line_text_field', label: 'Valgliste (Tekst med én linje)', group: 'Tekst' },
  { value: 'email', label: 'Mailadresse', group: 'Tekst' },
  
  // Medie
  { value: 'list.file_reference', label: 'Fil', group: 'Medie' },
  { value: 'list.media_image', label: 'Billede (Fil)', group: 'Medie' },
  { value: 'video_reference', label: 'Video (Fil)', group: 'Medie' },
  
  // Reference
  { value: 'article_reference', label: 'Blogopslag', group: 'Reference' },
  { value: 'collection_reference', label: 'Kollektion', group: 'Reference' },
  { value: 'company_reference', label: 'Firma', group: 'Reference' },
  { value: 'customer_reference', label: 'Kunde', group: 'Reference' },
  { value: 'metaobject_reference', label: 'Metaobjekt', group: 'Reference' },
  { value: 'order_reference', label: 'Ordre', group: 'Reference' },
  { value: 'page_reference', label: 'Side', group: 'Reference' },
  { value: 'product_reference', label: 'Produkt', group: 'Reference' },
  { value: 'variant_reference', label: 'Produktvariant', group: 'Reference' },
  
  // Tal
  { value: 'number_decimal', label: 'Decimaltal', group: 'Tal' },
  { value: 'rating', label: 'Bedømmelse', group: 'Tal' },
  { value: 'money', label: 'Penge', group: 'Tal' },
  { value: 'weight', label: 'Vægt', group: 'Tal' },
  { value: 'volume', label: 'Volumen', group: 'Tal' },
  { value: 'dimension', label: 'Dimension', group: 'Tal' },
  
  // Link
  { value: 'link', label: 'Link', group: 'Link' },
  { value: 'url', label: 'Webadresse', group: 'Link' },
  
  // Dato og tid
  { value: 'date', label: 'Dato', group: 'Dato og tid' },
  { value: 'date_time', label: 'Dato og klokkeslæt', group: 'Dato og tid' },
  
  // Andet
  { value: 'boolean', label: 'Sand eller falsk', group: 'Andet' },
  { value: 'color', label: 'Farve', group: 'Andet' },
  
  // Avanceret
  { value: 'json', label: 'JSON', group: 'Avanceret' },
  { value: 'mixed_reference', label: 'Blandet reference', group: 'Avanceret' },
];

const typeGroups = [...new Set(SHOPIFY_METAFIELD_TYPES.map(t => t.group))];

export interface NewMetafieldConfig {
  sourceField: string;
  targetField: string;
  metafieldName: string;
  metafieldType: string;
  status: 'pending' | 'creating' | 'success' | 'error';
  error?: string;
}

interface CreateMetafieldsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  newMetafields: { sourceField: string; targetField: string }[];
  onComplete: (createdMetafields: NewMetafieldConfig[]) => void;
}

export function CreateMetafieldsDialog({
  open,
  onOpenChange,
  projectId,
  newMetafields,
  onComplete,
}: CreateMetafieldsDialogProps) {
  const [configs, setConfigs] = useState<NewMetafieldConfig[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  // Initialize configs when dialog opens
  useEffect(() => {
    if (open && newMetafields.length > 0) {
      setConfigs(newMetafields.map(mf => {
        // Extract key from targetField (e.g., "metafields.custom.materiale" -> "materiale")
        const parts = mf.targetField.split('.');
        const key = parts[parts.length - 1];
        return {
          sourceField: mf.sourceField,
          targetField: mf.targetField,
          metafieldName: key,
          metafieldType: 'single_line_text_field',
          status: 'pending' as const,
        };
      }));
    }
  }, [open, newMetafields]);

  const updateConfig = (index: number, updates: Partial<NewMetafieldConfig>) => {
    setConfigs(prev => prev.map((c, i) => i === index ? { ...c, ...updates } : c));
  };

  const handleCreate = async () => {
    setIsCreating(true);
    const updatedConfigs = [...configs];

    for (let i = 0; i < updatedConfigs.length; i++) {
      const config = updatedConfigs[i];
      updateConfig(i, { status: 'creating' });

      try {
        const { data, error } = await supabase.functions.invoke('create-metafield-definition', {
          body: {
            projectId,
            name: config.metafieldName.charAt(0).toUpperCase() + config.metafieldName.slice(1).replace(/_/g, ' '),
            namespace: 'custom',
            key: config.metafieldName.toLowerCase().replace(/\s+/g, '_'),
            type: config.metafieldType,
            ownerType: 'PRODUCT',
          },
        });

        if (error) {
          
          updatedConfigs[i] = { ...updatedConfigs[i], status: 'error', error: error.message };
          updateConfig(i, { status: 'error', error: error.message });
        } else if (data?.success) {
          updatedConfigs[i] = { ...updatedConfigs[i], status: 'success' };
          updateConfig(i, { status: 'success' });
        } else {
          const errorMsg = data?.error || 'Ukendt fejl';
          updatedConfigs[i] = { ...updatedConfigs[i], status: 'error', error: errorMsg };
          updateConfig(i, { status: 'error', error: errorMsg });
        }
      } catch (err) {
        
        updatedConfigs[i] = { ...updatedConfigs[i], status: 'error', error: String(err) };
        updateConfig(i, { status: 'error', error: String(err) });
      }
    }

    setIsCreating(false);
    
    const successCount = updatedConfigs.filter(c => c.status === 'success').length;
    const errorCount = updatedConfigs.filter(c => c.status === 'error').length;
    
    if (errorCount === 0) {
      toast.success(`${successCount} metafelter oprettet i Shopify`);
    } else if (successCount > 0) {
      toast.warning(`${successCount} oprettet, ${errorCount} fejlede`);
    } else {
      toast.error('Kunne ikke oprette metafelter');
    }

    onComplete(updatedConfigs);
  };

  const allPending = configs.every(c => c.status === 'pending');
  const anyCreating = configs.some(c => c.status === 'creating');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Opret {newMetafields.length} nye metafelter i Shopify</DialogTitle>
          <DialogDescription>
            Følgende metafelter findes ikke i Shopify endnu. Vælg type for hvert felt inden de oprettes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-4 space-y-4">
          {configs.map((config, index) => (
            <div 
              key={config.targetField} 
              className="flex items-center gap-4 p-3 border rounded-lg bg-muted/30"
            >
              {/* Source field */}
              <div className="w-32 shrink-0">
                <Label className="text-xs text-muted-foreground">DanDomain</Label>
                <code className="text-sm font-mono block mt-1">{config.sourceField}</code>
              </div>

              <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />

              {/* Metafield name */}
              <div className="flex-1 min-w-0">
                <Label className="text-xs text-muted-foreground">Shopify metafelt navn</Label>
                <Input
                  value={config.metafieldName}
                  onChange={(e) => updateConfig(index, { metafieldName: e.target.value })}
                  className="h-8 text-sm mt-1"
                  disabled={config.status !== 'pending'}
                />
              </div>

              {/* Type selector */}
              <div className="w-48 shrink-0">
                <Label className="text-xs text-muted-foreground">Type</Label>
                <Select 
                  value={config.metafieldType} 
                  onValueChange={(v) => updateConfig(index, { metafieldType: v })}
                  disabled={config.status !== 'pending'}
                >
                  <SelectTrigger className="h-8 text-sm mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {typeGroups.map(group => (
                      <SelectGroup key={group}>
                        <SelectLabel className="text-xs">{group}</SelectLabel>
                        {SHOPIFY_METAFIELD_TYPES
                          .filter(t => t.group === group)
                          .map(type => (
                            <SelectItem key={type.value} value={type.value} className="text-sm">
                              {type.label}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Status indicator */}
              <div className="w-8 shrink-0 flex justify-center">
                {config.status === 'creating' && (
                  <Loader2 className="w-5 h-5 animate-spin text-primary" />
                )}
                {config.status === 'success' && (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                )}
                {config.status === 'error' && (
                  <span title={config.error}>
                    <AlertCircle className="w-5 h-5 text-destructive" />
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter className="border-t pt-4">
          <Button 
            variant="outline" 
            onClick={() => onOpenChange(false)} 
            disabled={isCreating}
          >
            Annuller
          </Button>
          <Button 
            onClick={handleCreate} 
            disabled={isCreating || !allPending || configs.some(c => !c.metafieldName.trim())}
          >
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Opretter...
              </>
            ) : anyCreating ? (
              'Opretter...'
            ) : (
              `Opret ${configs.length} metafelter i Shopify`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
