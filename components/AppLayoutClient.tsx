'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Background } from '@/components/Background';
import { ThemeProvider } from '@/components/ThemeProvider';

export function AppLayoutClient({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';

  if (isLoginPage) {
    return (
      <ThemeProvider>
        <Background />
        <div className="min-h-screen w-full relative z-10 overflow-auto">
          {children}
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <Background />
      <div className="flex h-screen w-full">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-8 relative z-10 ml-64">
          <div className="max-w-7xl mx-auto h-full">
            {children}
          </div>
        </main>
      </div>
    </ThemeProvider>
  );
}
