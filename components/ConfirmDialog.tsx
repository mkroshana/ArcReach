'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Typography, Stack,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDestructive?: boolean;
}

/**
 * Theme-aware confirmation dialog built on MUI's Dialog (focus-trapped,
 * Escape-to-close, portaled). Same props API across all call sites.
 */
export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  isDestructive = false,
}: ConfirmDialogProps) {
  const color = isDestructive ? 'error' : 'primary';
  return (
    <Dialog
      open={isOpen}
      onClose={onCancel}
      maxWidth="xs"
      fullWidth
      slotProps={{ paper: { sx: { borderRadius: '20px' } } }}
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <Box sx={{
            p: 1.25, borderRadius: '12px', display: 'grid', placeItems: 'center', flexShrink: 0,
            color: `${color}.main`,
            bgcolor: (t) => alpha(t.palette[color].main, 0.12),
          }}>
            <AlertTriangle size={20} />
          </Box>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>{title}</Typography>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{message}</Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onCancel} color="inherit" sx={{ color: 'text.secondary' }}>
          {cancelLabel}
        </Button>
        <Button onClick={onConfirm} variant="contained" color={color} autoFocus>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
