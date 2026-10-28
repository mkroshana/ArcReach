import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Shopeers surface: card fill, 1px border, 12px corners, no shadow. Padding is the caller's (p-4 is the norm). */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-card border border-card-border bg-card', className)} {...props} />;
}

/** Card title row: a 14px title, with optional controls (a range switch, a menu) on the right. No subtitle by design. */
export function CardHeader({ title, action, className }: { title: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-7 items-center justify-between gap-3', className)}>
      <h2 className="text-sm font-semibold text-text-main">{title}</h2>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}
