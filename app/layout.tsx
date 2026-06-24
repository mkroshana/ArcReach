import type {Metadata} from 'next';
import { Roboto } from 'next/font/google';
import './globals.css';
import { AppLayoutClient } from '@/components/AppLayoutClient';
import { MuiProvider } from '@/components/MuiProvider';

const roboto = Roboto({
  subsets: ['latin'],
  weight: ['300', '400', '500', '700'],
  variable: '--font-roboto',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ArcReach | Modern Email Marketing',
  description: 'Internal email marketing and automation platform',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`antialiased ${roboto.variable}`}>
      <body suppressHydrationWarning className="font-sans text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-950 overflow-hidden transition-colors duration-200">
        <MuiProvider>
          <AppLayoutClient>{children}</AppLayoutClient>
        </MuiProvider>
      </body>
    </html>
  );
}
