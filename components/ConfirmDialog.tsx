'use client';

import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDestructive?: boolean;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  isDestructive = false
}: ConfirmDialogProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            exit={{ opacity: 0 }}
            onClick={onCancel}
            className="fixed inset-0 bg-[#020205]/75 z-[100] backdrop-blur-xs cursor-pointer"
          />
          {/* Modal Content */}
          <div className="fixed inset-0 z-[101] flex items-center justify-center p-4 pointer-events-none">
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="bg-[#0b0c10] border border-[#1e2230] rounded-2xl w-full max-w-md p-6 shadow-2xl pointer-events-auto overflow-hidden relative"
            >
              <button
                onClick={onCancel}
                className="absolute top-4 right-4 p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-900/50 transition-colors cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex gap-4 items-start pr-6">
                <div className={`p-2.5 rounded-xl border flex-shrink-0 ${
                  isDestructive
                    ? 'bg-rose-500/10 border-rose-500/20 text-rose-500'
                    : 'bg-blue-500/10 border-blue-500/20 text-blue-500'
                }`}>
                  <AlertTriangle className="w-5 h-5 flex-shrink-0" />
                </div>
                <div className="flex-1 space-y-1.5">
                  <h3 className="text-sm font-bold text-slate-150 leading-none">{title}</h3>
                  <p className="text-xs text-slate-400 leading-relaxed font-medium">{message}</p>
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-900/60">
                <button
                  onClick={onCancel}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white bg-transparent hover:bg-slate-900/50 rounded-lg border border-transparent transition-colors cursor-pointer"
                >
                  {cancelLabel}
                </button>
                <button
                  onClick={onConfirm}
                  className={`px-4 py-2 rounded-lg text-xs font-semibold shadow-md transition-all duration-200 cursor-pointer text-white border ${
                    isDestructive
                      ? 'bg-rose-600 hover:bg-rose-500 border-rose-500/30'
                      : 'bg-blue-600 hover:bg-blue-500 border-blue-500/30'
                  }`}
                >
                  {confirmLabel}
                </button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
