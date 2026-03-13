import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { 
  Search, 
  Package, 
  FolderOpen, 
  FileText, 
  Check,
  ExternalLink,
  ImageOff
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OldUrlType } from '@/lib/redirect-matcher';

interface ShopifyDestinationSearchProps {
  projectId: string;
  currentValue: string;
  onSelect: (path: string, entity: ShopifyEntity) => void;
  disabled?: boolean;
  shopifyDomain?: string;
  inline?: boolean;
  /** Restrict results to only this old URL type (product→product, category→collection) */
  filterByOldType?: OldUrlType;
}

export interface ShopifyEntity {
  id: string;
  type: 'product' | 'collection' | 'page';
  title: string;
  handle: string;
  path: string;
  imageUrl?: string | null;
}

function generateShopifyHandle(title: string): string {
  return title.toLowerCase().trim()
    .replace(/[æ]/g, 'ae').replace(/[ø]/g, 'oe').replace(/[å]/g, 'aa')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').substring(0, 255);
}

export function ShopifyDestinationSearch({
  projectId,
  currentValue,
  onSelect,
  disabled = false,
  shopifyDomain,
  inline = false,
  filterByOldType,
}: ShopifyDestinationSearchProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [entities, setEntities] = useState<ShopifyEntity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && entities.length === 0) {
      loadEntities();
    }
  }, [open]);

  const loadEntities = async () => {
    setIsLoading(true);
    try {
      const allEntities: ShopifyEntity[] = [];

      // Products
      const { data: products } = await supabase
        .from('canonical_products')
        .select('id, data, shopify_id')
        .eq('project_id', projectId)
        .eq('status', 'uploaded');

      for (const product of products || []) {
        const data = product.data as Record<string, unknown>;
        const title = (data?.title as string) || 'Unavngivet produkt';
        const storedHandle = data?.shopify_handle as string | null;
        const handle = storedHandle || generateShopifyHandle(title);
        const images = (data?.images as string[]) || [];
        const imageUrl = images[0] || null;
        
        if (title && product.shopify_id) {
          allEntities.push({
            id: product.id,
            type: 'product',
            title,
            handle,
            path: `/products/${handle}`,
            imageUrl,
          });
        }
      }

      // Collections
      const { data: categories } = await supabase
        .from('canonical_categories')
        .select('id, name, shopify_tag, shopify_collection_id, shopify_handle')
        .eq('project_id', projectId)
        .eq('status', 'uploaded');

      for (const category of categories || []) {
        const storedHandle = (category as Record<string, unknown>).shopify_handle as string | null;
        const handle = storedHandle || generateShopifyHandle(category.shopify_tag || category.name);
        
        if (category.name && category.shopify_collection_id) {
          allEntities.push({
            id: category.id,
            type: 'collection',
            title: category.name,
            handle,
            path: `/collections/${handle}`,
            imageUrl: null,
          });
        }
      }

      // Pages
      const { data: pages } = await supabase
        .from('canonical_pages')
        .select('id, data, shopify_id')
        .eq('project_id', projectId)
        .eq('status', 'uploaded');

      for (const pg of pages || []) {
        const data = pg.data as Record<string, unknown>;
        const title = (data?.title as string) || 'Unavngivet side';
        const slug = data?.slug as string;
        const storedHandle = data?.shopify_handle as string | null;
        const handle = storedHandle || slug || generateShopifyHandle(title);
        
        if (title && pg.shopify_id) {
          allEntities.push({
            id: pg.id,
            type: 'page',
            title,
            handle,
            path: `/pages/${handle}`,
            imageUrl: null,
          });
        }
      }

      setEntities(allEntities);
    } catch (err) {
      console.error('Error loading entities:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Map old URL type to compatible Shopify type for filtering
  const compatibleType = useMemo(() => {
    if (!filterByOldType) return null;
    switch (filterByOldType) {
      case 'product': return 'product';
      case 'category': return 'collection';
      case 'page': return 'page';
      default: return null;
    }
  }, [filterByOldType]);

  const filteredEntities = useMemo(() => {
    let result = entities;

    // Type filter: strict — only show compatible type
    if (compatibleType) {
      result = result.filter(e => e.type === compatibleType);
    }

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        e => e.title.toLowerCase().includes(query) || 
             e.handle.toLowerCase().includes(query)
      );
    }

    return result.slice(0, 50);
  }, [entities, compatibleType, searchQuery]);

  const handleSelect = (entity: ShopifyEntity) => {
    onSelect(entity.path, entity);
    setOpen(false);
    setSearchQuery('');
  };

  const getEntityIcon = (type: string) => {
    switch (type) {
      case 'product': return <Package className="w-4 h-4 text-primary" />;
      case 'collection': return <FolderOpen className="w-4 h-4 text-primary/70" />;
      case 'page': return <FileText className="w-4 h-4 text-muted-foreground" />;
      default: return null;
    }
  };

  const getEntityTypeBadge = (type: string) => {
    switch (type) {
      case 'product': return <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Produkt</Badge>;
      case 'collection': return <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Kollektion</Badge>;
      case 'page': return <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Side</Badge>;
      default: return null;
    }
  };

  const typeLabel = compatibleType === 'product' ? 'produkter' : compatibleType === 'collection' ? 'kollektioner' : compatibleType === 'page' ? 'sider' : 'produkter, kollektioner eller sider';

  const triggerElement = inline ? (
    <PopoverTrigger asChild>
      <button
        className={cn(
          "flex items-center gap-2 w-full h-8 px-3 rounded-md border border-input bg-background text-sm",
          "hover:bg-accent hover:text-accent-foreground transition-colors",
          disabled && "opacity-50 cursor-not-allowed",
          !currentValue && "text-muted-foreground"
        )}
        disabled={disabled}
      >
        <Search className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        {currentValue ? (
          <span className="truncate font-mono text-xs">{currentValue}</span>
        ) : (
          <span className="truncate">Søg {typeLabel}...</span>
        )}
      </button>
    </PopoverTrigger>
  ) : (
    <PopoverTrigger asChild>
      <button
        className={cn(
          "h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md hover:bg-accent transition-colors",
          disabled && "opacity-50 cursor-not-allowed"
        )}
        disabled={disabled}
      >
        <Search className="h-4 w-4" />
      </button>
    </PopoverTrigger>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {triggerElement}
      <PopoverContent 
        className="w-[420px] p-0" 
        align="start"
        side="bottom"
        sideOffset={4}
      >
        <div className="p-3 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder={`Søg ${typeLabel}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
          {compatibleType && (
            <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
              {getEntityIcon(compatibleType)}
              Viser kun {typeLabel} (type-sikker filtrering)
            </div>
          )}
        </div>

        <ScrollArea className="h-[340px]">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Indlæser...
            </div>
          ) : filteredEntities.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {searchQuery ? 'Ingen resultater' : `Ingen uploadede ${typeLabel}`}
            </div>
          ) : (
            <div className="p-1">
              {filteredEntities.map((entity) => (
                <button
                  key={entity.id}
                  onClick={() => handleSelect(entity)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-md hover:bg-muted transition-colors",
                    "flex items-center gap-3 group",
                    currentValue === entity.path && "bg-muted"
                  )}
                >
                  {/* Product image thumbnail */}
                  <div className="w-10 h-10 rounded-md border border-border/60 bg-muted/30 flex items-center justify-center shrink-0 overflow-hidden">
                    {entity.imageUrl ? (
                      <img 
                        src={entity.imageUrl} 
                        alt={entity.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                          (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                        }}
                      />
                    ) : (
                      getEntityIcon(entity.type)
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">
                        {entity.title}
                      </span>
                      {getEntityTypeBadge(entity.type)}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground font-mono truncate">
                        {entity.path}
                      </span>
                      {shopifyDomain && (
                        <a
                          href={`https://${shopifyDomain.replace(/^https?:\/\//, '')}${entity.path}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <ExternalLink className="w-3 h-3 text-muted-foreground hover:text-primary" />
                        </a>
                      )}
                    </div>
                  </div>

                  <Check className={cn(
                    "w-4 h-4 shrink-0",
                    currentValue === entity.path ? "text-primary" : "text-transparent"
                  )} />
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
