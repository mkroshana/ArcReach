'use client';

import { createTheme } from '@mui/material/styles';

/**
 * Material 3 "Expressive"-flavored MUI theme.
 * - Tonal color roles seeded from the ArcReach blue, plus a vivid tertiary accent.
 * - Large, rounded "expressive" shapes (pill buttons, extra-rounded cards).
 * - Roboto type scale with bolder, tighter headlines.
 * - Dark scheme activates under the existing `.dark` class (set by ThemeProvider).
 */
export const theme = createTheme({
  cssVariables: {
    colorSchemeSelector: '.dark',
  },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#2563EB', light: '#5B8DEF', dark: '#1D4FD7', contrastText: '#FFFFFF' },
        secondary: { main: '#7C3AED', light: '#9D6BF5', dark: '#5B21B6', contrastText: '#FFFFFF' },
        success: { main: '#059669', contrastText: '#FFFFFF' },
        warning: { main: '#D97706', contrastText: '#FFFFFF' },
        error: { main: '#DC2626', contrastText: '#FFFFFF' },
        info: { main: '#0891B2', contrastText: '#FFFFFF' },
        background: { default: '#F6F7FB', paper: '#FFFFFF' },
        text: { primary: '#191C22', secondary: '#44474E' },
        divider: 'rgba(17,24,39,0.10)',
      },
    },
    dark: {
      palette: {
        primary: { main: '#A6C8FF', light: '#C8DCFF', dark: '#7CA8FF', contrastText: '#0A2D6B' },
        secondary: { main: '#CFBCFF', light: '#E4D7FF', dark: '#A98DF0', contrastText: '#3A1D72' },
        success: { main: '#34D399', contrastText: '#06281C' },
        warning: { main: '#FBBF24', contrastText: '#3A2A04' },
        error: { main: '#FF8A80', contrastText: '#5A0F0A' },
        info: { main: '#67E8F9', contrastText: '#08323B' },
        background: { default: '#111318', paper: '#1A1C22' },
        text: { primary: '#E3E2E6', secondary: '#C4C6CF' },
        divider: 'rgba(226,226,230,0.12)',
      },
    },
  },
  shape: { borderRadius: 16 },
  typography: {
    fontFamily: 'var(--font-roboto), Roboto, system-ui, -apple-system, sans-serif',
    h1: { fontWeight: 700, letterSpacing: '-0.02em' },
    h2: { fontWeight: 700, letterSpacing: '-0.02em' },
    h3: { fontWeight: 700, letterSpacing: '-0.015em' },
    h4: { fontWeight: 700, letterSpacing: '-0.015em' },
    h5: { fontWeight: 600, letterSpacing: '-0.01em' },
    h6: { fontWeight: 600, letterSpacing: '-0.01em' },
    button: { fontWeight: 600, letterSpacing: '0.01em' },
    overline: { fontWeight: 700, letterSpacing: '0.12em' },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 999,
          textTransform: 'none',
          paddingInline: 20,
          paddingBlock: 9,
          fontWeight: 600,
        },
        sizeSmall: { paddingInline: 14, paddingBlock: 6 },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: 24,
          backgroundImage: 'none',
          border: `1px solid ${theme.palette.divider}`,
        }),
      },
    },
    MuiPaper: {
      styleOverrides: { rounded: { borderRadius: 16 } },
    },
    MuiChip: {
      styleOverrides: { root: { borderRadius: 8, fontWeight: 600 } },
    },
    MuiOutlinedInput: {
      styleOverrides: { root: { borderRadius: 12 } },
    },
    MuiToggleButtonGroup: {
      styleOverrides: { root: { borderRadius: 999, gap: 4, padding: 4 } },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          border: 'none',
          textTransform: 'none',
          fontWeight: 600,
          paddingInline: 16,
          paddingBlock: 6,
        },
      },
    },
  },
});
