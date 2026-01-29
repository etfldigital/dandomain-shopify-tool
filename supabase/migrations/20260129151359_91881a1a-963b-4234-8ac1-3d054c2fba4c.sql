-- Add columns for AI-driven redirect matching
ALTER TABLE public.project_redirects
ADD COLUMN IF NOT EXISTS matched_by text DEFAULT 'auto',
ADD COLUMN IF NOT EXISTS ai_suggestions jsonb DEFAULT '[]'::jsonb;

-- Add comment for documentation
COMMENT ON COLUMN public.project_redirects.matched_by IS 'Strategy that found this match: exact, sku, title, ai, manual';
COMMENT ON COLUMN public.project_redirects.ai_suggestions IS 'Alternative match suggestions from AI for manual review';