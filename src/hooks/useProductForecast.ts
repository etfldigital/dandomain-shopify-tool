import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

type PrepareUploadStats = {
  totalRecords: number;
  groupsCreated: number;
  variantsTotal: number;
  recordsRejected: number;
};

type PrepareUploadResponse = {
  success: boolean;
  stats?: PrepareUploadStats;
  error?: string;
};

export type ProductForecast = {
  totalLines: number;
  shopifyProducts: number;
  totalVariants: number;
  avgVariants: number;
  rejected: number;
  computedAt: number;
  productsFileUpdatedAt: string | null;
  source: 'cache' | 'computed';
};

type CachedForecast = Omit<ProductForecast, 'source'>;

const cacheKey = (projectId: string) => `productForecast:${projectId}`;

async function fetchProductsFileUpdatedAt(projectId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('project_files')
    .select('updated_at')
    .eq('project_id', projectId)
    .eq('entity_type', 'products')
    .maybeSingle();

  if (error) {
    // If we can't read the file record, we still can compute forecast; just disable invalidation.
    return null;
  }

  return (data as { updated_at?: string } | null)?.updated_at ?? null;
}

function readCachedForecast(projectId: string): CachedForecast | null {
  try {
    const raw = localStorage.getItem(cacheKey(projectId));
    if (!raw) return null;
    return JSON.parse(raw) as CachedForecast;
  } catch {
    return null;
  }
}

function writeCachedForecast(projectId: string, forecast: CachedForecast) {
  try {
    localStorage.setItem(cacheKey(projectId), JSON.stringify(forecast));
  } catch {
    // ignore
  }
}

export function useProductForecast(projectId: string | undefined) {
  const [forecast, setForecast] = useState<ProductForecast | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const compute = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!projectId) return;
      setIsLoading(true);
      setError(null);

      try {
        const productsFileUpdatedAt = await fetchProductsFileUpdatedAt(projectId);

        if (!opts?.force) {
          const cached = readCachedForecast(projectId);
          if (cached && cached.productsFileUpdatedAt === productsFileUpdatedAt) {
            setForecast({ ...cached, source: 'cache' });
            setIsLoading(false);
            return;
          }
        }

        const response = await supabase.functions.invoke('prepare-upload', {
          body: {
            projectId,
            entityType: 'products',
            previewOnly: true,
          },
        });

        if (response.error) {
          throw new Error(response.error.message);
        }

        const data = response.data as PrepareUploadResponse;
        if (!data?.success || !data.stats) {
          throw new Error(data?.error || 'Forecast fejlede');
        }

        const totalLines = data.stats.totalRecords ?? 0;
        const shopifyProducts = data.stats.groupsCreated ?? 0;
        const totalVariants = data.stats.variantsTotal ?? 0;
        const avgVariants = shopifyProducts > 0 ? totalVariants / shopifyProducts : 0;
        const rejected = data.stats.recordsRejected ?? 0;

        const computedAt = Date.now();
        const computed: CachedForecast = {
          totalLines,
          shopifyProducts,
          totalVariants,
          avgVariants,
          rejected,
          computedAt,
          productsFileUpdatedAt,
        };

        writeCachedForecast(projectId, computed);
        setForecast({ ...computed, source: 'computed' });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ukendt fejl');
      } finally {
        setIsLoading(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    compute();
  }, [compute]);

  return {
    forecast,
    isLoading,
    error,
    refresh: (force = true) => compute({ force }),
  };
}
