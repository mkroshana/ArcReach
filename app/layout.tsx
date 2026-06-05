import type {Metadata} from 'next';
import './globals.css';
import { AppLayoutClient } from '@/components/AppLayoutClient';

export const metadata: Metadata = {
  title: 'ArcReach | Modern Email Marketing',
  description: 'Internal email marketing and automation platform',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className="antialiased">
      <body suppressHydrationWarning className="font-sans text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-950 overflow-hidden transition-colors duration-200">
        <AppLayoutClient>{children}</AppLayoutClient>
      </body>
    </html>
  );
}
