import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type SegmentedOption<T extends string> = { value: T; label: ReactNode };

/** Small switch between a few views (7d / 30d / 90d). The chosen segment is a raised white tile on a grey track. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group, e.g. "Date range". */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex items-center gap-0.5 rounded-control bg-slate-100 p-0.5 dark:bg-white/5', className)}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'h-6 cursor-pointer rounded-md px-2.5 text-xs font-medium transition-colors',
              active
                ? 'bg-card text-text-main shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                : 'text-text-sub hover:text-text-main',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
