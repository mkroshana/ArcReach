import type { ReactNode } from 'react';
import { Card } from './Card';
import { cn } from '@/lib/utils';

const TONES = {
  error: { border: 'border-rose-200 dark:border-rose-900/50', title: 'text-rose-700 dark:text-rose-300' },
  warning: { border: 'border-amber-200 dark:border-amber-900/50', title: 'text-amber-700 dark:text-amber-300' },
} as const;

/** A card saying something went wrong: a coloured title, the reason, and an action such as Retry on the right. */
export function Notice({
  tone,
  title,
  children,
  action,
  className,
}: {
  tone: keyof typeof TONES;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Card role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start justify-between gap-4 p-4', TONES[tone].border, className)}>
      <div className="min-w-0">
        <div className={cn('text-[13px] font-semibold', TONES[tone].title)}>{title}</div>
        {children && <div className="mt-0.5 text-xs text-text-sub">{children}</div>}
      </div>
      {action}
    </Card>
  );
}
