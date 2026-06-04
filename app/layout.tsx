import type {Metadata} from 'next';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';
import { Background } from '@/components/Background';
import { ThemeProvider } from '@/components/ThemeProvider';

export const metadata: Metadata = {
  title: 'ArcReach | Modern Email Marketing',
  description: 'Internal email marketing and automation platform',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className="antialiased">
      <body suppressHydrationWarning className="font-sans text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-950 overflow-hidden transition-colors duration-200">
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
      </body>
    </html>
  );
}
