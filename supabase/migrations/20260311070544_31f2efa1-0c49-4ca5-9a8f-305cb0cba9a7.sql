
-- Add DELETE policy for canonical_orders
CREATE POLICY "Users can delete canonical orders for own projects"
ON public.canonical_orders
FOR DELETE
TO authenticated
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = canonical_orders.project_id
  AND projects.user_id = auth.uid()
));

-- Add DELETE policy for canonical_customers
CREATE POLICY "Users can delete canonical customers for own projects"
ON public.canonical_customers
FOR DELETE
TO authenticated
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = canonical_customers.project_id
  AND projects.user_id = auth.uid()
));
