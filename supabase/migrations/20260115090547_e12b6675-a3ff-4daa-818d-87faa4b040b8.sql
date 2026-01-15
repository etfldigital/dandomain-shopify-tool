-- Create storage bucket for CSV files
INSERT INTO storage.buckets (id, name, public)
VALUES ('csv-uploads', 'csv-uploads', false)
ON CONFLICT (id) DO NOTHING;

-- Create RLS policies for csv-uploads bucket
CREATE POLICY "Users can upload their own CSV files"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'csv-uploads' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can view their own CSV files"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'csv-uploads' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can delete their own CSV files"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'csv-uploads' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- Create table to track uploaded files per project
CREATE TABLE public.project_files (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_size INTEGER,
  row_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(project_id, entity_type)
);

-- Enable RLS
ALTER TABLE public.project_files ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for project_files
CREATE POLICY "Users can view their own project files"
ON public.project_files
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE projects.id = project_files.project_id
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can insert their own project files"
ON public.project_files
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE projects.id = project_files.project_id
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can update their own project files"
ON public.project_files
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE projects.id = project_files.project_id
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete their own project files"
ON public.project_files
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE projects.id = project_files.project_id
    AND projects.user_id = auth.uid()
  )
);

-- Add trigger for updated_at
CREATE TRIGGER update_project_files_updated_at
BEFORE UPDATE ON public.project_files
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();