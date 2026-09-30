import type {Metadata} from 'next';
import { Roboto } from 'next/font/google';
import { headers } from 'next/headers';
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

// Runs before first paint: applies the saved theme class so the page never
// flashes the wrong scheme while React hydrates. Kept tiny and inline on
// purpose; ThemeProvider takes over (and enforces) after mount.
const themeInitScript = `try{var t=localStorage.getItem('arcreach-theme')==='dark'?'dark':'light';document.documentElement.classList.add(t)}catch(e){document.documentElement.classList.add('light')}`;

export default async function RootLayout({children}: {children: React.ReactNode}) {
  // The per-request nonce middleware.ts allows scripts by (lib/contentSecurityPolicy). Reading
  // headers renders every page per request, which a fresh nonce needs.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning className={`antialiased ${roboto.variable}`}>
      <head>
        {/* Browsers hide a nonce attribute once the script is in the page, so hydration would
            see it as a mismatch. */}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body suppressHydrationWarning className="font-sans text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-950 overflow-hidden transition-colors duration-200">
        <MuiProvider>
          <AppLayoutClient>{children}</AppLayoutClient>
        </MuiProvider>
      </body>
    </html>
  );
}
