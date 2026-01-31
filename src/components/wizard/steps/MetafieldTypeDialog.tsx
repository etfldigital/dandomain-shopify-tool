import { useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';

export interface MetafieldType {
  value: string;
  label: string;
  group: string;
}

// Shopify metafield types organized by group
export const SHOPIFY_METAFIELD_TYPES: MetafieldType[] = [
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

// Group types for rendering
const typeGroups = [...new Set(SHOPIFY_METAFIELD_TYPES.map(t => t.group))];

interface MetafieldTypeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceField: string;
  onConfirm: (metafieldName: string, metafieldType: string) => void;
  isCreating?: boolean;
}

export function MetafieldTypeDialog({
  open,
  onOpenChange,
  sourceField,
  onConfirm,
  isCreating = false,
}: MetafieldTypeDialogProps) {
  // Default name based on source field (e.g., FIELD_1 -> materiale)
  const defaultName = sourceField.toLowerCase().replace(/_/g, '_');
  const [metafieldName, setMetafieldName] = useState(defaultName);
  const [metafieldType, setMetafieldType] = useState('single_line_text_field');

  const handleConfirm = () => {
    if (!metafieldName.trim()) return;
    onConfirm(metafieldName.trim().toLowerCase().replace(/\s+/g, '_'), metafieldType);
  };

  // Reset when dialog opens with new source field
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setMetafieldName(defaultName);
      setMetafieldType('single_line_text_field');
    }
    onOpenChange(isOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Opret nyt metafelt i Shopify</DialogTitle>
          <DialogDescription>
            Feltet <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{sourceField}</code> vil blive mappet til et nyt Shopify metafelt.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="metafield-name">Metafelt navn</Label>
            <Input
              id="metafield-name"
              value={metafieldName}
              onChange={(e) => setMetafieldName(e.target.value)}
              placeholder="f.eks. materiale"
            />
            <p className="text-xs text-muted-foreground">
              Bliver til: <code className="bg-muted px-1 py-0.5 rounded">metafields.custom.{metafieldName.toLowerCase().replace(/\s+/g, '_')}</code>
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="metafield-type">Metafelt type</Label>
            <Select value={metafieldType} onValueChange={setMetafieldType}>
              <SelectTrigger>
                <SelectValue placeholder="Vælg type..." />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {typeGroups.map(group => (
                  <SelectGroup key={group}>
                    <SelectLabel>{group}</SelectLabel>
                    {SHOPIFY_METAFIELD_TYPES
                      .filter(t => t.group === group)
                      .map(type => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCreating}>
            Annuller
          </Button>
          <Button onClick={handleConfirm} disabled={!metafieldName.trim() || isCreating}>
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Opretter...
              </>
            ) : (
              'Opret og tilføj'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
