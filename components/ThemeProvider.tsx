'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useColorScheme } from '@mui/material/styles';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Hook into MUI's ColorSchemeContext when rendered inside MuiProvider
  const colorSchemeContext = useColorScheme();
  const muiMode = colorSchemeContext?.mode as Theme | undefined;
  const setMuiMode = colorSchemeContext?.setMode;

  const [localTheme, setLocalTheme] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('arcreach-theme') as Theme | null;
        if (saved === 'dark' || saved === 'light') return saved;
      } catch {
        // localStorage unavailable (e.g. security policy / incognito)
      }
    }
    return 'light';
  });

  // Effective active theme: prefer MUI mode when initialized, fallback to localTheme
  const theme: Theme = (muiMode === 'dark' || muiMode === 'light') ? muiMode : localTheme;

  // Sync DOM classes and native browser color-scheme
  useEffect(() => {
    const el = document.documentElement;
    const isDark = theme === 'dark';
    if (el.classList.contains('dark') !== isDark) {
      el.classList.toggle('dark', isDark);
    }
    if (el.classList.contains('light') === isDark) {
      el.classList.toggle('light', !isDark);
    }
    el.style.colorScheme = theme;
  }, [theme]);

  const setTheme = useCallback((nextTheme: Theme) => {
    setLocalTheme(nextTheme);
    if (setMuiMode) {
      setMuiMode(nextTheme);
    }
    try {
      localStorage.setItem('arcreach-theme', nextTheme);
    } catch {
      // localStorage unavailable
    }
  }, [setMuiMode]);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
