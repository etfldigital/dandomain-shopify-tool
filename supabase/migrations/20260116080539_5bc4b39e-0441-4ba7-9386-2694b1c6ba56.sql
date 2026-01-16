-- Create upload_jobs table for background processing
CREATE TABLE public.upload_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('products', 'customers', 'orders', 'categories', 'pages')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  
  -- Progress tracking
  total_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  
  -- Speed tracking for ETA
  items_per_minute NUMERIC(10, 2) DEFAULT NULL,
  
  -- Error details (JSON array of {externalId, message})
  error_details JSONB DEFAULT '[]'::jsonb,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  completed_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  last_heartbeat_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  
  -- Batch processing
  batch_size INTEGER NOT NULL DEFAULT 50,
  current_batch INTEGER NOT NULL DEFAULT 0,
  
  -- Test mode flag
  is_test_mode BOOLEAN NOT NULL DEFAULT false
);

-- Create index for faster lookups
CREATE INDEX idx_upload_jobs_project_status ON public.upload_jobs(project_id, status);
CREATE INDEX idx_upload_jobs_heartbeat ON public.upload_jobs(status, last_heartbeat_at) WHERE status = 'running';

-- Enable RLS
ALTER TABLE public.upload_jobs ENABLE ROW LEVEL SECURITY;

-- Users can only see their own project's jobs
CREATE POLICY "Users can view their own upload jobs"
ON public.upload_jobs
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = upload_jobs.project_id
    AND p.user_id = auth.uid()
  )
);

-- Users can create jobs for their own projects
CREATE POLICY "Users can create upload jobs for their projects"
ON public.upload_jobs
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = upload_jobs.project_id
    AND p.user_id = auth.uid()
  )
);

-- Users can update their own project's jobs (for pause/cancel)
CREATE POLICY "Users can update their own upload jobs"
ON public.upload_jobs
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = upload_jobs.project_id
    AND p.user_id = auth.uid()
  )
);

-- Create trigger for updating updated_at
CREATE TRIGGER update_upload_jobs_updated_at
BEFORE UPDATE ON public.upload_jobs
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Enable realtime for live progress updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.upload_jobs;