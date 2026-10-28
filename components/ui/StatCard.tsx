import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import { Card } from './Card';
import { Badge } from './Badge';

/**
 * Percent change against the previous period. Green when it moved the good way: up by default,
 * down for figures like bounces where `goodDirection` is 'down'. A zero change is grey.
 */
export function DeltaBadge({ delta, goodDirection = 'up' }: { delta: number; goodDirection?: 'up' | 'down' }) {
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return <Badge>0%</Badge>;
  const up = rounded > 0;
  const good = up === (goodDirection === 'up');
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <Badge tone={good ? 'green' : 'red'} className="gap-0.5">
      <Arrow aria-hidden size={12} strokeWidth={2.25} />
      {`${up ? '+' : ''}${rounded}%`}
    </Badge>
  );
}

/** KPI tile: label and a plain blue icon on top, the figure, then the change and what it compares against. */
export function StatCard({
  label,
  icon: Icon,
  value,
  delta,
  goodDirection,
  comparison,
  footer,
}: {
  label: string;
  icon?: LucideIcon;
  value: ReactNode;
  /** Percent change; null or undefined when there is no earlier period to compare against. */
  delta?: number | null;
  goodDirection?: 'up' | 'down';
  /** e.g. "vs. 14,653 last period" */
  comparison?: ReactNode;
  /** Replaces the change row, for figures that have no comparison. */
  footer?: ReactNode;
}) {
  const hasDelta = typeof delta === 'number' && Number.isFinite(delta);
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-text-sub">{label}</span>
        {Icon && <Icon aria-hidden size={16} strokeWidth={2} className="shrink-0 text-primary" />}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-text-main">{value}</div>
      {(footer || hasDelta || comparison) && (
        <div className="mt-2 flex min-h-5 flex-wrap items-center gap-1.5 text-xs text-text-muted">
          {footer ?? (
            <>
              {hasDelta && <DeltaBadge delta={delta} goodDirection={goodDirection} />}
              {comparison && <span>{comparison}</span>}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
