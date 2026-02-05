-- Ensure redirects can be upserted deterministically per project + old_path
-- Required because the match-redirects backend function uses upsert(..., { onConflict: 'project_id,old_path' })

ALTER TABLE public.project_redirects
ADD CONSTRAINT project_redirects_project_id_old_path_key UNIQUE (project_id, old_path);

-- Helpful index for loading/sorting in UI
CREATE INDEX IF NOT EXISTS idx_project_redirects_project_id_confidence
ON public.project_redirects (project_id, confidence_score DESC, updated_at DESC);
