import type { InputHTMLAttributes } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A text field's classes: 32px tall, 8px corners, card fill, blue focus ring. Also fits a <select>. */
export function inputClasses(className?: string) {
  return cn(
    'h-8 w-full rounded-control border border-input-border bg-card px-3 text-[13px] text-text-main transition-colors',
    'placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none',
    className,
  );
}

/** Search field with a leading magnifier. Give it an aria-label when there is no visible label. */
export function SearchInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={cn('relative', className)}>
      <Search aria-hidden size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted" />
      <input type="search" className={inputClasses('pl-8')} {...props} />
    </div>
  );
}
