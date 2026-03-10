import { Loader2, RefreshCw, AlertCircle, CheckCircle2, Users, FileText } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { EntityType } from '@/types/database';

interface SimplifiedEntityCardProps {
  type: EntityType;
  label: string;
  totalRows: number;
  processed: number;
  duplicates: number;
  errors: number;
  shopifyLiveCount: number | null;
  isShopifyLoading: boolean;
  onRefreshShopify: () => void;
  isRunning: boolean;
}

export function SimplifiedEntityCard({
  type,
  label,
  totalRows,
  processed,
  duplicates,
  errors,
  shopifyLiveCount,
  isShopifyLoading,
  onRefreshShopify,
  isRunning,
}: SimplifiedEntityCardProps) {
  const Icon = type === 'customers' ? Users : FileText;
  const percent = totalRows > 0 ? Math.min(100, (processed / totalRows) * 100) : 0;
  const isComplete = processed >= totalRows && totalRows > 0;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
          isComplete ? 'bg-green-100 dark:bg-green-900' :
          isRunning ? 'bg-primary/10' :
          'bg-muted'
        }`}>
          {isComplete ? (
            <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400" />
          ) : isRunning ? (
            <Loader2 className="w-4 h-4 text-primary animate-spin" />
          ) : (
            <Icon className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">
          {totalRows.toLocaleString('da-DK')} rækker i alt
        </span>
      </div>

      {/* Progress bar: Behandlet */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Behandlet</span>
          <span className="tabular-nums font-medium text-foreground">
            {processed.toLocaleString('da-DK')} / {totalRows.toLocaleString('da-DK')}
          </span>
        </div>
        <Progress value={percent} className="h-2" />
        {remaining > 0 && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Tilbage</span>
            <span className="tabular-nums">{remaining.toLocaleString('da-DK')}</span>
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Dubletter */}
        <div className="flex items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Dubletter:</span>
          <span className="tabular-nums font-medium text-amber-600">
            {duplicates.toLocaleString('da-DK')}
          </span>
        </div>

        {/* Fejl */}
        <div className="flex items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Fejl:</span>
          {errors > 0 ? (
            <span className="tabular-nums font-medium text-destructive flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {errors.toLocaleString('da-DK')}
            </span>
          ) : (
            <span className="tabular-nums text-muted-foreground">0</span>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* I Shopify nu — prominent */}
        <div className="flex items-center gap-1.5">
          <Badge
            variant={shopifyLiveCount !== null ? 'success' : 'outline'}
            className="gap-1.5 px-2.5 py-1 text-sm font-medium"
          >
            {isShopifyLoading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : shopifyLiveCount !== null ? (
              <span className="tabular-nums">{shopifyLiveCount.toLocaleString('da-DK')}</span>
            ) : (
              '–'
            )}
            <span className="font-normal">i Shopify</span>
          </Badge>
          <button
            onClick={(e) => { e.stopPropagation(); onRefreshShopify(); }}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={`Opdater ${label} Shopify-tal`}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
