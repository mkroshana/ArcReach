'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';

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

  // Sole authority over the .dark/.light classes. MUI's provider applies its
  // colorSchemeSelector class ('dark' — a literal with no scheme placeholder)
  // once per document mount, AFTER this child effect, re-adding `dark` even in
  // light mode. We can't stop that write, so enforce our state instead: apply
  // on change and repair any external mutation via a MutationObserver. The
  // observer only writes on mismatch, so it self-stabilizes (no loop).
  useEffect(() => {
    const el = document.documentElement;
    const enforce = () => {
      const wantDark = theme === 'dark';
      if (el.classList.contains('dark') !== wantDark) el.classList.toggle('dark', wantDark);
      if (el.classList.contains('light') === wantDark) el.classList.toggle('light', !wantDark);
    };
    enforce();
    const obs = new MutationObserver(enforce);
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, [theme]);

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
