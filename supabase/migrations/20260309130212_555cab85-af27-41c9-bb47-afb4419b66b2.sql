
CREATE INDEX IF NOT EXISTS idx_canonical_orders_project_status ON public.canonical_orders (project_id, status);
CREATE INDEX IF NOT EXISTS idx_canonical_customers_project_status ON public.canonical_customers (project_id, status);
CREATE INDEX IF NOT EXISTS idx_canonical_products_project_status ON public.canonical_products (project_id, status);
CREATE INDEX IF NOT EXISTS idx_canonical_categories_project_status ON public.canonical_categories (project_id, status);
CREATE INDEX IF NOT EXISTS idx_canonical_pages_project_status ON public.canonical_pages (project_id, status);
