
CREATE OR REPLACE FUNCTION public.count_primary_products(p_project_id uuid)
RETURNS TABLE(status text, primary_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT 
    cp.status::text,
    count(DISTINCT cp.data->>'title') as primary_count
  FROM canonical_products cp
  WHERE cp.project_id = p_project_id
  GROUP BY cp.status;
$$;
