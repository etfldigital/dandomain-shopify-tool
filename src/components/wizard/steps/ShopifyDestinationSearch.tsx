import { useState, useEffect, useMemo } from 'react';
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
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { matchesEntityQuery } from '@/lib/shopify-search';
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

interface LiveSearchResponse {
  success?: boolean;
  entities?: ShopifyEntity[];
  meta?: {
    indexedProducts?: number | null;
    shopifyProducts?: number | null;
    indexComplete?: boolean | null;
  };
  error?: string;
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
  const [liveEntities, setLiveEntities] = useState<ShopifyEntity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLiveSearching, setIsLiveSearching] = useState(false);

  useEffect(() => {
    if (open && entities.length === 0) {
      loadEntities();
    }
  }, [open]);

  const loadEntities = async () => {
    setIsLoading(true);
    try {
      const allEntities: ShopifyEntity[] = [];

      const fetchAllRows = async (
        table: 'canonical_products' | 'canonical_categories' | 'canonical_pages',
        select: string,
        projectIdVal: string,
      ) => {
        const PAGE_SIZE = 1000;
        let offset = 0;
        const allRows: any[] = [];
        while (true) {
          const { data, error } = await supabase
            .from(table)
            .select(select)
            .eq('project_id', projectIdVal)
            .eq('status', 'uploaded')
            .range(offset, offset + PAGE_SIZE - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          allRows.push(...data);
          if (data.length < PAGE_SIZE) break;
          offset += PAGE_SIZE;
        }
        return allRows;
      };

      // Products
      const products = await fetchAllRows('canonical_products', 'id, data, shopify_id', projectId);

      for (const product of products) {
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
      const categories = await fetchAllRows('canonical_categories', 'id, name, shopify_tag, shopify_collection_id, shopify_handle', projectId);

      for (const category of categories) {
        const handle = category.shopify_handle || generateShopifyHandle(category.shopify_tag || category.name);

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
      const pages = await fetchAllRows('canonical_pages', 'id, data, shopify_id', projectId);

      for (const pg of pages) {
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

  const localFilteredEntities = useMemo(() => {
    let result = entities;

    if (compatibleType) {
      result = result.filter((e) => e.type === compatibleType);
    }

    if (searchQuery.trim()) {
      result = result.filter((e) => matchesEntityQuery(e, searchQuery));
    }

    return result.slice(0, 50);
  }, [entities, compatibleType, searchQuery]);

  // Live Shopify fallback search for stores where local uploaded entities are incomplete
  useEffect(() => {
    if (!open) return;

    const query = searchQuery.trim();
    if (query.length < 2) {
      setLiveEntities([]);
      setIsLiveSearching(false);
      return;
    }

    const timeoutId = window.setTimeout(async () => {
      setIsLiveSearching(true);
      try {
        const { data, error } = await supabase.functions.invoke('search-shopify-entities', {
          body: {
            projectId,
            query,
            type: compatibleType ?? undefined,
            limit: 30,
          },
        });

        if (error) throw error;

        const response = (data || {}) as LiveSearchResponse;
        const candidates = Array.isArray(response.entities) ? response.entities : [];
        const safeEntities = candidates
          .filter((e) => !compatibleType || e.type === compatibleType)
          .filter((e) => matchesEntityQuery(e, query));

        setLiveEntities(safeEntities);
      } catch (err) {
        console.error('Live Shopify search failed:', err);
        setLiveEntities([]);
      } finally {
        setIsLiveSearching(false);
      }
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [open, searchQuery, projectId, compatibleType]);

  const filteredEntities = useMemo(() => {
    if (liveEntities.length === 0) return localFilteredEntities;

    const merged: ShopifyEntity[] = [...localFilteredEntities];
    const existingByPath = new Set(merged.map((e) => e.path));

    for (const entity of liveEntities) {
      if (!existingByPath.has(entity.path)) {
        merged.push(entity);
        existingByPath.add(entity.path);
      }
    }

    return merged.slice(0, 50);
  }, [localFilteredEntities, liveEntities]);

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
          'flex items-center gap-2 w-full h-8 px-3 rounded-md border border-input bg-background text-sm',
          'hover:bg-accent hover:text-accent-foreground transition-colors',
          disabled && 'opacity-50 cursor-not-allowed',
          !currentValue && 'text-muted-foreground'
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
          'h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md hover:bg-accent transition-colors',
          disabled && 'opacity-50 cursor-not-allowed'
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
          {searchQuery.trim().length >= 2 && (
            <div className="mt-1 text-[11px] text-muted-foreground">
              Søger både i uploadede data og live i Shopify
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
              {isLiveSearching
                ? 'Søger i Shopify...'
                : searchQuery
                  ? 'Ingen resultater'
                  : `Ingen uploadede ${typeLabel}`}
            </div>
          ) : (
            <div className="p-1">
              {filteredEntities.map((entity) => (
                <button
                  key={`${entity.type}-${entity.id}-${entity.path}`}
                  onClick={() => handleSelect(entity)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-md hover:bg-muted transition-colors',
                    'flex items-center gap-3 group',
                    currentValue === entity.path && 'bg-muted'
                  )}
                >
                  <div className="w-10 h-10 rounded-md border border-border/60 bg-muted/30 flex items-center justify-center shrink-0 overflow-hidden">
                    {entity.imageUrl ? (
                      <img
                        src={entity.imageUrl}
                        alt={entity.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
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
                    'w-4 h-4 shrink-0',
                    currentValue === entity.path ? 'text-primary' : 'text-transparent'
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
