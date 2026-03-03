
-- Create a table to store uploaded DanDomain price periods
CREATE TABLE public.price_periods (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  period_id text NOT NULL,
  title text,
  start_date date,
  end_date date,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(project_id, period_id)
);

-- Enable RLS
ALTER TABLE public.price_periods ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can view price periods for own projects"
ON public.price_periods FOR SELECT
USING (EXISTS (SELECT 1 FROM projects WHERE projects.id = price_periods.project_id AND projects.user_id = auth.uid()));

CREATE POLICY "Users can create price periods for own projects"
ON public.price_periods FOR INSERT
WITH CHECK (EXISTS (SELECT 1 FROM projects WHERE projects.id = price_periods.project_id AND projects.user_id = auth.uid()));

CREATE POLICY "Users can update price periods for own projects"
ON public.price_periods FOR UPDATE
USING (EXISTS (SELECT 1 FROM projects WHERE projects.id = price_periods.project_id AND projects.user_id = auth.uid()));

CREATE POLICY "Users can delete price periods for own projects"
ON public.price_periods FOR DELETE
USING (EXISTS (SELECT 1 FROM projects WHERE projects.id = price_periods.project_id AND projects.user_id = auth.uid()));

-- Trigger for updated_at
CREATE TRIGGER update_price_periods_updated_at
BEFORE UPDATE ON public.price_periods
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
