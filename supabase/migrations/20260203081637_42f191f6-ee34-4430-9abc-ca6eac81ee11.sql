-- Add explicit locking columns to prevent concurrent workers from creating duplicates
ALTER TABLE public.canonical_products
  ADD COLUMN IF NOT EXISTS upload_lock_id uuid,
  ADD COLUMN IF NOT EXISTS upload_locked_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS upload_locked_until timestamp with time zone;

-- Helpful index for finding/clearing expired locks
CREATE INDEX IF NOT EXISTS idx_canonical_products_upload_lock
  ON public.canonical_products (project_id, upload_locked_until);
