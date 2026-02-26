
-- Unpause the project
UPDATE projects SET uploads_paused = false WHERE id = '900674e0-5eef-450e-bda4-5246ae5190d0';

-- Reset the paused orders upload job to pending, clear stale lock
UPDATE upload_jobs 
SET status = 'pending', 
    worker_lock_id = NULL, 
    worker_locked_until = NULL,
    updated_at = now()
WHERE id = 'ea1a05fa-2332-4c42-a91c-cbe72702feaa' 
  AND entity_type = 'orders';
