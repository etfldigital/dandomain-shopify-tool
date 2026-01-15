-- Create enum for job types
CREATE TYPE public.job_type AS ENUM ('extract', 'normalize', 'upload');

-- Create enum for job status
CREATE TYPE public.job_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');

-- Create enum for entity types
CREATE TYPE public.entity_type AS ENUM ('products', 'customers', 'orders', 'categories', 'pages');

-- Create enum for project status
CREATE TYPE public.project_status AS ENUM ('draft', 'connected', 'extracted', 'mapped', 'migrating', 'completed');

-- Create enum for canonical item status
CREATE TYPE public.canonical_status AS ENUM ('pending', 'mapped', 'uploaded', 'failed');

-- Profiles table for user information
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  full_name TEXT,
  email TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Enable RLS on profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Profiles RLS policies
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Projects table
CREATE TABLE public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  dandomain_shop_url TEXT,
  dandomain_api_key_encrypted TEXT,
  shopify_store_domain TEXT,
  shopify_access_token_encrypted TEXT,
  status public.project_status DEFAULT 'draft' NOT NULL,
  product_count INTEGER DEFAULT 0,
  customer_count INTEGER DEFAULT 0,
  order_count INTEGER DEFAULT 0,
  category_count INTEGER DEFAULT 0,
  page_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Enable RLS on projects
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- Projects RLS policies
CREATE POLICY "Users can view own projects"
  ON public.projects FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own projects"
  ON public.projects FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own projects"
  ON public.projects FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own projects"
  ON public.projects FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Jobs table
CREATE TABLE public.jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  type public.job_type NOT NULL,
  entity_type public.entity_type NOT NULL,
  status public.job_status DEFAULT 'pending' NOT NULL,
  total_count INTEGER DEFAULT 0,
  processed_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  progress_percent INTEGER DEFAULT 0,
  error_log_url TEXT,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Enable RLS on jobs
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

-- Jobs RLS policies (via project ownership)
CREATE POLICY "Users can view jobs for own projects"
  ON public.jobs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = jobs.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create jobs for own projects"
  ON public.jobs FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = jobs.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update jobs for own projects"
  ON public.jobs FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = jobs.project_id 
      AND projects.user_id = auth.uid()
    )
  );

-- Mapping profiles table
CREATE TABLE public.mapping_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  mappings JSONB DEFAULT '[]'::jsonb NOT NULL,
  is_active BOOLEAN DEFAULT false NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Enable RLS on mapping_profiles
ALTER TABLE public.mapping_profiles ENABLE ROW LEVEL SECURITY;

-- Mapping profiles RLS policies
CREATE POLICY "Users can view mapping profiles for own projects"
  ON public.mapping_profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = mapping_profiles.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create mapping profiles for own projects"
  ON public.mapping_profiles FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = mapping_profiles.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update mapping profiles for own projects"
  ON public.mapping_profiles FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = mapping_profiles.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete mapping profiles for own projects"
  ON public.mapping_profiles FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = mapping_profiles.project_id 
      AND projects.user_id = auth.uid()
    )
  );

-- Canonical products table
CREATE TABLE public.canonical_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  external_id TEXT NOT NULL,
  shopify_id TEXT,
  data JSONB NOT NULL,
  status public.canonical_status DEFAULT 'pending' NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  UNIQUE(project_id, external_id)
);

-- Enable RLS on canonical_products
ALTER TABLE public.canonical_products ENABLE ROW LEVEL SECURITY;

-- Canonical products RLS policies
CREATE POLICY "Users can view canonical products for own projects"
  ON public.canonical_products FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_products.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create canonical products for own projects"
  ON public.canonical_products FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_products.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update canonical products for own projects"
  ON public.canonical_products FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_products.project_id 
      AND projects.user_id = auth.uid()
    )
  );

-- Canonical customers table
CREATE TABLE public.canonical_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  external_id TEXT NOT NULL,
  shopify_id TEXT,
  data JSONB NOT NULL,
  status public.canonical_status DEFAULT 'pending' NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  UNIQUE(project_id, external_id)
);

-- Enable RLS on canonical_customers
ALTER TABLE public.canonical_customers ENABLE ROW LEVEL SECURITY;

-- Canonical customers RLS policies
CREATE POLICY "Users can view canonical customers for own projects"
  ON public.canonical_customers FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_customers.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create canonical customers for own projects"
  ON public.canonical_customers FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_customers.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update canonical customers for own projects"
  ON public.canonical_customers FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_customers.project_id 
      AND projects.user_id = auth.uid()
    )
  );

-- Canonical orders table
CREATE TABLE public.canonical_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  external_id TEXT NOT NULL,
  shopify_id TEXT,
  data JSONB NOT NULL,
  status public.canonical_status DEFAULT 'pending' NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  UNIQUE(project_id, external_id)
);

-- Enable RLS on canonical_orders
ALTER TABLE public.canonical_orders ENABLE ROW LEVEL SECURITY;

-- Canonical orders RLS policies
CREATE POLICY "Users can view canonical orders for own projects"
  ON public.canonical_orders FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_orders.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create canonical orders for own projects"
  ON public.canonical_orders FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_orders.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update canonical orders for own projects"
  ON public.canonical_orders FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_orders.project_id 
      AND projects.user_id = auth.uid()
    )
  );

-- Canonical categories table
CREATE TABLE public.canonical_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  external_id TEXT NOT NULL,
  shopify_collection_id TEXT,
  name TEXT NOT NULL,
  parent_external_id TEXT,
  slug TEXT,
  shopify_tag TEXT,
  exclude BOOLEAN DEFAULT false NOT NULL,
  merge_into TEXT,
  status public.canonical_status DEFAULT 'pending' NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  UNIQUE(project_id, external_id)
);

-- Enable RLS on canonical_categories
ALTER TABLE public.canonical_categories ENABLE ROW LEVEL SECURITY;

-- Canonical categories RLS policies
CREATE POLICY "Users can view canonical categories for own projects"
  ON public.canonical_categories FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_categories.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create canonical categories for own projects"
  ON public.canonical_categories FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_categories.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update canonical categories for own projects"
  ON public.canonical_categories FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_categories.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete canonical categories for own projects"
  ON public.canonical_categories FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_categories.project_id 
      AND projects.user_id = auth.uid()
    )
  );

-- Canonical pages table
CREATE TABLE public.canonical_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  external_id TEXT NOT NULL,
  shopify_id TEXT,
  data JSONB NOT NULL,
  status public.canonical_status DEFAULT 'pending' NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  UNIQUE(project_id, external_id)
);

-- Enable RLS on canonical_pages
ALTER TABLE public.canonical_pages ENABLE ROW LEVEL SECURITY;

-- Canonical pages RLS policies
CREATE POLICY "Users can view canonical pages for own projects"
  ON public.canonical_pages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_pages.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create canonical pages for own projects"
  ON public.canonical_pages FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_pages.project_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update canonical pages for own projects"
  ON public.canonical_pages FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects 
      WHERE projects.id = canonical_pages.project_id 
      AND projects.user_id = auth.uid()
    )
  );

-- Job errors table
CREATE TABLE public.job_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES public.jobs(id) ON DELETE CASCADE NOT NULL,
  entity_type public.entity_type NOT NULL,
  entity_external_id TEXT NOT NULL,
  error_message TEXT NOT NULL,
  raw_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Enable RLS on job_errors
ALTER TABLE public.job_errors ENABLE ROW LEVEL SECURITY;

-- Job errors RLS policies
CREATE POLICY "Users can view job errors for own projects"
  ON public.job_errors FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.jobs 
      JOIN public.projects ON projects.id = jobs.project_id
      WHERE jobs.id = job_errors.job_id 
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create job errors for own projects"
  ON public.job_errors FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.jobs 
      JOIN public.projects ON projects.id = jobs.project_id
      WHERE jobs.id = job_errors.job_id 
      AND projects.user_id = auth.uid()
    )
  );

-- Function to auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, full_name)
  VALUES (
    NEW.id, 
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', '')
  );
  RETURN NEW;
END;
$$;

-- Trigger to auto-create profile
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Add updated_at triggers
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_mapping_profiles_updated_at
  BEFORE UPDATE ON public.mapping_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_canonical_products_updated_at
  BEFORE UPDATE ON public.canonical_products
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_canonical_customers_updated_at
  BEFORE UPDATE ON public.canonical_customers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_canonical_orders_updated_at
  BEFORE UPDATE ON public.canonical_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_canonical_categories_updated_at
  BEFORE UPDATE ON public.canonical_categories
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_canonical_pages_updated_at
  BEFORE UPDATE ON public.canonical_pages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Create indexes for performance
CREATE INDEX idx_projects_user_id ON public.projects(user_id);
CREATE INDEX idx_jobs_project_id ON public.jobs(project_id);
CREATE INDEX idx_jobs_status ON public.jobs(status);
CREATE INDEX idx_canonical_products_project_id ON public.canonical_products(project_id);
CREATE INDEX idx_canonical_products_status ON public.canonical_products(status);
CREATE INDEX idx_canonical_customers_project_id ON public.canonical_customers(project_id);
CREATE INDEX idx_canonical_orders_project_id ON public.canonical_orders(project_id);
CREATE INDEX idx_canonical_categories_project_id ON public.canonical_categories(project_id);
CREATE INDEX idx_canonical_pages_project_id ON public.canonical_pages(project_id);
CREATE INDEX idx_job_errors_job_id ON public.job_errors(job_id);