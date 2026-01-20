export type JobType = 'extract' | 'normalize' | 'upload';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type EntityType = 'products' | 'customers' | 'orders' | 'categories' | 'pages';
export type ProjectStatus = 'draft' | 'connected' | 'extracted' | 'mapped' | 'migrating' | 'completed';
export type CanonicalStatus = 'pending' | 'mapped' | 'uploaded' | 'failed';

export interface Profile {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  dandomain_shop_url: string | null;
  dandomain_api_key_encrypted: string | null;
  shopify_store_domain: string | null;
  shopify_access_token_encrypted: string | null;
  status: ProjectStatus;
  product_count: number;
  customer_count: number;
  order_count: number;
  category_count: number;
  page_count: number;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  project_id: string;
  type: JobType;
  entity_type: EntityType;
  status: JobStatus;
  total_count: number;
  processed_count: number;
  error_count: number;
  progress_percent: number;
  error_log_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface MappingProfile {
  id: string;
  project_id: string;
  name: string;
  mappings: CategoryMapping[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CategoryMapping {
  external_id: string;
  dandomain_name: string;
  shopify_tag: string;
  exclude: boolean;
  merge_into: string | null;
}

export interface CanonicalProduct {
  id: string;
  project_id: string;
  external_id: string;
  shopify_id: string | null;
  data: ProductData;
  status: CanonicalStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductData {
  title: string;
  body_html: string;
  short_description: string;
  sku: string;
  price: number;
  compare_at_price: number | null;
  cost_price?: number | null;
  weight: number | null;
  stock_quantity: number;
  active: boolean;
  images: string[];
  tags: string[];
  category_external_ids: string[];
  vendor: string | null;
  vat_rate: number | null;
  language: string;
  // Additional XML-specific fields
  barcode?: string;
  internal_id?: string;
  // Custom fields for metafield mapping (DanDomain CUSTOM_FIELDS)
  field_1?: string;
  field_2?: string;
  field_3?: string;
  field_9?: string;
}

export interface CanonicalCustomer {
  id: string;
  project_id: string;
  external_id: string;
  shopify_id: string | null;
  data: CustomerData;
  status: CanonicalStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerData {
  email: string;
  first_name: string;
  last_name: string;
  company: string | null;
  phone: string | null;
  country: string | null;
  vat_number: string | null;
  accepts_marketing: boolean;
  addresses: Address[];
  created_at: string;
}

export interface Address {
  address1: string;
  address2: string | null;
  city: string;
  zip: string;
  country: string;
  phone: string | null;
}

export interface CanonicalOrder {
  id: string;
  project_id: string;
  external_id: string;
  shopify_id: string | null;
  data: OrderData;
  status: CanonicalStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderData {
  customer_external_id: string;
  /**
   * Optional customer info from the Orders CSV.
   * Used as fallback for linking/creating customers when customer_external_id mapping is missing.
   */
  customer_email?: string;
  customer_first_name?: string;
  customer_last_name?: string;
  customer_phone?: string;
  customer_address?: string;
  customer_zip?: string;
  customer_city?: string;
  customer_country?: string;
  order_date: string;
  currency: string;
  subtotal_price: number;
  total_price: number;
  total_tax: number;
  shipping_price: number;
  discount_total: number;
  line_items: LineItem[];
  billing_address: Address;
  shipping_address: Address;
  financial_status: string;
  fulfillment_status: string;
}

export interface LineItem {
  product_external_id: string;
  sku: string;
  title: string;
  quantity: number;
  price: number;
}

export interface CanonicalCategory {
  id: string;
  project_id: string;
  external_id: string;
  shopify_collection_id: string | null;
  name: string;
  parent_external_id: string | null;
  slug: string | null;
  shopify_tag: string | null;
  exclude: boolean;
  merge_into: string | null;
  status: CanonicalStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalPage {
  id: string;
  project_id: string;
  external_id: string;
  shopify_id: string | null;
  data: PageData;
  status: CanonicalStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageData {
  title: string;
  body_html: string;
  slug: string;
  published: boolean;
}

export interface JobError {
  id: string;
  job_id: string;
  entity_type: EntityType;
  entity_external_id: string;
  error_message: string;
  raw_data: unknown;
  created_at: string;
}

// Wizard steps
export type WizardStep = 
  | 'connect' 
  | 'extract' 
  | 'mapping' 
  | 'upload' 
  | 'review'
  | 'report';

export const WIZARD_STEPS: { id: WizardStep; label: string; number: number }[] = [
  { id: 'connect', label: 'Forbind', number: 1 },
  { id: 'extract', label: 'Udtræk', number: 2 },
  { id: 'mapping', label: 'Mapping', number: 3 },
  { id: 'upload', label: 'Upload', number: 4 },
  { id: 'review', label: 'Gennemgang', number: 5 },
  { id: 'report', label: 'Rapport', number: 6 },
];