ALTER TABLE public.upload_jobs
ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP WITH TIME ZONE NULL;

CREATE INDEX IF NOT EXISTS idx_upload_jobs_next_attempt_at
ON public.upload_jobs (next_attempt_at)
WHERE next_attempt_at IS NOT NULL;