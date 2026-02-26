ALTER TABLE public.upload_jobs 
  ADD COLUMN IF NOT EXISTS lookup_cache jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lookup_cache_built_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_bucket_used integer DEFAULT 0;