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
      <ThemeProvider theme={theme} defaultMode="light">
        {children}
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
