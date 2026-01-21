-- Create table for storing URL redirects
CREATE TABLE public.project_redirects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL, -- 'product', 'category', 'page'
  entity_id UUID NOT NULL,   -- reference til canonical_* record
  old_path TEXT NOT NULL,    -- fx /shop/7-days-active-27040p.html
  new_path TEXT NOT NULL,    -- fx /products/7-days-active-2-pack-socks
  status TEXT NOT NULL DEFAULT 'pending', -- pending, created, failed, skipped
  shopify_redirect_id TEXT,  -- Shopify redirect ID efter oprettelse
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX idx_project_redirects_project_id ON public.project_redirects(project_id);
CREATE INDEX idx_project_redirects_status ON public.project_redirects(status);
CREATE INDEX idx_project_redirects_entity ON public.project_redirects(entity_type, entity_id);

-- Enable RLS
ALTER TABLE public.project_redirects ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can view redirects for own projects"
ON public.project_redirects
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_redirects.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can create redirects for own projects"
ON public.project_redirects
FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_redirects.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can update redirects for own projects"
ON public.project_redirects
FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_redirects.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can delete redirects for own projects"
ON public.project_redirects
FOR DELETE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_redirects.project_id
  AND projects.user_id = auth.uid()
));

-- Trigger for updated_at
CREATE TRIGGER update_project_redirects_updated_at
BEFORE UPDATE ON public.project_redirects
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();