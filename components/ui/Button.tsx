import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const VARIANTS = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover',
  secondary: 'border border-input-border bg-card text-text-main hover:bg-slate-50 dark:hover:bg-white/5',
  ghost: 'text-text-sub hover:bg-slate-100 hover:text-text-main dark:hover:bg-white/5',
  danger: 'border border-input-border bg-card text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10',
} as const;

const SIZES = {
  sm: 'h-7 gap-1.5 px-2.5 text-xs',
  md: 'h-8 gap-1.5 px-3 text-[13px]',
} as const;

const ICON_SIZES = { sm: 'size-7', md: 'size-8' } as const;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  /** Square button holding only an icon; give it an aria-label. */
  iconOnly?: boolean;
};

/** 8px-cornered button, 32px tall by default, matching MUI's themed Button. */
export function Button({ variant = 'secondary', size = 'md', iconOnly, className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-control font-medium whitespace-nowrap transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        iconOnly ? ICON_SIZES[size] : SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
