'use client';

import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import { ThemeProvider } from '@mui/material/styles';
import { theme } from '@/lib/theme';

/**
 * Mounts MUI with App Router-compatible Emotion SSR caching and the
 * Shopeers theme. Synchronized with the custom ThemeProvider
 * via modeStorageKey="arcreach-theme".
 */
export function MuiProvider({ children }: { children: React.ReactNode }) {
  return (
    <AppRouterCacheProvider options={{ key: 'mui' }}>
      <ThemeProvider
        theme={theme}
        defaultMode="light"
        modeStorageKey="arcreach-theme"
      >
        {children}
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
