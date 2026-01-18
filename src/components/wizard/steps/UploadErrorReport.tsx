import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  AlertCircle,
  SkipForward,
  Download,
  FileWarning,
  Users,
  ShoppingBag,
  FileText,
  Folder,
  FileSpreadsheet,
  ChevronRight,
  AlertTriangle,
  Loader2,
  RotateCcw,
  CheckCircle2,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { EntityType } from '@/types/database';

interface SkippedOrFailedItem {
  id: string;
  external_id: string;
  error_message: string | null;
  data?: Record<string, unknown>;
  title?: string;
  name?: string;
}

interface UploadJob {
  id: string;
  entity_type: EntityType;
  skipped_count: number;
  error_count: number;
  error_details: Array<{ externalId: string; message: string }> | null;
}

interface UploadErrorReportProps {
  projectId: string;
  jobs: UploadJob[];
  statusCounts: Record<EntityType, { pending: number; uploaded: number; failed: number }>;
  onRetryFailed?: (entityType: EntityType, recordIds?: string[]) => Promise<void>;
  isRetrying?: EntityType | null;
  retryingIds?: string[] | null;
}

const ENTITY_CONFIG: { type: EntityType; icon: typeof ShoppingBag; label: string; singular: string }[] = [
  { type: 'pages', icon: FileSpreadsheet, label: 'Sider', singular: 'side' },
  { type: 'categories', icon: Folder, label: 'Collections', singular: 'collection' },
  { type: 'products', icon: ShoppingBag, label: 'Produkter', singular: 'produkt' },
  { type: 'customers', icon: Users, label: 'Kunder', singular: 'kunde' },
  { type: 'orders', icon: FileText, label: 'Ordrer', singular: 'ordre' },
];

// Mapping of technical Shopify errors to user-friendly Danish messages
const ERROR_TRANSLATIONS: Record<string, string> = {
  // Phone errors
  'phone has already been taken': 'Telefonnummeret er allerede i brug hos en anden kunde',
  'has already been taken': 'er allerede i brug',
  'phone is invalid': 'Telefonnummeret er ugyldigt',
  'invalid phone': 'Telefonnummeret er ugyldigt',
  'phone number is invalid': 'Telefonnummeret er ugyldigt',
  
  // Email errors
  'email has already been taken': 'E-mailadressen er allerede registreret',
  'email is invalid': 'E-mailadressen er ugyldig',
  'email is required': 'E-mailadresse er påkrævet',
  'invalid email': 'E-mailadressen er ugyldig',
  'email not found': 'E-mailadressen blev ikke fundet',
  
  // Product errors
  'title can\'t be blank': 'Titel mangler',
  'title has already been taken': 'Et element med denne titel findes allerede',
  'sku has already been taken': 'Et produkt med dette varenummer (SKU) findes allerede',
  'price must be greater than or equal to 0': 'Prisen skal være mindst 0 kr.',
  'inventory_quantity must be greater than or equal to 0': 'Lagerbeholdningen skal være mindst 0',
  'product not found': 'Produktet blev ikke fundet i Shopify',
  'variant not found': 'Produktvarianten blev ikke fundet i Shopify',
  
  // Order errors
  'customer not found': 'Kunden blev ikke fundet i Shopify',
  'line items can\'t be blank': 'Ordren skal indeholde mindst én varelinje',
  'must have at least one line item': 'Ordren skal indeholde mindst én varelinje',
  'order not found': 'Ordren blev ikke fundet',
  'no line items': 'Ordren har ingen varelinjer',
  
  // Customer errors
  'customer already exists': 'Kunden eksisterer allerede i Shopify',
  'duplicate customer': 'Kunden er allerede oprettet',
  
  // Image errors
  'image url is invalid': 'Billedets URL er ugyldig eller utilgængelig',
  'image could not be downloaded': 'Billedet kunne ikke hentes',
  'invalid image': 'Billedet er ugyldigt',
  'image too large': 'Billedet er for stort',
  
  // Address errors
  'address is invalid': 'Adressen er ugyldig',
  'invalid address': 'Adressen er ugyldig',
  'zip is invalid': 'Postnummeret er ugyldigt',
  'postal code is invalid': 'Postnummeret er ugyldigt',
  'country is invalid': 'Landet er ugyldigt',
  'province is invalid': 'Region/delstat er ugyldig',
  
  // Rate limiting
  'rate limit': 'For mange forespørgsler - prøv igen senere',
  'too many requests': 'For mange forespørgsler - prøv igen senere',
  'throttled': 'Shopify API er midlertidigt begrænset',
  
  // General errors
  'is invalid': 'er ugyldig',
  'can\'t be blank': 'må ikke være tom',
  'is too long': 'er for lang',
  'is too short': 'er for kort',
  'is required': 'er påkrævet',
  'not found': 'blev ikke fundet',
  'already exists': 'eksisterer allerede',
  'must be unique': 'skal være unik',
  'internal server error': 'Serverfejl hos Shopify',
  'timeout': 'Forbindelsen tog for lang tid',
  'connection error': 'Forbindelsesfejl til Shopify',
  'unauthorized': 'Manglende adgang - tjek API-nøgle',
  'forbidden': 'Adgang nægtet',
};

// Translate a technical error message to a user-friendly version
function translateError(message: string): string {
  if (!message) return 'Ukendt fejl';
  
  // Check for "Kunde med e-mail xxx blev ikke fundet" pattern
  if (/kunde med e-mail .+ blev ikke fundet/i.test(message)) {
    return 'Kunden blev ikke fundet i Shopify';
  }
  
  // Check for Shopify API JSON errors like: Shopify API error: 422 - {"errors":{"phone":["has already been taken"]}}
  const jsonMatch = message.match(/\{"errors":\s*(\{[^}]+\})\}/);
  if (jsonMatch) {
    try {
      const errorsStr = message.match(/\{"errors":\s*(.+)\}$/)?.[1];
      if (errorsStr) {
        const parsed = JSON.parse(`{${errorsStr.slice(0, -1)}}`);
        const friendlyErrors: string[] = [];
        
        for (const [field, messages] of Object.entries(parsed)) {
          const fieldName = translateFieldName(field);
          const msgArray = Array.isArray(messages) ? messages : [messages];
          
          for (const msg of msgArray) {
            const translatedMsg = translateErrorMessage(String(msg));
            friendlyErrors.push(`${fieldName} ${translatedMsg}`);
          }
        }
        
        if (friendlyErrors.length > 0) {
          return friendlyErrors.join('. ');
        }
      }
    } catch {
      // Fall through to other methods
    }
  }
  
  // Check for simple matches
  const lowerMessage = message.toLowerCase();
  for (const [pattern, translation] of Object.entries(ERROR_TRANSLATIONS)) {
    if (lowerMessage.includes(pattern.toLowerCase())) {
      return translation;
    }
  }
  
  // Try to clean up Shopify API error format
  const shopifyMatch = message.match(/Shopify API error: (\d+) - (.+)/);
  if (shopifyMatch) {
    const statusCode = shopifyMatch[1];
    const errorBody = shopifyMatch[2];
    
    // Try to parse JSON error body
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.errors) {
        const friendlyErrors: string[] = [];
        
        if (typeof parsed.errors === 'string') {
          return translateErrorMessage(parsed.errors);
        }
        
        for (const [field, messages] of Object.entries(parsed.errors)) {
          const fieldName = translateFieldName(field);
          const msgArray = Array.isArray(messages) ? messages : [messages];
          
          for (const msg of msgArray) {
            const translatedMsg = translateErrorMessage(String(msg));
            friendlyErrors.push(`${fieldName} ${translatedMsg}`);
          }
        }
        
        return friendlyErrors.join('. ');
      }
    } catch {
      // Not JSON, continue
    }
    
    // Return cleaned version based on status code
    if (statusCode === '422') {
      // Try to extract meaningful part from error body
      const cleanedBody = errorBody.replace(/[{}"[\]]/g, '').trim();
      if (cleanedBody.length < 100) {
        return `Valideringsfejl: ${translateErrorMessage(cleanedBody)}`;
      }
      return 'Valideringsfejl i data';
    } else if (statusCode === '429') {
      return 'For mange forespørgsler - prøv igen senere';
    } else if (statusCode === '404') {
      return 'Ressourcen blev ikke fundet i Shopify';
    } else if (statusCode === '500' || statusCode === '502' || statusCode === '503') {
      return 'Shopify serverfejl - prøv igen senere';
    } else if (statusCode === '401') {
      return 'Manglende adgang - tjek API-nøgle';
    } else if (statusCode === '403') {
      return 'Adgang nægtet til denne ressource';
    }
  }
  
  // Clean up any remaining technical-looking messages
  if (message.includes('Error:') || message.includes('error:')) {
    const cleanedMessage = message.replace(/Error:|error:/gi, '').trim();
    return translateError(cleanedMessage);
  }
  
  // If message contains JSON-like structures, simplify it
  if (message.includes('{') && message.includes('}')) {
    return 'Der opstod en fejl under behandling';
  }
  
  return message;
}

function translateFieldName(field: string): string {
  const fieldTranslations: Record<string, string> = {
    phone: 'Telefonnummer',
    email: 'E-mail',
    title: 'Titel',
    sku: 'Varenummer',
    price: 'Pris',
    name: 'Navn',
    address: 'Adresse',
    address1: 'Adresse',
    address2: 'Adresse 2',
    city: 'By',
    zip: 'Postnummer',
    postal_code: 'Postnummer',
    country: 'Land',
    country_code: 'Landekode',
    province: 'Region',
    province_code: 'Regionskode',
    customer: 'Kunde',
    product: 'Produkt',
    variant: 'Variant',
    variants: 'Varianter',
    inventory: 'Lagerbeholdning',
    inventory_quantity: 'Lagerbeholdning',
    image: 'Billede',
    images: 'Billeder',
    line_items: 'Varelinjer',
    line_item: 'Varelinje',
    first_name: 'Fornavn',
    last_name: 'Efternavn',
    company: 'Firma',
    note: 'Note',
    tags: 'Tags',
    vendor: 'Leverandør',
    product_type: 'Produkttype',
    handle: 'URL-navn',
    body_html: 'Beskrivelse',
    weight: 'Vægt',
    weight_unit: 'Vægtenhed',
    shipping_address: 'Leveringsadresse',
    billing_address: 'Faktureringsadresse',
    financial_status: 'Betalingsstatus',
    fulfillment_status: 'Leveringsstatus',
    order: 'Ordre',
    quantity: 'Antal',
    tax: 'Moms',
    discount: 'Rabat',
    currency: 'Valuta',
    base: 'Basis',
  };
  
  return fieldTranslations[field.toLowerCase()] || capitalizeFirst(field.replace(/_/g, ' '));
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function translateErrorMessage(msg: string): string {
  const msgTranslations: Record<string, string> = {
    'has already been taken': 'er allerede i brug',
    'is invalid': 'er ugyldig',
    'can\'t be blank': 'må ikke være tom',
    'cannot be blank': 'må ikke være tom',
    'is blank': 'er tom',
    'is too long': 'er for lang',
    'is too short': 'er for kort',
    'is required': 'er påkrævet',
    'is missing': 'mangler',
    'not found': 'blev ikke fundet',
    'was not found': 'blev ikke fundet',
    'does not exist': 'eksisterer ikke',
    'must be greater than or equal to 0': 'skal være mindst 0',
    'must be greater than 0': 'skal være større end 0',
    'must be a number': 'skal være et tal',
    'must be an integer': 'skal være et heltal',
    'must be positive': 'skal være et positivt tal',
    'is not a number': 'er ikke et tal',
    'is not valid': 'er ikke gyldig',
    'already exists': 'eksisterer allerede',
    'must be unique': 'skal være unik',
    'is a duplicate': 'er en duplikat',
    'exceeds maximum': 'overskrider maksimum',
    'is below minimum': 'er under minimum',
    'failed to process': 'kunne ikke behandles',
    'could not be processed': 'kunne ikke behandles',
    'could not be created': 'kunne ikke oprettes',
    'could not be updated': 'kunne ikke opdateres',
    'could not be saved': 'kunne ikke gemmes',
  };
  
  const lowerMsg = msg.toLowerCase();
  for (const [pattern, translation] of Object.entries(msgTranslations)) {
    if (lowerMsg.includes(pattern.toLowerCase())) {
      return translation;
    }
  }
  
  // If message still looks technical, try to clean it up
  if (/^[a-z_]+$/.test(msg)) {
    return capitalizeFirst(msg.replace(/_/g, ' '));
  }
  
  return msg;
}

const SKIP_REASONS: Record<EntityType, { title: string; description: string }> = {
  products: { 
    title: 'Produkter sprunget over',
    description: 'Produkter der allerede eksisterede i Shopify (matchet på titel) eller manglede titel'
  },
  customers: { 
    title: 'Kunder linket',
    description: 'Kunder der allerede eksisterede i Shopify (matchet på e-mail) blev linket i stedet for oprettet på ny'
  },
  orders: { 
    title: 'Ordrer sprunget over',
    description: 'Ordrer med ugyldige data eller manglende referencer til produkter/kunder'
  },
  categories: { 
    title: 'Collections sprunget over',
    description: 'Kategorier markeret som "exclude" eller som allerede eksisterede'
  },
  pages: { 
    title: 'Sider sprunget over',
    description: 'Sider uden indhold eller som allerede eksisterede'
  },
};

export function UploadErrorReport({ projectId, jobs, statusCounts, onRetryFailed, isRetrying, retryingIds }: UploadErrorReportProps) {
  const [loadingDownload, setLoadingDownload] = useState<string | null>(null);
  const [failedItems, setFailedItems] = useState<Record<EntityType, SkippedOrFailedItem[]>>({
    products: [],
    customers: [],
    orders: [],
    categories: [],
    pages: [],
  });
  const [skippedItems, setSkippedItems] = useState<Record<EntityType, SkippedOrFailedItem[]>>({
    products: [],
    customers: [],
    orders: [],
    categories: [],
    pages: [],
  });
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const retriedStorageKey = `uploadErrorReport.retriedItemIds.${projectId}`;
  
  // Track which specific items have been retried (by record id)
  const [retriedItemIds, setRetriedItemIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(retriedStorageKey);
      const ids = raw ? (JSON.parse(raw) as string[]) : [];
      return new Set(ids);
    } catch {
      return new Set();
    }
  });

  // Persist markers so they don't disappear during retry cycles / refresh
  useEffect(() => {
    try {
      localStorage.setItem(retriedStorageKey, JSON.stringify(Array.from(retriedItemIds)));
    } catch {
      // ignore
    }
  }, [retriedStorageKey, retriedItemIds]);

  // Get job for entity
  const getJobForEntity = (entityType: EntityType) => {
    const entityJobs = jobs.filter(j => j.entity_type === entityType);
    return entityJobs.length > 0 ? entityJobs[entityJobs.length - 1] : undefined;
  };

  // Calculate totals
  const totalFailed = Object.values(statusCounts).reduce((acc, c) => acc + c.failed, 0);
  
  // Only count actual skipped items (products without title, etc.)
  // Don't count "linked" items like customers matched by email
  const totalSkipped = Object.values(skippedItems).reduce((acc, items) => acc + items.length, 0);

  // Fetch failed and skipped items from database
  useEffect(() => {
    const fetchItems = async () => {
      // Only show loading spinner on initial load
      if (!hasLoadedOnce) {
        setIsInitialLoading(true);
      }
      
      const failedResults: Record<EntityType, SkippedOrFailedItem[]> = {
        products: [],
        customers: [],
        orders: [],
        categories: [],
        pages: [],
      };
      
      const skippedResults: Record<EntityType, SkippedOrFailedItem[]> = {
        products: [],
        customers: [],
        orders: [],
        categories: [],
        pages: [],
      };

      // Fetch failed products
      if (statusCounts.products.failed > 0) {
        const { data } = await supabase
          .from('canonical_products')
          .select('id, external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) failedResults.products = data as SkippedOrFailedItem[];
      }

      // Fetch skipped products (status=uploaded but with skip error message starting with "Sprunget over")
      const productJob = getJobForEntity('products');
      if (productJob && productJob.skipped_count > 0) {
        const { data } = await supabase
          .from('canonical_products')
          .select('id, external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'uploaded')
          .like('error_message', 'Sprunget over%')
          .limit(500);
        if (data) {
          skippedResults.products = data.map(d => ({
            id: d.id,
            external_id: d.external_id,
            error_message: d.error_message,
            title: (d.data as Record<string, unknown>)?.title as string || '',
            data: d.data as Record<string, unknown>,
          }));
        }
      }

      // ALSO fetch products with status=uploaded but with OTHER error messages (not "Sprunget over")
      // These are products that had errors during upload but were marked as uploaded anyway
      {
        const { data } = await supabase
          .from('canonical_products')
          .select('id, external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'uploaded')
          .not('error_message', 'is', null)
          .not('error_message', 'like', 'Sprunget over%')
          .limit(500);
        if (data && data.length > 0) {
          // Add these to skippedResults.products for display
          const additionalSkipped = data.map(d => ({
            id: d.id,
            external_id: d.external_id,
            error_message: d.error_message,
            title: (d.data as Record<string, unknown>)?.title as string || '',
            data: d.data as Record<string, unknown>,
          }));
          skippedResults.products = [...skippedResults.products, ...additionalSkipped];
        }
      }

      // Fetch failed customers
      if (statusCounts.customers.failed > 0) {
        const { data } = await supabase
          .from('canonical_customers')
          .select('id, external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) failedResults.customers = data as SkippedOrFailedItem[];
      }

      // Fetch failed orders
      if (statusCounts.orders.failed > 0) {
        const { data } = await supabase
          .from('canonical_orders')
          .select('id, external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) failedResults.orders = data as SkippedOrFailedItem[];
      }

      // Fetch failed categories
      if (statusCounts.categories.failed > 0) {
        const { data } = await supabase
          .from('canonical_categories')
          .select('id, external_id, error_message, name')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) failedResults.categories = data.map(d => ({ 
          id: d.id,
          external_id: d.external_id, 
          error_message: d.error_message,
          name: d.name,
        }));
      }

      // Fetch failed pages
      if (statusCounts.pages.failed > 0) {
        const { data } = await supabase
          .from('canonical_pages')
          .select('id, external_id, error_message, data')
          .eq('project_id', projectId)
          .eq('status', 'failed')
          .limit(500);
        if (data) failedResults.pages = data as SkippedOrFailedItem[];
      }

      setFailedItems(failedResults);
      setSkippedItems(skippedResults);
      setIsInitialLoading(false);
      setHasLoadedOnce(true);
    };

    fetchItems();
  }, [projectId, statusCounts, jobs]);

  // Extract the specific field name from error message for better grouping
  const extractFieldFromError = (message: string): string | null => {
    // Match patterns like "Telefonnummer er allerede i brug" or "phone has already been taken"
    const fieldPatterns = [
      /^(telefonnummer|phone)/i,
      /^(e-mail|email)/i,
      /^(navn|name|first_name|last_name)/i,
      /^(adresse|address)/i,
      /^(postnummer|zip|postal)/i,
      /^(land|country)/i,
      /^(titel|title)/i,
      /^(varenummer|sku)/i,
      /^(pris|price)/i,
      /^(varelinjer|line.?items)/i,
    ];
    
    for (const pattern of fieldPatterns) {
      if (pattern.test(message)) {
        const match = message.match(pattern);
        return match ? match[0].toLowerCase() : null;
      }
    }
    return null;
  };

  // Normalize error messages for better grouping (removes specific values like emails)
  // entityType parameter allows for different grouping strategies per entity
  const normalizeErrorForGrouping = (message: string, entityType: EntityType): string => {
    if (!message) return 'Ukendt fejl';
    
    // First translate the error
    const translated = translateError(message);
    
    // For ORDERS: group customer not found errors together
    if (entityType === 'orders') {
      const customerEmailPattern = /Kunde med e-mail .+ blev ikke fundet/i;
      if (customerEmailPattern.test(translated) || customerEmailPattern.test(message)) {
        return 'Kunde blev ikke fundet i Shopify (e-mail eksisterer ikke)';
      }
      
      const customerNotFoundPattern = /kunde?.+ikke.+fundet|customer.+not.+found|email.+not.+found/i;
      if (customerNotFoundPattern.test(message)) {
        return 'Kunde blev ikke fundet i Shopify (e-mail eksisterer ikke)';
      }
      
      const productNotFoundPattern = /produkt.+ikke.+fundet|product.+not.+found|variant.+not.+found/i;
      if (productNotFoundPattern.test(message)) {
        return 'Produkt blev ikke fundet i Shopify';
      }
      
      const addressPattern = /adresse.+ugyldig|address.+invalid|postnummer|zip|postal/i;
      if (addressPattern.test(message)) {
        return 'Adressefejl (ugyldig eller manglende adresseinformation)';
      }
      
      const lineItemPattern = /varelinje|line.?item/i;
      if (lineItemPattern.test(message) || lineItemPattern.test(translated)) {
        return 'Ordren mangler varelinjer';
      }
    }
    
    // For CUSTOMERS: keep field-specific errors separate (phone, email, etc.)
    // Don't over-group - each field type should remain separate
    if (entityType === 'customers') {
      // Phone errors - keep together but separate from other errors
      if (/telefon|phone/i.test(message) || /telefon|phone/i.test(translated)) {
        if (/allerede i brug|already been taken/i.test(message)) {
          return 'Telefonnummer er allerede i brug hos en anden kunde';
        }
        if (/ugyldig|invalid/i.test(message)) {
          return 'Telefonnummeret er ugyldigt';
        }
        return translated;
      }
      
      // Email errors
      if (/e-mail|email/i.test(message) || /e-mail|email/i.test(translated)) {
        if (/allerede|already/i.test(message)) {
          return 'E-mailadressen er allerede registreret';
        }
        if (/ugyldig|invalid/i.test(message)) {
          return 'E-mailadressen er ugyldig';
        }
        return translated;
      }
      
      // Address errors
      if (/adresse|address|postnummer|zip|postal|land|country/i.test(message)) {
        return 'Adressefejl: ' + translated;
      }
      
      // Return the translated message for other customer errors
      return translated;
    }
    
    // For PRODUCTS: keep translated message as-is for better specificity
    if (entityType === 'products') {
      return translated;
    }
    
    // For other entity types, return translated message
    return translated;
  };

  // Group items by error message (with entity-aware normalization)
  const groupByError = (items: SkippedOrFailedItem[], entityType: EntityType, normalize = true): Map<string, SkippedOrFailedItem[]> => {
    const grouped = new Map<string, SkippedOrFailedItem[]>();
    for (const item of items) {
      const key = normalize 
        ? normalizeErrorForGrouping(item.error_message || 'Ukendt fejl', entityType)
        : translateError(item.error_message || 'Ukendt fejl');
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(item);
    }
    return grouped;
  };
  
  // We track retried item IDs so the “Forsøgt igen” marker persists even if items
  // temporarily move out of the failed list while a retry is running.

  // Extract email from error message if available
  const extractEmailFromError = (message: string): string | null => {
    const emailMatch = message.match(/[\w.-]+@[\w.-]+\.\w+/);
    return emailMatch ? emailMatch[0] : null;
  };

  // Extract a clean identifier from item - prioritize name/title over external_id
  const getCleanIdentifier = (item: SkippedOrFailedItem): string => {
    // Try to get a human-readable name first
    const name = item.name || item.title || (item.data as Record<string, unknown>)?.title as string;
    if (name && typeof name === 'string' && name.length > 0 && name.length < 50) {
      return name;
    }
    
    // If external_id looks like a simple ID (no semicolons or special chars), use it
    const externalId = item.external_id;
    if (externalId && !externalId.includes(';') && !externalId.includes(',') && externalId.length < 30) {
      return externalId;
    }
    
    // Try to extract first meaningful part before any delimiter
    if (externalId) {
      const cleanId = externalId.split(/[;,\s]/)[0]?.trim();
      if (cleanId && cleanId.length > 0 && cleanId.length < 30) {
        return cleanId;
      }
    }
    
    return '(Ukendt ID)';
  };

  // Get sample details for grouped errors (e.g., emails for customer not found)
  const getSampleDetails = (items: SkippedOrFailedItem[], maxSamples = 3): { details: string[]; type: 'email' | 'name' | 'id' } => {
    const details: string[] = [];
    let detailType: 'email' | 'name' | 'id' = 'id';
    
    for (const item of items.slice(0, maxSamples)) {
      // First try to find email in error message
      const email = extractEmailFromError(item.error_message || '');
      if (email) {
        details.push(email);
        detailType = 'email';
        continue;
      }
      
      // Use clean identifier
      const identifier = getCleanIdentifier(item);
      details.push(identifier);
      
      // Determine type based on what we found
      if (item.name || item.title || (item.data as Record<string, unknown>)?.title) {
        detailType = 'name';
      }
    }
    
    return { details, type: detailType };
  };

  // Generate CSV for a specific error type within an entity
  const generateErrorTypeCsv = (entityType: EntityType, errorMessage: string, items: SkippedOrFailedItem[]) => {
    const rows = [['External ID', 'Titel/Navn', 'Fejlbesked']];
    
    for (const item of items) {
      const title = item.title || item.name || (item.data as Record<string, unknown>)?.title as string || '';
      rows.push([
        getCleanIdentifier(item),
        title,
        translateError(item.error_message || ''),
      ]);
    }
    return rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  };

  // Download handler for specific error type
  const handleDownloadErrorType = async (entityType: EntityType, errorMessage: string, items: SkippedOrFailedItem[]) => {
    const safeFilename = errorMessage.replace(/[^a-zæøåA-ZÆØÅ0-9]/g, '-').substring(0, 30);
    setLoadingDownload(`${entityType}-${safeFilename}`);
    
    try {
      const csv = generateErrorTypeCsv(entityType, errorMessage, items);
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${entityType}-${safeFilename}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setLoadingDownload(null);
    }
  };

  // Generate CSV content for failed items - include all original data fields
  const generateFailedCsv = (entityType: EntityType) => {
    const items = failedItems[entityType];
    
    if (items.length > 0) {
      // Export ALL fields from the original data plus error info
      // Collect all unique keys from all data objects
      const allKeys = new Set<string>();
      for (const item of items) {
        const data = item.data as Record<string, unknown> || {};
        Object.keys(data).forEach(key => allKeys.add(key));
      }
      
      // Build header row with all fields + error info
      const dataFields = Array.from(allKeys);
      const headers = ['external_id', ...dataFields, 'error_message', 'error_friendly'];
      
      const rows: string[][] = [headers];
      
      for (const item of items) {
        const data = item.data as Record<string, unknown> || {};
        const row: string[] = [
          item.external_id || '',
          ...dataFields.map(field => {
            const value = data[field];
            if (value === null || value === undefined) return '';
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
          }),
          item.error_message || 'Ukendt fejl',
          translateError(item.error_message || ''),
        ];
        rows.push(row);
      }
      
      return rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    }
    
    // Fallback for empty items
    return [['External ID', 'Titel/Navn', 'Fejlbesked', 'Brugervenlig fejl']].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  };

  // Generate CSV content for skipped items - include all original product data
  const generateSkippedCsv = (entityType: EntityType) => {
    const items = skippedItems[entityType];
    
    if (entityType === 'products' && items.length > 0) {
      // For products, export ALL fields from the original data plus the skip reason
      // Collect all unique keys from all product data objects
      const allKeys = new Set<string>();
      for (const item of items) {
        const data = item.data as Record<string, unknown> || {};
        Object.keys(data).forEach(key => allKeys.add(key));
      }
      
      // Build header row with all product fields + skip reason
      const productFields = Array.from(allKeys);
      const headers = ['external_id', ...productFields, 'skip_reason'];
      
      const rows: string[][] = [headers];
      
      for (const item of items) {
        const data = item.data as Record<string, unknown> || {};
        const row: string[] = [
          item.external_id || '',
          ...productFields.map(field => {
            const value = data[field];
            if (value === null || value === undefined) return '';
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
          }),
          item.error_message || SKIP_REASONS[entityType].description,
        ];
        rows.push(row);
      }
      
      return rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    }
    
    // For other entity types (orders, customers, categories), also export all fields
    const allKeys = new Set<string>();
    for (const item of items) {
      const data = item.data as Record<string, unknown> || {};
      Object.keys(data).forEach(key => allKeys.add(key));
    }
    
    const dataFields = Array.from(allKeys);
    const headers = ['external_id', ...dataFields, 'skip_reason'];
    
    const rows: string[][] = [headers];
    
    for (const item of items) {
      const data = item.data as Record<string, unknown> || {};
      const row: string[] = [
        item.external_id || '',
        ...dataFields.map(field => {
          const value = data[field];
          if (value === null || value === undefined) return '';
          if (typeof value === 'object') return JSON.stringify(value);
          return String(value);
        }),
        item.error_message || SKIP_REASONS[entityType].description,
      ];
      rows.push(row);
    }
    
    return rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  };

  // Download handler
  const handleDownload = async (entityType: EntityType, type: 'failed' | 'skipped') => {
    setLoadingDownload(`${entityType}-${type}`);
    
    try {
      let csv = '';
      let filename = '';
      
      if (type === 'failed') {
        csv = generateFailedCsv(entityType);
        filename = `${entityType}-fejl.csv`;
      } else {
        csv = generateSkippedCsv(entityType);
        filename = `${entityType}-sprunget-over.csv`;
      }
      
      // Create and download file
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setLoadingDownload(null);
    }
  };

  // Download all errors combined
  const handleDownloadAll = async () => {
    setLoadingDownload('all');
    
    try {
      let csv = 'Type,External ID,Titel/Navn,Fejlbesked,Brugervenlig fejl\n';
      
      for (const { type, label } of ENTITY_CONFIG) {
        for (const item of failedItems[type]) {
          const title = item.title || item.name || (item.data as Record<string, unknown>)?.title as string || '';
          csv += [
            `"${label}"`,
            `"${item.external_id}"`,
            `"${String(title).replace(/"/g, '""')}"`,
            `"${(item.error_message || 'Ukendt fejl').replace(/"/g, '""')}"`,
            `"${translateError(item.error_message || '').replace(/"/g, '""')}"`,
          ].join(',') + '\n';
        }
      }
      
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'alle-fejl-rapport.csv';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setLoadingDownload(null);
    }
  };

  // If no errors or skips, don't render anything
  if (totalFailed === 0 && totalSkipped === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileWarning className="w-5 h-5 text-amber-600" />
              Upload rapport
            </CardTitle>
            <CardDescription className="mt-1">
              Oversigt over elementer der ikke blev uploadet som nye
            </CardDescription>
          </div>
          {totalFailed > 0 && (
            <Button 
              variant="outline" 
              size="sm"
              onClick={handleDownloadAll}
              disabled={loadingDownload === 'all'}
            >
              {loadingDownload === 'all' ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Download className="w-4 h-4 mr-2" />
              )}
              Download alle fejl
            </Button>
          )}
        </div>
        
        {/* Summary badges */}
        <div className="flex flex-wrap gap-2 mt-4">
          {totalFailed > 0 && (
            <Badge variant="destructive" className="text-sm">
              <AlertCircle className="w-3.5 h-3.5 mr-1" />
              {totalFailed.toLocaleString('da-DK')} fejlede
            </Badge>
          )}
          {totalSkipped > 0 && (
            <Badge variant="outline" className="text-sm bg-amber-500/10 text-amber-700 border-amber-500/30">
              <SkipForward className="w-3.5 h-3.5 mr-1" />
              {totalSkipped.toLocaleString('da-DK')} sprunget over / linket
            </Badge>
          )}
        </div>
      </CardHeader>
      
      <CardContent>
        {isInitialLoading && !hasLoadedOnce ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Accordion type="multiple" className="w-full">
            {ENTITY_CONFIG.map(({ type, icon: Icon, label, singular }) => {
              const job = getJobForEntity(type);
              const failedCount = statusCounts[type].failed;
              const skippedCount = job?.skipped_count || 0;
              const failed = failedItems[type];
              const skipped = skippedItems[type];
              const groupedErrors = groupByError(failed, type);
              const groupedSkipped = groupByError(skipped, type);
              
              // Skip if no errors or skips for this entity
              if (failedCount === 0 && skippedCount === 0) return null;

              return (
                <AccordionItem key={type} value={type} className="border rounded-lg mb-3 px-4">
                  <AccordionTrigger className="hover:no-underline py-4">
                    <div className="flex items-center justify-between w-full pr-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                          <Icon className="w-5 h-5 text-muted-foreground" />
                        </div>
                        <div className="text-left">
                          <span className="font-medium">{label}</span>
                          <div className="flex gap-3 text-xs mt-0.5">
                            {failedCount > 0 && (
                              <span className="text-destructive flex items-center gap-1">
                                <AlertCircle className="w-3 h-3" />
                                {failedCount} fejl
                              </span>
                            )}
                            {skippedCount > 0 && (
                              <span className="text-amber-600 flex items-center gap-1">
                                <SkipForward className="w-3 h-3" />
                                {skippedCount} sprunget over
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </AccordionTrigger>
                  
                  <AccordionContent className="pb-4">
                    <div className="space-y-4">
                      {/* Failed items section */}
                      {failedCount > 0 && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-medium text-destructive flex items-center gap-2">
                              <AlertTriangle className="w-4 h-4" />
                              Fejlede elementer ({failedCount})
                            </h4>
                            <div className="flex items-center gap-2">
                              {onRetryFailed && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    const ids = failed.map(item => item.id);
                                    setRetriedItemIds(prev => new Set([...prev, ...ids]));
                                    onRetryFailed(type, undefined);
                                  }}
                                  disabled={isRetrying === type}
                                  className="text-xs h-7 border-amber-500/50 text-amber-700 hover:bg-amber-500/10"
                                >
                                  {isRetrying === type && !retryingIds ? (
                                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                  ) : (
                                    <RotateCcw className="w-3 h-3 mr-1" />
                                  )}
                                  Prøv alle igen
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDownload(type, 'failed')}
                                disabled={loadingDownload === `${type}-failed`}
                                className="text-xs h-7"
                              >
                                {loadingDownload === `${type}-failed` ? (
                                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                ) : (
                                  <Download className="w-3 h-3 mr-1" />
                                )}
                                Download CSV
                              </Button>
                            </div>
                          </div>
                          
                          {/* Grouped errors - with normalized messages */}
                          <div className="space-y-2">
                            {Array.from(groupedErrors.entries()).map(([message, errorItems]) => {
                              const { details: sampleDetails, type: detailType } = getSampleDetails(errorItems, 3);
                               const safeFilename = message.replace(/[^a-zæøåA-ZÆØÅ0-9]/g, '-').substring(0, 30);
                               const wasRetried = errorItems.every(item => retriedItemIds.has(item.id));
                              
                              return (
                                <div 
                                  key={message} 
                                  className={`rounded-lg p-3 ${
                                    wasRetried 
                                      ? 'bg-amber-500/10 border border-amber-500/30' 
                                      : 'bg-destructive/5 border border-destructive/20'
                                  }`}
                                >
                                  <div className="flex items-start gap-2">
                                    {wasRetried ? (
                                      <CheckCircle2 className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                                    ) : (
                                      <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <p className={`text-sm font-medium ${wasRetried ? 'text-amber-700' : 'text-destructive'}`}>
                                          {message}
                                        </p>
                                        {wasRetried && (
                                          <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-700 border-amber-500/30">
                                            Forsøgt igen
                                          </Badge>
                                        )}
                                      </div>
                                      <p className="text-xs text-muted-foreground mt-1">
                                        {errorItems.length === 1 
                                          ? `1 ${singular}` 
                                          : `${errorItems.length} ${label.toLowerCase()}`
                                        }
                                      </p>
                                      {/* Show sample details based on type */}
                                      {sampleDetails.length > 0 && (
                                        <p className="text-xs text-muted-foreground mt-1">
                                          {detailType === 'email' ? 'F.eks.: ' : detailType === 'name' ? 'F.eks.: ' : ''}
                                          {sampleDetails.join(', ')}
                                          {errorItems.length > 3 && ` og ${errorItems.length - 3} flere`}
                                        </p>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      {onRetryFailed && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => {
                                            const ids = errorItems.map(item => item.id);
                                            setRetriedItemIds(prev => new Set([...prev, ...ids]));
                                            onRetryFailed(type, ids);
                                          }}
                                          disabled={isRetrying === type}
                                          className="text-xs h-6 px-2 text-amber-700 hover:bg-amber-500/10"
                                          title="Prøv denne fejltype igen"
                                        >
                                          {isRetrying === type && retryingIds?.some(id => errorItems.some(e => e.id === id)) ? (
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                          ) : (
                                            <RotateCcw className="w-3 h-3" />
                                          )}
                                        </Button>
                                      )}
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => handleDownloadErrorType(type, message, errorItems)}
                                        disabled={loadingDownload === `${type}-${safeFilename}`}
                                        className="text-xs h-6 px-2"
                                        title="Download denne fejltype"
                                      >
                                        {loadingDownload === `${type}-${safeFilename}` ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <Download className="w-3 h-3" />
                                        )}
                                      </Button>
                                      <Badge variant="outline" className={`text-xs ${
                                        wasRetried 
                                          ? 'bg-amber-500/10 text-amber-700 border-amber-500/30' 
                                          : 'bg-destructive/10 text-destructive border-destructive/30'
                                      }`}>
                                        {errorItems.length}
                                      </Badge>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      
                      {/* Skipped items section */}
                      {skippedCount > 0 && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-medium text-amber-700 dark:text-amber-500 flex items-center gap-2">
                              <SkipForward className="w-4 h-4" />
                              Sprunget over ({skippedCount})
                            </h4>
                            {skipped.length > 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDownload(type, 'skipped')}
                                disabled={loadingDownload === `${type}-skipped`}
                                className="text-xs h-7"
                              >
                                {loadingDownload === `${type}-skipped` ? (
                                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                ) : (
                                  <Download className="w-3 h-3 mr-1" />
                                )}
                                Download CSV
                              </Button>
                            )}
                          </div>
                          
                          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
                            <div className="flex items-start gap-2">
                              <ChevronRight className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                              <div className="flex-1">
                                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                                  {SKIP_REASONS[type].title}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                  {SKIP_REASONS[type].description}
                                </p>
                              </div>
                              <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-700 border-amber-500/30">
                                {skippedCount}
                              </Badge>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}
