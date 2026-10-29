'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const emptySubscribe = () => () => {};

/**
 * Renders its children into document.body. A page's own panels and modals need it: <main> is a
 * z-10 stacking context, so a fixed panel inside it stays under the z-40 top bar whatever its z-index.
 */
export function BodyPortal({ children }: { children: ReactNode }) {
  // Nothing on the server or the first client render, so hydration matches
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  return mounted ? createPortal(children, document.body) : null;
}
