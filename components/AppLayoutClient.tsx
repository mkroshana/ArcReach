'use client';

import React, { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { TopNavBar } from '@/components/TopNavBar';
import { Background } from '@/components/Background';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastProvider } from '@/components/Toast';
import { TaskProvider } from '@/components/TaskProvider';
import type { UserSession } from '@/lib/session';

export function AppLayoutClient({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [session, setSession] = useState<UserSession | null>(null);
  const [systemStatus, setSystemStatus] = useState<any>(null);

  // Close mobile drawer on route transition during render
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    if (mobileSidebarOpen) setMobileSidebarOpen(false);
  }

  // Load session and system status centrally for global navigation & shell
  useEffect(() => {
    if (isLoginPage) return;

    fetch('/api/session')
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login';
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (data) setSession(data);
      })
      .catch(() => {});

    const loadStatus = () => {
      fetch('/api/system-status')
        .then((res) => (res.status === 401 ? null : res.json()))
        .then((data) => {
          if (data) setSystemStatus(data);
        })
        .catch(() => {});
    };

    loadStatus();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadStatus();
      }
    }, 60000);

    return () => clearInterval(interval);
  }, [isLoginPage]);

  return (
    <ThemeProvider>
      <ToastProvider>
        <TaskProvider>
          <Background />
          {isLoginPage ? (
            <div className="min-h-screen w-full relative z-10 overflow-auto bg-[#F5F6F9] dark:bg-[#090A0F]">
              {children}
            </div>
          ) : (
            <div className="flex h-dvh w-full overflow-hidden bg-[#F5F6F9] dark:bg-[#090A0F]">
              {/* Shopeers Sidebar (Drawer on mobile, fixed column on desktop) */}
              <Sidebar
                mobileOpen={mobileSidebarOpen}
                onMobileClose={() => setMobileSidebarOpen(false)}
                session={session}
                systemStatus={systemStatus}
              />

              {/* Right content column */}
              <div className="flex-1 flex flex-col min-w-0 h-dvh md:ml-64 overflow-hidden relative">
                {/* Shopeers Top Navigation Bar */}
                <TopNavBar
                  session={session}
                  systemStatus={systemStatus}
                  onMobileMenuToggle={() => setMobileSidebarOpen((prev) => !prev)}
                />

                {/* Main page content area */}
                <main className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 relative z-10">
                  <div className="max-w-7xl mx-auto h-full">
                    {children}
                  </div>
                </main>
              </div>
            </div>
          )}
        </TaskProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default AppLayoutClient;
