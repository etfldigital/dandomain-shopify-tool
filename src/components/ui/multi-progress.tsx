import * as React from "react";
import { cn } from "@/lib/utils";

interface ProgressSegment {
  value: number; // percentage 0-100
  className?: string;
  label?: string;
}

interface MultiProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  segments: ProgressSegment[];
  total?: number; // If provided, values are treated as counts instead of percentages
}

const MultiProgress = React.forwardRef<HTMLDivElement, MultiProgressProps>(
  ({ className, segments, total, ...props }, ref) => {
    // Calculate percentages if total is provided
    const normalizedSegments = total
      ? segments.map((s) => ({
          ...s,
          value: total > 0 ? (s.value / total) * 100 : 0,
        }))
      : segments;

    // Calculate cumulative offsets for stacking
    let cumulativeWidth = 0;

    return (
      <div
        ref={ref}
        className={cn(
          "relative h-4 w-full overflow-hidden rounded-full bg-secondary",
          className
        )}
        {...props}
      >
        {normalizedSegments.map((segment, index) => {
          const offset = cumulativeWidth;
          cumulativeWidth += segment.value;

          return (
            <div
              key={index}
              className={cn(
                "absolute h-full transition-all",
                segment.className || "bg-primary"
              )}
              style={{
                left: `${offset}%`,
                width: `${segment.value}%`,
              }}
              title={segment.label}
            />
          );
        })}
      </div>
    );
  }
);
MultiProgress.displayName = "MultiProgress";

export { MultiProgress };
export type { ProgressSegment, MultiProgressProps };
