'use client';

import React, { useEffect, useRef, useId, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, type LucideIcon } from 'lucide-react';

export type ActionDrawerWidth = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ActionDrawerAction {
  label: string;
  onClick?: () => void;
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  form?: string;
  variant?: 'primary' | 'danger';
}

export interface ActionDrawerProps {
  /** Controls drawer visibility */
  isOpen: boolean;
  /** Callback fired when drawer requests closing (via backdrop click, close button, or Escape key) */
  onClose: () => void;
  /** Header title rendered in Title Case */
  title: string;
  /** Optional subtitle providing concise context */
  subtitle?: string;
  /** Icon displayed in the header icon container (Lucide icon or React element) */
  icon?: LucideIcon | React.ComponentType<{ className?: string }> | React.ReactNode;
  /** Content rendered in the scrollable body container */
  children: React.ReactNode;
  /**
   * Custom footer actions container.
   * - Pass `ReactNode` to render custom footer actions.
   * - Pass `null` to explicitly suppress the footer bar (e.g. for pure view or timeline sheets).
   * - Omit (`undefined`) to render the default sticky Cancel + Primary Submit action bar.
   */
  footer?: React.ReactNode | null;
  /**
   * Drawer width preset:
   * - 'sm': 420px max-width (quick confirmations, single input forms)
   * - 'md': 560px max-width (standard creation forms, Create Campaign) [DEFAULT]
   * - 'lg': 680px max-width (multi-column forms, Connect Mailbox)
   * - 'xl': 840px max-width (tables, CSV mapping, multi-step wizards)
   * - 'full': 100vw full width
   */
  width?: ActionDrawerWidth;
  /** Global loading state: displays indeterminate header loading bar and disables actions */
  isLoading?: boolean;

  // Primary action button props
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryLoading?: boolean;
  primaryDisabled?: boolean;
  primaryVariant?: 'primary' | 'danger';

  // Secondary / Cancel button props
  cancelLabel?: string;
  onCancel?: () => void;
  showCancel?: boolean;

  // Form submission integration
  formId?: string;
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void;

  // Visual & behavioral customizations
  className?: string;
  bodyClassName?: string;
  headerClassName?: string;
  footerClassName?: string;
  showCloseButton?: boolean;
  closeOnBackdropClick?: boolean;
  closeOnEscape?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

const WIDTH_CLASSES: Record<ActionDrawerWidth, string> = {
  sm: 'sm:max-w-[420px]',
  md: 'sm:max-w-[560px]',
  lg: 'sm:max-w-[680px]',
  xl: 'sm:max-w-[840px]',
  full: 'sm:max-w-full',
};

const emptySubscribe = () => () => {};

/**
 * Reusable slide-over Action Drawer component strictly adhering to Shopeers aesthetic.
 *
 * Features:
 * - Fluid spring physics via `motion/react` (damping: 28, stiffness: 280, mass: 0.9).
 * - Soft backdrop blur overlay: `backdrop-blur-sm bg-black/25 dark:bg-black/60`.
 * - Sticky frosted header: backdrop blur, Title Case typography, optional icon container, close button.
 * - Scrollable body container: `flex-1 overflow-y-auto px-6 py-5`.
 * - Sticky frosted bottom action bar: Cancel button + Primary Submit button with spinning loading state.
 * - Zero-layout-shift scroll locking: body scrollbar width is automatically compensated.
 * - Keyboard accessibility: Escape key listener and backdrop click-to-close.
 * - Fully portaled: renders into `document.body` via `createPortal` with SSR hydration guard.
 */
export function ActionDrawer({
  isOpen,
  onClose,
  title,
  subtitle,
  icon: Icon,
  children,
  footer,
  width = 'md',
  isLoading = false,
  primaryLabel = 'Save Changes',
  onPrimary,
  primaryLoading = false,
  primaryDisabled = false,
  primaryVariant = 'primary',
  cancelLabel = 'Cancel',
  onCancel,
  showCancel = true,
  formId,
  onSubmit,
  className = '',
  bodyClassName = '',
  headerClassName = '',
  footerClassName = '',
  showCloseButton = true,
  closeOnBackdropClick = true,
  closeOnEscape = true,
  initialFocusRef,
}: ActionDrawerProps) {
  // Client-side hydration guard for createPortal via React's official useSyncExternalStore
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const titleId = useId();
  const subtitleId = useId();
  const drawerRef = useRef<HTMLDivElement>(null);

  // Keyboard accessibility: Escape key listener
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeOnEscape, onClose]);

  // Body scroll lock with zero-layout-shift scrollbar compensation
  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
    };
  }, [isOpen]);

  // Focus management
  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(() => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
      } else if (drawerRef.current) {
        drawerRef.current.focus();
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [isOpen, initialFocusRef]);

  if (!mounted || !isOpen) return null;

  const widthClass = WIDTH_CLASSES[width] || WIDTH_CLASSES.md;
  const isPrimaryBusy = isLoading || primaryLoading;

  // Render icon helper
  const renderIcon = () => {
    if (!Icon) return null;
    if (React.isValidElement(Icon)) return Icon;
    const IconComponent = Icon as React.ComponentType<{ className?: string }>;
    return <IconComponent className="w-5 h-5 text-blue-600 dark:text-blue-400" />;
  };

  const handleCancelClick = () => {
    if (onCancel) {
      onCancel();
    } else {
      onClose();
    }
  };

  const drawerContent = (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden font-sans">
          {/* Soft Backdrop Overlay */}
          <motion.div
            key="action-drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            onClick={closeOnBackdropClick ? onClose : undefined}
            className="fixed inset-0 backdrop-blur-sm bg-black/25 dark:bg-black/60 transition-colors cursor-pointer"
            aria-hidden="true"
          />

          {/* Slide-over Drawer Panel */}
          <motion.div
            key="action-drawer-panel"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={subtitle ? subtitleId : undefined}
            tabIndex={-1}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{
              type: 'spring',
              damping: 28,
              stiffness: 280,
              mass: 0.9,
            }}
            className={`fixed right-0 top-0 bottom-0 z-50 w-full ${widthClass} bg-white dark:bg-[#11131a] border-l border-[#ebf0f5] dark:border-[#1e222d] shadow-2xl flex flex-col focus:outline-none transition-colors ${className}`}
          >
            {/* Sticky Frosted Header */}
            <div
              className={`sticky top-0 z-10 backdrop-blur-md bg-white/85 dark:bg-[#11131a]/85 border-b border-[#ebf0f5] dark:border-[#1e222d] px-6 py-4.5 flex items-center justify-between gap-4 transition-colors ${headerClassName}`}
            >
              <div className="flex items-center gap-3.5 min-w-0">
                {Icon && (
                  <div className="p-2.5 rounded-xl bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-900/40 flex-shrink-0">
                    {renderIcon()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h2
                    id={titleId}
                    className="text-base sm:text-lg font-bold text-slate-900 dark:text-white tracking-tight truncate"
                  >
                    {title}
                  </h2>
                  {subtitle && (
                    <p
                      id={subtitleId}
                      className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1 leading-relaxed"
                    >
                      {subtitle}
                    </p>
                  )}
                </div>
              </div>

              {showCloseButton && (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close drawer"
                  className="p-2 rounded-xl text-slate-400 hover:text-slate-700 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            {/* Indeterminate loading bar when isLoading */}
            {isLoading && (
              <div className="h-0.5 w-full bg-blue-100 dark:bg-blue-950 overflow-hidden relative">
                <div className="h-full bg-blue-600 dark:bg-blue-500 animate-pulse w-full" />
              </div>
            )}

            {/* Scrollable Body or Form Container */}
            {onSubmit ? (
              <form
                id={formId}
                onSubmit={onSubmit}
                className="flex-1 flex flex-col min-h-0 overflow-hidden"
              >
                <div
                  className={`flex-1 overflow-y-auto px-6 py-5 space-y-6 focus:outline-none ${bodyClassName}`}
                >
                  {children}
                </div>

                {/* Sticky Frosted Action Footer */}
                {footer !== null && (
                  <div
                    className={`sticky bottom-0 z-10 backdrop-blur-md bg-white/90 dark:bg-[#11131a]/90 border-t border-[#ebf0f5] dark:border-[#1e222d] px-6 py-4 flex items-center justify-between gap-3 transition-colors ${footerClassName}`}
                  >
                    {footer !== undefined ? (
                      footer
                    ) : (
                      <>
                        <div>
                          {showCancel && (
                            <button
                              type="button"
                              onClick={handleCancelClick}
                              disabled={isPrimaryBusy}
                              className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {cancelLabel}
                            </button>
                          )}
                        </div>
                        <button
                          type="submit"
                          disabled={isPrimaryBusy || primaryDisabled}
                          className={`px-5 py-2.5 rounded-xl text-xs font-semibold text-white transition-all flex items-center justify-center gap-2 active:scale-[0.98] shadow-xs hover:shadow disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none ${
                            primaryVariant === 'danger'
                              ? 'bg-red-600 hover:bg-red-500'
                              : 'bg-blue-600 hover:bg-blue-500'
                          }`}
                        >
                          {isPrimaryBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          <span>{primaryLabel}</span>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </form>
            ) : (
              <>
                <div
                  className={`flex-1 overflow-y-auto px-6 py-5 space-y-6 focus:outline-none ${bodyClassName}`}
                >
                  {children}
                </div>

                {/* Sticky Frosted Action Footer */}
                {footer !== null && (
                  <div
                    className={`sticky bottom-0 z-10 backdrop-blur-md bg-white/90 dark:bg-[#11131a]/90 border-t border-[#ebf0f5] dark:border-[#1e222d] px-6 py-4 flex items-center justify-between gap-3 transition-colors ${footerClassName}`}
                  >
                    {footer !== undefined ? (
                      footer
                    ) : (
                      <>
                        <div>
                          {showCancel && (
                            <button
                              type="button"
                              onClick={handleCancelClick}
                              disabled={isPrimaryBusy}
                              className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {cancelLabel}
                            </button>
                          )}
                        </div>
                        <button
                          type={formId ? 'submit' : 'button'}
                          form={formId}
                          onClick={onPrimary}
                          disabled={isPrimaryBusy || primaryDisabled}
                          className={`px-5 py-2.5 rounded-xl text-xs font-semibold text-white transition-all flex items-center justify-center gap-2 active:scale-[0.98] shadow-xs hover:shadow disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none ${
                            primaryVariant === 'danger'
                              ? 'bg-red-600 hover:bg-red-500'
                              : 'bg-blue-600 hover:bg-blue-500'
                          }`}
                        >
                          {isPrimaryBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          <span>{primaryLabel}</span>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );

  if (!mounted || typeof document === 'undefined') {
    return null;
  }

  return createPortal(drawerContent, document.body);
}

export default ActionDrawer;
