'use client';

import { useState, type ReactNode } from 'react';
import { Menu, MenuItem } from '@mui/material';
import { MoreHorizontal } from 'lucide-react';
import { Button } from './Button';

export type OverflowMenuItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Red text, for destructive actions. */
  danger?: boolean;
  disabled?: boolean;
};

/** A "more" button whose menu holds actions that should not sit in the toolbar, such as rare or destructive ones. */
export function OverflowMenu({ items, label = 'More actions' }: { items: OverflowMenuItem[]; label?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = Boolean(anchor);
  return (
    <>
      <Button
        iconOnly
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        <MoreHorizontal size={16} />
      </Button>
      <Menu
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          // The theme's Backdrop dims and blurs; a menu's backdrop only catches the outside click
          backdrop: { invisible: true, sx: { backgroundColor: 'transparent', backdropFilter: 'none' } },
          paper: {
            sx: {
              mt: 0.5,
              minWidth: 176,
              borderRadius: '8px',
              border: 1,
              borderColor: 'divider',
              boxShadow: '0 8px 24px rgba(15, 23, 42, 0.12)',
            },
          },
        }}
      >
        {items.map((item) => (
          <MenuItem
            key={item.label}
            disabled={item.disabled}
            onClick={() => {
              setAnchor(null);
              item.onSelect();
            }}
            sx={{ gap: 1, fontSize: 13, minHeight: 32, color: item.danger ? 'error.main' : 'text.primary' }}
          >
            {item.icon}
            {item.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
