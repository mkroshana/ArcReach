'use client';

import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import { ThemeProvider } from '@mui/material/styles';
import { theme } from '@/lib/theme';

/**
 * Mounts MUI with App Router-compatible Emotion SSR caching and the
 * Material 3 Expressive theme. No global CssBaseline — pages still on
 * Tailwind keep their existing styling; MUI components self-style.
 */
export function MuiProvider({ children }: { children: React.ReactNode }) {
  return (
    <AppRouterCacheProvider options={{ key: 'mui' }}>
      {/* storageManager={null} disables MUI's own mode persistence — the custom
          ThemeProvider is the single source of truth and drives MUI's mode. */}
      <ThemeProvider theme={theme} defaultMode="light" storageManager={null}>
        {children}
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
