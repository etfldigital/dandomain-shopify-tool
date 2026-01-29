-- Add confidence_score column to project_redirects
ALTER TABLE public.project_redirects 
ADD COLUMN IF NOT EXISTS confidence_score integer DEFAULT 0;

-- Add a check constraint to ensure valid score range
ALTER TABLE public.project_redirects 
ADD CONSTRAINT confidence_score_range 
CHECK (confidence_score >= 0 AND confidence_score <= 100);

COMMENT ON COLUMN public.project_redirects.confidence_score IS 'Confidence score for the redirect match (0-100). Low scores indicate uncertain matches.';