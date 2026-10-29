import { cn } from '@/lib/utils';

/** On/off toggle: a 32×18 track, blue when on. Give it an aria-label or point aria-labelledby at its label. */
export function Switch({
  checked,
  onChange,
  disabled,
  className,
  ...aria
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors',
        'focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-slate-300 dark:bg-white/15',
        className,
      )}
      {...aria}
    >
      <span
        aria-hidden
        className={cn(
          'size-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(15,23,42,0.2)] transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
