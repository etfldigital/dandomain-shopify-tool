-- Add a hard-stop flag on projects to prevent any background auto-restarts
ALTER TABLE public.projects
ADD COLUMN IF NOT EXISTS uploads_paused boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_projects_uploads_paused ON public.projects (uploads_paused);
