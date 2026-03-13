import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { 
  Search, 
  Package, 
  FolderOpen, 
  FileText, 
  Pencil,
  Check,
  ExternalLink
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ShopifyDestinationSearchProps {
  projectId: string;
  currentValue: string;
  onSelect: (path: string) => void;
  disabled?: boolean;
  shopifyDomain?: string;
  inline?: boolean;
}

interface ShopifyEntity {
  id: string;
  type: 'product' | 'collection' | 'page';
  title: string;
  handle: string;
  path: string;
}

export function ShopifyDestinationSearch({
  projectId,
  currentValue,
  onSelect,
  disabled = false,
  shopifyDomain,
}: ShopifyDestinationSearchProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'products' | 'collections' | 'pages' | 'custom'>('all');
  const [entities, setEntities] = useState<ShopifyEntity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Load entities when popover opens
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
        .eq('status', 'uploaded')
        .not('shopify_id', 'is', null);

      for (const product of products || []) {
        const data = product.data as Record<string, unknown>;
        const title = (data?.title as string) || 'Unavngivet produkt';
        const storedHandle = data?.shopify_handle as string | null;
        const handle = storedHandle || generateShopifyHandle(title);
        
        allEntities.push({
          id: product.id,
          type: 'product',
          title,
          handle,
          path: `/products/${handle}`,
        });
      }

      // Collections (categories)
      const { data: categories } = await supabase
        .from('canonical_categories')
        .select('id, name, shopify_tag, shopify_collection_id')
        .eq('project_id', projectId)
        .eq('status', 'uploaded')
        .not('shopify_collection_id', 'is', null);

      for (const category of categories || []) {
        const handle = category.shopify_tag || generateShopifyHandle(category.name);
        
        allEntities.push({
          id: category.id,
          type: 'collection',
          title: category.name,
          handle,
          path: `/collections/${handle}`,
        });
      }

      // Pages
      const { data: pages } = await supabase
        .from('canonical_pages')
        .select('id, data, shopify_id')
        .eq('project_id', projectId)
        .eq('status', 'uploaded')
        .not('shopify_id', 'is', null);

      for (const page of pages || []) {
        const data = page.data as Record<string, unknown>;
        const title = (data?.title as string) || 'Unavngivet side';
        const slug = data?.slug as string;
        const storedHandle = data?.shopify_handle as string | null;
        const handle = storedHandle || slug || generateShopifyHandle(title);
        
        allEntities.push({
          id: page.id,
          type: 'page',
          title,
          handle,
          path: `/pages/${handle}`,
        });
      }

      setEntities(allEntities);
    } catch (err) {
      
    } finally {
      setIsLoading(false);
    }
  };

  // Generate proper Shopify handle - MUST NOT contain spaces!
  const generateShopifyHandle = (title: string): string => {
    return title
      .toLowerCase()
      .trim()
      .replace(/[æ]/g, 'ae')
      .replace(/[ø]/g, 'oe')
      .replace(/[å]/g, 'aa')
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/[^a-z0-9-]+/g, '-') // Replace non-alphanumeric (except hyphens) with hyphens
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
      .substring(0, 255);
  };

  // Filter entities based on search and tab
  const filteredEntities = useMemo(() => {
    let result = entities;

    // Filter by tab
    if (activeTab === 'products') {
      result = result.filter(e => e.type === 'product');
    } else if (activeTab === 'collections') {
      result = result.filter(e => e.type === 'collection');
    } else if (activeTab === 'pages') {
      result = result.filter(e => e.type === 'page');
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        e => e.title.toLowerCase().includes(query) || 
             e.handle.toLowerCase().includes(query) ||
             e.path.toLowerCase().includes(query)
      );
    }

    // Limit results
    return result.slice(0, 50);
  }, [entities, activeTab, searchQuery]);

  const handleSelect = (path: string) => {
    onSelect(path);
    setOpen(false);
    setSearchQuery('');
  };

  const handleCustomPathSubmit = () => {
    if (customPath.trim()) {
      let path = customPath.trim();
      if (!path.startsWith('/')) {
        path = '/' + path;
      }
      handleSelect(path);
      setCustomPath('');
    }
  };

  const getEntityIcon = (type: string) => {
    switch (type) {
      case 'product':
        return <Package className="w-4 h-4 text-primary" />;
      case 'collection':
        return <FolderOpen className="w-4 h-4 text-primary/70" />;
      case 'page':
        return <FileText className="w-4 h-4 text-muted-foreground" />;
      default:
        return null;
    }
  };

  const getEntityTypeBadge = (type: string) => {
    switch (type) {
      case 'product':
        return <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Produkt</Badge>;
      case 'collection':
        return <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Kollektion</Badge>;
      case 'page':
        return <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Side</Badge>;
      default:
        return null;
    }
  };

  const getShopifyPreviewUrl = (path: string): string | null => {
    if (!shopifyDomain) return null;
    let domain = shopifyDomain;
    if (!domain.startsWith('http')) {
      domain = 'https://' + domain;
    }
    domain = domain.replace(/\/$/, '');
    return domain + path;
  };

  const stats = useMemo(() => ({
    products: entities.filter(e => e.type === 'product').length,
    collections: entities.filter(e => e.type === 'collection').length,
    pages: entities.filter(e => e.type === 'page').length,
  }), [entities]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={disabled}
        >
          <Search className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent 
        className="w-[400px] p-0" 
        align="start"
        side="bottom"
        sideOffset={4}
      >
        <div className="p-3 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Søg efter produkt, kollektion eller side..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
          <div className="px-3 pt-2">
            <TabsList className="w-full grid grid-cols-5 h-8">
              <TabsTrigger value="all" className="text-xs px-1">
                Alle
              </TabsTrigger>
              <TabsTrigger value="products" className="text-xs px-1">
                <Package className="w-3 h-3 mr-1" />
                {stats.products}
              </TabsTrigger>
              <TabsTrigger value="collections" className="text-xs px-1">
                <FolderOpen className="w-3 h-3 mr-1" />
                {stats.collections}
              </TabsTrigger>
              <TabsTrigger value="pages" className="text-xs px-1">
                <FileText className="w-3 h-3 mr-1" />
                {stats.pages}
              </TabsTrigger>
              <TabsTrigger value="custom" className="text-xs px-1">
                <Pencil className="w-3 h-3 mr-1" />
                Skriv
              </TabsTrigger>
            </TabsList>
          </div>

          {activeTab !== 'custom' && (
            <TabsContent value={activeTab} className="mt-0">
              <ScrollArea className="h-[280px]">
                {isLoading ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    Indlæser...
                  </div>
                ) : filteredEntities.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    {searchQuery ? 'Ingen resultater' : 'Ingen uploadede elementer'}
                  </div>
                ) : (
                  <div className="p-1">
                    {filteredEntities.map((entity) => (
                      <button
                        key={entity.id}
                        onClick={() => handleSelect(entity.path)}
                        className={cn(
                          "w-full text-left px-3 py-2 rounded-md hover:bg-muted transition-colors",
                          "flex items-start gap-3 group"
                        )}
                      >
                        <div className="mt-0.5">
                          {getEntityIcon(entity.type)}
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
                                href={getShopifyPreviewUrl(entity.path) || '#'}
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
                          "w-4 h-4 mt-0.5 shrink-0",
                          currentValue === entity.path ? "text-primary" : "text-transparent"
                        )} />
                      </button>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>
          )}

          <TabsContent value="custom" className="mt-0">
            <div className="p-4 space-y-3">
              <div className="text-sm text-muted-foreground">
                Skriv en custom sti til Shopify (f.eks. <code>/pages/om-os</code>)
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="/collections/min-kollektion"
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleCustomPathSubmit();
                    }
                  }}
                />
                <Button 
                  onClick={handleCustomPathSubmit}
                  disabled={!customPath.trim()}
                >
                  Vælg
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                <strong>Eksempler:</strong>
                <ul className="mt-1 space-y-1">
                  <li><code>/products/produkt-handle</code> - Produktside</li>
                  <li><code>/collections/kollektion-handle</code> - Kollektion</li>
                  <li><code>/pages/side-handle</code> - Indholdside</li>
                  <li><code>/</code> - Forside</li>
                </ul>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
