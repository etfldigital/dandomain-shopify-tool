-- Add dandomain_base_url column to projects table for building full image URLs
ALTER TABLE public.projects 
ADD COLUMN IF NOT EXISTS dandomain_base_url TEXT;