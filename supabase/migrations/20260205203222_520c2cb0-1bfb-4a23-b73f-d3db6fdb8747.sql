-- Add prepare offset column for resumable prepare-upload
ALTER TABLE public.upload_jobs
  ADD COLUMN IF NOT EXISTS prepare_offset integer NOT NULL DEFAULT 0;