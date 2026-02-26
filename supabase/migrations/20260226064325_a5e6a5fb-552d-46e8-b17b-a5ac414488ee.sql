ALTER TABLE public.upload_jobs
ADD COLUMN IF NOT EXISTS worker_lock_id uuid,
ADD COLUMN IF NOT EXISTS worker_locked_until timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_upload_jobs_orders_worker_lock
ON public.upload_jobs (entity_type, status, worker_locked_until)
WHERE entity_type = 'orders';