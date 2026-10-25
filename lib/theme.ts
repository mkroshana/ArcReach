'use client';

import { createTheme } from '@mui/material/styles';

/**
 * Shopeers-aligned MUI theme.
 * - Light Mode: Shopeers canvas (#F5F6F9), pure white cards (#FFFFFF), clean borders (#EBF0F5), vibrant blue primary (#2563EB).
 * - Dark Mode Counterpart: Deep canvas (#090A0F), rich card surface (#11131A), borders (#1E222D), vibrant primary (#3B82F6).
 * - Shape: 24px card border radius, pill buttons (999px), rounded-xl inputs (12px), pill chips (999px).
 * - Typography: Clean modern type scale with tighter headlines, Title Case, purposeful spacing.
 * - CSS Variables: Mode switching driven by class selector 'class' (generating .light and .dark selectors).
 */
export const theme = createTheme({
  cssVariables: {
    colorSchemeSelector: 'class',
  },
  colorSchemes: {
    light: {
      palette: {
        primary: {
          main: '#2563EB',
          light: '#3B82F6',
          dark: '#1D4ED8',
          contrastText: '#FFFFFF',
        },
        secondary: {
          main: '#4F46E5',
          light: '#6366F1',
          dark: '#3730A3',
          contrastText: '#FFFFFF',
        },
        success: {
          main: '#059669',
          light: '#10B981',
          dark: '#047857',
          contrastText: '#FFFFFF',
        },
        warning: {
          main: '#D97706',
          light: '#F59E0B',
          dark: '#B45309',
          contrastText: '#FFFFFF',
        },
        error: {
          main: '#DC2626',
          light: '#EF4444',
          dark: '#B91C1C',
          contrastText: '#FFFFFF',
        },
        info: {
          main: '#0284C7',
          light: '#0EA5E9',
          dark: '#0369A1',
          contrastText: '#FFFFFF',
        },
        background: {
          default: '#F5F6F9',
          paper: '#FFFFFF',
        },
        text: {
          primary: '#0F172A',
          secondary: '#64748B',
          disabled: '#94A3B8',
        },
        divider: '#EBF0F5',
        action: {
          hover: 'rgba(15, 23, 42, 0.04)',
          selected: 'rgba(37, 99, 235, 0.08)',
          disabled: 'rgba(15, 23, 42, 0.26)',
          disabledBackground: 'rgba(15, 23, 42, 0.12)',
        },
      },
    },
    dark: {
      palette: {
        primary: {
          main: '#3B82F6',
          light: '#60A5FA',
          dark: '#2563EB',
          contrastText: '#FFFFFF',
        },
        secondary: {
          main: '#818CF8',
          light: '#A5B4FC',
          dark: '#6366F1',
          contrastText: '#FFFFFF',
        },
        success: {
          main: '#10B981',
          light: '#34D399',
          dark: '#059669',
          contrastText: '#FFFFFF',
        },
        warning: {
          main: '#F59E0B',
          light: '#FBBF24',
          dark: '#D97706',
          contrastText: '#FFFFFF',
        },
        error: {
          main: '#EF4444',
          light: '#F87171',
          dark: '#DC2626',
          contrastText: '#FFFFFF',
        },
        info: {
          main: '#0EA5E9',
          light: '#38BDF8',
          dark: '#0284C7',
          contrastText: '#FFFFFF',
        },
        background: {
          default: '#090A0F',
          paper: '#11131A',
        },
        text: {
          primary: '#F8FAFC',
          secondary: '#94A3B8',
          disabled: '#64748B',
        },
        divider: '#1E222D',
        action: {
          hover: 'rgba(255, 255, 255, 0.05)',
          selected: 'rgba(59, 130, 246, 0.15)',
          disabled: 'rgba(255, 255, 255, 0.3)',
          disabledBackground: 'rgba(255, 255, 255, 0.12)',
        },
      },
    },
  },
  shape: {
    borderRadius: 24,
  },
  typography: {
    fontFamily: 'var(--font-roboto), Roboto, system-ui, -apple-system, sans-serif',
    h1: { fontWeight: 700, letterSpacing: '-0.025em' },
    h2: { fontWeight: 700, letterSpacing: '-0.02em' },
    h3: { fontWeight: 700, letterSpacing: '-0.02em' },
    h4: { fontWeight: 600, letterSpacing: '-0.015em' },
    h5: { fontWeight: 600, letterSpacing: '-0.01em' },
    h6: { fontWeight: 600, letterSpacing: '-0.01em' },
    button: { fontWeight: 600, letterSpacing: '0.01em', textTransform: 'none' },
    overline: { fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' },
  },
  components: {
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          borderRadius: 999,
          textTransform: 'none',
          fontWeight: 600,
          letterSpacing: '0.01em',
          transition: 'all 0.15s ease-in-out',
        },
        sizeSmall: {
          paddingInline: 14,
          paddingBlock: 6,
          fontSize: '0.8125rem',
        },
        sizeMedium: {
          paddingInline: 20,
          paddingBlock: 8,
          fontSize: '0.875rem',
        },
        sizeLarge: {
          paddingInline: 24,
          paddingBlock: 10,
          fontSize: '0.9375rem',
        },
        outlined: ({ theme }) => ({
          borderColor: theme.palette.divider,
          '&:hover': {
            borderColor: theme.palette.primary.main,
          },
        }),
      },
    },
    MuiCard: {
      defaultProps: {
        elevation: 0,
      },
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: 24,
          backgroundImage: 'none',
          backgroundColor: theme.palette.background.paper,
          border: `1px solid ${theme.palette.divider}`,
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
        }),
      },
    },
    MuiPaper: {
      defaultProps: {
        elevation: 0,
      },
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
        rounded: {
          borderRadius: 24,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: ({ theme }) => ({
          borderRadius: 24,
          backgroundImage: 'none',
          backgroundColor: theme.palette.background.paper,
          border: `1px solid ${theme.palette.divider}`,
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
        }),
      },
    },
    MuiBackdrop: {
      styleOverrides: {
        root: {
          backgroundColor: 'rgba(0, 0, 0, 0.35)',
          backdropFilter: 'blur(4px)',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          fontWeight: 600,
          fontSize: '0.75rem',
        },
        sizeSmall: {
          height: 24,
          fontSize: '0.75rem',
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: 12,
          backgroundColor: theme.palette.background.paper,
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: theme.palette.divider,
            transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          },
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: theme.palette.primary.main,
          },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: theme.palette.primary.main,
            borderWidth: '1.5px',
          },
        }),
        input: {
          fontSize: '0.875rem',
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: ({ theme }) => ({
          borderColor: theme.palette.divider,
          paddingBlock: 12,
          paddingInline: 16,
          fontSize: '0.875rem',
        }),
        head: {
          fontWeight: 600,
          textTransform: 'uppercase',
          fontSize: '0.6875rem',
          letterSpacing: '0.06em',
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          borderRadius: 8,
          fontSize: '0.75rem',
          fontWeight: 500,
          padding: '6px 12px',
        },
      },
    },
    MuiToggleButtonGroup: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          gap: 4,
          padding: 4,
        },
      },
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
