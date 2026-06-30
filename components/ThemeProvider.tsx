'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColorScheme } from '@mui/material/styles';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      const savedTheme = localStorage.getItem('arcreach-theme') as Theme | null;
      if (savedTheme) return savedTheme;
      return 'light';
    }
    return 'light';
  });

  // MUI renders inside this provider's parent, so we can drive its color scheme
  // from the same state — keeping the .dark/.light classes (Tailwind + globals.css
  // + MUI css vars) and MUI's runtime mode (theme.palette.mode) in lockstep.
  const { setMode } = useColorScheme();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.classList.toggle('light', theme === 'light');
    setMode(theme);
  }, [theme, setMode]);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('arcreach-theme', nextTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
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
