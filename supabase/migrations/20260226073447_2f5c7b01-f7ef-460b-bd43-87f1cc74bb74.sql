CREATE TABLE public.watchdog_state (
  id text PRIMARY KEY DEFAULT 'singleton',
  last_execution_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Insert the singleton row
INSERT INTO public.watchdog_state (id, last_execution_at) VALUES ('singleton', now());

-- No RLS needed - only accessed by service role from edge functions
ALTER TABLE public.watchdog_state ENABLE ROW LEVEL SECURITY;