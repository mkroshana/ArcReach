'use client';

import { useState } from 'react';
import { ChevronDown, Type, FileText } from 'lucide-react';
import {
  Stack, Button, ToggleButtonGroup, ToggleButton, Menu, MenuItem,
  ListSubheader, Typography, Box,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

/**
 * VariableToolbar — Reusable toolbar for inserting personalization variables
 * into subject line and body fields across templates and campaign editors.
 *
 * Features a field target selector (Subject/Body) when onInsertSubject is provided,
 * quick-access buttons for common variables, and a "More" menu for all options.
 *
 * Built on MUI primitives so the "More" menu portals to <body> and inherits the
 * app's z-index scale (avoids clipping / stacking issues inside MUI layouts).
 */

interface Variable {
  label: string;
  value: string;
  description: string;
  category: 'personalization' | 'spintax';
}

const VARIABLES: Variable[] = [
  { label: 'First Name', value: '{{firstName}}', description: 'Lead\'s first name', category: 'personalization' },
  { label: 'Full Name', value: '{{name}}', description: 'Lead\'s full name', category: 'personalization' },
  { label: 'Company', value: '{{company}}', description: 'Lead\'s company', category: 'personalization' },
  { label: 'Job Title', value: '{{jobTitle}}', description: 'Lead\'s job title', category: 'personalization' },
  { label: 'Email', value: '{{email}}', description: 'Lead\'s email address', category: 'personalization' },
  { label: 'Greeting', value: '{Hi|Hey|Hello}', description: 'Random greeting spintax', category: 'spintax' },
  { label: 'Opener', value: '{Hope you\'re doing well|Hope this finds you well|Trust you\'re having a great day}', description: 'Opener line spintax', category: 'spintax' },
  { label: 'CTA', value: '{Would love to chat|Happy to hop on a quick call|Let me know if you\'d be open to a brief call}', description: 'Call-to-action spintax', category: 'spintax' },
  { label: 'Custom Spintax', value: '{Option A|Option B}', description: 'Your own custom spintax', category: 'spintax' },
];

const CATEGORY_LABELS: Record<string, string> = {
  personalization: 'Personalization',
  spintax: 'Spintax',
};

// MUI palette key per category — personalization=primary (blue), spintax=secondary (violet).
const CATEGORY_COLOR: Record<Variable['category'], 'primary' | 'secondary'> = {
  personalization: 'primary',
  spintax: 'secondary',
};

interface VariableToolbarProps {
  /** Insert variable into the body field (default target) */
  onInsert: (value: string) => void;
  /** Insert variable into the subject field (enables target selector) */
  onInsertSubject?: (value: string) => void;
  /** Unused — kept for backwards compatibility */
  compact?: boolean;
}

export default function VariableToolbar({ onInsert, onInsertSubject }: VariableToolbarProps) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [target, setTarget] = useState<'body' | 'subject'>('body');
  const open = Boolean(anchorEl);

  const handleInsert = (value: string) => {
    if (target === 'subject' && onInsertSubject) {
      onInsertSubject(value);
    } else {
      onInsert(value);
    }
  };

  // Primary quick-access variables (always visible as buttons)
  const quickVars = VARIABLES.filter(v =>
    ['First Name', 'Company', 'Job Title', 'Greeting'].includes(v.label)
  );

  // All remaining variables in the dropdown
  const dropdownVars = VARIABLES.filter(v => !quickVars.includes(v));

  // Group dropdown vars by category
  const grouped = dropdownVars.reduce<Record<string, Variable[]>>((acc, v) => {
    (acc[v.category] = acc[v.category] || []).push(v);
    return acc;
  }, {});

  const chipSx = (category: Variable['category']) => {
    const color = CATEGORY_COLOR[category];
    return {
      minHeight: 24,
      py: 0.25,
      px: 1,
      fontSize: 9,
      fontWeight: 700,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.04em',
      borderRadius: '8px',
      color: `${color}.main`,
      borderColor: (t: any) => alpha(t.palette[color].main, 0.25),
      bgcolor: (t: any) => alpha(t.palette[color].main, 0.08),
      '&:hover': { bgcolor: (t: any) => alpha(t.palette[color].main, 0.16), borderColor: `${color}.main` },
    };
  };

  return (
    <Stack direction="row" sx={{ flexWrap: 'wrap', alignItems: 'center', gap: 0.75 }}>
      {/* Target selector — only show when both handlers are provided */}
      {onInsertSubject && (
        <ToggleButtonGroup
          size="small"
          exclusive
          value={target}
          onChange={(_, v) => v && setTarget(v)}
          sx={{
            mr: 0.5,
            '& .MuiToggleButton-root': {
              py: 0.25, px: 1, fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.04em', border: 'none', borderRadius: '8px', color: 'text.secondary',
              gap: 0.5,
            },
            '& .Mui-selected': { bgcolor: 'background.paper', color: 'text.primary' },
            bgcolor: 'action.selected', borderRadius: '10px', p: 0.25,
          }}
        >
          <ToggleButton value="subject" title="Insert into Subject Line">
            <Type size={11} /> Subject
          </ToggleButton>
          <ToggleButton value="body" title="Insert into Body">
            <FileText size={11} /> Body
          </ToggleButton>
        </ToggleButtonGroup>
      )}

      {/* Quick-access buttons */}
      {quickVars.map((v) => (
        <Button
          key={v.label}
          size="small"
          variant="outlined"
          onClick={() => handleInsert(v.value)}
          title={`Insert ${v.value} — ${v.description}`}
          sx={chipSx(v.category)}
        >
          + {v.label}
        </Button>
      ))}

      {/* More menu toggle */}
      <Button
        size="small"
        variant="outlined"
        color="inherit"
        onClick={(e) => setAnchorEl(e.currentTarget)}
        endIcon={<ChevronDown size={11} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />}
        sx={{
          minHeight: 24, py: 0.25, px: 1, fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.04em', borderRadius: '8px', color: 'text.secondary', borderColor: 'divider',
        }}
      >
        More
      </Button>

      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 320, maxWidth: '90vw', borderRadius: '12px', mt: 0.5 } } }}
      >
        {Object.entries(grouped).flatMap(([category, vars]) => [
          <ListSubheader
            key={`${category}-header`}
            sx={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', lineHeight: 2.4, color: 'text.secondary', bgcolor: 'action.hover' }}
          >
            {CATEGORY_LABELS[category] || category}
          </ListSubheader>,
          ...vars.map((v) => (
            <MenuItem
              key={v.label}
              onClick={() => { handleInsert(v.value); setAnchorEl(null); }}
              sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, py: 1 }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography component="span" sx={{ fontSize: 11, fontWeight: 700, color: `${CATEGORY_COLOR[v.category]}.main` }}>
                  + {v.label}
                </Typography>
                <Typography component="span" sx={{ fontSize: 10, color: 'text.secondary', ml: 1 }}>
                  {v.description}
                </Typography>
              </Box>
              <Box
                component="code"
                sx={{
                  fontSize: 9, fontFamily: 'monospace', color: 'text.secondary', bgcolor: 'action.hover',
                  px: 0.75, py: 0.25, borderRadius: '6px', flexShrink: 0, maxWidth: 120,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {v.value}
              </Box>
            </MenuItem>
          )),
        ])}
      </Menu>
    </Stack>
  );
}
