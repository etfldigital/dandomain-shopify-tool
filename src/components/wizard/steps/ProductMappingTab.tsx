import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, ArrowRight, Package, AlertTriangle, Check, X, Plus, Trash2, ChevronLeft, ChevronRight, Shuffle, ImageIcon, FileText, Wand2, Settings, Link2, Eye, RefreshCw, Search } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { ProductData } from '@/types/database';
import { toast } from 'sonner';
import { CreateMetafieldsDialog, NewMetafieldConfig } from './CreateMetafieldsDialog';

interface ProductMappingTabProps {
  projectId: string;
}

// Vendor extraction mode for the new title-based rule
type VendorExtractionMode = 'none' | 'extract_from_title';

interface MappingRules {
  stripVendorFromTitle: boolean;
  vendorSeparator: string;
  excludeUntitled: boolean;
  excludeZeroPrice: boolean;
  excludeNoImages: boolean;
  // New: Vendor extraction from product title
  vendorExtractionMode: VendorExtractionMode;
  // Barcode inheritance: apply primary product barcode to variants missing one
  inheritProductBarcode: boolean;
  // Period pricing (Periodestyring): apply period prices as sale prices
  applyPeriodPricing: boolean;
}

// Known compound product types (two words) for vendor extraction
const KNOWN_COMPOUND_PRODUCT_TYPES = [
  'BODY LOTION',
  'HAND SOAP',
  'FACE CREAM',
  'BODY WASH',
  'HAND CREAM',
  'BODY OIL',
  'FACE OIL',
  'SHOWER GEL',
  'BODY SCRUB',
  'LIP BALM',
];

interface FieldMapping {
  id: string;
  sourceField: string;
  targetField: string;
}

interface ShopifyMetafield {
  namespace: string;
  key: string;
  name: string;
  type: string;
}

// Base Shopify product fields that can be mapped
const BASE_SHOPIFY_FIELDS = [
  { value: 'title', label: 'Titel' },
  { value: 'body_html', label: 'Beskrivelse (HTML)' },
  { value: 'vendor', label: 'Leverandør' },
  { value: 'product_type', label: 'Produkttype' },
  { value: 'tags', label: 'Tags' },
  { value: 'variants[0].sku', label: 'SKU' },
  { value: 'variants[0].barcode', label: 'Stregkode' },
  { value: 'variants[0].price', label: 'Pris' },
  { value: 'variants[0].compare_at_price', label: 'Sammenlign ved pris' },
  { value: 'variants[0].cost', label: 'Kostpris' },
  { value: 'variants[0].weight', label: 'Vægt' },
  { value: 'variants[0].inventory_quantity', label: 'Lagerbeholdning' },
  { value: 'metafields_global_title_tag', label: 'SEO Titel' },
  { value: 'metafields_global_description_tag', label: 'SEO Beskrivelse' },
];

// Known source fields from DanDomain XML exports
const KNOWN_SOURCE_FIELDS = [
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
  'INTERNAL_ID',
  'PROD_HIDDEN',
  // STOCK section
  'STOCK_COUNT',
  // DESCRIPTION section
  'DESC_SHORT',
  'DESC_LONG',
  'META_DESCRIPTION',
  'META_TITLE',
  // MANUFACTURERS
  'MANUFAC_ID',
  // INFO section
  'PROD_CREATED',
  'PROD_SALES_COUNT',
  // CUSTOM FIELDS (kun de anvendte)
  'FIELD_1',  // Materiale
  'FIELD_2',  // Farve
  'FIELD_3',  // Pasform
  'FIELD_9',  // Vaskeanvisning
];

// Auto-map suggestions: DanDomain field -> Shopify field
const AUTO_MAP_SUGGESTIONS: { source: string; target: string }[] = [
  { source: 'PROD_NUM', target: 'variants[0].sku' },
  { source: 'PROD_BARCODE_NUMBER', target: 'variants[0].barcode' },
  { source: 'UNIT_PRICE', target: 'variants[0].price' },
  { source: 'SPECIAL_OFFER_PRICE', target: 'variants[0].compare_at_price' },
  { source: 'PROD_COST_PRICE', target: 'variants[0].cost' },
  { source: 'PROD_WEIGHT', target: 'variants[0].weight' },
  { source: 'STOCK_COUNT', target: 'variants[0].inventory_quantity' },
  { source: 'MANUFAC_ID', target: 'vendor' },
  { source: 'DESC_LONG', target: 'body_html' },
];

interface ProductRef {
  id: string;
  external_id: string;
  title?: string;
}

interface VariantData {
  size: string;
  sku: string;
  price: number;
  compareAtPrice: number | null;
  stockQuantity: number;
  barcode: string | null;
}

// Helper function to safely parse price values that might be strings (e.g., "639.60 kr.")
const parsePrice = (value: any): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Remove currency suffix and whitespace, replace comma with dot for Danish format
    const cleaned = value.replace(/[^\d.,\-]/g, '').replace(',', '.').trim();
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

// Helper function to safely format price for display
const formatPrice = (value: any): string => {
  const num = parsePrice(value);
  return num.toFixed(2);
};

interface ProductPreviewData {
  original: {
    title: string;
    body_html: string;
    sku: string;
    price: number;
    cost_price: number | null;
    compare_at_price: number | null;
    stock_quantity: number;
    weight: number | null;
    images: string[];
    vendor: string | null;
    category_ids: string[];
    barcode: string | null;
    rawData: Record<string, any>; // Store raw data for field mapping
    // Custom fields for metafield display
    field_1: string | null;
    field_2: string | null;
    field_3: string | null;
    field_9: string | null;
    // SEO fields
    meta_title: string | null;
    meta_description: string | null;
  };
  transformed: {
    title: string;
    vendor: string;
    sku: string;
    barcode: string;
    price: number;
    compare_at_price: number | null;
    cost_price: number | null;
    weight: number | null;
    stock_quantity: number;
    body_html: string;
    // SEO fields
    meta_title: string | null;
    meta_description: string | null;
  };
  categoryNames: string[];
  mappedFields: { field: string; value: any; source: string }[];
  // Variants
  variants: VariantData[];
  hasVariants: boolean;
}

const defaultMappingRules: MappingRules = {
  stripVendorFromTitle: true,
  vendorSeparator: ' - ',
  excludeUntitled: true,
  excludeZeroPrice: false,
  excludeNoImages: false,
  vendorExtractionMode: 'none',
  inheritProductBarcode: false,
  applyPeriodPricing: false,
};

/**
 * Extract vendor from a DanDomain-style product title.
 * 
/**
 * Convert a string to Title Case (first letter of each word uppercase, rest lowercase)
 */
function toTitleCase(str: string): string {
  return str.toLowerCase().replace(/(?:^|\s)\S/g, (match) => match.toUpperCase());
}

/**
 * Extract vendor and cleaned title from a product title.
 * 
 * Input format: BRAND + PRODUCTTYPE, MODEL + DESCRIPTORS + ENGLISH PRODUCTTYPE, COLOR / VARIANT
 * Examples:
 *   - "BLACK COLOUR HÅRSPÆNDE, BCPREMIUM RHINESTONE HAIR CLAW, PURPLE/WHITE CONFETTI" 
 *       → { vendor: "Black Colour", cleanedTitle: "BCPREMIUM RHINESTONE HAIR CLAW, PURPLE/WHITE CONFETTI" }
 *   - "MERAKI BODY LOTION, BODYLOTION NORTHERN DAWN 275 ML" 
 *       → { vendor: "Meraki", cleanedTitle: "BODYLOTION NORTHERN DAWN 275 ML" }
 * 
 * Logic:
 * 1. Split title on first comma → left_part (contains "BRAND PRODUCTTYPE") and right_part (rest of title)
 * 2. Check if last two words match a known compound product type (e.g., BODY LOTION)
 * 3. If match: Vendor = all words before those two
 * 4. Else: Vendor = all words except final word (the product type)
 * 5. Fallback: first word as vendor
 * 
 * Returns: { vendor: string (Title Case), cleanedTitle: string (rest after first comma) }
 */
function extractVendorFromTitle(title: string): { vendor: string; cleanedTitle: string } {
  if (!title) return { vendor: '', cleanedTitle: '' };
  
  // Split on first comma
  const commaIndex = title.indexOf(',');
  const leftPart = commaIndex > 0 ? title.substring(0, commaIndex).trim() : title.trim();
  const rightPart = commaIndex > 0 ? title.substring(commaIndex + 1).trim() : '';
  
  // Tokenize into words
  const words = leftPart.split(/\s+/).filter(w => w.length > 0);
  
  if (words.length === 0) return { vendor: '', cleanedTitle: rightPart };
  if (words.length === 1) {
    // Only one word in left part - use it as vendor, right part is the cleaned title
    return { vendor: toTitleCase(words[0]), cleanedTitle: rightPart };
  }
  
  let vendorWords: string[];
  
  // Check if last two words form a known compound product type
  if (words.length >= 2) {
    const lastTwoWords = `${words[words.length - 2]} ${words[words.length - 1]}`.toUpperCase();
    if (KNOWN_COMPOUND_PRODUCT_TYPES.includes(lastTwoWords)) {
      // Vendor is all words before the compound product type
      if (words.length > 2) {
        vendorWords = words.slice(0, words.length - 2);
      } else {
        // Only two words and they match a compound type - fallback to first word
        vendorWords = [words[0]];
      }
    } else {
      // Default: Vendor = all words except the last one (product type)
      vendorWords = words.slice(0, words.length - 1);
    }
  } else {
    vendorWords = words.slice(0, words.length - 1);
  }
  
  const vendor = toTitleCase(vendorWords.join(' '));
  return { vendor, cleanedTitle: rightPart };
}

export function ProductMappingTab({ projectId }: ProductMappingTabProps) {
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'transform' | 'mapping' | 'preview'>('transform');
  const [mappingRules, setMappingRules] = useState<MappingRules>(defaultMappingRules);
  const [fieldMappings, setFieldMappings] = useState<FieldMapping[]>([]);
  const [newMapping, setNewMapping] = useState({ sourceField: '', targetField: '' });
  const [customMetafieldName, setCustomMetafieldName] = useState('');
  const [showCustomMetafieldInput, setShowCustomMetafieldInput] = useState(false);

  // Create metafields dialog state (for new custom metafields)
  const [showCreateMetafieldsDialog, setShowCreateMetafieldsDialog] = useState(false);
  const [pendingNewMetafields, setPendingNewMetafields] = useState<{ sourceField: string; targetField: string }[]>([]);
  const [savingMappings, setSavingMappings] = useState(false);
  
  // Preview state
  const [product, setProduct] = useState<ProductPreviewData | null>(null);
  const [productIds, setProductIds] = useState<ProductRef[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [untitledCount, setUntitledCount] = useState(0);
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ProductRef[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  
  // Dynamic metafields from Shopify
  const [shopifyMetafields, setShopifyMetafields] = useState<ShopifyMetafield[]>([]);
  const [fetchingMetafields, setFetchingMetafields] = useState(false);
  const [metafieldsLoaded, setMetafieldsLoaded] = useState(false);
  
  // DanDomain base URL for resolving relative image paths
  const [danDomainBaseUrl, setDanDomainBaseUrl] = useState<string | null>(null);

  // Period pricing (Periodestyring) state - loaded from price_periods table
  const [periodData, setPeriodData] = useState<{
    periods: { periodId: string; title: string | null; productCount: number; startDate: string | null; endDate: string | null; isActive: boolean }[];
    totalProducts: number;
    totalWithPeriod: number;
    hasUploadedPeriods: boolean;
  } | null>(null);
  const [loadingPeriods, setLoadingPeriods] = useState(false);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [manufacturerNameMap, setManufacturerNameMap] = useState<Map<string, string>>(new Map());

  const normalizeManufacturerKey = (value: string): string =>
    value.trim().replace(/\s+/g, ' ').toLowerCase();

  const manufacturerTitleStopWords = new Set([
    'top', 'bluse', 'kjole', 'ring', 'ørering', 'oerering', 'sneakers', 'boots', 'cardigan',
    'blazer', 'sandaler', 'sandal', 'jakke', 'taske', 'belt', 'bælte', 'pumps', 'strømper',
    'stroemper', 'bukser', 'leggings', 'skjorte', 'tee', 't-shirt', 'tshirt', 'creme', 'cream',
  ]);

  const formatInferredVendor = (value: string): string =>
    value
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => {
        if (word === '&') return '&';
        const clean = word.replace(/[^A-Za-z0-9ÆØÅæøå]/g, '');
        if (!clean) return word;
        if (clean.length === 1) return clean.toUpperCase();
        if (clean.length <= 4 && clean === clean.toUpperCase()) return clean;
        return `${clean.charAt(0).toUpperCase()}${clean.slice(1).toLowerCase()}`;
      })
      .join(' ');

  const inferVendorFromTitle = (manufacturerId: string, fallbackTitle?: unknown): string => {
    const normalizedId = normalizeManufacturerKey(manufacturerId).replace(/[^a-z0-9]/g, '');
    if (!normalizedId) return '';

    const leadingTitlePart = String(fallbackTitle ?? '').split(',')[0]?.trim() || '';
    if (!leadingTitlePart) return '';

    const words = leadingTitlePart.split(/\s+/).filter(Boolean);
    if (words.length === 0) return '';

    const sanitizeWord = (word: string): string =>
      normalizeManufacturerKey(word).replace(/[^a-z0-9]/g, '');

    // Abbreviation fallback (e.g. SA -> STINE A)
    let initials = '';
    for (let index = 0; index < Math.min(words.length, 5); index += 1) {
      const currentWord = sanitizeWord(words[index]);
      if (!currentWord) continue;
      initials += currentWord.charAt(0);
      if (initials === normalizedId) {
        return formatInferredVendor(words.slice(0, index + 1).join(' '));
      }
    }

    // ID matches first word (e.g. ARKK -> ARKK COPENHAGEN, Tim -> Tim & Simonsen)
    const firstWord = sanitizeWord(words[0]);
    if (firstWord !== normalizedId) return '';

    if (words.length >= 3) {
      const connector = normalizeManufacturerKey(words[1]);
      if (connector === '&' || connector === 'og') {
        return formatInferredVendor(words.slice(0, 3).join(' '));
      }
    }

    if (words.length >= 2) {
      const secondWord = sanitizeWord(words[1]);
      if (secondWord && !manufacturerTitleStopWords.has(secondWord)) {
        return formatInferredVendor(words.slice(0, 2).join(' '));
      }
    }

    return formatInferredVendor(words[0]);
  };

  const resolveVendorName = (rawVendor: unknown, fallbackTitle?: unknown): string => {
    const manufacturerId = String(rawVendor ?? '').trim();
    const normalizedId = normalizeManufacturerKey(manufacturerId);
    if (!manufacturerId) return '';

    const directMatch =
      manufacturerNameMap.get(manufacturerId) ??
      manufacturerNameMap.get(normalizedId);

    if (directMatch) return directMatch;

    const candidateNames = Array.from(new Set(manufacturerNameMap.values()));

    // Fallback 1: If ID is a prefix of exactly one manufacturer name, use that
    const prefixMatches = candidateNames.filter((name) => {
      const normalizedName = normalizeManufacturerKey(name);
      return normalizedName === normalizedId || normalizedName.startsWith(`${normalizedId} `);
    });

    if (prefixMatches.length === 1) return prefixMatches[0];

    // Fallback 2: Abbreviation -> initials (e.g. SA -> Stine A)
    if (normalizedId.length <= 5 && /^[a-z0-9]+$/i.test(normalizedId)) {
      const initialMatches = candidateNames.filter((name) => {
        const initialsFromName = normalizeManufacturerKey(name)
          .split(' ')
          .filter(Boolean)
          .map((part) => part[0])
          .join('');
        return initialsFromName === normalizedId;
      });

      if (initialMatches.length === 1) return initialMatches[0];
    }

    const inferredFromTitle = inferVendorFromTitle(manufacturerId, fallbackTitle);
    if (inferredFromTitle) return inferredFromTitle;

    return manufacturerId;
  };

  // Combined list of Shopify fields including dynamically fetched metafields
  const allShopifyFields = [
    ...BASE_SHOPIFY_FIELDS,
    ...shopifyMetafields.map(mf => ({
      value: `metafields.${mf.namespace}.${mf.key}`,
      label: mf.name || `${mf.namespace}.${mf.key}`,
      isMetafield: true,
    })),
  ];

  const findNewMetafields = (mappings: FieldMapping[]) => {
    const existingKeys = new Set(shopifyMetafields.map(mf => `metafields.${mf.namespace}.${mf.key}`));
    return mappings
      .filter(m => m.targetField.startsWith('metafields.') && !existingKeys.has(m.targetField))
      .map(m => ({ sourceField: m.sourceField, targetField: m.targetField }));
  };

  const handleMetafieldsCreated = async (createdConfigs: NewMetafieldConfig[]) => {
    // Add successful ones to local shopify metafields list (so subsequent checks don't re-trigger)
    const successfulConfigs = createdConfigs.filter(c => c.status === 'success');
    const newShopifyMetafields: ShopifyMetafield[] = successfulConfigs.map(c => ({
      namespace: 'custom',
      key: c.metafieldName.toLowerCase().replace(/\s+/g, '_'),
      name: c.metafieldName.charAt(0).toUpperCase() + c.metafieldName.slice(1).replace(/_/g, ' '),
      type: c.metafieldType,
    }));
    if (newShopifyMetafields.length > 0) {
      setShopifyMetafields(prev => [...prev, ...newShopifyMetafields]);
    }

    setShowCreateMetafieldsDialog(false);

    // Now persist the mappings (they were already added to state)
    await saveMappings(fieldMappings);
    setSavingMappings(false);
    toast.success('Felt-mappings gemt');

    // Refresh metafields from Shopify so preview shows the newly created ones
    await fetchShopifyMetafields(true);
  };

  useEffect(() => {
    loadData();
  }, [projectId]);

  // Auto-fetch Shopify metafields on mount
  useEffect(() => {
    if (!metafieldsLoaded && projectId) {
      fetchShopifyMetafields(true); // silent mode
    }
  }, [projectId, metafieldsLoaded]);

  // Auto-fetch period data from price_periods table and canonical_products
  const fetchPeriodData = async () => {
    setLoadingPeriods(true);
    setPeriodError(null);
    try {
      // 1. Load uploaded periods from price_periods table
      const { data: uploadedPeriods, error: periodsError } = await supabase
        .from('price_periods')
        .select('*')
        .eq('project_id', projectId);

      if (periodsError) throw periodsError;

      const hasUploadedPeriods = uploadedPeriods && uploadedPeriods.length > 0;

      if (!hasUploadedPeriods) {
        setPeriodData({ periods: [], totalProducts: 0, totalWithPeriod: 0, hasUploadedPeriods: false });
        setLoadingPeriods(false);
        return;
      }

      // 2. Count products per period_id from canonical_products (exact counts to avoid row-limit truncation)
      const normalizePeriodId = (value: unknown) => String(value ?? '').trim();
      const periodIds = Array.from(
        new Set(
          (uploadedPeriods || [])
            .map((p: any) => normalizePeriodId(p.period_id))
            .filter(Boolean)
        )
      );

      const periodCounts = new Map<string, number>();
      await Promise.all(
        periodIds.map(async (pid) => {
          const { count, error } = await supabase
            .from('canonical_products')
            .select('*', { count: 'exact', head: true })
            .eq('project_id', projectId)
            .eq('data->>period_id', pid);

          if (error) throw error;
          periodCounts.set(pid, count || 0);
        })
      );

      // 3. Get total product count
      const { count: totalProducts } = await supabase
        .from('canonical_products')
        .select('*', { count: 'exact', head: true })
        .eq('project_id', projectId);

      const now = new Date();
      const periods = uploadedPeriods.map((p: any) => {
        const startDate = p.start_date || null;
        const endDate = p.end_date || null;
        const normalizedPeriodId = normalizePeriodId(p.period_id);
        let isActive = !p.disabled;
        if (isActive && startDate && endDate) {
          const start = new Date(startDate);
          const end = new Date(endDate);
          // Set end to end of day
          end.setHours(23, 59, 59, 999);
          isActive = now >= start && now <= end;
        }
        return {
          periodId: p.period_id,
          title: p.title || null,
          productCount: periodCounts.get(normalizedPeriodId) || 0,
          startDate,
          endDate,
          isActive,
        };
      });

      // Sort by product count descending
      periods.sort((a: any, b: any) => b.productCount - a.productCount);

      setPeriodData({
        periods,
        totalProducts: totalProducts || 0,
        totalWithPeriod: periods.reduce((sum: number, p: any) => sum + p.productCount, 0),
        hasUploadedPeriods: true,
      });
    } catch (e: any) {
      
      setPeriodError('Kunne ikke hente periodestyring data');
    } finally {
      setLoadingPeriods(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetchPeriodData();
    }
  }, [projectId]);

  useEffect(() => {
    if (productIds.length > 0) {
      loadProduct(productIds[currentIndex].id);
    }
  }, [currentIndex, productIds, mappingRules, manufacturerNameMap]);

  const loadData = async () => {
    setLoading(true);
    
    // Load project to get DanDomain base URL for image resolution
    const { data: project } = await supabase
      .from('projects')
      .select('dandomain_base_url')
      .eq('id', projectId)
      .single();
    
    if (project?.dandomain_base_url) {
      setDanDomainBaseUrl(project.dandomain_base_url);
    }

    const { data: manufacturers, error: manufacturersError } = await supabase
      .from('canonical_manufacturers')
      .select('external_id, name')
      .eq('project_id', projectId);

    if (manufacturersError) {
      
      setManufacturerNameMap(new Map());
    } else {
      const nextMap = new Map<string, string>();
      for (const manufacturer of manufacturers || []) {
        const id = String(manufacturer.external_id || '').trim().replace(/\s+/g, ' ');
        const name = String(manufacturer.name || '').trim().replace(/\s+/g, ' ');
        if (id && name) {
          nextMap.set(id, name);
          nextMap.set(normalizeManufacturerKey(id), name);
        }
      }
      setManufacturerNameMap(nextMap);
    }
    
    // Load product list
    const { count } = await supabase
      .from('canonical_products')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      // Only preview PRIMARY products (grouped products)
      // Otherwise the carousel can land on a secondary record like "...-XL" and show "ingen varianter".
      .eq('data->>_isPrimary', 'true')
      .neq('data->>title', 'Untitled');
    
    setTotalCount(count || 0);

    // Count untitled
    const { count: untitled } = await supabase
      .from('canonical_products')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('data->>_isPrimary', 'true')
      .eq('data->>title', 'Untitled');
    
    setUntitledCount(untitled || 0);

    // Get first batch of product IDs
    const { data: products } = await supabase
      .from('canonical_products')
      .select('id, external_id')
      .eq('project_id', projectId)
      .eq('data->>_isPrimary', 'true')
      .neq('data->>title', 'Untitled')
      .limit(100);

    if (products && products.length > 0) {
      setProductIds(products);
      setCurrentIndex(0);
    }

    // Load existing field mappings
    await loadFieldMappings();
    
    setLoading(false);
  };

  const loadFieldMappings = async () => {
    try {
      const { data } = await supabase
        .from('mapping_profiles')
        .select('*')
        .eq('project_id', projectId)
        .eq('is_active', true)
        .maybeSingle();

      if (data?.mappings) {
        const allMappings = data.mappings as any[];
        
        // Load field mappings
        const fieldMappingsData = allMappings.filter(m => m.type === 'field');
        setFieldMappings(fieldMappingsData.map((m, i) => ({
          id: `mapping-${i}`,
          sourceField: m.sourceField,
          targetField: m.targetField,
        })));
        
        // Load transformation rules
        const rulesMapping = allMappings.find(m => m.type === 'transformationRules');
        if (rulesMapping?.rules) {
          setMappingRules({
            ...defaultMappingRules,
            ...rulesMapping.rules,
          });
        }
      }
    } catch (error) {
      
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

  const loadProduct = async (productId: string) => {
    const { data: products } = await supabase
      .from('canonical_products')
      .select('*')
      .eq('id', productId)
      .limit(1);

    if (products && products.length > 0) {
      const p = products[0];
      const data = p.data as any;
      
      // Get category names
      const categoryIds = data.category_external_ids || [];
      let categoryNames: string[] = [];
      
      if (categoryIds.length > 0) {
        const { data: categories } = await supabase
          .from('canonical_categories')
          .select('name, shopify_tag')
          .eq('project_id', projectId)
          .in('external_id', categoryIds);
        
        if (categories) {
          categoryNames = categories.map(c => c.shopify_tag || c.name);
        }
      }

      // Transform title based on rules - fuzzy case-insensitive vendor stripping
      let transformedTitle = data.title || '';
      let vendor = resolveVendorName(data.vendor, data.title);
      
      // Apply vendor extraction from title if enabled (new rule)
      // MANUFAC_ID (original vendor) takes precedence if filled, otherwise extract from title
      // Also cleans the title by removing vendor + producttype + first comma
      if (mappingRules.vendorExtractionMode === 'extract_from_title') {
        const originalVendorId = String(data.vendor || '').trim();
        if (originalVendorId) {
          // Resolve MANUFAC_ID to manufacturer name for preview
          vendor = resolveVendorName(originalVendorId, data.title);
          // Still clean the title by extracting and removing the prefix
          const { cleanedTitle } = extractVendorFromTitle(data.title || '');
          if (cleanedTitle) {
            transformedTitle = cleanedTitle;
          }
        } else {
          // MANUFAC_ID is empty, extract vendor from product title
          const { vendor: extractedVendor, cleanedTitle } = extractVendorFromTitle(data.title || '');
          if (extractedVendor) {
            vendor = extractedVendor;
          }
          if (cleanedTitle) {
            transformedTitle = cleanedTitle;
          }
        }
      }
      
      // Helper to normalize brand names for comparison (remove +, &, extra spaces)
      const normalizeBrand = (s: string) => s.toLowerCase().replace(/[+&]/g, ' ').replace(/\s+/g, ' ').trim();
      
      // Apply title stripping only if NOT using vendor extraction mode
      // (vendor extraction mode keeps title unchanged)
      if (mappingRules.vendorExtractionMode !== 'extract_from_title' && mappingRules.stripVendorFromTitle && vendor) {
        const normalizedVendor = normalizeBrand(vendor);
        const separators = [' - ', ' – ', ' — ', ': ', ' | '];
        let stripped = false;
        
        // Try to find separator and compare prefix with fuzzy matching
        for (const sep of separators) {
          const sepIndex = transformedTitle.indexOf(sep);
          if (sepIndex > 0 && sepIndex < 60) {
            const prefix = transformedTitle.slice(0, sepIndex).trim();
            const normalizedPrefix = normalizeBrand(prefix);
            
            // Exact match OR vendor starts with the prefix (fuzzy)
            // e.g. "moshi moshi" matches "Moshi Moshi Mind"
            // e.g. "gai + lisva" matches "gai lisva"
            if (normalizedPrefix === normalizedVendor || 
                normalizedVendor.startsWith(normalizedPrefix + ' ') ||
                normalizedVendor.startsWith(normalizedPrefix)) {
              const rest = transformedTitle.slice(sepIndex + sep.length).trim();
              if (rest) {
                transformedTitle = rest;
                stripped = true;
                break;
              }
            }
          }
        }
        
        // Fallback: simple startsWith with case-insensitive check
        if (!stripped && normalizeBrand(transformedTitle).startsWith(normalizedVendor)) {
          const rest = transformedTitle.substring(vendor.length).replace(/^[\s\-–—:]+/, '').trim();
          if (rest) {
            transformedTitle = rest;
          }
        }
      }

      // Determine if period pricing applies to this product in preview
      const productPeriodId = data.period_id ? String(data.period_id) : null;
      const activePeriodIdsSet = new Set(
        (periodData?.periods || []).filter((p: any) => p.isActive).map((p: any) => p.periodId)
      );
      const previewHasPeriodPricing = mappingRules.applyPeriodPricing && productPeriodId && activePeriodIdsSet.has(productPeriodId) && data.special_offer_price && parseFloat(String(data.special_offer_price)) > 0;

      // Parse variants from _mergedVariants if available
      const mergedVariants = data._mergedVariants as any[] || [];
      const hasVariants = data._isPrimary === true && mergedVariants.length > 0;

      // Helper to apply period pricing swap to a price/compareAtPrice pair
      const applyPeriodPricingToVariant = (basePrice: number, compareAt: number | null): { price: number; compareAtPrice: number | null } => {
        if (previewHasPeriodPricing) {
          const salePrice = parsePrice(data.special_offer_price) || 0;
          return { price: salePrice, compareAtPrice: basePrice };
        }
        return { price: basePrice, compareAtPrice: compareAt };
      };
      
      const variants: VariantData[] = hasVariants 
        ? mergedVariants.map((v: any) => {
            const rawPrice = parsePrice(v.price) || parsePrice(data.price) || 0;
            const rawCompare = v.compareAtPrice ? parsePrice(v.compareAtPrice) : null;
            const { price: vPrice, compareAtPrice: vCompare } = applyPeriodPricingToVariant(rawPrice, rawCompare);
            return {
              size: v.size || 'ONE-SIZE',
              sku: v.sku || '',
              price: vPrice,
              compareAtPrice: vCompare,
              stockQuantity: typeof v.stockQuantity === 'number' ? v.stockQuantity : parseInt(v.stockQuantity) || 0,
              barcode: v.barcode || null,
            };
          })
        : [{
            size: 'ONE-SIZE',
            sku: data.sku || '',
            ...applyPeriodPricingToVariant(
              parsePrice(data.price) || 0,
              data.compare_at_price ? parsePrice(data.compare_at_price) : null
            ),
            stockQuantity: typeof data.stock_quantity === 'number' ? data.stock_quantity : parseInt(data.stock_quantity) || 0,
            barcode: data.barcode || null,
          }];

      setProduct({
        original: {
          title: data.title || '',
          body_html: data.body_html || '',
          sku: data.sku || '',
          price: parsePrice(data.price) || 0,
          cost_price: data.cost_price ? parsePrice(data.cost_price) : null,
          compare_at_price: data.compare_at_price ? parsePrice(data.compare_at_price) : null,
          stock_quantity: data.stock_quantity || 0,
          weight: data.weight || null,
          images: data.images || [],
          vendor: data.vendor,
          category_ids: categoryIds,
          barcode: data.barcode || null,
          rawData: data, // Store raw data for field mapping
          // Custom fields for metafields
          field_1: data.field_1 || null,
          field_2: data.field_2 || null,
          field_3: data.field_3 || null,
          field_9: data.field_9 || null,
          // SEO fields
          meta_title: data.meta_title || null,
          meta_description: data.meta_description || null,
        },
        transformed: (() => {
          const rawPrice = parsePrice(data.price) || 0;
          const rawCompare = data.compare_at_price ? parsePrice(data.compare_at_price) : null;
          const { price: tPrice, compareAtPrice: tCompare } = applyPeriodPricingToVariant(rawPrice, rawCompare);
          return {
          title: transformedTitle,
          vendor: vendor,
          sku: data.sku || '',
          barcode: data.barcode || '',
          price: tPrice,
          compare_at_price: tCompare,
          cost_price: data.cost_price ? parsePrice(data.cost_price) : null,
          weight: data.weight || null,
          stock_quantity: typeof data.stock_quantity === 'number' ? data.stock_quantity : parseInt(data.stock_quantity) || 0,
          body_html: data.body_html || '',
          // SEO fields - default to original or fallback to title
          meta_title: data.meta_title || null,
          meta_description: data.meta_description || null,
          };
        })(),
        categoryNames,
        mappedFields: [],
        variants,
        hasVariants,
      });
    }
  };

  // Apply field mappings to preview when they change
  useEffect(() => {
    if (!product) return;

    const rawData = product.original.rawData;
    const mappedFields: { field: string; value: any; source: string }[] = [];

    const getSourceValue = (sourceField: string) => {
      // 1) Direct hit
      if (rawData && Object.prototype.hasOwnProperty.call(rawData, sourceField)) {
        return rawData[sourceField];
      }

      // 2) Handle DanDomain custom fields: FIELD_1 -> field_1
      const m = sourceField.match(/^FIELD_(\d+)$/i);
      if (m) {
        const n = m[1];
        const camel = `field_${n}`;
        if (rawData && Object.prototype.hasOwnProperty.call(rawData, camel)) {
          return rawData[camel];
        }
      }

      // 3) Generic case-insensitive fallback
      if (!rawData) return undefined;
      const lower = sourceField.toLowerCase();
      const hitKey = Object.keys(rawData).find(k => k.toLowerCase() === lower);
      return hitKey ? rawData[hitKey] : undefined;
    };
    
    // Start with original values
    const transformed = { ...product.transformed };

    for (const mapping of fieldMappings) {
      const sourceValue = getSourceValue(mapping.sourceField);
      
      // ALTID tilføj mapping - også for tomme værdier (så de vises i preview)
      mappedFields.push({
        field: mapping.targetField,
        value: sourceValue ?? null, // null for tomme værdier
        source: mapping.sourceField,
      });

      // Kun anvend til transformed hvis der er en værdi
      if (sourceValue !== undefined && sourceValue !== null && sourceValue !== '') {
        // Apply mapping to transformed data
        switch (mapping.targetField) {
          case 'variants[0].sku':
            transformed.sku = String(sourceValue);
            break;
          case 'variants[0].barcode':
            transformed.barcode = String(sourceValue);
            break;
          case 'variants[0].price':
            transformed.price = parseFloat(sourceValue) || 0;
            break;
          case 'variants[0].compare_at_price':
            transformed.compare_at_price = parseFloat(sourceValue) || null;
            break;
          case 'variants[0].cost':
            transformed.cost_price = parseFloat(sourceValue) || null;
            break;
          case 'variants[0].weight':
            transformed.weight = parseFloat(sourceValue) || null;
            break;
          case 'variants[0].inventory_quantity':
            transformed.stock_quantity = parseInt(sourceValue) || 0;
            break;
          case 'body_html':
            transformed.body_html = String(sourceValue);
            break;
          case 'vendor':
            transformed.vendor = resolveVendorName(sourceValue, product?.original.title);
            break;
          case 'title':
            transformed.title = String(sourceValue);
            break;
        }
      }
    }

    // Re-apply period pricing after field mappings (field mappings set raw prices)
    const periodRawData = product.original.rawData as any;
    const productPeriodId = periodRawData?.period_id ? String(periodRawData.period_id) : null;
    const activePeriodIdsSet = new Set(
      (periodData?.periods || []).filter((p: any) => p.isActive).map((p: any) => p.periodId)
    );
    const shouldApplyPeriod = mappingRules.applyPeriodPricing && productPeriodId && activePeriodIdsSet.has(productPeriodId) && periodRawData?.special_offer_price && parseFloat(String(periodRawData.special_offer_price)) > 0;

    if (shouldApplyPeriod) {
      const salePrice = parseFloat(String(periodRawData.special_offer_price)) || 0;
      const basePrice = transformed.price; // After field mapping, this is UNIT_PRICE
      transformed.price = salePrice;
      transformed.compare_at_price = basePrice;
    }

    setProduct(prev => prev ? {
      ...prev,
      transformed,
      mappedFields,
    } : null);
  }, [fieldMappings, product?.original.rawData, mappingRules.applyPeriodPricing, periodData]);

  const handlePrevious = () => {
    setCurrentIndex(prev => Math.max(0, prev - 1));
  };

  const handleNext = () => {
    setCurrentIndex(prev => Math.min(productIds.length - 1, prev + 1));
  };

  const handleRandom = () => {
    const randomIndex = Math.floor(Math.random() * productIds.length);
    setCurrentIndex(randomIndex);
    setSearchQuery('');
    setSearchResults([]);
  };

  // Search function to find products by SKU or title - only returns PRIMARY products
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    
    setIsSearching(true);
    try {
      const searchTerm = searchQuery.trim().toLowerCase();
      
      // Search by SKU (exact or partial match) and title - only return primary products
      const { data: results } = await supabase
        .from('canonical_products')
        .select('id, external_id, data')
        .eq('project_id', projectId)
        .eq('data->>_isPrimary', 'true')
        .or(`external_id.ilike.%${searchTerm}%,data->>sku.ilike.%${searchTerm}%,data->>title.ilike.%${searchTerm}%`)
        .limit(20);
      
      if (results && results.length > 0) {
        setSearchResults(results.map(r => ({ 
          id: r.id, 
          external_id: r.external_id,
          title: (r.data as any)?.title || r.external_id 
        })));
        toast.success(`Fandt ${results.length} produkt(er)`);
      } else {
        setSearchResults([]);
        toast.info('Ingen produkter fundet');
      }
    } catch (error) {
      console.error('Search error:', error);
      toast.error('Fejl ved søgning');
    } finally {
      setIsSearching(false);
    }
  };

  const selectSearchResult = (productId: string) => {
    // Find in current list or load directly
    const index = productIds.findIndex(p => p.id === productId);
    if (index >= 0) {
      setCurrentIndex(index);
    } else {
      // Not in current batch, load directly
      loadProduct(productId);
    }
    setSearchResults([]);
    setSearchQuery('');
  };

  const addFieldMapping = async (customTargetField?: string) => {
    const sourceField = newMapping.sourceField;
    const targetField = customTargetField || newMapping.targetField;
    
    if (!sourceField || !targetField) {
      toast.error('Vælg både kilde- og målfelt');
      return;
    }

    const mapping: FieldMapping = {
      id: `mapping-${Date.now()}`,
      sourceField: sourceField,
      targetField: targetField,
    };

    const updatedMappings = [...fieldMappings, mapping];
    setFieldMappings(updatedMappings);
    setNewMapping({ sourceField: '', targetField: '' });

    // If this introduces new metafields (not yet present in Shopify), force the dialog
    const newMetafields = findNewMetafields(updatedMappings);
    if (newMetafields.length > 0) {
      setPendingNewMetafields(newMetafields);
      setShowCreateMetafieldsDialog(true);
      setSavingMappings(true);
      return;
    }

    setSavingMappings(true);
    await saveMappings(updatedMappings);
    setSavingMappings(false);
    toast.success('Felt-mapping tilføjet');
  };

  const removeFieldMapping = async (id: string) => {
    const updatedMappings = fieldMappings.filter(m => m.id !== id);
    setFieldMappings(updatedMappings);

    setSavingMappings(true);
    await saveMappings(updatedMappings);
    setSavingMappings(false);
    toast.success('Felt-mapping fjernet');
  };

  const autoMapFields = async () => {
    // Get existing mapped target fields to avoid duplicates
    const existingTargets = new Set(fieldMappings.map(m => m.targetField));
    
    // Create new mappings for fields that aren't already mapped
    const newMappings: FieldMapping[] = [];
    for (const suggestion of AUTO_MAP_SUGGESTIONS) {
      if (!existingTargets.has(suggestion.target)) {
        newMappings.push({
          id: `mapping-${Date.now()}-${suggestion.source}`,
          sourceField: suggestion.source,
          targetField: suggestion.target,
        });
        existingTargets.add(suggestion.target);
      }
    }

    if (newMappings.length === 0) {
      toast.info('Alle standard felt-mappings er allerede tilføjet');
      return;
    }

    const updatedMappings = [...fieldMappings, ...newMappings];
    setFieldMappings(updatedMappings);

    const newMetafields = findNewMetafields(updatedMappings);
    if (newMetafields.length > 0) {
      setPendingNewMetafields(newMetafields);
      setShowCreateMetafieldsDialog(true);
      setSavingMappings(true);
      return;
    }

    setSavingMappings(true);
    await saveMappings(updatedMappings);
    setSavingMappings(false);
    toast.success(`${newMappings.length} felt-mappings tilføjet automatisk`);
  };

  const saveMappings = async (mappings: FieldMapping[], rules?: MappingRules) => {
    try {
      const { data: existing } = await supabase
        .from('mapping_profiles')
        .select('*')
        .eq('project_id', projectId)
        .eq('is_active', true)
        .maybeSingle();

      const fieldMappingsData = mappings.map(m => ({
        type: 'field',
        sourceField: m.sourceField,
        targetField: m.targetField,
        entityType: 'products',
      }));

      // Include transformation rules if provided
      const rulesData = rules ? [{
        type: 'transformationRules',
        rules: rules,
      }] : [];

      if (existing) {
        const existingMappings = (existing.mappings as any[]) || [];
        // Keep mappings that are not field mappings or transformation rules
        const otherMappings = existingMappings.filter(m => m.type !== 'field' && m.type !== 'transformationRules');
        
        // If rules not provided, preserve existing rules
        let preservedRules: any[] = [];
        if (!rules) {
          preservedRules = existingMappings.filter(m => m.type === 'transformationRules');
        }
        
        await supabase
          .from('mapping_profiles')
          .update({ 
            mappings: [...otherMappings, ...fieldMappingsData, ...rulesData, ...preservedRules],
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('mapping_profiles')
          .insert({
            project_id: projectId,
            name: 'Standard',
            mappings: [...fieldMappingsData, ...rulesData] as any,
            is_active: true,
          });
      }
    } catch (error) {
      console.error('Error saving field mappings:', error);
      toast.error('Fejl ved gemning af felt-mappings');
    }
  };

  // Save transformation rules when they change
  const saveTransformationRules = async (rules: MappingRules) => {
    try {
      await saveMappings(fieldMappings, rules);
      toast.success('Migrationsregler gemt');
    } catch (error) {
      console.error('Error saving transformation rules:', error);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  const pricingPreview = product ? (() => {
    const normalizePreviewPrice = (price: number, compareAtPrice: number | null) => {
      if (compareAtPrice !== null && compareAtPrice < price) {
        return { price: compareAtPrice, compareAtPrice: price };
      }
      return { price, compareAtPrice };
    };

    if (product.hasVariants && product.variants.length > 0) {
      const cheapestVariant = product.variants.reduce((lowest, variant) =>
        variant.price < lowest.price ? variant : lowest
      );
      return normalizePreviewPrice(cheapestVariant.price, cheapestVariant.compareAtPrice);
    }

    return normalizePreviewPrice(product.transformed.price, product.transformed.compare_at_price);
  })() : null;

  return (
    <div className="space-y-6">
      {/* Inner Tabs for Transformation, Mapping, Preview */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          const next = v as 'transform' | 'mapping' | 'preview';
          setActiveTab(next);
          // Ensure preview always reflects latest DB state (e.g. after regrouping/prepare-upload)
          if (next === 'preview' && productIds.length > 0) {
            void loadProduct(productIds[currentIndex].id);
          }
        }}
        className="w-full"
      >
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="transform" className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            <span className="hidden sm:inline">Migrationsregler</span>
            <span className="sm:hidden">Regler</span>
          </TabsTrigger>
          <TabsTrigger value="mapping" className="flex items-center gap-2">
            <Link2 className="w-4 h-4" />
            <span className="hidden sm:inline">Felt-mapping</span>
            <span className="sm:hidden">Mapping</span>
          </TabsTrigger>
          <TabsTrigger value="preview" className="flex items-center gap-2">
            <Eye className="w-4 h-4" />
            <span className="hidden sm:inline">Shopify Preview</span>
            <span className="sm:hidden">Preview</span>
          </TabsTrigger>
        </TabsList>

        {/* Transformation Rules Tab */}
        <TabsContent value="transform" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Migrationsregler</CardTitle>
              <CardDescription>
                Konfigurer hvordan produktdata transformeres til Shopify
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Vendor Extraction Section */}
              <div className="space-y-4">
                <div>
                  <Label className="text-base font-medium">Vendor/Forhandler</Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    Vælg hvordan leverandør (vendor) skal bestemmes
                  </p>
                </div>
                
                <div className="space-y-3 pl-4 border-l-2 border-muted">
                  {/* Option 1: No vendor transformation */}
                  <div 
                    className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                      mappingRules.vendorExtractionMode === 'none' && !mappingRules.stripVendorFromTitle
                        ? 'border-primary bg-primary/5' 
                        : 'border-border hover:border-muted-foreground/50'
                    }`}
                    onClick={() => {
                      const newRules = { 
                        ...mappingRules, 
                        vendorExtractionMode: 'none' as VendorExtractionMode,
                        stripVendorFromTitle: false 
                      };
                      setMappingRules(newRules);
                      saveTransformationRules(newRules);
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`w-4 h-4 rounded-full border-2 mt-0.5 flex-shrink-0 ${
                        mappingRules.vendorExtractionMode === 'none' && !mappingRules.stripVendorFromTitle
                          ? 'border-primary bg-primary' 
                          : 'border-muted-foreground/50'
                      }`}>
                        {mappingRules.vendorExtractionMode === 'none' && !mappingRules.stripVendorFromTitle && (
                          <div className="w-full h-full flex items-center justify-center">
                            <div className="w-1.5 h-1.5 rounded-full bg-background" />
                          </div>
                        )}
                      </div>
                      <div>
                        <p className="font-medium text-sm">Brug eksisterende vendor felt</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Vendor hentes fra produktets eksisterende MANUFAC_ID eller vendor felt
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Option 2: Strip vendor from title (existing rule) */}
                  <div 
                    className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                      mappingRules.vendorExtractionMode === 'none' && mappingRules.stripVendorFromTitle
                        ? 'border-primary bg-primary/5' 
                        : 'border-border hover:border-muted-foreground/50'
                    }`}
                    onClick={() => {
                      const newRules = { 
                        ...mappingRules, 
                        vendorExtractionMode: 'none' as VendorExtractionMode,
                        stripVendorFromTitle: true 
                      };
                      setMappingRules(newRules);
                      saveTransformationRules(newRules);
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`w-4 h-4 rounded-full border-2 mt-0.5 flex-shrink-0 ${
                        mappingRules.vendorExtractionMode === 'none' && mappingRules.stripVendorFromTitle
                          ? 'border-primary bg-primary' 
                          : 'border-muted-foreground/50'
                      }`}>
                        {mappingRules.vendorExtractionMode === 'none' && mappingRules.stripVendorFromTitle && (
                          <div className="w-full h-full flex items-center justify-center">
                            <div className="w-1.5 h-1.5 rounded-full bg-background" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-sm">Fjern brand fra titel</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          "Mads Nørgaard - T-shirt" → Titel: "T-shirt", Vendor: fra eksisterende felt
                        </p>
                        {mappingRules.vendorExtractionMode === 'none' && mappingRules.stripVendorFromTitle && (
                          <div className="mt-2 flex items-center gap-2">
                            <Label className="text-xs">Separator:</Label>
                            <Input
                              value={mappingRules.vendorSeparator}
                              onChange={(e) => setMappingRules({ ...mappingRules, vendorSeparator: e.target.value })}
                              onBlur={() => saveTransformationRules(mappingRules)}
                              placeholder=" - "
                              className="w-20 h-7 text-xs"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Option 3: Extract vendor from title (new rule) */}
                  <div 
                    className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                      mappingRules.vendorExtractionMode === 'extract_from_title'
                        ? 'border-primary bg-primary/5' 
                        : 'border-border hover:border-muted-foreground/50'
                    }`}
                    onClick={() => {
                      const newRules = { 
                        ...mappingRules, 
                        vendorExtractionMode: 'extract_from_title' as VendorExtractionMode,
                        stripVendorFromTitle: false 
                      };
                      setMappingRules(newRules);
                      saveTransformationRules(newRules);
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`w-4 h-4 rounded-full border-2 mt-0.5 flex-shrink-0 ${
                        mappingRules.vendorExtractionMode === 'extract_from_title'
                          ? 'border-primary bg-primary' 
                          : 'border-muted-foreground/50'
                      }`}>
                        {mappingRules.vendorExtractionMode === 'extract_from_title' && (
                          <div className="w-full h-full flex items-center justify-center">
                            <div className="w-1.5 h-1.5 rounded-full bg-background" />
                          </div>
                        )}
                      </div>
                      <div>
                        <p className="font-medium text-sm">Brug eksisterende vendor felt når udfyldt - ellers træk fra produkttitel</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Vendor konverteres til Title Case. Titlen renses for brand + produkttype + første komma.
                        </p>
                        <div className="mt-2 text-xs bg-muted/50 p-2 rounded space-y-1">
                          <p className="font-mono">"BLACK COLOUR HÅRSPÆNDE, BCPREMIUM..." → Vendor: "Black Colour", Titel: "BCPREMIUM..."</p>
                          <p className="font-mono">"MERAKI BODY LOTION, BODYLOTION..." → Vendor: "Meraki", Titel: "BODYLOTION..."</p>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">
                          Understøtter sammensatte produkttyper (BODY LOTION, HAND SOAP, osv.)
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Exclusion Rules */}
              <div className="space-y-4">
                <div>
                  <Label className="text-base font-medium">Ekskluderingsregler</Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    Bestem hvilke produkter der skal udelukkes fra upload
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Ekskluder "Untitled" produkter</Label>
                    <p className="text-sm text-muted-foreground">
                      {untitledCount} produkter uden navn vil ikke blive oprettet
                    </p>
                  </div>
                  <Switch
                    checked={mappingRules.excludeUntitled}
                    onCheckedChange={(checked) => setMappingRules({ ...mappingRules, excludeUntitled: checked })}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Ekskluder produkter med pris 0</Label>
                    <p className="text-sm text-muted-foreground">
                      Produkter uden pris vil ikke blive oprettet
                    </p>
                  </div>
                  <Switch
                    checked={mappingRules.excludeZeroPrice}
                    onCheckedChange={(checked) => setMappingRules({ ...mappingRules, excludeZeroPrice: checked })}
                  />
                </div>
              </div>

              <Separator />

              {/* Barcode Inheritance */}
              <div className="space-y-4">
                <div>
                  <Label className="text-base font-medium">Stregkode</Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    Indstillinger for stregkode-håndtering under migrering
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Anvend primært produkts stregkode, hvis stregkode ikke er angivet for varianter</Label>
                    <p className="text-sm text-muted-foreground">
                      Hvis en variant mangler stregkode, kopieres produktets stregkode til varianten. Eksisterende variant-stregkoder overskrives aldrig.
                    </p>
                  </div>
                  <Switch
                    checked={mappingRules.inheritProductBarcode}
                    onCheckedChange={(checked) => {
                      const newRules = { ...mappingRules, inheritProductBarcode: checked };
                      setMappingRules(newRules);
                      saveTransformationRules(newRules);
                    }}
                  />
                </div>
              </div>

              <Separator />

              {/* Periodestyring (Period Pricing) */}
              <div className="space-y-4">
                <div>
                  <Label className="text-base font-medium">Periodestyring</Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    DanDomain periodebaserede priser – anvend udsalgspriser fra aktive perioder
                  </p>
                </div>

                {/* Period overview */}
                {loadingPeriods ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Henter periodestyring data...
                  </div>
                ) : periodError ? (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                    <AlertTriangle className="w-4 h-4" />
                    {periodError}
                  </div>
                ) : periodData && periodData.hasUploadedPeriods && periodData.periods.length > 0 ? (
                  <div className="border rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Periode</TableHead>
                          <TableHead>Titel</TableHead>
                          <TableHead className="text-right">Produkter</TableHead>
                          <TableHead>Datointerval</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {periodData.periods.map((period) => (
                          <TableRow key={period.periodId}>
                            <TableCell className="font-medium font-mono text-sm">
                              {period.periodId}
                            </TableCell>
                            <TableCell className="text-sm">
                              {period.title || '–'}
                            </TableCell>
                            <TableCell className="text-right">
                              <Badge variant="secondary">{period.productCount}</Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {period.startDate && period.endDate
                                ? `${new Date(period.startDate).toLocaleDateString('da-DK')} → ${new Date(period.endDate).toLocaleDateString('da-DK')}`
                                : 'Ukendt'}
                            </TableCell>
                            <TableCell>
                              {period.isActive ? (
                                <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
                                  Aktiv
                                </Badge>
                              ) : (
                                <Badge variant="secondary">Inaktiv</Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <div className="px-4 py-2 bg-muted/30 text-xs text-muted-foreground border-t">
                      {periodData.totalWithPeriod} af {periodData.totalProducts} produkter har en tildelt periode
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground p-3 bg-muted/30 rounded-lg">
                    {periodData && !periodData.hasUploadedPeriods
                      ? 'Upload en Periodestyring XML fil i Udtræk-trinnet for at aktivere denne funktion'
                      : 'Ingen produkter med periodestyring fundet'}
                  </div>
                )}

                {/* Toggle */}
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className={!(periodData?.hasUploadedPeriods) ? 'text-muted-foreground' : ''}>
                      Anvend periodestyringspris ved migrering (udsalgspris)
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {!(periodData?.hasUploadedPeriods)
                        ? 'Upload en Periodestyring XML fil først'
                        : 'Produkter med aktiv periode: periodepris → Shopify pris, basispris → sammenlign ved pris (overstreget)'}
                    </p>
                  </div>
                  <Switch
                    checked={mappingRules.applyPeriodPricing}
                    disabled={!(periodData?.hasUploadedPeriods)}
                    onCheckedChange={(checked) => {
                      const newRules = { ...mappingRules, applyPeriodPricing: checked };
                      setMappingRules(newRules);
                      saveTransformationRules(newRules);
                    }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Field Mapping Tab */}
        <TabsContent value="mapping" className="mt-6">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">Ekstra felt-mappings</CardTitle>
                  <CardDescription>
                    Map ekstra felter fra DanDomain XML til Shopify felter
                    {fetchingMetafields && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        <Loader2 className="w-3 h-3 inline animate-spin mr-1" />
                        Henter metafelter...
                      </span>
                    )}
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={autoMapFields}
                  className="flex items-center gap-2"
                  disabled={savingMappings}
                >
                  <Wand2 className="w-4 h-4" />
                  Auto-map
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Centered add mapping button */}
              <div className="flex justify-center">
                <Button
                  onClick={() => addFieldMapping()}
                  disabled={savingMappings || !newMapping.sourceField || !newMapping.targetField}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Tilføj mapping
                </Button>
              </div>

              {/* Source and target field selectors */}
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
                  {showCustomMetafieldInput ? (
                    <div className="flex gap-2">
                      <Input
                        placeholder="Navngiv metafelt..."
                        value={customMetafieldName}
                        onChange={(e) => setCustomMetafieldName(e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        size="sm"
                        onClick={async () => {
                          if (customMetafieldName.trim() && newMapping.sourceField) {
                            const key = customMetafieldName.trim().toLowerCase().replace(/\s+/g, '_');
                            const customTarget = `metafields.custom.${key}`;
                            setShowCustomMetafieldInput(false);
                            setCustomMetafieldName('');
                            // Directly add the mapping with the custom target
                            await addFieldMapping(customTarget);
                          } else if (!newMapping.sourceField) {
                            toast.error('Vælg først et kilde felt');
                          }
                        }}
                        disabled={savingMappings || !customMetafieldName.trim()}
                      >
                        <Check className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setShowCustomMetafieldInput(false);
                          setCustomMetafieldName('');
                        }}
                        disabled={savingMappings}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ) : (
                    <Select
                      value={newMapping.targetField}
                      onValueChange={(v) => {
                        if (v === '__custom_metafield__') {
                          setShowCustomMetafieldInput(true);
                        } else {
                          setNewMapping(prev => ({ ...prev, targetField: v }));
                        }
                      }}
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
                        {/* Custom metafield option at the bottom */}
                        <SelectItem value="__custom_metafield__">
                          <span className="flex items-center gap-2">
                            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/10">
                              <Plus className="w-3 h-3 text-primary" />
                            </span>
                            Metafelt
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
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
                              disabled={savingMappings}
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
                <div className="text-center py-4 text-muted-foreground text-sm">
                  Ingen ekstra felt-mappings tilføjet endnu
                </div>
              )}

              {/* Suggestion */}
              {fieldMappings.length === 0 && (
                <Card className="bg-muted/50 border-dashed">
                  <CardContent className="py-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-warning mt-0.5" />
                      <div>
                        <p className="font-medium text-sm">Forslag: Stregkode mapping</p>
                        <p className="text-sm text-muted-foreground">
                          Hvis dine produkter har stregkoder i PROD_BARCODE_NUMBER, kan du mappe dem til Shopify stregkode-feltet ovenfor.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Shopify Preview Tab */}
        <TabsContent value="preview" className="mt-6">
          {product ? (
            <div className="space-y-4">
              {/* Search and Navigation Bar */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-medium">Shopify Preview</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => productIds[currentIndex] && loadProduct(productIds[currentIndex].id)}
                    title="Opdater preview"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                </div>
                
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
                  {/* Search Input */}
                  <div className="relative flex-1 sm:w-64">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      placeholder="Søg på SKU eller titel..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      className="pl-9 pr-16"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleSearch}
                      disabled={isSearching}
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7"
                    >
                      {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Søg'}
                    </Button>
                  </div>
                  
                  {/* Navigation */}
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePrevious}
                      disabled={currentIndex === 0}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <span className="text-sm text-muted-foreground min-w-[80px] text-center">
                      {currentIndex + 1} / {productIds.length}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleNext}
                      disabled={currentIndex === productIds.length - 1}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleRandom}
                    >
                      <Shuffle className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Search Results Dropdown */}
              {searchResults.length > 0 && (
                <Card className="border-primary/50">
                  <CardContent className="p-2">
                    <p className="text-xs text-muted-foreground mb-2 px-2">Søgeresultater ({searchResults.length})</p>
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {searchResults.map(result => (
                        <button
                          key={result.id}
                          onClick={() => selectSearchResult(result.id)}
                          className="w-full text-left px-3 py-2 rounded-md hover:bg-muted transition-colors text-sm flex items-center justify-between group"
                        >
                          <div className="flex flex-col items-start gap-0.5 min-w-0 flex-1">
                            <span className="text-sm font-medium truncate w-full">{result.title}</span>
                            <span className="font-mono text-[10px] text-muted-foreground">{result.external_id}</span>
                          </div>
                          <Eye className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 ml-2" />
                        </button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="font-medium">XML Data</span>
                <ArrowRight className="w-4 h-4" />
                <span className="font-medium">Shopify Felter</span>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 space-y-4">
                  {/* Title Field */}
                  <Card>
                    <CardContent className="pt-4">
                      <label className="text-sm font-medium text-foreground mb-2 block">Titel</label>
                      <div className="relative">
                        <Input 
                          value={product.transformed.title} 
                          readOnly 
                          className="bg-background"
                        />
                        {product.original.title !== product.transformed.title && (
                          <div className="mt-2 text-xs text-muted-foreground">
                            <span className="text-warning">Original:</span> {product.original.title}
                            <br />
                            <span className="text-success">→ Vendor fjernet fra titel</span>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  {/* Description Field */}
                  <Card>
                    <CardContent className="pt-4">
                      <label className="text-sm font-medium text-foreground mb-2 block">Beskrivelse</label>
                      <div className="min-h-[100px] p-3 border rounded-md bg-background text-sm">
                        {product.transformed.body_html ? (
                          <div dangerouslySetInnerHTML={{ __html: product.transformed.body_html.substring(0, 300) + (product.transformed.body_html.length > 300 ? '...' : '') }} />
                        ) : (
                          <span className="text-muted-foreground italic">Ingen beskrivelse</span>
                        )}
                      </div>
                      {product.mappedFields.some(m => m.field === 'body_html') && (
                        <div className="mt-2 text-xs text-success flex items-center gap-1">
                          <Check className="w-3 h-3" />
                          Mappet fra {product.mappedFields.find(m => m.field === 'body_html')?.source}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Variants Section - Shopify Style */}
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-medium">Varianter</CardTitle>
                        {product.hasVariants && product.variants.length > 1 && (
                          <Badge variant="secondary" className="text-xs">
                            {product.variants.length} varianter
                          </Badge>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0 space-y-4">
                      {product.hasVariants && product.variants.length > 1 ? (
                        <>
                          {/* Option name with values as chips */}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">Størrelse</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {product.variants.map((variant, i) => (
                                <Badge 
                                  key={i} 
                                  variant="outline" 
                                  className="text-xs px-2 py-1 font-medium"
                                >
                                  {variant.size}
                                </Badge>
                              ))}
                            </div>
                          </div>

                          <Separator />

                          {/* Variant table */}
                          <div className="border rounded-lg overflow-hidden">
                            <Table>
                              <TableHeader>
                                <TableRow className="bg-muted/50">
                                  <TableHead className="text-xs h-9">Størrelse</TableHead>
                                  <TableHead className="text-xs h-9">SKU</TableHead>
                                  <TableHead className="text-xs h-9">Pris</TableHead>
                                  <TableHead className="text-xs h-9">Lager</TableHead>
                                  <TableHead className="text-xs h-9">Stregkode</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {product.variants.map((variant, i) => (
                                  <TableRow key={i}>
                                    <TableCell className="py-2">
                                      <Badge variant="outline" className="text-xs font-medium">
                                        {variant.size}
                                      </Badge>
                                    </TableCell>
                                    <TableCell className="py-2 font-mono text-xs text-muted-foreground">
                                      {variant.sku}
                                    </TableCell>
                                    <TableCell className="py-2 text-xs">
                                      {variant.price.toFixed(2)} kr.
                                      {variant.compareAtPrice && (
                                        <span className="ml-1 line-through text-muted-foreground">
                                          {variant.compareAtPrice.toFixed(2)}
                                        </span>
                                      )}
                                    </TableCell>
                                    <TableCell className="py-2 text-xs">
                                      <span className={variant.stockQuantity > 0 ? 'text-success' : 'text-muted-foreground'}>
                                        {variant.stockQuantity}
                                      </span>
                                    </TableCell>
                                    <TableCell className="py-2 font-mono text-[10px] text-muted-foreground">
                                      {variant.barcode || '–'}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </>
                      ) : (
                        <>
                          {/* Single variant / no variants - show SKU directly on product */}
                          <div className="text-sm text-muted-foreground mb-3">
                            Dette produkt har ingen størrelser eller varianter
                          </div>
                          
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {/* SKU */}
                            <div>
                              <label className="text-xs text-muted-foreground mb-1 block">SKU</label>
                              <Input 
                                value={product.transformed.sku} 
                                readOnly 
                                className="bg-background h-8 font-mono text-xs"
                              />
                            </div>

                            {/* Price */}
                            <div>
                              <label className="text-xs text-muted-foreground mb-1 block">Pris</label>
                              <Input 
                                value={`${product.transformed.price.toFixed(2)} kr.`} 
                                readOnly 
                                className="bg-background h-8 font-mono text-xs"
                              />
                            </div>

                            {/* Lagerbeholdning */}
                            <div>
                              <label className="text-xs text-muted-foreground mb-1 block">Lager</label>
                              <Input 
                                value={product.transformed.stock_quantity.toString()} 
                                readOnly 
                                className="bg-background h-8 font-mono text-xs"
                              />
                            </div>

                            {/* Stregkode */}
                            <div>
                              <label className="text-xs text-muted-foreground mb-1 block">Stregkode</label>
                              <Input 
                                value={product.transformed.barcode || '–'} 
                                readOnly 
                                className="bg-background h-8 font-mono text-xs"
                              />
                            </div>
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>

                  {/* Price Summary Card */}
                  <Card>
                    <CardContent className="pt-4 space-y-4">
                      <div>
                        <label className="text-sm font-medium text-foreground mb-2 block">Prissætning</label>
                        <div className="flex items-center gap-4">
                          <div>
                            <Input 
                              value={pricingPreview ? pricingPreview.price.toFixed(2) : '0.00'} 
                              readOnly 
                              className="w-32 bg-background"
                            />
                          </div>
                          <span className="text-muted-foreground">kr.</span>
                          {pricingPreview && pricingPreview.compareAtPrice !== null && (
                            <div className="text-muted-foreground">
                              <span className="text-xs">Før: </span>
                              <span className="line-through">{pricingPreview.compareAtPrice.toFixed(2)} kr.</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <Separator />

                      {/* Kostpris */}
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Kostpris</label>
                        <Input 
                          value={product.transformed.cost_price ? `${product.transformed.cost_price.toFixed(2)} kr.` : '(ingen)'} 
                          readOnly 
                          className="bg-background h-8 font-mono text-xs w-32"
                        />
                      </div>
                    </CardContent>
                  </Card>

                  {/* Metafields Card - Vis ALLE mappede metafelter fra fieldMappings */}
                  {fieldMappings.filter(m => m.targetField.startsWith('metafields.')).length > 0 && (
                    <Card>
                      <CardContent className="pt-4">
                        <label className="text-sm font-medium text-foreground mb-2 block flex items-center gap-2">
                          Metafelter
                          <Badge variant="secondary" className="text-[10px] py-0 px-1.5 font-medium rounded-full">
                            Shopify
                          </Badge>
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                          {fieldMappings
                            .filter(m => m.targetField.startsWith('metafields.'))
                            .map((mapping, i) => {
                              // Find værdien for dette produkt
                              const mappedField = product.mappedFields.find(
                                mf => mf.field === mapping.targetField
                              );
                              const value = mappedField?.value;
                              const hasValue = value !== null && value !== undefined && value !== '';
                              
                              // Try to get the official name from Shopify metafields first
                              const shopifyField = allShopifyFields.find(f => f.value === mapping.targetField);
                              let displayName: string;
                              if (shopifyField && 'isMetafield' in shopifyField) {
                                // Use the Shopify name
                                displayName = shopifyField.label;
                              } else {
                                // Fallback: derive from targetField
                                const parts = mapping.targetField.split('.');
                                const fieldName = parts[parts.length - 1].replace(/_/g, ' ');
                                displayName = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
                              }
                              
                              return (
                                <div key={i}>
                                  <label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                                    {displayName}
                                    <span className="text-[10px] text-primary">← {mapping.sourceField}</span>
                                  </label>
                                  <Input 
                                    value={hasValue ? String(value) : ''} 
                                    placeholder={hasValue ? undefined : 'Ikke udfyldt'}
                                    readOnly 
                                    className={`bg-background h-8 text-xs ${!hasValue ? 'text-muted-foreground italic placeholder:text-muted-foreground' : ''}`}
                                  />
                                </div>
                              );
                            })}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* SEO Card */}
                  <Card>
                    <CardContent className="pt-4">
                      <label className="text-sm font-medium text-foreground mb-2 block flex items-center gap-2">
                        SEO
                        <Badge variant="secondary" className="text-[10px] py-0 px-1.5 font-medium rounded-full">
                          Shopify
                        </Badge>
                      </label>
                      <div className="space-y-3">
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">Meta Titel</label>
                          {(product.transformed.meta_title || product.original.meta_title) ? (
                            <Input 
                              value={product.transformed.meta_title || product.original.meta_title} 
                              readOnly 
                              className="bg-background h-8 text-xs"
                            />
                          ) : (
                            <div className="p-2 border border-dashed rounded-md bg-muted/30 text-xs text-muted-foreground italic">
                              Ikke udfyldt
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">Meta Beskrivelse</label>
                          {(product.transformed.meta_description || product.original.meta_description) ? (
                            <div className="p-2 border rounded-md bg-background text-xs text-muted-foreground min-h-[60px]">
                              {(product.transformed.meta_description || product.original.meta_description || '').substring(0, 160)}
                              {(product.transformed.meta_description || product.original.meta_description || '').length > 160 && '...'}
                            </div>
                          ) : (
                            <div className="p-2 border border-dashed rounded-md bg-muted/30 text-xs text-muted-foreground italic min-h-[60px] flex items-center">
                              Ikke udfyldt
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <div className="space-y-4">
                  {/* Image preview */}
                  <Card>
                    <CardContent className="pt-4">
                      <label className="text-xs text-muted-foreground mb-1 block">
                        Billeder ({product.original.images.length})
                      </label>
                      {product.original.images.length > 0 ? (
                        <div className="space-y-2">
                          {/* Primary image */}
                          <div className="relative aspect-square w-full overflow-hidden rounded-lg border bg-background">
                            <img 
                              src={product.original.images[0].startsWith('http') 
                                ? product.original.images[0] 
                                : danDomainBaseUrl 
                                  ? `${danDomainBaseUrl.replace(/\/$/, '')}${product.original.images[0].startsWith('/') ? '' : '/'}${product.original.images[0]}`
                                  : product.original.images[0]} 
                              alt="Primært produktbillede"
                              className="object-contain w-full h-full"
                              onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                target.src = '/placeholder.svg';
                              }}
                            />
                          </div>
                          {/* Gallery thumbnails */}
                          {product.original.images.length > 1 && (
                            <div className="grid grid-cols-4 gap-1">
                              {product.original.images.slice(1, 5).map((img, i) => (
                                <div key={i} className="aspect-square overflow-hidden rounded border bg-background">
                                  <img 
                                    src={img.startsWith('http') 
                                      ? img 
                                      : danDomainBaseUrl 
                                        ? `${danDomainBaseUrl.replace(/\/$/, '')}${img.startsWith('/') ? '' : '/'}${img}`
                                        : img} 
                                    alt={`Galleri billede ${i + 2}`}
                                    className="object-contain w-full h-full"
                                    onError={(e) => {
                                      const target = e.target as HTMLImageElement;
                                      target.src = '/placeholder.svg';
                                    }}
                                  />
                                </div>
                              ))}
                              {product.original.images.length > 5 && (
                                <div className="aspect-square flex items-center justify-center rounded border bg-muted text-xs text-muted-foreground">
                                  +{product.original.images.length - 5}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center justify-center aspect-square w-full rounded-lg border border-dashed bg-muted/50 text-muted-foreground">
                          <div className="text-center">
                            <ImageIcon className="w-8 h-8 mx-auto mb-2 opacity-50" />
                            <span className="text-xs">Intet billede</span>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Produktorganisering</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Vendor */}
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Forhandler</label>
                        <Input 
                          value={product.transformed.vendor || '(tom)'} 
                          readOnly 
                          className="bg-background h-9"
                        />
                      </div>

                      <Separator />

                      {/* Tags */}
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Tags</label>
                        {product.categoryNames.length > 0 ? (
                          <div className="flex flex-wrap gap-1 p-2 border rounded-md bg-background min-h-[38px]">
                            {product.categoryNames.map((name, i) => (
                              <Badge key={i} variant="outline" className="text-xs">
                                {name}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <Input 
                            value="(ingen tags)" 
                            readOnly 
                            className="bg-background h-9 text-muted-foreground"
                          />
                        )}
                      </div>
                    </CardContent>
                  </Card>

                </div>
              </div>

              {/* Applied Field Mappings in Preview */}
              {fieldMappings.length > 0 && (
                <Card className="bg-primary/5 border-primary/20">
                  <CardContent className="pt-4">
                    <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                      <Check className="w-4 h-4 text-primary" />
                      Ekstra felt-mappings anvendt
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {fieldMappings.map(mapping => (
                        <Badge key={mapping.id} variant="outline" className="gap-1">
                          <span className="font-mono text-xs">{mapping.sourceField}</span>
                          <ArrowRight className="w-3 h-3" />
                          <span>{allShopifyFields.find(f => f.value === mapping.targetField)?.label || mapping.targetField}</span>
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          ) : totalCount === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Ingen produkter fundet til preview</p>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Create metafields dialog - shown when saving mappings that reference new metafields */}
      <CreateMetafieldsDialog
        open={showCreateMetafieldsDialog}
        onOpenChange={(open) => {
          setShowCreateMetafieldsDialog(open);
          if (!open) setSavingMappings(false);
        }}
        projectId={projectId}
        newMetafields={pendingNewMetafields}
        onComplete={handleMetafieldsCreated}
      />
    </div>
  );
}
