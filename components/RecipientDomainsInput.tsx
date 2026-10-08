'use client';

import React from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { parseRecipientDomains } from '@/lib/senderRouting';

interface RecipientDomainsInputProps {
  /** The list as stored (lib/senderRouting). */
  value: string[];
  /** Gets the new list once every entry is a domain name. */
  onChange: (domains: string[]) => void;
  /** Gets why a typed entry was not taken; the list then stays as it was. */
  onInvalid: (error: string) => void;
  helperText: React.ReactNode;
  disabled?: boolean;
}

/**
 * The Recipient Domains of a mailbox, as chips: the domains of the leads it
 * sends to (lib/senderRouting). A domain is added with Enter or by leaving the
 * field, and several typed or pasted together are split apart.
 */
export function RecipientDomainsInput({ value, onChange, onInvalid, helperText, disabled = false }: RecipientDomainsInputProps) {
  return (
    <Autocomplete
      multiple freeSolo autoSelect size="small" options={[] as string[]}
      value={value}
      disabled={disabled}
      onChange={(_, entries) => {
        const parsed = parseRecipientDomains(entries);
        if (parsed.error !== null) onInvalid(parsed.error);
        else onChange(parsed.domains);
      }}
      renderInput={(params) => (
        <TextField
          {...params} label="Recipient Domains"
          placeholder={value.length === 0 ? 'gmail.com' : ''}
          helperText={helperText}
          sx={{ '& .MuiInputBase-input': { fontFamily: 'monospace' } }}
        />
      )}
    />
  );
}
