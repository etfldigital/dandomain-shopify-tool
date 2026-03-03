
-- Table to store DanDomain manufacturer lookup (MANUFAC_ID → name)
CREATE TABLE public.canonical_manufacturers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(project_id, external_id)
);

ALTER TABLE public.canonical_manufacturers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view manufacturers for own projects"
ON public.canonical_manufacturers FOR SELECT
USING (EXISTS (SELECT 1 FROM projects WHERE projects.id = canonical_manufacturers.project_id AND projects.user_id = auth.uid()));

CREATE POLICY "Users can create manufacturers for own projects"
ON public.canonical_manufacturers FOR INSERT
WITH CHECK (EXISTS (SELECT 1 FROM projects WHERE projects.id = canonical_manufacturers.project_id AND projects.user_id = auth.uid()));

CREATE POLICY "Users can delete manufacturers for own projects"
ON public.canonical_manufacturers FOR DELETE
USING (EXISTS (SELECT 1 FROM projects WHERE projects.id = canonical_manufacturers.project_id AND projects.user_id = auth.uid()));

CREATE POLICY "Service role full access to manufacturers"
ON public.canonical_manufacturers FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
