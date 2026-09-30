'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Background } from '@/components/Background';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastProvider } from '@/components/Toast';
import { TaskProvider } from '@/components/TaskProvider';

export function AppLayoutClient({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';

  return (
    <ThemeProvider>
      <ToastProvider>
        <TaskProvider>
          <Background />
          {isLoginPage ? (
            <div className="min-h-screen w-full relative z-10 overflow-auto">
              {children}
            </div>
          ) : (
            // Below md the Sidebar is a top bar and drawer, so the page stacks under the bar with no sidebar offset.
            // h-dvh keeps the bottom of the page above a phone browser's toolbar (the same height as h-screen on desktop).
            <div className="flex h-dvh w-full flex-col md:flex-row">
              <Sidebar />
              <main className="flex-1 min-h-0 overflow-y-auto p-4 md:p-8 relative z-10 md:ml-64">
                <div className="max-w-7xl mx-auto h-full">
                  {children}
                </div>
              </main>
            </div>
          )}
        </TaskProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
