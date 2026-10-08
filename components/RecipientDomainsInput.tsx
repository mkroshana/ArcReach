'use client';

import React, { useState } from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { PROVIDER_ENTRIES, entryLabel, parseRecipientDomains } from '@/lib/senderRouting';

interface RecipientDomainsInputProps {
  /** The list as stored (lib/senderRouting). */
  value: string[];
  /** Gets the new list once every entry is a domain name or a mail provider. */
  onChange: (domains: string[]) => void;
  /** Gets why a typed entry was not taken; the list then stays as it was. */
  onInvalid: (error: string) => void;
  helperText: React.ReactNode;
  disabled?: boolean;
}

/**
 * The Recipient Domains of a mailbox, as chips: the domains and mail providers
 * of the leads it sends to (lib/senderRouting). A provider is picked from the
 * list the field opens; a domain is typed and added with Enter or by leaving
 * the field, and several typed or pasted together are split apart.
 */
export function RecipientDomainsInput({ value, onChange, onInvalid, helperText, disabled = false }: RecipientDomainsInputProps) {
  // What is typed and not yet added: the field keeps it itself, so leaving the field adds it and never a provider the pointer rested on.
  const [typed, setTyped] = useState('');

  const take = (entries: string[]) => {
    const parsed = parseRecipientDomains(entries);
    if (parsed.error !== null) onInvalid(parsed.error);
    else onChange(parsed.domains);
  };

  return (
    <Autocomplete
      multiple freeSolo filterSelectedOptions size="small"
      options={PROVIDER_ENTRIES}
      getOptionLabel={entryLabel}
      value={value}
      inputValue={typed}
      onInputChange={(_, text) => setTyped(text)}
      disabled={disabled}
      onChange={(_, entries) => {
        setTyped('');
        take(entries);
      }}
      onBlur={() => {
        if (!typed.trim()) return;
        setTyped('');
        take([...value, typed]);
      }}
      renderInput={(params) => (
        <TextField
          {...params} label="Recipient Domains"
          placeholder={value.length === 0 ? 'gmail.com, or pick a mail provider' : ''}
          helperText={helperText}
          sx={{ '& .MuiInputBase-input': { fontFamily: 'monospace' } }}
        />
      )}
    />
  );
}
