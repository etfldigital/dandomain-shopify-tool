import { LucideIcon, Loader2, RefreshCw, AlertCircle, MoreVertical } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export interface EntityMenuItem {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  separator?: 'before' | 'after';
}

interface EntityCardProps {
  label: string;
  icon: LucideIcon;
  processed: number;
  total: number;
  duplicates: number;
  errors: number;
  skipped: number;
  shopifyLiveCount: number | null;
  isShopifyLoading: boolean;
  onRefreshShopify: () => void;
  isRunning: boolean;
  isComplete: boolean;
  isPaused: boolean;
  isWaiting: boolean;
  isSyncing: boolean;
  menuItems: EntityMenuItem[];
  onErrorClick?: () => void;
}

export function EntityCard({
  label,
  icon: Icon,
  processed,
  total,
  duplicates,
  errors,
  skipped,
  shopifyLiveCount,
  isShopifyLoading,
  onRefreshShopify,
  isRunning,
  isComplete,
  isPaused,
  isWaiting,
  isSyncing,
  menuItems,
  onErrorClick,
}: EntityCardProps) {
  const percent = total > 0 ? Math.min(100, (processed / total) * 100) : 0;

  // Icon box color
  const iconBoxClass = isSyncing
    ? 'bg-primary/10'
    : isComplete
    ? 'bg-green-100 dark:bg-green-900/40'
    : isRunning
    ? 'bg-primary/10'
    : isPaused
    ? 'bg-amber-100 dark:bg-amber-900/40'
    : 'bg-muted';

  // Icon content
  const iconContent = isSyncing ? (
    <RefreshCw className="w-4 h-4 text-primary animate-spin" />
  ) : isComplete ? (
    <svg className="w-4 h-4 text-green-600 dark:text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ) : isRunning ? (
    <Loader2 className="w-4 h-4 text-primary animate-spin" />
  ) : isPaused ? (
    <svg className="w-4 h-4 text-amber-600" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
  ) : (
    <Icon className="w-4 h-4 text-muted-foreground" />
  );

  // Bar color
  const barBg = isComplete
    ? 'bg-green-500'
    : isRunning
    ? 'bg-primary'
    : isPaused
    ? 'bg-amber-500'
    : 'bg-muted-foreground/20';

  return (
    <div className="px-4 py-3 space-y-2">
      {/* Header row */}
      <div className="flex items-center gap-2.5 min-h-[34px]">
        {/* Icon */}
        <div className={`w-[34px] h-[34px] rounded-lg flex items-center justify-center flex-shrink-0 ${iconBoxClass}`}>
          {iconContent}
        </div>

        {/* Label */}
        <span className="font-semibold text-sm text-foreground">{label}</span>

        {/* Processed / Total */}
        <span className="text-sm tabular-nums text-muted-foreground ml-1">
          {processed.toLocaleString('da-DK')} / {total.toLocaleString('da-DK')}
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Inline badges */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Duplicates */}
          {duplicates > 0 && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="warning" className="gap-1 px-1.5 py-0.5 text-xs cursor-default">
                    <AlertCircle className="w-3 h-3" />
                    {duplicates.toLocaleString('da-DK')}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{duplicates.toLocaleString('da-DK')} dubletter</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Skipped */}
          {skipped > 0 && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="gap-1 px-1.5 py-0.5 text-xs cursor-default">
                    {skipped.toLocaleString('da-DK')}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{skipped.toLocaleString('da-DK')} sprunget over (allerede i Shopify)</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Errors */}
          {errors > 0 && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="destructive"
                    className="gap-1 px-1.5 py-0.5 text-xs cursor-pointer"
                    onClick={onErrorClick}
                  >
                    <AlertCircle className="w-3 h-3" />
                    {errors.toLocaleString('da-DK')}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{errors.toLocaleString('da-DK')} fejl — klik for detaljer</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Shopify live count */}
          <Badge
            variant={shopifyLiveCount !== null ? 'success' : 'outline'}
            className="gap-1 px-1.5 py-0.5 text-xs"
          >
            {isShopifyLoading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : shopifyLiveCount !== null ? (
              <span className="tabular-nums">{shopifyLiveCount.toLocaleString('da-DK')}</span>
            ) : (
              '–'
            )}
            <span className="font-normal text-[10px]">Shopify</span>
          </Badge>
          <button
            onClick={(e) => { e.stopPropagation(); onRefreshShopify(); }}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={`Opdater ${label} Shopify-tal`}
          >
            <RefreshCw className="w-3 h-3" />
          </button>

          {/* Kebab menu */}
          {menuItems.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-popover">
                {menuItems.map((item, i) => (
                  <div key={i}>
                    {item.separator === 'before' && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onClick={item.onClick}
                      disabled={item.disabled}
                      className={item.className}
                    >
                      <item.icon className="w-4 h-4 mr-2" />
                      {item.label}
                    </DropdownMenuItem>
                    {item.separator === 'after' && <DropdownMenuSeparator />}
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Progress bar — 5px, with shimmer when running */}
      <div className="relative w-full h-[5px] rounded-full bg-secondary overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${barBg}`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
        {/* Shimmer overlay when running */}
        {isRunning && percent > 0 && percent < 100 && (
          <div
            className="absolute inset-y-0 left-0 rounded-full overflow-hidden"
            style={{ width: `${Math.min(100, percent)}%` }}
          >
            <div className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/25 to-transparent" />
          </div>
        )}
      </div>

      {/* Waiting indicator */}
      {isWaiting && (
        <div className="text-[11px] text-muted-foreground flex items-center gap-1">
          <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse" />
          Venter på Shopify (genoptager automatisk)
        </div>
      )}
    </div>
  );
}
